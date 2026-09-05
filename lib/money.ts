// lib/money.ts — the single source of truth for CreatorNet payment splits.
//
// All amounts are integer minor units (cents for USD). The 12% platform fee is
// intentionally independent from the optional creator-funded processing
// deduction: combining the two would make reporting and creator disclosures
// misleading even though Stripe receives one application_fee_amount.

export const PLATFORM_FEE_RATE = 0.12;
export const PLATFORM_FEE_BPS = 1_200;

/** Whole-number percent retained for Stripe's subscription fallback. */
export const PLATFORM_FEE_PERCENT = Math.round(PLATFORM_FEE_RATE * 100);

/** String form used in checkout/session metadata ("12"). */
export const PLATFORM_FEE_PERCENT_STR = String(PLATFORM_FEE_PERCENT);

export const LEGACY_FEE_SCHEDULE_VERSION = "platform-only-v1";

export type FeeSplit = {
  /** What the buyer paid. */
  grossCents: number;
  /** CreatorNet's 12% platform fee. */
  feeCents: number;
  /** Gross less only the platform fee (legacy behavior). */
  creatorCents: number;
};

export type ProcessingFeeSchedule = {
  enabled: boolean;
  /** Percentage component expressed as integer basis points. */
  basisPoints: number;
  /** Fixed component in the charge's minor currency unit. */
  fixedCents: number;
  /** Immutable identifier stored with each transaction for auditability. */
  version: string;
};

export type CreatorFeeBreakdown = {
  grossAmountCents: number;
  platformFeeCents: number;
  processingFeeCents: number;
  totalCreatorDeductionCents: number;
  creatorNetCents: number;
  processingFeeEnabled: boolean;
  /** Immutable percentage component used to create this split. */
  processingFeeBasisPoints: number;
  /** Immutable fixed minor-unit component used to create this split. */
  processingFeeFixedCents: number;
  feeScheduleVersion: string;
};

export class FeeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeeConfigurationError";
  }
}

export class FeeCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeeCalculationError";
  }
}

/**
 * Checkout subscriptions accept only a percentage (at most two decimals), not
 * an integer application_fee_amount. The first invoice can be paid before an
 * invoice.created handler runs. Configure its full deduction up front.
 *
 * Deliberately require an exact ratio: do not assume Stripe's fractional-cent
 * rounding or silently change the creator's agreed split. Unsupported amounts
 * need another plan length / full payment until a separate exact-amount
 * installment architecture is reviewed. Renewal drafts still use exact cents.
 * https://docs.stripe.com/api/checkout/sessions/create
 * https://docs.stripe.com/billing/subscriptions/webhooks
 */
export function exactSubscriptionApplicationFeePercent(
  fees: CreatorFeeBreakdown
): number {
  if (!fees.processingFeeEnabled) return PLATFORM_FEE_PERCENT;
  const gross = fees.grossAmountCents;
  const deduction = fees.totalCreatorDeductionCents;
  if (!Number.isSafeInteger(gross) || gross <= 0 ||
      !Number.isSafeInteger(deduction) || deduction < 0 || deduction > gross) {
    throw new FeeCalculationError("Invalid subscription fee amounts.");
  }
  const numerator = BigInt(deduction) * 10_000n;
  if (numerator % BigInt(gross) !== 0n) {
    throw new FeeCalculationError(
      "This installment amount cannot represent the exact creator deduction at Stripe's supported percentage precision."
    );
  }
  return Number(numerator / BigInt(gross)) / 100;
}

function normalizedGross(amountCents: number): number {
  return Number.isSafeInteger(amountCents) && amountCents > 0 ? amountCents : 0;
}

/** Round a nonnegative integer-cent basis-point calculation without floats. */
function roundedBasisPointAmount(amountCents: number, basisPoints: number): number {
  const rounded =
    (BigInt(amountCents) * BigInt(basisPoints) + 5_000n) / 10_000n;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) {
    throw new FeeCalculationError("Calculated fee exceeds the supported integer range.");
  }
  return result;
}

