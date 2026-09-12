import "server-only";
import type Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import { isSupportedStripeSnapshotVersion } from "./stripeSnapshotVersion";
import { assertMembershipId } from "./membershipAgreement";
import { buildMembershipCheckout, buildMembershipSubscription, membershipMetadata, membershipCheck as check, membershipStripeId as sid, type MembershipRecord } from "./membershipCheckout";
import { membershipCheckoutRecoveryReady, type BootstrapOperation, type CheckoutRecoveryResult } from "./membershipCheckoutRecovery";
import type { MembershipBillingDependencies } from "./membershipBillingRuntime";
type Kind = "expire_checkout" | "cancel_subscription" | "hold_invoice" | "void_invoice";
type Resource = Stripe.Response<Stripe.Checkout.Session | Stripe.Subscription | Stripe.Invoice>;
type Proof = Record<string, unknown> & { objectId: string; objectType: string; status: string | null };
type Closure = { id: string; agreement_id: string; kind: Kind; resource_id: string; request: unknown; status: string };
export function membershipInitialAbandonmentReady(env: Record<string, string | undefined> = process.env) {
  return membershipCheckoutRecoveryReady(env) && env.CREATOR_MONTHLY_MENTORSHIPS_INITIAL_ABANDONMENT_SCHEMA_READY === "true" &&
    env.CREATOR_MONTHLY_MENTORSHIPS_INITIAL_ABANDONMENT_READY === "true";
}
export function createMembershipInitialAbandonment(d: MembershipBillingDependencies,
  api: { reconcileFirstCheckout(id: string, buyerId: string): Promise<CheckoutRecoveryResult> }) {
  const { admin, stripe, context, env, load, checked, observeContext } = d;
  const live = context.mode === "live";
  function list<T>(value: { data: T[]; has_more: boolean }, limit = 100) {
    check(value.has_more === false && Array.isArray(value.data) && value.data.length <= limit, "Initial provider list needs review");
    return value.data;
  }
  function metadata(value: Stripe.Metadata | null, a: MembershipRecord) {
    check(value?.creatornet_membership_id === a.id && value.creatornet_membership_fingerprint === a.fingerprint,
      "Initial provider ownership differs");
  }
  function proof(a: MembershipRecord, r: Stripe.Checkout.Session | Stripe.Subscription | Stripe.Invoice, customer: string, subscription: string,
    requestId: string): Proof {
    check(/^req_[A-Za-z0-9]+$/.test(requestId), "Initial provider read lacks provenance");
    check(r.livemode === live && sid(r.customer, "cus") === customer, "Initial provider customer differs");
    const common = { version: "monthly-initial-resource-proof-v1", paymentContext: context, requestId,
      objectId: r.id, objectType: r.object, customerId: customer, subscriptionId: subscription, status: r.status };
    if (r.object === "subscription") {
      check(r.id === subscription); metadata(r.metadata, a);
      for (const [key, value] of Object.entries(membershipMetadata(a, "subscription"))) check(r.metadata[key] === value);
      return { ...common, metadata: r.metadata };
    }
    if (r.object === "checkout.session") {
      const expected = buildMembershipCheckout(a, customer, subscription);
      check(r.mode === "payment" && r.currency === "usd" && r.amount_total === a.monthly_price_cents &&
        r.amount_subtotal === a.monthly_price_cents && isDeepStrictEqual(r.metadata, expected.metadata) && r.subscription === null &&
        r.setup_intent === null && r.recovered_from == null && r.after_expiration?.recovery?.enabled !== true &&
        r.total_details?.amount_discount === 0 && r.total_details.amount_tax === 0 && r.total_details.amount_shipping === 0,
      "Initial checkout contract differs");
      return { ...common, metadata: r.metadata, amountCents: r.amount_total, paymentStatus: r.payment_status };
    }
    check(r.parent?.type === "subscription_details" && sid(r.parent.subscription_details?.subscription, "sub") === subscription &&
      r.currency === "usd" && Number.isSafeInteger(r.amount_paid) && r.amount_paid === 0, "Initial invoice has money or another owner");
    return { ...common, currency: r.currency, amountPaidCents: r.amount_paid, totalCents: r.total,
      autoAdvance: r.auto_advance, hostedInvoiceUrlNull: r.hosted_invoice_url == null };
  }
  const terminal = (kind: Kind, p: Proof) => kind === "expire_checkout" ? p.status === "expired" && p.paymentStatus === "unpaid" :
    kind === "cancel_subscription" ? p.status === "canceled" : kind === "void_invoice" ? p.status === "void" :
      p.status === "draft" && p.autoAdvance === false && p.hostedInvoiceUrlNull === true;
  const requestFor = (kind: Kind, id: string) => kind === "expire_checkout" ? { method: "POST", path: "/v1/checkout/sessions/" + id + "/expire", params: {} } :
    kind === "cancel_subscription" ? { method: "DELETE", path: "/v1/subscriptions/" + id, params: { invoice_now: false, prorate: false } } :
      { method: "POST", path: "/v1/invoices/" + id + (kind === "void_invoice" ? "/void" : ""), params: kind === "void_invoice" ? {} : { auto_advance: false } };
  async function close(a: MembershipRecord, kind: Kind, first: Resource, customer: string, subscription: string) {
    let r = first, p = proof(a, r, customer, subscription, r.lastResponse.requestId);
    const claimed = await admin.rpc("claim_monthly_initial_closure_v1", { p_id: a.id, p_buyer_id: a.buyer_id, p_context: context, p_kind: kind, p_proof: p });
    const op = claimed.data as Closure;
    check(!claimed.error && op?.agreement_id === a.id && op.kind === kind && op.resource_id === r.id &&
      isDeepStrictEqual(op.request, requestFor(kind, r.id)), "Initial closure admission differs"); assertMembershipId(op.id);
    if (!terminal(kind, p)) {
      check(op.status === "pending", "Initial closure state changed");
      await observeContext();
      const options = { idempotencyKey: "creatornet-initial-close:" + op.id, maxNetworkRetries: 0 as const };
      r = kind === "expire_checkout" ? await checked(stripe.checkout.sessions.expire(r.id, {}, options)) :
        kind === "cancel_subscription" ? await checked(stripe.subscriptions.cancel(r.id, { invoice_now: false, prorate: false }, options)) :
          kind === "hold_invoice" ? await checked(stripe.invoices.update(r.id, { auto_advance: false }, options)) :
            await checked(stripe.invoices.voidInvoice(r.id, {}, options));
      check(r.id === op.resource_id); p = proof(a, r, customer, subscription, r.lastResponse.requestId);
    }
    check(terminal(kind, p), "Initial provider close-out remains pending");
    await observeContext();
    const completed = await admin.rpc("complete_monthly_initial_closure_v1", { p_operation_id: op.id, p_buyer_id: a.buyer_id, p_context: context, p_proof: p });
    check(!completed.error && typeof completed.data === "boolean", "Initial close-out proof needs retry");
    return r;
  }
  async function readSealedInitialProof(a: MembershipRecord, customer: string, subscription: string, checkout: string | null) {
    // These are bounded fresh barriers on the dedicated original customer.
    // None of these reads can create a payment, invoice, credit or new agreement.
    const intentsRead = await checked(stripe.paymentIntents.list({ customer, limit: 100 }));
    const intents = list(intentsRead);
    for (const pi of intents) check(pi.livemode === live && sid(pi.customer, "cus") === customer && pi.status === "canceled" &&
      pi.amount_received === 0 && pi.amount_capturable === 0, "Initial payment remains captured or pending");
    const chargesRead = await checked(stripe.charges.list({ customer, limit: 100 })), charges = list(chargesRead);
    for (const charge of charges) check(charge.livemode === live && sid(charge.customer, "cus") === customer && !charge.paid &&
      charge.amount_captured === 0, "Initial charge needs reconciliation");
    const invoicesRead = await checked(stripe.invoices.list({ customer, limit: 100 })), finalInvoices = list(invoicesRead, 8);
    const invoiceProofs = finalInvoices.map(i => { const p = proof(a, i, customer, subscription, invoicesRead.lastResponse.requestId);
      check(i.status === "void" || i.status === "paid" && i.total === 0 ||
        i.status === "draft" && i.auto_advance === false && i.hosted_invoice_url == null, "Initial invoice remains payable");
      return { id: i.id, status: i.status, amountPaidCents: i.amount_paid, totalCents: i.total, autoAdvance: p.autoAdvance, hostedInvoiceUrlNull: p.hostedInvoiceUrlNull }; });
    const subsRead = await checked(stripe.subscriptions.list({ customer, status: "all", limit: 100 })), subscriptions = list(subsRead);
    for (const s of subscriptions) check(s.livemode === live && sid(s.customer, "cus") === customer && s.status === "canceled", "Initial subscription remains active");
    check(subscriptions.some(s => s.id === subscription), "Original subscription stop is not visible");
    const sessionsRead = await checked(stripe.checkout.sessions.list({ customer, limit: 100 })), sessions = list(sessionsRead);
    for (const s of sessions) check(s.livemode === live && sid(s.customer, "cus") === customer && s.status === "expired" && s.payment_status === "unpaid" &&
      s.after_expiration?.recovery?.enabled !== true, "Original customer has another payable Checkout");
    check(checkout == null || sessions.some(s => s.id === checkout), "Original Checkout expiry is not visible");
    const pendingRead = await checked(stripe.invoiceItems.list({ customer, pending: true, limit: 100 }));
    check(list(pendingRead).length === 0, "Original customer has pending invoice items");
    return { version: "monthly-initial-abandonment-proof-v1", paymentContext: context, membershipId: a.id, neverPayable: false,
      customerId: customer, subscriptionId: subscription, checkoutSessionId: checkout, listsComplete: true, pendingInvoiceItemCount: 0,
      readRequestIds: [intentsRead, chargesRead, invoicesRead, subsRead, sessionsRead, pendingRead].map(r => r.lastResponse.requestId),
      paymentIntents: intents.map(pi => ({ id: pi.id, status: pi.status, amountReceivedCents: pi.amount_received, amountCapturableCents: pi.amount_capturable })),
      charges: charges.map(c => ({ id: c.id, paid: c.paid, amountCapturedCents: c.amount_captured })), invoices: invoiceProofs,
      subscriptions: subscriptions.map(s => ({ id: s.id, status: s.status })), checkouts: sessions.map(s => ({ id: s.id, status: s.status, paymentStatus: s.payment_status })) };
  }
  async function abandonFirstCheckout(id: string, buyerId: string, confirmed: boolean): Promise<CheckoutRecoveryResult> {
    check(membershipInitialAbandonmentReady(env), "Initial checkout close-out is not enabled");
    check(confirmed === true, "Explicit initial checkout close-out intent required");
    let a = await load(id, buyerId);
    const result = (status: "abandon_pending" | "abandoned"): CheckoutRecoveryResult => ({ membershipId: a.id, title: a.terms.title,
      monthlyPriceCents: a.monthly_price_cents, minimumMonths: a.minimum_months, minimumTotalCents: a.terms.minimumTotalCents,
      autoRenew: a.auto_renew, status, canResume: false, canAbandon: status !== "abandoned", completedStages: 0,
      firstPaymentRecorded: false, accessGranted: false, paidThrough: null,
      reviewUrl: "/memberships/review?product_id=" + a.product_id + "&post_id=" + a.post_id });
    if (a.covered_months > 0) return api.reconcileFirstCheckout(a.id, a.buyer_id);
    if (a.initial_abandoned_at) return result("abandoned");
    const accepted = await admin.rpc("request_monthly_initial_abandonment_v1", { p_id: a.id, p_buyer_id: a.buyer_id, p_context: context, p_confirmed: true });
    if (accepted.error) {
      const actual = await api.reconcileFirstCheckout(a.id, a.buyer_id);
      if (actual.firstPaymentRecorded) return actual;
      throw Error("Initial checkout is not proven unpaid");
    }
    check(accepted.data?.membershipId === a.id && accepted.data.requested === true, "Initial close-out acceptance differs");
    a = await load(a.id, a.buyer_id);
    try {
      await observeContext();
      const saved = await admin.from("monthly_mentorship_operations_v1").select("id,agreement_id,kind,scope_key,request,status,provider_id,dispatched_at")
        .eq("agreement_id", a.id).eq("scope_key", "initial").limit(8);
      check(!saved.error && Array.isArray(saved.data) && saved.data.length <= 7);
      const ops = saved.data as BootstrapOperation[];
      for (const op of ops) check(op.agreement_id === a.id && op.scope_key === "initial");
      const payable = ops.some(op => ["subscription", "hold", "checkout", "activate", "collect"].includes(op.kind));
      if (!payable) {
        const done = await admin.rpc("complete_monthly_initial_abandonment_v1", { p_id: a.id, p_buyer_id: a.buyer_id, p_context: context,
          p_proof: { version: "monthly-initial-abandonment-proof-v1", paymentContext: context, membershipId: a.id, neverPayable: true } });
        check(!done.error && typeof done.data === "boolean"); return result("abandoned");
      }
      const customer = sid(a.stripe_customer_id || ops.find(op => op.kind === "customer" && op.status === "complete")?.provider_id, "cus");
      const prior = await admin.from("monthly_mentorship_initial_closures_v1").select("id,agreement_id,kind,resource_id,request,status").eq("agreement_id", a.id).limit(32);
      check(!prior.error && Array.isArray(prior.data) && prior.data.length <= 32); const closures = prior.data as Closure[];
      let subscription = a.stripe_subscription_id || ops.find(op => op.kind === "subscription" && op.status === "complete")?.provider_id ||
        closures.find(op => op.kind === "cancel_subscription")?.resource_id;
      if (!subscription) {
        const choices = list(await checked(stripe.subscriptions.list({ customer, status: "all", limit: 100 })))
          .filter(s => s.metadata.creatornet_membership_id === a.id && s.metadata.creatornet_membership_fingerprint === a.fingerprint);
        check(choices.length === 1, "Original subscription needs recovery"); subscription = choices[0].id;
      }
      subscription = sid(subscription, "sub");
      const sub = await checked(stripe.subscriptions.retrieve(subscription)); check(sub.id === subscription); proof(a, sub, customer, subscription, sub.lastResponse.requestId);
      const checkoutOp = ops.find(op => op.kind === "checkout");
      let checkout: string | null = a.stripe_checkout_session_id || checkoutOp?.provider_id ||
        closures.find(op => op.kind === "expire_checkout")?.resource_id || null;
      if (checkoutOp && !checkout) {
        const choices = list(await checked(stripe.checkout.sessions.list({ customer, limit: 100 })))
          .filter(s => s.metadata?.creatornet_membership_id === a.id && s.metadata.creatornet_membership_fingerprint === a.fingerprint);
        check(choices.length === 1, "Original Checkout needs recovery"); checkout = choices[0].id;
      }
      if (checkout) {
        const session = await checked(stripe.checkout.sessions.retrieve(sid(checkout, "cs"))); check(session.id === checkout);
        proof(a, session, customer, subscription, session.lastResponse.requestId);
        if (session.status === "complete" && session.payment_status === "paid") return api.reconcileFirstCheckout(a.id, a.buyer_id);
        if (session.status === "complete") return result("abandon_pending");
        check(session.payment_status === "unpaid", "Initial payment needs recovery");
        await close(a, "expire_checkout", session, customer, subscription);
      }
      await close(a, "cancel_subscription", sub, customer, subscription);
      const invoices = list(await checked(stripe.invoices.list({ customer, limit: 100 })), 8);
      for (const listed of invoices) {
        const invoice = await checked(stripe.invoices.retrieve(listed.id)); check(invoice.id === listed.id); proof(a, invoice, customer, subscription, invoice.lastResponse.requestId);
        if (invoice.status === "paid") { check(invoice.total === 0, "Initial invoice has captured money"); continue; }
        if (invoice.status === "void") continue;
        check(["draft", "open", "uncollectible"].includes(invoice.status || ""), "Initial invoice cannot be sealed");
        await close(a, invoice.status === "draft" ? "hold_invoice" : "void_invoice", invoice, customer, subscription);
      }
      const sealed = await readSealedInitialProof(a, customer, subscription, checkout);
      await observeContext();
      const done = await admin.rpc("complete_monthly_initial_abandonment_v1", { p_id: a.id, p_buyer_id: a.buyer_id, p_context: context, p_proof: sealed });
      check(!done.error && typeof done.data === "boolean", "Initial close-out proof needs retry");
      return result("abandoned");
    } catch { return result("abandon_pending"); }
  }
  /** A signed event may predate binding or arrive after unpaid closure. Only
   * reconcile a completed closure, using its original operations and fresh sealed
   * resource lists. No binding, billing, entitlement or lifecycle state is written.
   * The canonical webhook claim records success only after these checks return. */
  async function reconcileAbandonedCheckoutEvent(id: string, buyerId: string, event: Stripe.Event) {
    check(membershipInitialAbandonmentReady(env) && env.CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY === "true",
      "Initial closed-event reconciliation is not enabled");
    check(/^evt_[A-Za-z0-9_]+$/.test(event.id) && event.livemode === live &&
      isSupportedStripeSnapshotVersion(event.api_version, context.apiVersion) &&
      (event.account == null || event.account === context.stripeAccountId), "Initial closed-event context differs");
    const a = await load(id, buyerId), object = event.data.object;
    check(a.covered_months === 0 && a.anchor_at === null && Number.isFinite(Date.parse(a.initial_abandoned_at || "")) &&
      Number.isFinite(Date.parse(a.initial_abandon_requested_at || "")), "Initial checkout is not proven closed unpaid");
    check(event.type.startsWith("customer.subscription.") && object.object === "subscription" ||
      event.type.startsWith("invoice.") && object.object === "invoice", "Initial closed event needs its payment adapter");
    const saved = a.initial_abandon_proof as Record<string, unknown> | null;
    check(saved?.version === "monthly-initial-abandonment-proof-v1" && saved.membershipId === a.id &&
      isDeepStrictEqual(saved.paymentContext, context) && saved.neverPayable === false && saved.listsComplete === true &&
      saved.pendingInvoiceItemCount === 0 && Array.isArray(saved.readRequestIds) && saved.readRequestIds.length === 6 &&
      saved.readRequestIds.every(r => typeof r === "string" && /^req_[A-Za-z0-9]+$/.test(r)), "Initial closure proof is incomplete");
    const customer = sid(saved.customerId, "cus"), subscription = sid(saved.subscriptionId, "sub");
    const checkout = saved.checkoutSessionId === null ? null : sid(saved.checkoutSessionId, "cs");
    check((a.stripe_customer_id === null || a.stripe_customer_id === customer) &&
      (a.stripe_subscription_id === null || a.stripe_subscription_id === subscription) &&
      (a.stripe_checkout_session_id === null || a.stripe_checkout_session_id === checkout), "Initial closed bindings differ");
    check(object.livemode === live && sid(object.customer, "cus") === customer, "Initial closed-event customer differs");
    if (object.object === "subscription") {
      check(object.id === subscription); metadata(object.metadata, a);
    } else {
      check(sid(object.parent?.subscription_details?.subscription, "sub") === subscription && object.amount_paid === 0 &&
        (!["invoice.paid", "invoice.payment_succeeded"].includes(event.type) || object.total === 0), "Initial event contains payment evidence");
    }
    const operations = await admin.from("monthly_mentorship_operations_v1").select("id,agreement_id,kind,scope_key,request,status,provider_id,dispatched_at")
      .eq("agreement_id", a.id).eq("scope_key", "initial").limit(8);
    check(!operations.error && Array.isArray(operations.data) && operations.data.length <= 7, "Initial operation evidence unavailable");
    const ops = operations.data as BootstrapOperation[];
    for (const op of ops) { assertMembershipId(op.id); check(op.agreement_id === a.id && op.scope_key === "initial"); }
    const one = (kind: string) => { const matches = ops.filter(o => o.kind === kind); check(matches.length === 1); return matches[0]; };
    const customerOp = one("customer"), productOp = one("product"), subOp = one("subscription");
    const product = sid(productOp.provider_id, "prod");
    check(customerOp.status === "complete" && customerOp.provider_id === customer && productOp.status === "complete" &&
      isDeepStrictEqual(customerOp.request, { method: "POST", path: "/v1/customers", params: { metadata: membershipMetadata(a, "customer") } }) &&
      isDeepStrictEqual(productOp.request, { method: "POST", path: "/v1/products", params: { name: a.terms.title.slice(0, 200), metadata: membershipMetadata(a, "product") } }) &&
      ["dispatched", "complete"].includes(subOp.status) && Number.isFinite(Date.parse(subOp.dispatched_at || "")) &&
      (subOp.status === "complete" ? subOp.provider_id === subscription : subOp.provider_id === null || subOp.provider_id === subscription) &&
      isDeepStrictEqual(subOp.request, { method: "POST", path: "/v1/subscriptions", params: buildMembershipSubscription(a, customer, product) }),
    "Initial closed operation ownership differs");
    const prior = await admin.from("monthly_mentorship_initial_closures_v1").select("id,agreement_id,kind,resource_id,request,status")
      .eq("agreement_id", a.id).limit(32);
    check(!prior.error && Array.isArray(prior.data) && prior.data.length <= 32);
    const stops = (prior.data as Closure[]).filter(o => o.kind === "cancel_subscription");
    check(stops.length === 1 && stops[0].agreement_id === a.id && stops[0].resource_id === subscription && stops[0].status === "complete" &&
      isDeepStrictEqual(stops[0].request, requestFor("cancel_subscription", subscription)), "Initial subscription closure is not complete");
    assertMembershipId(stops[0].id);
    await observeContext();
    const sub = await checked(stripe.subscriptions.retrieve(subscription));
    proof(a, sub, customer, subscription, sub.lastResponse.requestId); check(sub.status === "canceled");
    const fresh = await readSealedInitialProof(a, customer, subscription, checkout);
    // Compare every terminal resource, independent of list ordering; request IDs
    // differ on fresh reads. Missing, additional or changed resources require review.
    const normalized = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== "readRequestIds")
      .map(([k, v]) => [k, Array.isArray(v) ? [...v].sort((x, y) => String(x.id).localeCompare(String(y.id))) : v]));
    check(isDeepStrictEqual(normalized(saved), normalized(fresh)), "Initial sealed provider evidence changed");
    if (object.object === "invoice") check(fresh.invoices.some(i => i.id === object.id), "Initial invoice was not closed with this attempt");
    const current = await load(id, buyerId);
    check(current.covered_months === 0 && current.anchor_at === null && current.initial_abandoned_at === a.initial_abandoned_at &&
      isDeepStrictEqual(current.initial_abandon_proof, saved), "Initial closure changed during reconciliation");
    return { status: "abandoned" as const, membershipId: a.id };
  }
  return { abandonFirstCheckout, reconcileAbandonedCheckoutEvent };
}
