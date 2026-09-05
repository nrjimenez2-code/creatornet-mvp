/**
 * The ONE "cleared to sell" predicate, as a pure function.
 *
 * Mirrors lib/creatorStripeConnect.ts#isCreatorSellReady exactly:
 *   profiles.stripe_account_id IS NOT NULL AND profiles.stripe_onboarding_complete = true
 *
 * Only the Stripe `account.updated` webhook and the Connect return route set
 * these columns (browsers cannot write them — migration 009), so a `true` here
 * means Stripe has confirmed the creator's identity and payout details.
 *
 * Server-safe and dependency-free: pages and routes read the two columns with
 * whatever client they already hold and feed the row through this function.
 * __tests__/verified-creator-badge.test.ts asserts parity with
 * isCreatorSellReady — change both or neither.
 */

/** Append to a `profiles` select to feed `isSellReadyProfile`. */
export const SELL_READY_COLUMNS = "stripe_account_id, stripe_onboarding_complete";

export type SellReadyProfileRow = {
  stripe_account_id?: string | null;
  stripe_onboarding_complete?: boolean | null;
};

export function isSellReadyProfile(profile: SellReadyProfileRow | null | undefined): boolean {
  return !!(profile?.stripe_account_id && profile.stripe_onboarding_complete);
}
