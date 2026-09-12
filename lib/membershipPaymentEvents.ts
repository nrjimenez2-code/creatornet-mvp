import "server-only";
import { isSupportedStripeSnapshotVersion } from "./stripeSnapshotVersion";
import type Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import type { MembershipBillingDependencies } from "./membershipBillingRuntime";
import { membershipLifecycleReady } from "./membershipLifecycle";
import { assertMembershipSession, buildMembershipCheckout, membershipCheck as check, membershipStripeId as sid,
  type MembershipRecord } from "./membershipCheckout";
import { assertMembershipId } from "./membershipAgreement";
import { assertMembershipInvoice, readMembershipFirstProof } from "./membershipRenewal";
import { assertMembershipPayoffSession, membershipPayoffMetadata, readMembershipPayoff, type MembershipPayoffRecord } from "./membershipPayoff";
import { applyPaymentRefundState, reconcileKnownPaymentRefund, recordPaymentRefundState } from "./paymentRefunds";
import { applyPaymentDisputeState, reconcileKnownPaymentDispute, recordPaymentDisputeState } from "./paymentDisputes";
export function membershipPaymentEventsReady(env: Record<string, string | undefined> = process.env) {
  return membershipLifecycleReady(env) && ["CREATOR_MONTHLY_MENTORSHIPS_PAYMENT_EVENTS_SCHEMA_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_PAYMENT_EVENTS_READY"].every(key => env[key] === "true");
}
type Callbacks = {
  confirmFirst: (id: string, buyer: string) => Promise<{ firstPaymentRecorded: boolean }>;
  confirmPayoff: (id: string, buyer: string, payoff: string) => Promise<{ payoffRecorded: boolean }>;
  reconcileInvoice: (id: string, buyer: string, invoice: string) => Promise<{ status: string; month: number }>;
};
type Link = { kind: "first"; session: Stripe.Response<Stripe.Checkout.Session> } |
  { kind: "payoff"; session: Stripe.Response<Stripe.Checkout.Session>; payoff: MembershipPayoffRecord } |
  { kind: "renewal"; invoice: Stripe.Response<Stripe.Invoice>; month: number };
