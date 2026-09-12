export const REFUND_RESPONSIBILITIES = ["creator", "platform"] as const;
export type RefundResponsibility = (typeof REFUND_RESPONSIBILITIES)[number];

export const REFUND_REASON_OPTIONS = [
  {
    value: "creator_non_delivery",
    label: "Creator did not deliver",
    responsibility: "creator",
  },
  {
    value: "creator_missed_session",
    label: "Creator missed the session",
    responsibility: "creator",
  },
  {
    value: "material_misrepresentation",
    label: "Offer materially differed from its listing",
    responsibility: "creator",
  },
  {
    value: "creator_discretionary",
    label: "Creator approved a discretionary refund",
    responsibility: "creator",
  },
  {
    value: "duplicate_charge",
    label: "Duplicate charge",
    responsibility: "platform",
  },
  {
    value: "platform_technical_error",
    label: "CreatorNet technical error",
    responsibility: "platform",
  },
  {
    value: "incorrect_platform_billing",
    label: "Incorrect platform billing",
    responsibility: "platform",
  },
  {
    value: "platform_goodwill",
    label: "CreatorNet goodwill refund",
    responsibility: "platform",
  },
  {
    value: "legally_required",
    label: "Legally required refund",
    responsibility: "either",
  },
] as const;

export type RefundReasonCode = (typeof REFUND_REASON_OPTIONS)[number]["value"];

export interface RefundAllocationInput {
  grossAmountCents: number;
  platformFeeCents: number;
  processingFeeCents: number;
  creatorNetCents: number;
  refundedBeforeCents: number;
  applicationFeeRefundedBeforeCents: number;
  requestedRefundAmountCents: number;
  responsibility: RefundResponsibility;
}

export interface RefundAllocationPreview {
  customerRefundCents: number;
  refundedBeforeCents: number;
  cumulativeCustomerRefundTargetCents: number;
  remainingRefundableCents: number;
  creatorEarningsReversalCents: number;
  creatorBalanceImpactCents: number;
  platformFeeRefundCents: number;
  processingFeeAllocationCents: number;
  processingCostBearer: RefundResponsibility;
  allocationRoundingCents: number;
  applicationFeeRefundAmountCents: number;
  applicationFeeRefundTargetCents: number;
}