function parseUnsignedInteger(name: string, raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) {
    throw new FeeConfigurationError(`${name} must be a non-negative integer.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new FeeConfigurationError(`${name} is outside the supported integer range.`);
  }
  return parsed;
}

/**
 * Read the creator-funded processing schedule from server environment values.
 *
 * Only the literal value "true" enables the feature. When enabled, every
 * pricing input is required; this deliberately fails closed instead of
 * inventing a Stripe rate. Callers may inject an env-like object in tests.
 */
export function getProcessingFeeSchedule(
  env: Record<string, string | undefined> = process.env
): ProcessingFeeSchedule {
  if (env.CREATOR_PROCESSING_FEE_ENABLED !== "true") {
    return {
      enabled: false,
      basisPoints: 0,
      fixedCents: 0,
      version: LEGACY_FEE_SCHEDULE_VERSION,
    };
  }

  const basisPoints = parseUnsignedInteger(
    "STRIPE_PROCESSING_FEE_BPS",
    env.STRIPE_PROCESSING_FEE_BPS
  );
  const fixedCents = parseUnsignedInteger(
    "STRIPE_PROCESSING_FEE_FIXED_CENTS",
    env.STRIPE_PROCESSING_FEE_FIXED_CENTS
  );
  const version = (env.STRIPE_PROCESSING_FEE_SCHEDULE_VERSION || "").trim();

  if (!version) {
    throw new FeeConfigurationError(
      "STRIPE_PROCESSING_FEE_SCHEDULE_VERSION is required when creator-funded processing is enabled."
    );
  }
  if (basisPoints > 10_000) {
    throw new FeeConfigurationError("STRIPE_PROCESSING_FEE_BPS cannot exceed 10000.");
  }

  return { enabled: true, basisPoints, fixedCents, version };
}

/**
 * Stripe Billing is priced separately from the underlying card charge. Keep
 * the account's verified Billing percentage additive and immutable on each
 * installment subscription rather than charging one-time purchases for a
 * service they do not use.
 */
export function getSubscriptionProcessingFeeSchedule(
  env: Record<string, string | undefined> = process.env
): ProcessingFeeSchedule {
  const paymentSchedule = getProcessingFeeSchedule(env);
  if (!paymentSchedule.enabled) return paymentSchedule;

  const billingBasisPoints = parseUnsignedInteger(
    "STRIPE_BILLING_FEE_BPS",
    env.STRIPE_BILLING_FEE_BPS
  );
  if (billingBasisPoints > 10_000) {
    throw new FeeConfigurationError("STRIPE_BILLING_FEE_BPS cannot exceed 10000.");
  }

  const combinedBasisPoints = paymentSchedule.basisPoints + billingBasisPoints;
  if (combinedBasisPoints > 10_000) {
    throw new FeeConfigurationError(
      "Combined Stripe Payments and Billing basis points cannot exceed 10000."
    );
  }

  return {
    ...paymentSchedule,
    basisPoints: combinedBasisPoints,
    version: `${paymentSchedule.version}+billing-${billingBasisPoints}bps`,
  };
}

/** Legacy 12% split retained for historical rows and disabled rollout state. */
export function splitFee(amountCents: number): FeeSplit {
  const gross = normalizedGross(amountCents);
  const feeCents = roundedBasisPointAmount(gross, PLATFORM_FEE_BPS);
  return { grossCents: gross, feeCents, creatorCents: Math.max(0, gross - feeCents) };
}

/**
 * Calculate the complete creator payout from a server-controlled schedule.
 * Throws before checkout creation if configured deductions exceed the charge.
 */
export function calculateCreatorFees(
  amountCents: number,
  schedule: ProcessingFeeSchedule = getProcessingFeeSchedule()
): CreatorFeeBreakdown {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new FeeCalculationError("Gross amount must be a non-negative integer.");
  }
  if (
    !Number.isSafeInteger(schedule.basisPoints) ||
    schedule.basisPoints < 0 ||
    schedule.basisPoints > 10_000 ||
    !Number.isSafeInteger(schedule.fixedCents) ||
    schedule.fixedCents < 0 ||
    !schedule.version.trim()
  ) {
    throw new FeeCalculationError("Processing fee schedule is invalid.");
  }
  const grossAmountCents = normalizedGross(amountCents);
  const platformFeeCents = roundedBasisPointAmount(
    grossAmountCents,
    PLATFORM_FEE_BPS
  );
  // A zero-value invoice produces no payment and therefore no fixed processing
  // cost. This also prevents a legitimate credit-covered invoice from being
  // stuck in invoice.created retries.
  const variableProcessingFeeCents =
    schedule.enabled && grossAmountCents > 0
      ? roundedBasisPointAmount(grossAmountCents, schedule.basisPoints)
      : 0;
  const processingFeeBigInt =
    schedule.enabled && grossAmountCents > 0
      ? BigInt(variableProcessingFeeCents) + BigInt(schedule.fixedCents)
      : 0n;
  const totalCreatorDeductionBigInt =
    BigInt(platformFeeCents) + processingFeeBigInt;

  if (totalCreatorDeductionBigInt > BigInt(grossAmountCents)) {
    throw new FeeCalculationError(
      "Configured creator deductions exceed the transaction amount."
    );
  }
  const processingFeeCents = Number(processingFeeBigInt);
  const totalCreatorDeductionCents = Number(totalCreatorDeductionBigInt);

  return {
    grossAmountCents,
    platformFeeCents,
    processingFeeCents,
    totalCreatorDeductionCents,
    creatorNetCents: grossAmountCents - totalCreatorDeductionCents,
    processingFeeEnabled: schedule.enabled,
    processingFeeBasisPoints: schedule.enabled ? schedule.basisPoints : 0,
    processingFeeFixedCents: schedule.enabled ? schedule.fixedCents : 0,
    feeScheduleVersion: schedule.version,
  };
}

/** Metadata written to Stripe so later webhooks never recalculate using a new rate. */
export function creatorFeeMetadata(
  breakdown: CreatorFeeBreakdown
): Record<string, string> {
  return {
    fee_gross_cents: String(breakdown.grossAmountCents),
    platform_fee_cents: String(breakdown.platformFeeCents),
    processing_fee_cents: String(breakdown.processingFeeCents),
    total_creator_deduction_cents: String(breakdown.totalCreatorDeductionCents),
    creator_net_cents: String(breakdown.creatorNetCents),
    processing_fee_enabled: String(breakdown.processingFeeEnabled),
    processing_fee_bps: String(breakdown.processingFeeBasisPoints),
    processing_fee_fixed_cents: String(breakdown.processingFeeFixedCents),
    fee_schedule_version: breakdown.feeScheduleVersion,
  };
}

function metadataInteger(meta: Record<string, string> | null | undefined, key: string) {
  const raw = meta?.[key];
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Recover the immutable split attached when checkout was created. Older Stripe
 * objects have no fee metadata and intentionally fall back to the historical
 * 12% split, even if the processing feature is enabled today.
 */
export function creatorFeesFromMetadata(
  meta: Record<string, string> | null | undefined,
  grossAmountCents: number
): CreatorFeeBreakdown {
  const gross = normalizedGross(grossAmountCents);
  const metadataGross = metadataInteger(meta, "fee_gross_cents");
  const platform = metadataInteger(meta, "platform_fee_cents");
  const processing = metadataInteger(meta, "processing_fee_cents");
  const total = metadataInteger(meta, "total_creator_deduction_cents");
  const creator = metadataInteger(meta, "creator_net_cents");
  const basisPoints = metadataInteger(meta, "processing_fee_bps");
  const fixedCents = metadataInteger(meta, "processing_fee_fixed_cents");
  const processingEnabled = meta?.processing_fee_enabled === "true";
  const scheduleVersion = (meta?.fee_schedule_version || "").trim();
  const expectedPlatform = splitFee(gross).feeCents;
  const expectedProcessing =
    processingEnabled && gross > 0 && basisPoints !== null && fixedCents !== null
      ? roundedBasisPointAmount(gross, basisPoints) + fixedCents
      : 0;

  if (
    metadataGross === gross &&
    platform !== null &&
    processing !== null &&
    total !== null &&
    creator !== null &&
    (!processingEnabled || (basisPoints !== null && basisPoints <= 10_000)) &&
    (!processingEnabled || fixedCents !== null) &&
    (!processingEnabled || Boolean(scheduleVersion)) &&
    platform === expectedPlatform &&
    processing === expectedProcessing &&
    platform + processing === total &&
    total + creator === gross
  ) {
    return {
      grossAmountCents: gross,
      platformFeeCents: platform,
      processingFeeCents: processing,
      totalCreatorDeductionCents: total,
      creatorNetCents: creator,
      processingFeeEnabled: processingEnabled,
      processingFeeBasisPoints: processingEnabled ? basisPoints! : 0,
      processingFeeFixedCents: processingEnabled ? fixedCents! : 0,
      feeScheduleVersion: scheduleVersion || LEGACY_FEE_SCHEDULE_VERSION,
    };
  }

  // Metadata marked as creator-funded was written by CreatorNet itself. If it
  // is incomplete or inconsistent, silently substituting the legacy 12% split
  // would make the stored accounting disagree with Stripe's application fee.
  // Historical objects have no enabled marker and still use the fallback below.
  if (processingEnabled) {
    throw new FeeCalculationError(
      "Creator-funded processing metadata is incomplete or inconsistent."
    );
  }

  const legacy = splitFee(gross);
  return {
    grossAmountCents: gross,
    platformFeeCents: legacy.feeCents,
    processingFeeCents: 0,
    totalCreatorDeductionCents: legacy.feeCents,
    creatorNetCents: legacy.creatorCents,
    processingFeeEnabled: false,
    processingFeeBasisPoints: 0,
    processingFeeFixedCents: 0,
    feeScheduleVersion: LEGACY_FEE_SCHEDULE_VERSION,
  };
}

/**
 * Recalculate an installment invoice using the immutable schedule stored on
 * the subscription. The invoice gross can legitimately differ from the first
 * installment because of discounts, credits, or other invoice adjustments.
 */
export function calculateCreatorFeesFromMetadataSchedule(
  meta: Record<string, string> | null | undefined,
  grossAmountCents: number
): CreatorFeeBreakdown {
  if (meta?.processing_fee_enabled !== "true") {
    return calculateCreatorFees(grossAmountCents, {
      enabled: false,
      basisPoints: 0,
      fixedCents: 0,
      version: LEGACY_FEE_SCHEDULE_VERSION,
    });
  }

  const basisPoints = metadataInteger(meta, "processing_fee_bps");
  const fixedCents = metadataInteger(meta, "processing_fee_fixed_cents");
  const version = (meta?.fee_schedule_version || "").trim();
  if (
    basisPoints === null ||
    basisPoints > 10_000 ||
    fixedCents === null ||
    !version
  ) {
    throw new FeeCalculationError(
      "Creator-funded processing schedule metadata is incomplete or invalid."
    );
  }

  return calculateCreatorFees(grossAmountCents, {
    enabled: true,
    basisPoints,
    fixedCents,
    version,
  });
}

/** Convenience: just CreatorNet's 12% fee in cents. */
export function platformFeeCents(amountCents: number): number {
  return splitFee(amountCents).feeCents;
}
