import "server-only";
import { isSupportedStripeSnapshotVersion } from "./stripeSnapshotVersion";
import type Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import type { MembershipBillingDependencies } from "./membershipBillingRuntime";
import { assertMembershipHeld, assertMembershipSession, membershipCheck as check,
  membershipStripeId as sid, MEMBERSHIP_STRIPE_VERSION, type MembershipRecord } from "./membershipCheckout";
import { assertMembershipActivated, assertMembershipInvoice, readMembershipFirstProof } from "./membershipRenewal";
import { assertMembershipPayoffSession, readMembershipPayoff } from "./membershipPayoff";
import { assertMembershipBootstrapInvoice, reconcileMembershipActivation } from "./membershipActivationRecovery";
export function membershipLifecycleReady(env: Record<string, string | undefined> = process.env) {
  return ["CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_LIFECYCLE_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_LIFECYCLE_READY"].every(key => env[key] === "true");
}
type Callbacks = {
  confirmFirst: (id: string, buyer: string) => Promise<{ firstPaymentRecorded: boolean }>;
  confirmPayoff: (id: string, buyer: string, payoff: string) => Promise<{ payoffRecorded: boolean }>;
  reconcileInvoice: (id: string, buyer: string, invoice: string) => Promise<{ status: string; month: number }>;
};
type Resource = Stripe.Response<Stripe.Subscription> | Stripe.Response<Stripe.Invoice> | Stripe.Response<Stripe.Checkout.Session>;
type Outcome = "observed" | "waiting_collection" | "reconciled" | "checkout_attention" | "review_required" | "provider_stopped";
export function createMembershipLifecycleRuntime(d: MembershipBillingDependencies, callbacks: Callbacks) {
  const { admin, stripe, context, env, checked, observeContext, load, productId } = d;
  function ownedSubscription(s: Stripe.Subscription, a: MembershipRecord) {
    check(s.object === "subscription" && s.id === a.stripe_subscription_id && sid(s.customer, "cus") === a.stripe_customer_id &&
      s.livemode === (context.mode === "live") && s.metadata.creatornet_membership_version === MEMBERSHIP_STRIPE_VERSION &&
      s.metadata.creatornet_membership_id === a.id && s.metadata.creatornet_membership_fingerprint === a.fingerprint,
    "Monthly lifecycle subscription owner differs");
  }
  function ownedInvoice(i: Stripe.Invoice, a: MembershipRecord) {
    check(i.object === "invoice" && sid(i.id, "in") && sid(i.customer, "cus") === a.stripe_customer_id &&
      sid(i.parent?.subscription_details?.subscription, "sub") === a.stripe_subscription_id && i.livemode === (context.mode === "live"),
    "Monthly lifecycle invoice owner differs");
  }
  function proof(a: MembershipRecord, r: Resource) {
    return { version: "monthly-lifecycle-proof-v1", paymentContext: context, customerId: a.stripe_customer_id,
      subscriptionId: a.stripe_subscription_id, objectType: r.object, objectId: r.id, status: r.status, requestId: r.lastResponse.requestId,
      ...(r.object === "subscription" ? { pauseBehavior: r.pause_collection?.behavior ?? null, resumesAt: r.pause_collection?.resumes_at ?? null } : {}),
      ...(r.object === "invoice" ? { autoAdvance: r.auto_advance, total: r.total, amountPaid: r.amount_paid, billingReason: r.billing_reason } : {}),
      ...(r.object === "checkout.session" ? { paymentStatus: r.payment_status } : {}) };
  }
  async function record(a: MembershipRecord, event: Stripe.Event, r: Resource, outcome: Outcome) {
    await observeContext();
    const saved = await admin.rpc("record_monthly_mentorship_lifecycle_v1", { p_id: a.id, p_buyer_id: a.buyer_id, p_context: context,
      p_event_id: event.id, p_event_type: event.type, p_outcome: outcome, p_proof: proof(a, r) });
    check(!saved.error && saved.data?.agreement_id === a.id && saved.data.event_id === event.id, "Monthly lifecycle observation needs retry");
    return saved.data;
  }
  const held = (s: Stripe.Subscription) => s.status === "canceled" ||
    s.pause_collection?.behavior === "keep_as_draft" && s.pause_collection.resumes_at == null;
  async function contain(a: MembershipRecord, event: Stripe.Event, type: "subscription" | "invoice", id: string) {
    const request = { method: "POST", path: `/v1/${type === "subscription" ? "subscriptions" : "invoices"}/${id}`,
      params: type === "subscription" ? { pause_collection: { behavior: "keep_as_draft" }, proration_behavior: "none" } : { auto_advance: false } };
    const claim = await admin.rpc("claim_monthly_mentorship_containment_v1", { p_id: a.id, p_buyer_id: a.buyer_id, p_context: context,
      p_event_id: event.id, p_resource_type: type, p_resource_id: id, p_request: request });
    const o = claim.data;
    check(!claim.error && o?.agreement_id === a.id && o.event_id === event.id && o.resource_id === id &&
      isDeepStrictEqual(o.request, request) && /^[0-9a-f-]{36}$/i.test(o.id), "Monthly containment admission differs");
    await observeContext();
    let r = type === "subscription" ? await checked(stripe.subscriptions.retrieve(id)) : await checked(stripe.invoices.retrieve(id));
    const inspect = (value: Stripe.Subscription | Stripe.Invoice) => value.object === "subscription" ? ownedSubscription(value, a) : ownedInvoice(value, a);
    const stopped = (value: Stripe.Subscription | Stripe.Invoice) => value.object === "subscription" ? held(value) : value.auto_advance === false;
    inspect(r);
    if (!stopped(r)) {
      check(o.status === "dispatched" && Number.isFinite(Date.parse(o.dispatched_at)) &&
        Date.parse(o.dispatched_at) > Date.now() - 20 * 3600000, "Unknown monthly containment requires provider review");
      await observeContext();
      const options = { idempotencyKey: `creatornet-membership-containment:${o.id}`, maxNetworkRetries: 0 as const };
      r = type === "subscription" ?
        await checked(stripe.subscriptions.update(id, request.params as Stripe.SubscriptionUpdateParams, options)) :
        await checked(stripe.invoices.update(id, request.params as Stripe.InvoiceUpdateParams, options));
      inspect(r); check(stopped(r), "Monthly provider collection hold is not confirmed");
    }
    await observeContext();
    const saved = await admin.rpc("complete_monthly_mentorship_containment_v1", { p_operation_id: o.id, p_buyer_id: a.buyer_id,
      p_context: context, p_proof: proof(a, r) });
    check(!saved.error && typeof saved.data === "boolean", "Monthly containment completion needs retry");
    return r;
  }
  async function first(a: MembershipRecord) {
    const result = await admin.from("monthly_mentorship_receipts_v1").select("provider_proof")
      .eq("agreement_id", a.id).eq("month_number", 1).maybeSingle();
    check(!result.error && result.data); return readMembershipFirstProof(a, result.data.provider_proof);
  }
  async function subscription(a: MembershipRecord, event: Stripe.Event) {
    const object = event.data.object; check(object.object === "subscription");
    const s = await checked(stripe.subscriptions.retrieve(sid(object.id, "sub"))); ownedSubscription(s, a);
    if (s.status === "canceled") { await record(a, event, s, "provider_stopped"); return; }
    let healthy = true;
    try {
      const product = await productId(a);
      if (s.metadata.creatornet_membership_activation) assertMembershipActivated(s, a, product, await first(a));
      else assertMembershipHeld(s, a, a.stripe_customer_id!, product, true, true);
    } catch { healthy = false; }
    if (healthy && s.metadata.creatornet_membership_activation)
      await reconcileMembershipActivation(admin, env, a, await productId(a), await first(a), s);
    const saved = await record(a, event, s, healthy ? "observed" : "review_required");
    if (!held(s) || saved.outcome === "review_required") {
      const contained = await contain(a, event, "subscription", s.id);
      if (contained.object === "subscription" && contained.status === "canceled") await record(a, event, contained, "provider_stopped");
    }
  }
  async function zeroInvoice(a: MembershipRecord, i: Stripe.Invoice) {
    const product = await productId(a), kind = assertMembershipBootstrapInvoice(i, a, product);
    check(kind !== "bootstrap_draft", "Zero invoice has nonzero bootstrap evidence");
    if (kind === "activation_zero") {
      const sub = await checked(stripe.subscriptions.retrieve(a.stripe_subscription_id!)); ownedSubscription(sub, a);
      await reconcileMembershipActivation(admin, env, a, product, await first(a), sub);
    }
    const links = await checked(stripe.invoicePayments.list({ invoice: i.id, limit: 100 }));
    check(links.has_more === false && links.data.length === 0, "Zero invoice has unexpected payment evidence");
  }
  async function invoice(a: MembershipRecord, event: Stripe.Event) {
    const object = event.data.object; check(object.object === "invoice");
    const i = await checked(stripe.invoices.retrieve(sid(object.id, "in"))); ownedInvoice(i, a);
    if (i.total === 0) {
      try { await zeroInvoice(a, i); } catch (error) { await record(a, event, i, "review_required"); throw error; }
      await record(a, event, i, "observed"); return;
    }
    const admission = await admin.from("monthly_mentorship_operations_v1").select("scope_key,request,status")
      .eq("agreement_id", a.id).eq("kind", "collect").eq("request->>path", `/v1/invoices/${i.id}/pay`).maybeSingle();
    check(!admission.error, "Monthly invoice admission lookup needs retry");
    if (i.status === "paid" || i.amount_paid > 0) {
      if (!admission.data) { await record(a, event, i, "review_required"); throw Error("Captured invoice has no owned collection admission"); }
      const result = await callbacks.reconcileInvoice(a.id, a.buyer_id, i.id);
      check(["recorded", "already_recorded"].includes(result.status), "Monthly invoice capture is not yet recorded");
      await record(a, event, i, "reconciled"); return;
    }
    if (["invoice.paid", "invoice.payment_succeeded"].includes(event.type)) {
      await record(a, event, i, "review_required");
      throw Error("Monthly invoice capture is not yet recorded");
    }
    if (i.auto_advance !== false) {
      await record(a, event, i, "review_required");
      const current = await contain(a, event, "invoice", i.id);
      // A settlement racing containment must still reach the captured-money
      // adapter. A hold result is not a receipt or proof of no payment.
      if (current.object === "invoice" && (current.status === "paid" || current.amount_paid > 0)) {
        check(admission.data, "Captured invoice has no owned collection admission");
        const result = await callbacks.reconcileInvoice(a.id, a.buyer_id, current.id);
        check(["recorded", "already_recorded"].includes(result.status), "Monthly invoice capture is not yet recorded");
        await record(a, event, current, "reconciled");
      }
      return;
    }
    if (["void", "uncollectible"].includes(i.status || "")) { await record(a, event, i, "review_required"); return; }
    if (!admission.data && ["invoice.created", "invoice.updated"].includes(event.type)) {
      let bootstrap = false;
      try { bootstrap = assertMembershipBootstrapInvoice(i, a, await productId(a)) === "bootstrap_draft"; } catch { /* Validate as a renewal below. */ }
      if (bootstrap) {
        const sub = await checked(stripe.subscriptions.retrieve(a.stripe_subscription_id!)); ownedSubscription(sub, a);
        const product = await productId(a);
        if (sub.metadata.creatornet_membership_activation) await reconcileMembershipActivation(admin, env, a, product, await first(a), sub);
        else assertMembershipHeld(sub, a, a.stripe_customer_id!, product, true, true);
        const links = await checked(stripe.invoicePayments.list({ invoice: i.id, limit: 100 }));
        check(links.has_more === false && links.data.length === 0, "Held bootstrap invoice has payment evidence");
        await record(a, event, i, "observed"); return;
      }
    }
    try {
      const month = admission.data ? Number(admission.data.scope_key) : a.covered_months + 1;
      const product = await productId(a), p = await first(a);
      assertMembershipInvoice(i, a, p, month, product, "held");
      const sub = await checked(stripe.subscriptions.retrieve(a.stripe_subscription_id!)); ownedSubscription(sub, a);
      if (!held(sub)) {
        await record(a, event, i, "review_required"); await contain(a, event, "subscription", sub.id); return;
      }
      assertMembershipActivated(sub, a, product, p);
    } catch (error) { await record(a, event, i, "review_required"); throw error; }
    if (["invoice.payment_failed", "invoice.payment_action_required"].includes(event.type)) {
      if (admission.data) {
        const reviewed = await admin.rpc("review_monthly_mentorship_collection_v1", { p_id: a.id, p_month: Number(admission.data.scope_key), p_context: context });
        check(!reviewed.error && typeof reviewed.data === "boolean", "Monthly collection review needs retry");
      }
      await record(a, event, i, "review_required"); return;
    }
    await record(a, event, i, "waiting_collection");
  }
  async function checkout(a: MembershipRecord, event: Stripe.Event, payoffId: string | null) {
    const object = event.data.object; check(object.object === "checkout.session");
    const s = await checked(stripe.checkout.sessions.retrieve(sid(object.id, "cs")));
    if (payoffId) {
      check(env.CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_SCHEMA_READY === "true");
      const row = await admin.from("monthly_mentorship_payoffs_v1").select("*").eq("agreement_id", a.id).eq("buyer_id", a.buyer_id).eq("id", payoffId).maybeSingle();
      check(!row.error && row.data); const p = readMembershipPayoff(row.data, a);
      assertMembershipPayoffSession(s, a, p, null);
    } else assertMembershipSession(s, a, null);
    if (s.status === "complete" && s.payment_status === "paid") {
      if (payoffId) check((await callbacks.confirmPayoff(a.id, a.buyer_id, payoffId)).payoffRecorded);
      else check((await callbacks.confirmFirst(a.id, a.buyer_id)).firstPaymentRecorded);
      await record(a, event, s, "reconciled"); return;
    }
    check(s.payment_status === "unpaid" && ["open", "expired", "complete"].includes(s.status || ""), "Checkout state needs reconciliation");
    // Expiry is not proof of no money and never releases the payoff hold.
    // Only the explicit abandonment adapter can establish and release it.
    await record(a, event, s, "checkout_attention");
  }
  async function reconcileLifecycle(id: string, buyerId: string, event: Stripe.Event, payoffId: string | null = null) {
    check(membershipLifecycleReady(env), "Monthly lifecycle reconciliation is not enabled");
    check(/^evt_[A-Za-z0-9_]+$/.test(event.id) && event.livemode === (context.mode === "live") && isSupportedStripeSnapshotVersion(event.api_version, context.apiVersion) &&
      (event.account == null || event.account === context.stripeAccountId), "Monthly lifecycle event context differs");
    const a = await load(id, buyerId); await observeContext();
    const object = event.data.object;
    if (event.type.startsWith("customer.subscription.") && object.object === "subscription") await subscription(a, event);
    else if (event.type.startsWith("invoice.") && object.object === "invoice") await invoice(a, event);
    else if (["checkout.session.expired", "checkout.session.async_payment_failed"].includes(event.type) && object.object === "checkout.session")
      await checkout(a, event, payoffId);
    else throw Error("Monthly lifecycle event requires its dedicated payment adapter");
    return { status: "observed" as const, membershipId: a.id };
  }
  return { reconcileLifecycle };
}