function requireSafeCents(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer number of cents`);
  }
}

/** Round a positive rational number half-up without floating-point arithmetic. */
function roundedShare(componentCents: number, cumulativeRefundCents: number, grossCents: number) {
  const numerator = BigInt(componentCents) * BigInt(cumulativeRefundCents);
  const denominator = BigInt(grossCents);
  const rounded = (numerator + denominator / 2n) / denominator;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) {
    throw new Error("Refund allocation exceeds JavaScript's safe integer range");
  }
  return result;
}

export function isRefundResponsibility(value: unknown): value is RefundResponsibility {
  return value === "creator" || value === "platform";
}

export function isRefundReasonCode(value: unknown): value is RefundReasonCode {
  return REFUND_REASON_OPTIONS.some((option) => option.value === value);
}

export function reasonMatchesResponsibility(
  reason: RefundReasonCode,
  responsibility: RefundResponsibility,
): boolean {
  const option = REFUND_REASON_OPTIONS.find((item) => item.value === reason);
  return option?.responsibility === "either" || option?.responsibility === responsibility;
}

/**
 * Produce the exact incremental allocation for one refund. Every component is
 * derived from cumulative targets, so many partial refunds finish at exactly
 * the same cent totals as one full refund. The current operation receives any
 * processing-cent increment; that makes mixed responsibility sequences add to
 * the immutable processing fee without independently rounding two buckets.
 */
export function calculateRefundAllocation(
  input: RefundAllocationInput,
): RefundAllocationPreview {
  requireSafeCents("grossAmountCents", input.grossAmountCents);
  requireSafeCents("platformFeeCents", input.platformFeeCents);
  requireSafeCents("processingFeeCents", input.processingFeeCents);
  requireSafeCents("creatorNetCents", input.creatorNetCents);
  requireSafeCents("refundedBeforeCents", input.refundedBeforeCents);
  requireSafeCents(
    "applicationFeeRefundedBeforeCents",
    input.applicationFeeRefundedBeforeCents,
  );
  requireSafeCents("requestedRefundAmountCents", input.requestedRefundAmountCents);

  if (input.grossAmountCents <= 0) throw new Error("Payment gross must be positive");
  if (input.requestedRefundAmountCents <= 0) throw new Error("Refund amount must be positive");
  if (
    input.platformFeeCents + input.processingFeeCents + input.creatorNetCents !==
    input.grossAmountCents
  ) {
    throw new Error("Immutable payment split does not equal the payment gross");
  }

  const cumulative = input.refundedBeforeCents + input.requestedRefundAmountCents;
  if (!Number.isSafeInteger(cumulative) || cumulative > input.grossAmountCents) {
    throw new Error("Refund exceeds the remaining refundable amount");
  }

  const independentIncrementalShare = (component: number) =>
    roundedShare(component, cumulative, input.grossAmountCents) -
    roundedShare(component, input.refundedBeforeCents, input.grossAmountCents);

  const totalFeeCents = input.platformFeeCents + input.processingFeeCents;
  const feeTarget = (refundedCents: number) =>
    roundedShare(totalFeeCents, refundedCents, input.grossAmountCents);
  const processingTarget = (refundedCents: number) => {
    const totalTarget = feeTarget(refundedCents);
    return totalFeeCents === 0
      ? 0
      : roundedShare(input.processingFeeCents, totalTarget, totalFeeCents);
  };
  const platformTarget = (refundedCents: number) =>
    feeTarget(refundedCents) - processingTarget(refundedCents);

  const platformFeeRefundCents =
    platformTarget(cumulative) - platformTarget(input.refundedBeforeCents);
  const processingFeeAllocationCents =
    processingTarget(cumulative) - processingTarget(input.refundedBeforeCents);
  const creatorEarningsReversalCents = independentIncrementalShare(
    input.creatorNetCents,
  );
  const allocationRoundingCents =
    input.requestedRefundAmountCents -
    platformFeeRefundCents -
    processingFeeAllocationCents -
    creatorEarningsReversalCents;

  if (allocationRoundingCents < -2 || allocationRoundingCents > 2) {
    throw new Error("Refund allocation rounding exceeded the supported boundary");
  }

  const applicationFeeRefundAmountCents =
    platformFeeRefundCents +
    (input.responsibility === "platform" ? processingFeeAllocationCents : 0);
  if (applicationFeeRefundAmountCents > input.requestedRefundAmountCents) {
    throw new Error("Application-fee refund exceeds the customer refund amount");
  }
  const applicationFeeRefundTargetCents =
    input.applicationFeeRefundedBeforeCents + applicationFeeRefundAmountCents;
  const totalApplicationFeeCents = input.platformFeeCents + input.processingFeeCents;
  if (applicationFeeRefundTargetCents > totalApplicationFeeCents) {
    throw new Error("Application-fee refund exceeds the amount originally collected");
  }

  return {
    customerRefundCents: input.requestedRefundAmountCents,
    refundedBeforeCents: input.refundedBeforeCents,
    cumulativeCustomerRefundTargetCents: cumulative,
    remainingRefundableCents: input.grossAmountCents - cumulative,
    creatorEarningsReversalCents,
    creatorBalanceImpactCents:
      input.requestedRefundAmountCents - applicationFeeRefundAmountCents,
    platformFeeRefundCents,
    processingFeeAllocationCents,
    processingCostBearer: input.responsibility,
    allocationRoundingCents,
    applicationFeeRefundAmountCents,
    applicationFeeRefundTargetCents,
  };
}
