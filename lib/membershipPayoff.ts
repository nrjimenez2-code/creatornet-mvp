import "server-only";
import type Stripe from "stripe";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { calculateCreatorFees, creatorFeeMetadata } from "./money";
import { assertMembershipId, membershipMonthBoundary } from "./membershipAgreement";
import { membershipCheck as check, membershipMetadata, membershipStripeId as sid, type MembershipRecord } from "./membershipCheckout";
import type { MembershipExitQuote } from "./membershipExit";
export const MEMBERSHIP_PAYOFF_VERSION = "monthly-mentorship-payoff-v1";
export const MEMBERSHIP_PAYOFF_PROOF_VERSION = "monthly-mentorship-payoff-proof-v1";
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v)]));
  return value;
}
export const membershipPayoffFingerprint = (terms: unknown) => createHash("sha256").update(JSON.stringify(stable(terms))).digest("hex");
export function buildMembershipPayoffTerms(a: MembershipRecord, q: MembershipExitQuote) {
  const remaining = a.minimum_months - a.covered_months, amount = remaining * a.monthly_price_cents;
  check(a.anchor_at != null && a.covered_months >= 1 && remaining >= 1 && q.version === "monthly-exit-quote-v1" &&
    q.membershipId === a.id && q.revision === a.revision && q.agreementFingerprint === a.fingerprint &&
    q.coveredMonths === a.covered_months && q.remainingMonths === remaining && q.payoffAmountCents === amount &&
    q.monthlyPriceCents === a.monthly_price_cents && q.minimumMonths === a.minimum_months && q.reviewReasons.length === 0 &&
    q.minimumEnd === membershipMonthBoundary(a.anchor_at, a.minimum_months) &&
    q.paidThrough === membershipMonthBoundary(a.anchor_at, a.covered_months) &&
    q.minimumEnd > Math.floor(Date.now() / 1000), "Payoff needs a current, settled, unpaid minimum");
  const schedule = a.terms.firstMonthFees;
  return { version: MEMBERSHIP_PAYOFF_VERSION, membershipId: a.id, agreementFingerprint: a.fingerprint,
    buyerId: a.buyer_id, creatorId: a.creator_id, purchaseId: a.purchase_id, productId: a.product_id, postId: a.post_id,
    title: a.terms.title, destinationId: a.terms.destinationId, currency: "usd" as const,
    amountCents: amount, remainingMonths: remaining, firstUnpaidMonth: a.covered_months + 1,
    periodStart: q.paidThrough, periodEnd: q.minimumEnd, exitQuote: q,
    fees: calculateCreatorFees(amount, { enabled: schedule.processingFeeEnabled, basisPoints: schedule.processingFeeBasisPoints,
      fixedCents: schedule.processingFeeFixedCents, version: schedule.feeScheduleVersion }),
    paymentContext: a.terms.paymentContext, policyVersion: a.terms.policyVersion, policy: a.terms.policy,
    renewalsStopAfterPayoff: true, paidAccessAndSupportThroughMinimum: true, refundRightsPreserved: true };
}
export type MembershipPayoffTerms = ReturnType<typeof buildMembershipPayoffTerms>;
export type MembershipPayoffRecord = {
  id: string; agreement_id: string; buyer_id: string; terms: MembershipPayoffTerms; fingerprint: string;
  accepted_at: string; status: "accepted" | "checkout_dispatched" | "checkout_ready" | "review_required" | "captured" | "abandoned";
  checkout_request: Record<string, unknown> | null; checkout_dispatched_at: string | null; stripe_checkout_session_id: string | null;
  ledger_id: string | null; provider_proof: Record<string, unknown> | null;
};
export function readMembershipPayoff(value: unknown, a: MembershipRecord): MembershipPayoffRecord {
  const p = value as MembershipPayoffRecord, t = p?.terms; assertMembershipId(p?.id);
  const schedule = a.terms.firstMonthFees;
  check(p.agreement_id === a.id && p.buyer_id === a.buyer_id && t?.version === MEMBERSHIP_PAYOFF_VERSION &&
    t.membershipId === a.id && t.agreementFingerprint === a.fingerprint && t.purchaseId === a.purchase_id &&
    t.buyerId === a.buyer_id && t.creatorId === a.creator_id && t.productId === a.product_id && t.postId === a.post_id &&
    t.destinationId === a.terms.destinationId && t.currency === "usd" && a.anchor_at != null &&
    Number.isInteger(t.firstUnpaidMonth) && t.firstUnpaidMonth >= 2 && t.firstUnpaidMonth <= a.minimum_months &&
    t.remainingMonths === a.minimum_months - t.firstUnpaidMonth + 1 && t.amountCents === t.remainingMonths * a.monthly_price_cents &&
    t.periodStart === membershipMonthBoundary(a.anchor_at, t.firstUnpaidMonth - 1) &&
    t.periodEnd === membershipMonthBoundary(a.anchor_at, a.minimum_months) && t.policyVersion === a.terms.policyVersion &&
    isDeepStrictEqual(t.policy, a.terms.policy) && isDeepStrictEqual(t.paymentContext, a.terms.paymentContext) &&
    isDeepStrictEqual(t.fees, calculateCreatorFees(t.amountCents, { enabled: schedule.processingFeeEnabled, basisPoints: schedule.processingFeeBasisPoints,
      fixedCents: schedule.processingFeeFixedCents, version: schedule.feeScheduleVersion })) &&
    t.renewalsStopAfterPayoff === true && t.paidAccessAndSupportThroughMinimum === true && t.refundRightsPreserved === true &&
    p.fingerprint === membershipPayoffFingerprint(t) && Number.isFinite(Date.parse(p.accepted_at)), "Saved payoff terms differ");
  return p;
}
export function membershipPayoffMetadata(a: MembershipRecord, p: MembershipPayoffRecord) {
  return { ...membershipMetadata(a, "payoff"), creatornet_membership_payoff_id: p.id,
    creatornet_membership_payoff_fingerprint: p.fingerprint, ...creatorFeeMetadata(p.terms.fees) };
}
export function buildMembershipPayoffCheckout(a: MembershipRecord, p: MembershipPayoffRecord): Stripe.Checkout.SessionCreateParams {
  const t = p.terms, metadata = membershipPayoffMetadata(a, p);
  const disclosure = `One payment of $${(t.amountCents / 100).toFixed(2)} settles the remaining ${t.remainingMonths} month(s) of your agreed minimum. ` +
    "Future membership renewal stops. Paid access and mentor support continue through the agreed minimum end. Refund rights are preserved.";
  return { mode: "payment", customer: a.stripe_customer_id!, payment_method_types: ["card"], adaptive_pricing: { enabled: false },
    automatic_tax: { enabled: false }, allow_promotion_codes: false, invoice_creation: { enabled: false },
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: t.amountCents,
      product_data: { name: ("Minimum-term payoff: " + t.title).slice(0, 200), description: disclosure } } }],
    payment_intent_data: { application_fee_amount: t.fees.totalCreatorDeductionCents, transfer_data: { destination: t.destinationId }, metadata },
    custom_text: { submit: { message: disclosure + " This is your separately confirmed one-time payoff, not another monthly payment." } },
    expires_at: Math.floor(Date.parse(p.accepted_at) / 1000) + 23 * 3600, metadata,
    success_url: `${t.paymentContext.siteOrigin}/memberships/payoff?membership_id=${a.id}&payoff_id=${p.id}&confirm=1`,
    cancel_url: `${t.paymentContext.siteOrigin}/memberships/payoff?membership_id=${a.id}&payoff_id=${p.id}` };
}
export function assertMembershipPayoffSession(s: Stripe.Checkout.Session, a: MembershipRecord, p: MembershipPayoffRecord, paid: boolean | null) {
  const expected = buildMembershipPayoffCheckout(a, p); sid(s.id, "cs");
  check(s.object === "checkout.session" && s.livemode === (a.terms.paymentContext.mode === "live") && s.mode === "payment" &&
    s.customer === a.stripe_customer_id && s.currency === "usd" && s.amount_total === p.terms.amountCents && s.amount_subtotal === p.terms.amountCents &&
    s.automatic_tax.enabled === false && s.total_details?.amount_discount === 0 && s.total_details.amount_tax === 0 && s.total_details.amount_shipping === 0 &&
    s.invoice_creation?.enabled === false && s.subscription === null && s.setup_intent === null &&
    s.success_url === expected.success_url && s.cancel_url === expected.cancel_url && s.expires_at === expected.expires_at &&
    isDeepStrictEqual(s.metadata, expected.metadata) && isDeepStrictEqual(s.payment_method_types, ["card"]) &&
    (!p.stripe_checkout_session_id || p.stripe_checkout_session_id === s.id) &&
    (paid === null || (paid ? s.status === "complete" && s.payment_status === "paid" : s.status === "open" && s.payment_status === "unpaid")),
  "Payoff checkout ownership or amount differs");
}
export function inspectMembershipPayoffCapture(a: MembershipRecord, p: MembershipPayoffRecord, s: Stripe.Checkout.Session,
  pi: Stripe.PaymentIntent, c: Stripe.Charge, b: Stripe.BalanceTransaction) {
  assertMembershipPayoffSession(s, a, p, true);
  const live = a.terms.paymentContext.mode === "live", fees = p.terms.fees, method = sid(pi.payment_method, "pm");
  check(pi.object === "payment_intent" && pi.id === sid(s.payment_intent, "pi") && pi.livemode === live && pi.status === "succeeded" &&
    pi.customer === a.stripe_customer_id && pi.currency === "usd" && pi.amount === p.terms.amountCents && pi.amount_received === pi.amount &&
    pi.amount_capturable === 0 && ["automatic", "automatic_async"].includes(pi.capture_method) && pi.setup_future_usage == null &&
    pi.application_fee_amount === fees.totalCreatorDeductionCents && pi.transfer_data?.destination === p.terms.destinationId &&
    pi.transfer_data.amount == null && isDeepStrictEqual(pi.metadata, membershipPayoffMetadata(a, p)) &&
    isDeepStrictEqual(pi.payment_method_types, ["card"]), "Payoff payment evidence differs");
  check(c.object === "charge" && c.id === sid(pi.latest_charge, "ch") && c.payment_intent === pi.id && c.livemode === live &&
    c.customer === a.stripe_customer_id && c.status === "succeeded" && c.paid && c.captured && c.currency === "usd" &&
    c.amount === p.terms.amountCents && c.amount_captured === c.amount && c.application_fee_amount === fees.totalCreatorDeductionCents &&
    c.payment_method === method && c.payment_method_details?.type === "card" && Number.isSafeInteger(c.created) &&
    c.created >= Math.floor(Date.parse(p.accepted_at) / 1000) && c.created <= Math.floor(Date.now() / 1000) &&
    Number.isSafeInteger(c.amount_refunded) && c.amount_refunded >= 0 && c.amount_refunded <= c.amount && typeof c.disputed === "boolean",
  "Payoff captured charge differs");
  check(b.object === "balance_transaction" && b.id === sid(c.balance_transaction, "txn") && b.source === c.id && b.type === "charge" &&
    b.currency === "usd" && b.amount === c.amount && Number.isSafeInteger(b.fee) && b.fee >= 0 && b.fee <= c.amount && b.net === b.amount - b.fee);
  return { stripeFee: { chargeId: c.id, balanceTransactionId: b.id, actualStripeFeeCents: b.fee, applicationFeeAmountCents: c.application_fee_amount },
    proof: { version: MEMBERSHIP_PAYOFF_PROOF_VERSION, paymentContext: a.terms.paymentContext, payoffId: p.id,
      payoffFingerprint: p.fingerprint, customerId: a.stripe_customer_id, subscriptionId: a.stripe_subscription_id,
      checkoutSessionId: s.id, destinationId: p.terms.destinationId, paymentIntentId: pi.id, chargeId: c.id,
      capturedAmountCents: c.amount, applicationFeeAmountCents: c.application_fee_amount, paymentStatus: "succeeded",
      paymentMethodId: method, paidAt: c.created, periodStart: p.terms.periodStart, periodEnd: p.terms.periodEnd } };
}
