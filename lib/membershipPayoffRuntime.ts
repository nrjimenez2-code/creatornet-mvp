import "server-only";
import type Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import { membershipCheck as check, membershipStripeId as sid, assertMembershipHeld, MEMBERSHIP_STRIPE_VERSION, type MembershipRecord } from "./membershipCheckout";
import { assertMembershipId } from "./membershipAgreement";
import { assertMembershipActivated, readMembershipFirstProof } from "./membershipRenewal";
import { createMembershipExitRuntime, type MembershipExitQuote } from "./membershipExit";
import type { MembershipBillingDependencies } from "./membershipBillingRuntime";
import { buildMembershipPayoffTerms, membershipPayoffFingerprint, buildMembershipPayoffCheckout, assertMembershipPayoffSession,
  inspectMembershipPayoffCapture, membershipPayoffMetadata, readMembershipPayoff, MEMBERSHIP_PAYOFF_VERSION, type MembershipPayoffRecord } from "./membershipPayoff";
import { recordPaymentFeeLedger } from "./paymentFeeLedger";
import { reconcileKnownPaymentDispute } from "./paymentDisputes";
import { applyPaymentRefundState, reconcileKnownPaymentRefund, recordPaymentRefundState } from "./paymentRefunds";
export function membershipPayoffReconciliationReady(env: Record<string, string | undefined> = process.env) {
  return ["CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_SCHEMA_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_EXIT_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY"].every(key => env[key] === "true");
}
export function membershipPayoffCheckoutReady(env: Record<string, string | undefined> = process.env) {
  return membershipPayoffReconciliationReady(env) && ["CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_READY",
    "CREATOR_PURCHASE_CONSENT_SCHEMA_READY", "CREATOR_PURCHASE_POLICIES_READY", "CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED"].every(key => env[key] === "true");
}
export function createMembershipPayoffRuntime(d: MembershipBillingDependencies) {
  const { admin, stripe, context, env, checked, observeContext, load, productId } = d, exit = createMembershipExitRuntime(d);
  const reconcileReady = () => check(membershipPayoffReconciliationReady(env), "Payoff reconciliation is not enabled");
  const checkoutReady = () => check(membershipPayoffCheckoutReady(env), "Payoff checkout is not enabled");
  async function existing(a: MembershipRecord, payoffId?: string) {
    let query = admin.from("monthly_mentorship_payoffs_v1").select("*").eq("agreement_id", a.id).eq("buyer_id", a.buyer_id);
    if (payoffId) { assertMembershipId(payoffId); query = query.eq("id", payoffId); }
    else query = query.neq("status", "abandoned");
    const row = await query.maybeSingle(); check(!row.error);
    return row.data ? readMembershipPayoff(row.data, a) : null;
  }
  async function currentQuote(a: MembershipRecord) {
    const r = await admin.rpc("read_monthly_mentorship_exit_quote_v1", { p_id: a.id, p_buyer_id: a.buyer_id, p_context: context });
    check(!r.error && r.data?.membershipId === a.id); return r.data as MembershipExitQuote;
  }
  async function quotePayoff(id: string, buyerId: string) {
    reconcileReady(); const a = await load(id, buyerId), prior = await existing(a);
    if (prior) return { terms: prior.terms, fingerprint: prior.fingerprint, payoffId: prior.id, status: prior.status,
      checkoutEnabled: membershipPayoffCheckoutReady(env) };
    checkoutReady();
    const terms = buildMembershipPayoffTerms(a, await currentQuote(a));
    return { terms, fingerprint: membershipPayoffFingerprint(terms), payoffId: null, status: "quoted" as const, checkoutEnabled: true };
  }
  async function heldProvider(a: MembershipRecord) {
    await observeContext();
    const sub = await checked(stripe.subscriptions.retrieve(a.stripe_subscription_id!));
    check(sub.customer === a.stripe_customer_id && sub.id === a.stripe_subscription_id && sub.livemode === (context.mode === "live") &&
      sub.metadata.creatornet_membership_version === MEMBERSHIP_STRIPE_VERSION && sub.metadata.creatornet_membership_id === a.id &&
      sub.metadata.creatornet_membership_fingerprint === a.fingerprint, "Payoff subscription ownership differs");
    if (sub.status === "canceled") return;
    const product = await productId(a);
    if (sub.metadata.creatornet_membership_activation) {
      const r = await admin.from("monthly_mentorship_receipts_v1").select("provider_proof").eq("agreement_id", a.id).eq("month_number", 1).maybeSingle();
      check(!r.error && r.data); assertMembershipActivated(sub, a, product, readMembershipFirstProof(a, r.data.provider_proof));
    } else assertMembershipHeld(sub, a, a.stripe_customer_id!, product, true);
  }
  async function eligible(a: MembershipRecord, p: MembershipPayoffRecord) {
    const q = await currentQuote(a);
    check(q.reviewReasons.length === 0 && q.coveredMonths === p.terms.firstUnpaidMonth - 1 &&
      q.payoffAmountCents === p.terms.amountCents && q.minimumEnd === p.terms.periodEnd, "Payoff balance changed; do not pay an old quote");
    await heldProvider(a);
  }
  const completeUrl = (a: MembershipRecord, p: MembershipPayoffRecord) =>
    buildMembershipPayoffCheckout(a, p).success_url!;
  async function recoverCheckout(a: MembershipRecord, p: MembershipPayoffRecord) {
    if (p.stripe_checkout_session_id || !p.checkout_request || !p.checkout_dispatched_at) return p;
    check(isDeepStrictEqual(p.checkout_request, buildMembershipPayoffCheckout(a, p)), "Saved payoff creation request differs");
    await observeContext();
    const start = Math.floor(Date.parse(p.accepted_at) / 1000), end = Math.min(start + 23 * 3600, Math.floor(Date.now() / 1000));
    const list = await checked(stripe.checkout.sessions.list({ customer: a.stripe_customer_id!, created: { gte: start, lte: end }, limit: 100 }));
    check(list.has_more === false, "Payoff checkout discovery requires bounded review");
    const matches = list.data.filter(s => s.metadata?.creatornet_membership_payoff_id === p.id);
    if (matches.length === 0) return p; // Absence is not proof of an unpaid or nonexistent payment.
    check(matches.length === 1, "More than one provider checkout claims this payoff");
    const session = await checked(stripe.checkout.sessions.retrieve(matches[0].id)); assertMembershipPayoffSession(session, a, p, null);
    check(Number.isSafeInteger(session.created) && session.created >= start && session.created <= end, "Payoff checkout creation time differs");
    const bound = await admin.rpc("bind_monthly_mentorship_payoff_checkout_v1", { p_payoff_id: p.id, p_buyer_id: a.buyer_id,
      p_context: context, p_session_id: session.id, p_request_id: session.lastResponse.requestId });
    check(!bound.error && typeof bound.data === "boolean", "Recovered payoff checkout needs publication review");
    return readMembershipPayoff({ ...p, stripe_checkout_session_id: session.id, status: "checkout_ready" }, a);
  }
  async function acceptAndPreparePayoff(id: string, buyerId: string, consent: { accepted: boolean; version: string; fingerprint: string }) {
    checkoutReady(); check(consent?.accepted === true && consent.version === MEMBERSHIP_PAYOFF_VERSION, "Separate payoff confirmation required");
    const a = await load(id, buyerId), quote = await quotePayoff(id, buyerId);
    check(consent.fingerprint === quote.fingerprint, "Payoff quote changed; review again");
    const reserved = await admin.rpc("reserve_monthly_mentorship_payoff_v1", { p_id: a.id, p_buyer_id: a.buyer_id,
      p_context: context, p_terms: quote.terms, p_fingerprint: quote.fingerprint, p_accepted: true });
    check(!reserved.error && reserved.data, "Payoff reservation needs fresh review");
    let p = readMembershipPayoff(reserved.data, a);
    if (p.status === "captured") return { url: completeUrl(a, p), payoffId: p.id };
    check(p.status !== "abandoned", "Abandoned payoff requires new acceptance");
    await observeContext();
    if (!p.stripe_checkout_session_id && (p.status === "review_required" || p.checkout_dispatched_at &&
      Date.now() - Date.parse(p.checkout_dispatched_at) >= 20 * 3600000)) p = await recoverCheckout(a, p);
    if (p.stripe_checkout_session_id) {
      const saved = await checked(stripe.checkout.sessions.retrieve(p.stripe_checkout_session_id)); assertMembershipPayoffSession(saved, a, p, null);
      if (saved.status === "complete" && saved.payment_status === "paid") return { url: completeUrl(a, p), payoffId: p.id };
      assertMembershipPayoffSession(saved, a, p, false); await eligible(a, p);
      check(saved.url?.startsWith("https://checkout.stripe.com/")); return { url: saved.url, payoffId: p.id };
    }
    await eligible(a, p);
    const request = buildMembershipPayoffCheckout(a, p);
    const claimed = await admin.rpc("claim_monthly_mentorship_payoff_checkout_v1", { p_payoff_id: p.id, p_buyer_id: a.buyer_id, p_context: context, p_request: request });
    check(!claimed.error && claimed.data, "Payoff checkout admission needs review");
    p = readMembershipPayoff(claimed.data, a);
    check(p.status === "checkout_dispatched" && p.checkout_request && isDeepStrictEqual(p.checkout_request, request) &&
      p.checkout_dispatched_at && Date.now() - Date.parse(p.checkout_dispatched_at) < 20 * 3600000, "Payoff creation requires reconciliation, not a new identity");
    await observeContext();
    const session = await checked(stripe.checkout.sessions.create(p.checkout_request as Stripe.Checkout.SessionCreateParams,
      { idempotencyKey: `creatornet-membership-payoff:${p.id}`, maxNetworkRetries: 0 }));
    assertMembershipPayoffSession(session, a, p, false);
    const bound = await admin.rpc("bind_monthly_mentorship_payoff_checkout_v1", { p_payoff_id: p.id, p_buyer_id: a.buyer_id,
      p_context: context, p_session_id: session.id, p_request_id: session.lastResponse.requestId });
    check(!bound.error && typeof bound.data === "boolean", "Payoff session needs publication reconciliation");
    check(session.url?.startsWith("https://checkout.stripe.com/")); return { url: session.url, payoffId: p.id };
  }
  async function confirmPayoff(id: string, buyerId: string, payoffId: string) {
    reconcileReady(); const a = await load(id, buyerId); let p = await existing(a, payoffId);
    check(p && p.status !== "abandoned", "Owned current payoff not found");
    if (!p.stripe_checkout_session_id) p = await recoverCheckout(a, p);
    const pending = { membershipId: a.id, payoffId: p.id, payoffRecorded: false, accessGranted: false, paidThrough: null, providerStopped: false };
    if (!p.stripe_checkout_session_id) return pending;
    await observeContext();
    const session = await checked(stripe.checkout.sessions.retrieve(p.stripe_checkout_session_id)); assertMembershipPayoffSession(session, a, p, null);
    if (session.payment_status !== "paid" || session.status !== "complete") return pending;
    const pi = await checked(stripe.paymentIntents.retrieve(sid(session.payment_intent, "pi")));
    const charge = await checked(stripe.charges.retrieve(sid(pi.latest_charge, "ch")));
    const balance = await checked(stripe.balanceTransactions.retrieve(sid(charge.balance_transaction, "txn")));
    const inspected = inspectMembershipPayoffCapture(a, p, session, pi, charge, balance);
    await observeContext();
    const ledgerId = await recordPaymentFeeLedger(admin, { breakdown: p.terms.fees, currency: "usd", creatorId: a.creator_id,
      purchaseId: a.purchase_id, checkoutSessionId: session.id, paymentIntentId: pi.id, stripeFee: inspected.stripeFee }, true);
    check(ledgerId);
    if (charge.amount_refunded > 0) {
      const r = await recordPaymentRefundState(admin, { paymentIntentId: pi.id, chargeId: charge.id, chargeAmountCents: charge.amount, refundedAmountCents: charge.amount_refunded });
      await applyPaymentRefundState(admin, r);
    }
    await reconcileKnownPaymentRefund(admin, pi.id);
    await reconcileKnownPaymentDispute(admin, pi.id);
    if (charge.disputed) {
      const r = await admin.from("payment_fee_ledger").select("dispute_status").eq("id", ledgerId).maybeSingle();
      check(!r.error && ["won", "warning_closed"].includes(r.data?.dispute_status), "Payoff dispute needs reconciliation before credit");
    }
    const receipt = await admin.rpc("record_monthly_mentorship_payoff_v1", { p_payoff_id: p.id, p_buyer_id: a.buyer_id,
      p_context: context, p_ledger_id: ledgerId, p_proof: inspected.proof });
    check(!receipt.error && typeof receipt.data === "boolean", "Payoff receipt needs reconciliation");
    let providerStopped = false;
    try { providerStopped = (await exit.requestExit(a.id, a.buyer_id, "stop_renewal", true, null)).providerStopped; } catch { /* Durable stop request remains queued for review. */ }
    const access = await admin.rpc("read_monthly_mentorship_entitlement_v1", { p_purchase_id: a.purchase_id, p_buyer_id: a.buyer_id });
    const q = await currentQuote(a); check(!access.error && typeof access.data?.allowed === "boolean");
    return { membershipId: a.id, payoffId: p.id, payoffRecorded: true, accessGranted: access.data.allowed, paidThrough: q.paidThrough, providerStopped };
  }
  async function abandonPayoff(id: string, buyerId: string, payoffId: string, confirmed: boolean) {
    reconcileReady(); check(confirmed === true, "Explicit payoff abandonment confirmation required");
    const a = await load(id, buyerId); let p = await existing(a, payoffId); check(p, "Owned payoff not found");
    if (p.status === "captured") return { status: "already_paid" as const, ...(await confirmPayoff(id, buyerId, payoffId)) };
    if (p.status === "abandoned") return { status: "abandoned" as const, payoffId: p.id };
    if (!p.stripe_checkout_session_id) p = await recoverCheckout(a, p);
    let proof: Record<string, unknown> = { paymentContext: context, neverDispatched: true };
    if (p.checkout_request || p.checkout_dispatched_at || p.stripe_checkout_session_id) {
      check(p.stripe_checkout_session_id, "Unknown payoff checkout result requires reconciliation");
      await observeContext();
      let session = await checked(stripe.checkout.sessions.retrieve(p.stripe_checkout_session_id)); assertMembershipPayoffSession(session, a, p, null);
      if (session.payment_status === "paid") return { status: "already_paid" as const, ...(await confirmPayoff(id, buyerId, payoffId)) };
      if (session.status === "open") session = await checked(stripe.checkout.sessions.expire(session.id, {},
        { idempotencyKey: `creatornet-membership-payoff:${p.id}:expire`, maxNetworkRetries: 0 }));
      assertMembershipPayoffSession(session, a, p, null);
      check(session.status === "expired" && session.payment_status === "unpaid", "Payoff is not proven expired and unpaid");
      proof = { paymentContext: context, checkoutSessionId: session.id, sessionStatus: session.status, paymentStatus: session.payment_status,
        requestId: session.lastResponse.requestId, paymentIntentId: null };
      if (session.payment_intent) {
        let pi = await checked(stripe.paymentIntents.retrieve(sid(session.payment_intent, "pi")));
        check(pi.customer === a.stripe_customer_id && pi.livemode === (context.mode === "live") && pi.amount === p.terms.amountCents &&
          pi.currency === "usd" && pi.amount_received === 0 && isDeepStrictEqual(pi.metadata, membershipPayoffMetadata(a, p)),
        "Payoff has an uncertain or captured payment");
        if (pi.status !== "canceled") {
          check(["requires_payment_method", "requires_confirmation", "requires_action"].includes(pi.status), "Payoff payment is still in flight");
          pi = await checked(stripe.paymentIntents.cancel(pi.id, {}, { idempotencyKey: `creatornet-membership-payoff:${p.id}:cancel`, maxNetworkRetries: 0 }));
        }
        check(pi.status === "canceled" && pi.amount_received === 0); proof = { ...proof, paymentIntentId: pi.id, paymentIntentStatus: pi.status, amountReceived: 0 };
      }
      await observeContext();
    }
    const saved = await admin.rpc("abandon_monthly_mentorship_payoff_v1", { p_payoff_id: p.id, p_buyer_id: a.buyer_id, p_context: context, p_proof: proof });
    check(!saved.error && typeof saved.data === "boolean", "Payoff abandonment needs reconciliation");
    return { status: "abandoned" as const, payoffId: p.id, originalMonthlyPaymentsMayResume: !a.debit_revoked_at && !a.renewal_stopped_at };
  }
  return { quotePayoff, acceptAndPreparePayoff, confirmPayoff, abandonPayoff };
}