type Source = Stripe.Response<Stripe.PaymentIntent> | Stripe.Response<Stripe.Charge>;
type Outcome = "observed" | "checkout_attention" | "review_required" | "reconciled";
export function createMembershipPaymentEventRuntime(d: MembershipBillingDependencies, callbacks: Callbacks) {
  const { admin, stripe, context, env, checked, observeContext, load, productId } = d;
  function ownedPi(p: Stripe.PaymentIntent, a: MembershipRecord) {
    check(p.object === "payment_intent" && sid(p.id, "pi") && sid(p.customer, "cus") === a.stripe_customer_id &&
      p.livemode === (context.mode === "live") && Number.isSafeInteger(p.amount) && p.amount >= 0 && p.amount <= 99999999 &&
      Number.isSafeInteger(p.amount_received) && p.amount_received >= 0 && p.amount_received <= 99999999,
    "Monthly PaymentIntent owner or amount differs");
  }
  function ownedCharge(c: Stripe.Charge, a: MembershipRecord, piId: string) {
    check(c.object === "charge" && sid(c.id, "ch") && sid(c.payment_intent, "pi") === piId &&
      sid(c.customer, "cus") === a.stripe_customer_id && c.livemode === (context.mode === "live"), "Monthly charge owner differs");
  }
  async function record(a: MembershipRecord, event: Stripe.Event, source: Source, pi: Stripe.Response<Stripe.PaymentIntent>,
    link: Link | null, outcome: Outcome, reason: string) {
    await observeContext();
    const proof = { version: "monthly-payment-event-proof-v1", paymentContext: context, customerId: a.stripe_customer_id,
      subscriptionId: a.stripe_subscription_id, objectType: source.object, objectId: source.id, status: source.status,
      requestId: source.lastResponse.requestId, paymentRequestId: pi.lastResponse.requestId, paymentIntentId: pi.id,
      paymentStatus: pi.status, amountCents: pi.amount, amountReceivedCents: pi.amount_received,
      chargeId: pi.latest_charge == null ? null : sid(pi.latest_charge, "ch"), path: link?.kind ?? "unresolved",
      checkoutSessionId: link && link.kind !== "renewal" ? link.session.id : null,
      invoiceId: link?.kind === "renewal" ? link.invoice.id : null, month: link?.kind === "renewal" ? link.month : null,
      payoffId: link?.kind === "payoff" ? link.payoff.id : null, reason };
    const saved = await admin.rpc("record_monthly_mentorship_payment_event_v1", { p_id: a.id, p_buyer_id: a.buyer_id, p_context: context,
      p_event_id: event.id, p_event_type: event.type, p_outcome: outcome, p_proof: proof });
    check(!saved.error && saved.data?.agreement_id === a.id && saved.data.event_id === event.id, "Monthly payment observation needs retry");
  }
  async function relation(a: MembershipRecord, pi: Stripe.PaymentIntent, payoffHint: string | null): Promise<Link> {
    // Two bounded provider lookups prove which system owns this PaymentIntent.
    // A missing or ambiguous link is not permission to guess or create another.
    const sessions = await checked(stripe.checkout.sessions.list({ payment_intent: pi.id, limit: 100 }));
    const payments = await checked(stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: pi.id }, limit: 100 }));
    check(sessions.has_more === false && payments.has_more === false &&
      sessions.data.length + payments.data.length === 1, "Monthly payment link is unavailable or ambiguous");
    if (sessions.data.length === 1) {
      const s = await checked(stripe.checkout.sessions.retrieve(sid(sessions.data[0].id, "cs")));
      check(s.id === sessions.data[0].id && sid(s.payment_intent, "pi") === pi.id, "Checkout PaymentIntent link differs");
      if (s.id === a.stripe_checkout_session_id) {
        check(payoffHint == null, "First payment cannot be a payoff"); assertMembershipSession(s, a, null);
        return { kind: "first", session: s };
      }
      check(env.CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_SCHEMA_READY === "true");
      const row = await admin.from("monthly_mentorship_payoffs_v1").select("*").eq("agreement_id", a.id).eq("buyer_id", a.buyer_id)
        .eq("stripe_checkout_session_id", s.id).maybeSingle();
      check(!row.error && row.data, "Payment has no owned payoff Checkout");
      const p = readMembershipPayoff(row.data, a); check(payoffHint == null || payoffHint === p.id, "Payoff hint owner differs");
      assertMembershipPayoffSession(s, a, p, null); return { kind: "payoff", session: s, payoff: p };
    }
    check(payoffHint == null, "A renewal invoice cannot be a payoff");
    const payment = payments.data[0];
    check(payment.object === "invoice_payment" && payment.livemode === (context.mode === "live") &&
      payment.payment.type === "payment_intent" && sid(payment.payment.payment_intent, "pi") === pi.id &&
      payment.is_default === true && payment.currency === "usd" && payment.amount_requested === a.monthly_price_cents,
    "Monthly invoice-payment link differs");
    const inv = await checked(stripe.invoices.retrieve(sid(payment.invoice, "in")));
    check(inv.object === "invoice" && inv.id === sid(payment.invoice, "in") && sid(inv.customer, "cus") === a.stripe_customer_id &&
      sid(inv.parent?.subscription_details?.subscription, "sub") === a.stripe_subscription_id &&
      inv.livemode === (context.mode === "live"), "Monthly invoice owner differs");
    const row = await admin.from("monthly_mentorship_operations_v1").select("scope_key,request").eq("agreement_id", a.id)
      .eq("kind", "collect").eq("request->>path", `/v1/invoices/${inv.id}/pay`).maybeSingle();
    check(!row.error && row.data && /^[1-9][0-9]{0,8}$/.test(row.data.scope_key) && Number(row.data.scope_key) >= 2,
      "Monthly payment has no owned collection admission");
    return { kind: "renewal", invoice: inv, month: Number(row.data.scope_key) };
  }
  function expected(a: MembershipRecord, link: Link) {
    return link.kind === "payoff" ? { amount: link.payoff.terms.amountCents, fees: link.payoff.terms.fees } :
      { amount: a.monthly_price_cents, fees: link.kind === "first" ? a.terms.firstMonthFees : a.terms.recurringMonthFees };
  }
  async function contract(a: MembershipRecord, pi: Stripe.PaymentIntent, link: Link) {
    const { amount, fees } = expected(a, link);
    check(pi.amount === amount && pi.currency === "usd" && pi.application_fee_amount === fees.totalCreatorDeductionCents &&
      pi.transfer_data?.destination === a.terms.destinationId && pi.transfer_data.amount == null &&
      ["automatic", "automatic_async"].includes(pi.capture_method) && isDeepStrictEqual(pi.payment_method_types, ["card"]),
    "Monthly payment contract differs");
    if (link.kind === "first") check(pi.setup_future_usage === "off_session" && isDeepStrictEqual(pi.metadata,
      buildMembershipCheckout(a, a.stripe_customer_id!, a.stripe_subscription_id!).payment_intent_data!.metadata), "First payment consent differs");
    if (link.kind === "payoff") check(pi.setup_future_usage == null && isDeepStrictEqual(pi.metadata, membershipPayoffMetadata(a, link.payoff)),
      "Payoff payment consent differs");
    if (link.kind === "renewal" && ["draft", "open", "paid"].includes(link.invoice.status || "")) {
      const row = await admin.from("monthly_mentorship_receipts_v1").select("provider_proof").eq("agreement_id", a.id).eq("month_number", 1).maybeSingle();
      check(!row.error && row.data);
      assertMembershipInvoice(link.invoice, a, readMembershipFirstProof(a, row.data.provider_proof), link.month, await productId(a),
        link.invoice.status === "paid" ? "paid" : "held");
    }
  }
  async function disputes(a: MembershipRecord, event: Stripe.Event, pi: Stripe.PaymentIntent, c: Stripe.Charge) {
    if (c.disputed) {
      const list = await checked(stripe.disputes.list({ charge: c.id, payment_intent: pi.id, limit: 100 }));
      check(list.has_more === false && list.data.length === 1, "Monthly dispute needs unambiguous provider state");
      const dispute = await checked(stripe.disputes.retrieve(sid(list.data[0].id, "dp")));
      check(dispute.object === "dispute" && dispute.id === list.data[0].id && sid(dispute.charge, "ch") === c.id && sid(dispute.payment_intent, "pi") === pi.id &&
        dispute.livemode === (context.mode === "live") && dispute.currency === "usd" &&
        Number.isSafeInteger(dispute.amount) && dispute.amount > 0 && dispute.amount <= c.amount, "Monthly dispute owner differs");
      const state = { disputeId: dispute.id, paymentIntentId: pi.id, chargeId: c.id, disputedAmountCents: dispute.amount,
        currency: dispute.currency, status: dispute.status, eventCreated: event.created };
      if (await recordPaymentDisputeState(admin, state)) await applyPaymentDisputeState(admin, state);
      else await reconcileKnownPaymentDispute(admin, pi.id);
    }
    await reconcileKnownPaymentDispute(admin, pi.id);
    // Existing dispute policy is unchanged: this is audit/ledger status, not a new creator debit.
    check(a.terms.paymentContext.stripeAccountId === context.stripeAccountId);
  }
  async function captured(a: MembershipRecord, event: Stripe.Event, pi: Stripe.Response<Stripe.PaymentIntent>, link: Link) {
    check(pi.status === "succeeded" && pi.amount_received === pi.amount && pi.amount_capturable === 0, "Monthly capture is not complete");
    const chargeId = sid(pi.latest_charge, "ch"), c = await checked(stripe.charges.retrieve(chargeId));
    ownedCharge(c, a, pi.id); check(c.id === chargeId, "Monthly captured charge identity differs");
    const { amount, fees } = expected(a, link);
    check(c.status === "succeeded" && c.paid && c.captured && c.currency === "usd" && c.amount === amount && c.amount_captured === amount &&
      c.application_fee_amount === fees.totalCreatorDeductionCents && c.payment_method_details?.type === "card" &&
      sid(c.payment_method, "pm") === sid(pi.payment_method, "pm") &&
      Number.isSafeInteger(c.amount_refunded) && c.amount_refunded >= 0 && c.amount_refunded <= c.amount, "Monthly captured charge differs");
    await disputes(a, event, pi, c);
    if (link.kind === "first") check((await callbacks.confirmFirst(a.id, a.buyer_id)).firstPaymentRecorded, "First receipt is not yet recorded");
    else if (link.kind === "payoff") check((await callbacks.confirmPayoff(a.id, a.buyer_id, link.payoff.id)).payoffRecorded, "Payoff receipt is not yet recorded");
    else check(["recorded", "already_recorded"].includes((await callbacks.reconcileInvoice(a.id, a.buyer_id, link.invoice.id)).status),
      "Renewal receipt is not yet recorded");
    const query = link.kind === "payoff" ?
      admin.from("monthly_mentorship_payoffs_v1").select("ledger_id,provider_proof").eq("agreement_id", a.id).eq("id", link.payoff.id).eq("status", "captured") :
      admin.from("monthly_mentorship_receipts_v1").select("ledger_id,provider_proof").eq("agreement_id", a.id).eq("month_number", link.kind === "first" ? 1 : link.month);
    const receipt = await query.maybeSingle(), p = receipt.data?.provider_proof;
    check(!receipt.error && receipt.data?.ledger_id && p?.paymentIntentId === pi.id && p.chargeId === c.id &&
      p.capturedAmountCents === amount && p.applicationFeeAmountCents === fees.totalCreatorDeductionCents &&
      p.customerId === a.stripe_customer_id && p.subscriptionId === a.stripe_subscription_id && p.destinationId === a.terms.destinationId &&
      isDeepStrictEqual(p.paymentContext, context) &&
      (link.kind === "renewal" ? p.invoiceId === link.invoice.id : p.checkoutSessionId === link.session.id),
    "Payment event has no matching captured receipt");
    if (c.amount_refunded > 0) {
      const state = await recordPaymentRefundState(admin, { paymentIntentId: pi.id, chargeId: c.id,
        chargeAmountCents: c.amount, refundedAmountCents: c.amount_refunded });
      await applyPaymentRefundState(admin, state);
    }
    await reconcileKnownPaymentRefund(admin, pi.id); await reconcileKnownPaymentDispute(admin, pi.id);
  }
  async function reconcilePaymentEvent(id: string, buyerId: string, event: Stripe.Event, payoffHint: string | null = null) {
    check(membershipPaymentEventsReady(env), "Monthly payment events are not enabled");
    check(/^evt_[A-Za-z0-9_]+$/.test(event.id) && event.livemode === (context.mode === "live") && isSupportedStripeSnapshotVersion(event.api_version, context.apiVersion) &&
      Number.isSafeInteger(event.created) && event.created > 0 && event.created <= Math.floor(Date.now() / 1000) &&
      (event.account == null || event.account === context.stripeAccountId), "Monthly payment event context differs");
    check(event.type !== "charge.refunded" && !event.type.startsWith("charge.dispute."), "Use the existing refund/dispute event engine");
    if (payoffHint) assertMembershipId(payoffHint);
    const a = await load(id, buyerId); await observeContext(); const object = event.data.object;
    let source: Source, pi: Stripe.Response<Stripe.PaymentIntent>;
    if (event.type.startsWith("payment_intent.") && object.object === "payment_intent") {
      pi = await checked(stripe.paymentIntents.retrieve(sid(object.id, "pi")));
      check(pi.id === object.id, "Monthly PaymentIntent retrieval identity differs"); source = pi;
    } else {
      check(event.type.startsWith("charge.") && object.object === "charge", "Unsupported monthly payment event");
      const c = await checked(stripe.charges.retrieve(sid(object.id, "ch")));
      check(c.id === object.id, "Monthly charge retrieval identity differs");
      const piId = sid(c.payment_intent, "pi"); ownedCharge(c, a, piId);
      pi = await checked(stripe.paymentIntents.retrieve(piId));
      check(pi.id === piId, "Monthly charge PaymentIntent retrieval identity differs"); source = c;
    }
    ownedPi(pi, a);
    let link: Link;
    try { link = await relation(a, pi, payoffHint); }
    catch (error) { await record(a, event, source, pi, null, "review_required", "payment_link_requires_review"); throw error; }
    try { await contract(a, pi, link); }
    catch (error) { await record(a, event, source, pi, link, "review_required", "payment_contract_differs"); throw error; }
    if (pi.status === "succeeded") {
      await captured(a, event, pi, link);
      await record(a, event, source, pi, link, "reconciled", "captured_receipt_confirmed");
      return { status: "reconciled" as const, membershipId: a.id };
    }
    if (pi.amount_received !== 0 || pi.amount_capturable !== 0 || !["requires_payment_method", "requires_confirmation", "requires_action", "processing", "canceled"].includes(pi.status)) {
      await record(a, event, source, pi, link, "review_required", "unexpected_payment_state"); throw Error("Monthly payment needs review");
    }
    if (["payment_intent.succeeded", "charge.succeeded", "charge.captured"].includes(event.type)) {
      await record(a, event, source, pi, link, "observed", "capture_not_yet_confirmed"); throw Error("Monthly capture is not yet confirmed");
    }
    const recovery = ["payment_intent.payment_failed", "payment_intent.requires_action", "payment_intent.canceled", "charge.failed", "charge.expired"].includes(event.type) ||
      ["requires_action", "processing", "canceled"].includes(pi.status);
    if (link.kind === "renewal" && recovery) {
      const reviewed = await admin.rpc("review_monthly_mentorship_collection_v1", { p_id: a.id, p_month: link.month, p_context: context });
      check(!reviewed.error && typeof reviewed.data === "boolean", "Monthly payment recovery needs durable review");
      await record(a, event, source, pi, link, "review_required", "renewal_payment_needs_recovery");
    } else await record(a, event, source, pi, link, recovery ? "checkout_attention" : "observed", recovery ? "payment_needs_recovery" : "payment_not_captured");
    return { status: "payment_pending" as const, membershipId: a.id };
  }
  return { reconcilePaymentEvent };
}
