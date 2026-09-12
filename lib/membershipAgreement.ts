import { createHash } from "node:crypto";
import { calculateCreatorFees, getProcessingFeeSchedule, getSubscriptionProcessingFeeSchedule } from "./money";
import { describeMonthlyMentorship, membershipCommitment, readMonthlyMentorshipTerms } from "./membershipTerms";
import { PURCHASE_POLICY, PURCHASE_POLICY_VERSION } from "./purchasePolicies";

export const MEMBERSHIP_AGREEMENT_VERSION = "monthly-mentorship-purchase-v1";
export const MEMBERSHIP_PAYMENT_PROOF_VERSION = "monthly-mentorship-payment-proof-v1";
export type MembershipPaymentContext = Readonly<{
  stripeAccountId: string; mode: "test" | "live"; apiVersion: string; siteOrigin: string; supabaseProjectRef: string;
}>;
export type MembershipOffer = {
  id: string; creator_id: string; title: string; description?: string | null; type: string;
  price_cents: number; amount_cents: number; currency: string; membership_terms: unknown;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertMembershipId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !uuid.test(value)) throw Error("Invalid membership identity");
}
/** Construct only from authenticated identity, the stored offer and separately
 * observed/approved server context. This function does not accept consent or
 * authorize a provider operation. First-month Checkout is a captured payment;
 * held renewal invoices use the separately snapshotted Billing fee schedule. */
export function buildMembershipAgreement(args: {
  offer: MembershipOffer; buyerId: string; postId: string; destinationId: string; context: MembershipPaymentContext;
  env: Record<string, string | undefined>;
}) {
  const p = args.offer;
  [p.id, p.creator_id, args.buyerId, args.postId].forEach(assertMembershipId);
  const terms = readMonthlyMentorshipTerms(p.membership_terms, p.type);
  if (!terms || p.amount_cents !== p.price_cents || p.currency !== "usd" || !p.title.trim() || p.creator_id === args.buyerId ||
      !/^acct_[A-Za-z0-9]+$/.test(args.destinationId)) {
    throw Error("A consistent owned monthly service offer is required");
  }
  const commitment = membershipCommitment(p.price_cents, terms);
  // The agreed minimum must remain payable as one buyer-confirmed USD payoff.
  if (commitment.minimumTotalCents > 99999999) throw Error("Minimum commitment exceeds the supported single-payment amount");
  const c = args.context, origin = new URL(c.siteOrigin);
  if (!/^acct_[A-Za-z0-9]+$/.test(c.stripeAccountId) || !["test", "live"].includes(c.mode) ||
      c.apiVersion !== "2025-10-29.clover" || origin.protocol !== "https:" || origin.origin !== c.siteOrigin ||
      !/^[a-z0-9]{20}$/.test(c.supabaseProjectRef)) throw Error("Unapproved membership payment context");
  const agreement = Object.freeze({
    version: MEMBERSHIP_AGREEMENT_VERSION, kind: "monthly_mentorship" as const,
    buyerId: args.buyerId, creatorId: p.creator_id, productId: p.id, postId: args.postId,
    destinationId: args.destinationId,
    title: p.title, description: p.description || "", currency: "usd" as const,
    monthlyPriceCents: p.price_cents, minimumMonths: terms.minimumMonths, autoRenew: terms.autoRenew,
    minimumTotalCents: commitment.minimumTotalCents,
    billing: describeMonthlyMentorship(p.price_cents, terms),
    firstMonthFees: Object.freeze(calculateCreatorFees(p.price_cents, getProcessingFeeSchedule(args.env))),
    recurringMonthFees: Object.freeze(calculateCreatorFees(p.price_cents, getSubscriptionProcessingFeeSchedule(args.env))),
    paymentContext: Object.freeze({ ...c }), policyVersion: PURCHASE_POLICY_VERSION, policy: PURCHASE_POLICY,
  });
  return Object.freeze({ agreement, fingerprint: membershipAgreementFingerprint(agreement) });
}
export type MembershipAgreement = ReturnType<typeof buildMembershipAgreement>["agreement"];

/** JSONB key order is not acceptance identity. All values are supplied by the
 * owned agreement builder or its validated stored snapshot, never browser price. */
export function membershipAgreementFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) :
    item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key =>
      [key, canonical((item as Record<string, unknown>)[key])])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Same original-day UTC month anchoring as the existing installment helper,
 * but memberships do not end at installment number 24. Provider boundaries
 * must still be verified against these expected dates before receipt admission.
 * Stripe: https://docs.stripe.com/billing/subscriptions/billing-cycle */
export function membershipMonthBoundary(anchor: number, months: number): number {
  if (!Number.isSafeInteger(anchor) || anchor <= 0 || !Number.isSafeInteger(months) || months < 0) throw Error("Invalid membership period");
  const original = new Date(anchor * 1000), result = new Date(anchor * 1000);
  result.setUTCDate(1); result.setUTCMonth(result.getUTCMonth() + months);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(original.getUTCDate(), last));
  const seconds = Math.floor(result.getTime() / 1000);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || result.getUTCFullYear() > 9999) throw Error("Invalid membership period");
  return seconds;
}
