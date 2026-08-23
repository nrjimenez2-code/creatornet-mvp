// lib/money.ts — the one place the platform fee is defined and applied.
//
// Every route that touches money used to carry its own copy of
// `const PLATFORM_FEE_RATE = 0.12` and its own `Math.round(amount * RATE)`.
// Three copies of the rate and eight copies of the arithmetic is how the
// number drifts: one file rounds, another floors, a subscription gets 0.12%
// instead of 12%. Import from here instead.
//
// All amounts are integer cents. Stripe only accepts integer minor units, so
// the split is done once, here, with the same rounding Stripe sees.

export const PLATFORM_FEE_RATE = 0.12;

/** Whole-number percent, for Stripe `application_fee_percent` and metadata. */
export const PLATFORM_FEE_PERCENT = Math.round(PLATFORM_FEE_RATE * 100);

/** String form used in checkout/session metadata ("12"). */
export const PLATFORM_FEE_PERCENT_STR = String(PLATFORM_FEE_PERCENT);

export type FeeSplit = {
  /** What the buyer paid. */
  grossCents: number;
  /** Platform's cut, rounded to the nearest cent. This is what is passed to Stripe as application_fee_amount. */
  feeCents: number;
  /** What the creator receives: gross minus fee, never negative. */
  creatorCents: number;
};

/**
 * Split an amount into platform fee and creator payout.
 *
 * Rounds the fee to the nearest cent (matching what this code base has always
 * sent to Stripe, so existing orders reconcile unchanged) and derives the
 * creator amount as the remainder so the two parts always sum to the gross.
 * Non-finite or negative input is treated as zero.
 */
export function splitFee(amountCents: number): FeeSplit {
  const gross =
    Number.isFinite(amountCents) && amountCents > 0 ? Math.round(amountCents) : 0;
  const feeCents = Math.round(gross * PLATFORM_FEE_RATE);
  return { grossCents: gross, feeCents, creatorCents: Math.max(0, gross - feeCents) };
}

/** Convenience: just the fee in cents. */
export function platformFeeCents(amountCents: number): number {
  return splitFee(amountCents).feeCents;
}
