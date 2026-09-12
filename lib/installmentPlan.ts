import {
  calculateCreatorFees,
  type CreatorFeeBreakdown,
  type ProcessingFeeSchedule,
} from "./money";

/**
 * Pure planning only. No Stripe calls, environment reads or existing-plan edits.
 * This does not make Checkout subscription percentages support arbitrary cents.
 * Wire it into collection only after exact first/renewal invoice fees are proven.
 */
export const INSTALLMENT_PLAN_VERSION = "exact-cents-v1";

export type InstallmentPayment = Readonly<{
  number: number;
  amountCents: number;
  fees: CreatorFeeBreakdown;
}>;

export type InstallmentPlan = Readonly<{
  version: typeof INSTALLMENT_PLAN_VERSION;
  totalCents: number;
  paymentCount: number;
  regularAmountCents: number;
  finalAmountCents: number;
  payments: ReadonlyArray<InstallmentPayment>;
}>;

/**
 * Preserve the quoted purchase total exactly. All but the last payment use the
 * floor in integer cents; the final payment includes the remaining cents.
 * The full resulting schedule must be disclosed before buyer agreement.
 * Each payment uses the existing per-charge 12%/processing calculation, not a
 * separately rounded percentage or a buyer surcharge. The schedule is supplied
 * by trusted server configuration, never accepted directly from a buyer.
 * Retains the booking flow's existing 2–24 count and 50-cent minimum per charge.
 */
export function calculateInstallmentPlan(
  totalCents: number,
  paymentCount: number,
  feeSchedule: ProcessingFeeSchedule,
  firstPaymentFeeSchedule: ProcessingFeeSchedule = feeSchedule,
): InstallmentPlan {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
    throw new Error("Installment total must be a positive safe integer in cents.");
  }
  if (!Number.isInteger(paymentCount) || paymentCount < 2 || paymentCount > 24) {
    throw new Error("Installment count must be an integer between 2 and 24.");
  }

  const total = BigInt(totalCents);
  const count = BigInt(paymentCount);
  const regular = total / count;
  if (regular < 50n) {
    throw new Error("Each installment must be at least 50 cents.");
  }
  const final = regular + total % count;
  const payments = Array.from({ length: paymentCount }, (_, index) => {
    const amountCents = Number(index === paymentCount - 1 ? final : regular);
    return Object.freeze({
      number: index + 1,
      amountCents,
      // A future hosted one-time first payment must not silently include a
      // subscription Billing fee. Existing callers retain one schedule by default.
      fees: Object.freeze(calculateCreatorFees(
        amountCents, index === 0 ? firstPaymentFeeSchedule : feeSchedule,
      )),
    });
  });

  return Object.freeze({
    version: INSTALLMENT_PLAN_VERSION,
    totalCents,
    paymentCount,
    regularAmountCents: Number(regular),
    finalAmountCents: Number(final),
    payments: Object.freeze(payments),
  });
}
