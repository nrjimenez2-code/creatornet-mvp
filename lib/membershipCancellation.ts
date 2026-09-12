import { readMonthlyMentorshipTerms, membershipCommitment } from "./membershipTerms";

/** #4 policy calculation only. This cannot authorize a payment, prove capture,
 * grant access, waive debt, cancel a provider subscription, or accept browser
 * counters as financial evidence. Application integration must supply owned,
 * receipt-backed state and revalidate it when a payoff is confirmed. */
export function planMembershipExit(input: {
  monthlyPriceCents: number;
  terms: unknown;
  paidMonths: number;
  paidThrough: string;
  minimumEndsAt: string;
  financialReviewRequired: boolean;
}) {
  const terms = readMonthlyMentorshipTerms(input.terms, "mentorship");
  if (!terms) throw Error("A monthly service contract is required");
  membershipCommitment(input.monthlyPriceCents, terms);
  if (!Number.isSafeInteger(input.paidMonths) || input.paidMonths < 1 || input.financialReviewRequired) {
    throw Error("Receipt-backed membership state needs review");
  }
  const paidThrough = Date.parse(input.paidThrough);
  const minimumEndsAt = Date.parse(input.minimumEndsAt);
  if (!Number.isFinite(paidThrough) || !Number.isFinite(minimumEndsAt)) throw Error("Invalid service period");
  const remainingMonths = Math.max(0, terms.minimumMonths - input.paidMonths);
  const payoffCents = remainingMonths * input.monthlyPriceCents;
  if (!Number.isSafeInteger(payoffCents) || (remainingMonths > 0 && minimumEndsAt <= paidThrough)) {
    throw Error("Inconsistent minimum commitment");
  }
  return Object.freeze({
    kind: payoffCents > 0 ? "buyer_confirmed_payoff" as const : "stop_renewal" as const,
    remainingMonths,
    payoffCents,
    accessEndsAt: new Date(Math.max(paidThrough, remainingMonths > 0 ? minimumEndsAt : paidThrough)).toISOString(),
    automaticPayoffAuthorized: false as const,
    receiptRequiredBeforePayoffCompletion: payoffCents > 0,
  });
}
