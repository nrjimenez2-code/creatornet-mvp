import type Stripe from "stripe";
import { membershipFixture, membershipTestEnv } from "./membership-fixtures";
import { membershipMonthBoundary } from "@/lib/membershipAgreement";
import { buildMembershipPayoffTerms, membershipPayoffFingerprint, buildMembershipPayoffCheckout, type MembershipPayoffRecord } from "@/lib/membershipPayoff";
import type { MembershipExitQuote } from "@/lib/membershipExit";
export const payoffTestEnv = { ...membershipTestEnv, CREATOR_MONTHLY_MENTORSHIPS_EXIT_SCHEMA_READY: "true",
  CREATOR_MONTHLY_MENTORSHIPS_EXIT_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_READY: "true" };
export function membershipPayoffFixture(paid = true) {
  const base = membershipFixture(true), a = base.a, now = Math.floor(Date.now() / 1000);
  a.anchor_at = now - 30; a.covered_months = 1; a.revision = 2;
  const exitQuote: MembershipExitQuote = { version: "monthly-exit-quote-v1", membershipId: a.id, revision: a.revision, agreementFingerprint: a.fingerprint,
    monthlyPriceCents: a.monthly_price_cents, minimumMonths: a.minimum_months, minimumTotalCents: a.terms.minimumTotalCents,
    coveredMonths: 1, remainingMonths: 2, payoffAmountCents: 20000, paidThrough: membershipMonthBoundary(a.anchor_at, 1),
    minimumEnd: membershipMonthBoundary(a.anchor_at, 3), reviewReasons: [], renewalStopped: false, debitsRevoked: false, policyVersion: a.terms.policyVersion };
  const terms = buildMembershipPayoffTerms(a, exitQuote);
  const p: MembershipPayoffRecord = { id: "20000000-0000-4000-8000-000000000001", agreement_id: a.id, buyer_id: a.buyer_id,
    terms, fingerprint: membershipPayoffFingerprint(terms), accepted_at: new Date((now - 5) * 1000).toISOString(), status: "checkout_ready",
    checkout_request: null, checkout_dispatched_at: new Date((now - 4) * 1000).toISOString(), stripe_checkout_session_id: "cs_payofffixture",
    ledger_id: null, provider_proof: null };
  const params = buildMembershipPayoffCheckout(a, p); p.checkout_request = params as unknown as Record<string, unknown>;
  const session: Stripe.Checkout.Session = { ...base.session, id: p.stripe_checkout_session_id!, amount_total: 20000, amount_subtotal: 20000,
    created: now - 4,
    status: paid ? "complete" : "open", payment_status: paid ? "paid" : "unpaid", payment_intent: paid ? "pi_payofffixture" : null,
    expires_at: params.expires_at!, metadata: params.metadata as Stripe.Metadata, success_url: params.success_url!, cancel_url: params.cancel_url!,
    url: paid ? null : "https://checkout.stripe.com/c/pay/synthetic-payoff" };
  const pi: Stripe.PaymentIntent = { ...base.paymentIntent, id: "pi_payofffixture", amount: 20000, amount_received: paid ? 20000 : 0,
    payment_method_types: ["card"],
    setup_future_usage: null, application_fee_amount: terms.fees.totalCreatorDeductionCents, metadata: params.payment_intent_data!.metadata as Stripe.Metadata,
    status: paid ? "succeeded" : "requires_payment_method", latest_charge: paid ? "ch_payofffixture" : null };
  const charge: Stripe.Charge = { ...base.charge, id: "ch_payofffixture", payment_intent: pi.id, amount: 20000,
    amount_captured: 20000, application_fee_amount: terms.fees.totalCreatorDeductionCents, created: now };
  const balance: Stripe.BalanceTransaction = { ...base.balance, source: charge.id, amount: 20000, fee: 610, net: 19390 };
  return { ...base, a, p, exitQuote, params, session, pi, charge, balance };
}
