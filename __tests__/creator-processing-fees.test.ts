import {
  FeeCalculationError,
  FeeConfigurationError,
  LEGACY_FEE_SCHEDULE_VERSION,
  calculateCreatorFees,
  calculateCreatorFeesFromMetadataSchedule,
  creatorFeeMetadata,
  creatorFeesFromMetadata,
  exactSubscriptionApplicationFeePercent,
  getProcessingFeeSchedule,
  getSubscriptionProcessingFeeSchedule,
  type ProcessingFeeSchedule,
} from "@/lib/money";
import { readFileSync } from "node:fs";
import path from "node:path";

const TEST_SCHEDULE: ProcessingFeeSchedule = {
  enabled: true,
  basisPoints: 290,
  fixedCents: 30,
  version: "test-us-card-v1",
};

describe("creator-funded processing configuration", () => {
  test("is disabled by default and preserves the legacy schedule", () => {
    expect(getProcessingFeeSchedule({})).toEqual({
      enabled: false,
      basisPoints: 0,
      fixedCents: 0,
      version: LEGACY_FEE_SCHEDULE_VERSION,
    });
  });

  test("only the literal value true enables creator-funded processing", () => {
    expect(
      getProcessingFeeSchedule({
        CREATOR_PROCESSING_FEE_ENABLED: "TRUE",
        STRIPE_PROCESSING_FEE_BPS: "290",
        STRIPE_PROCESSING_FEE_FIXED_CENTS: "30",
        STRIPE_PROCESSING_FEE_SCHEDULE_VERSION: "ignored",
      }).enabled,
    ).toBe(false);
  });

  test("reads an explicitly configured integer schedule", () => {
    expect(
      getProcessingFeeSchedule({
        CREATOR_PROCESSING_FEE_ENABLED: "true",
        STRIPE_PROCESSING_FEE_BPS: "290",
        STRIPE_PROCESSING_FEE_FIXED_CENTS: "30",
        STRIPE_PROCESSING_FEE_SCHEDULE_VERSION: "test-us-card-v1",
      }),
    ).toEqual(TEST_SCHEDULE);
  });

  test("adds the verified Stripe Billing percentage only to subscription charges", () => {
    const env = {
      CREATOR_PROCESSING_FEE_ENABLED: "true",
      STRIPE_PROCESSING_FEE_BPS: "290",
      STRIPE_PROCESSING_FEE_FIXED_CENTS: "30",
      STRIPE_PROCESSING_FEE_SCHEDULE_VERSION: "test-us-card-v1",
      STRIPE_BILLING_FEE_BPS: "70",
    };

    expect(getProcessingFeeSchedule(env)).toEqual(TEST_SCHEDULE);
    expect(getSubscriptionProcessingFeeSchedule(env)).toEqual({
      enabled: true,
      basisPoints: 360,
      fixedCents: 30,
      version: "test-us-card-v1+billing-70bps",
    });
  });

  test("fails closed when enabled subscription pricing omits Stripe Billing", () => {
    expect(() =>
      getSubscriptionProcessingFeeSchedule({
        CREATOR_PROCESSING_FEE_ENABLED: "true",
        STRIPE_PROCESSING_FEE_BPS: "290",
        STRIPE_PROCESSING_FEE_FIXED_CENTS: "30",
        STRIPE_PROCESSING_FEE_SCHEDULE_VERSION: "test-us-card-v1",
      })
    ).toThrow("STRIPE_BILLING_FEE_BPS");
  });

  test.each<[Record<string, string>, string]>([
    [{ CREATOR_PROCESSING_FEE_ENABLED: "true" }, "STRIPE_PROCESSING_FEE_BPS"],
    [
      {
        CREATOR_PROCESSING_FEE_ENABLED: "true",
        STRIPE_PROCESSING_FEE_BPS: "290",
      },
      "STRIPE_PROCESSING_FEE_FIXED_CENTS",
    ],
    [
      {
        CREATOR_PROCESSING_FEE_ENABLED: "true",
        STRIPE_PROCESSING_FEE_BPS: "290",
        STRIPE_PROCESSING_FEE_FIXED_CENTS: "30",
      },
      "STRIPE_PROCESSING_FEE_SCHEDULE_VERSION",
    ],
  ])("fails closed when enabled configuration is incomplete", (env, missingName) => {
    expect(() => getProcessingFeeSchedule(env)).toThrow(FeeConfigurationError);
    expect(() => getProcessingFeeSchedule(env)).toThrow(missingName);
  });

  test.each<[string, string]>([
    ["-1", "30"],
    ["2.9", "30"],
    ["290", "0.30"],
    ["10001", "0"],
  ])("rejects invalid integer pricing (%s bps + %s cents)", (basisPoints, fixedCents) => {
    expect(() =>
      getProcessingFeeSchedule({
        CREATOR_PROCESSING_FEE_ENABLED: "true",
        STRIPE_PROCESSING_FEE_BPS: basisPoints,
        STRIPE_PROCESSING_FEE_FIXED_CENTS: fixedCents,
        STRIPE_PROCESSING_FEE_SCHEDULE_VERSION: "test-v1",
      }),
    ).toThrow(FeeConfigurationError);
  });
});

describe("creator-funded processing arithmetic", () => {
  test.each([50, 1_000, 4_000, 5_000, 50_000, 100_000])("represents an exact initial subscription deduction for %i cents", (gross) => {
    const fees = calculateCreatorFees(gross, { ...TEST_SCHEDULE, basisPoints: 360 });
    const percent = exactSubscriptionApplicationFeePercent(fees);
    const basisPoints = Math.round(percent * 100);
    expect(BigInt(gross) * BigInt(basisPoints)).toBe(BigInt(fees.totalCreatorDeductionCents) * 10_000n);
    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThanOrEqual(100);
  });

  test("does not round an unsupported fee ratio or use binary-float approximations", () => {
    const fees = calculateCreatorFees(33_300, { ...TEST_SCHEDULE, basisPoints: 360 });
    expect(() => exactSubscriptionApplicationFeePercent(fees)).toThrow("supported percentage precision");
  });

  test("preserves the explicitly disabled legacy subscription percentage", () => {
    const fees = calculateCreatorFees(3_333, getProcessingFeeSchedule({}));
    expect(exactSubscriptionApplicationFeePercent(fees)).toBe(12);
  });

  test("keeps CreatorNet's 12% separate from the configured processing deduction", () => {
    expect(calculateCreatorFees(10_000, TEST_SCHEDULE)).toEqual({
      grossAmountCents: 10_000,
      platformFeeCents: 1_200,
      processingFeeCents: 320,
      totalCreatorDeductionCents: 1_520,
      creatorNetCents: 8_480,
      processingFeeEnabled: true,
      processingFeeBasisPoints: 290,
      processingFeeFixedCents: 30,
      feeScheduleVersion: "test-us-card-v1",
    });
  });

  test("disabled rollout retains the historical 12%-only split", () => {
    expect(
      calculateCreatorFees(10_000, {
        enabled: false,
        basisPoints: 0,
        fixedCents: 0,
        version: LEGACY_FEE_SCHEDULE_VERSION,
      }),
    ).toEqual({
      grossAmountCents: 10_000,
      platformFeeCents: 1_200,
      processingFeeCents: 0,
      totalCreatorDeductionCents: 1_200,
      creatorNetCents: 8_800,
      processingFeeEnabled: false,
      processingFeeBasisPoints: 0,
      processingFeeFixedCents: 0,
      feeScheduleVersion: LEGACY_FEE_SCHEDULE_VERSION,
    });
  });

  test.each<[number, number, number, number]>([
    [50, 6, 31, 13],
    [99, 12, 33, 54],
    [101, 12, 33, 56],
    [333, 40, 40, 253],
    [652_300, 78_276, 18_947, 555_077],
  ])(
    "rounds %i cents deterministically",
    (grossAmountCents, platformFeeCents, processingFeeCents, creatorNetCents) => {
      const result = calculateCreatorFees(grossAmountCents, TEST_SCHEDULE);
      expect(result).toMatchObject({
        grossAmountCents,
        platformFeeCents,
        processingFeeCents,
        creatorNetCents,
      });
      expect(result.totalCreatorDeductionCents + result.creatorNetCents).toBe(
        grossAmountCents,
      );
    },
  );

  test("rejects a small charge when configured deductions would consume more than gross", () => {
    expect(() => calculateCreatorFees(30, TEST_SCHEDULE)).toThrow(FeeCalculationError);
    expect(() => calculateCreatorFees(30, TEST_SCHEDULE)).toThrow(
      "Configured creator deductions exceed the transaction amount.",
    );
  });

  test("a zero-value invoice has no fixed processing deduction", () => {
    expect(calculateCreatorFees(0, TEST_SCHEDULE)).toMatchObject({
      grossAmountCents: 0,
      platformFeeCents: 0,
      processingFeeCents: 0,
      totalCreatorDeductionCents: 0,
      creatorNetCents: 0,
    });
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid integer gross %s",
    (gross) => {
      expect(() => calculateCreatorFees(gross, TEST_SCHEDULE)).toThrow(
        "Gross amount must be a non-negative integer.",
      );
    },
  );

  test("rejects an invalid injected schedule as well as invalid environment config", () => {
    expect(() =>
      calculateCreatorFees(10_000, {
        enabled: true,
        basisPoints: 10_001,
        fixedCents: 0,
        version: "invalid",
      }),
    ).toThrow("Processing fee schedule is invalid.");
  });
});

describe("immutable Stripe fee metadata", () => {
  test("round-trips the exact split and schedule version", () => {
    const original = calculateCreatorFees(10_000, TEST_SCHEDULE);
    const metadata = creatorFeeMetadata(original);

    expect(metadata).toEqual({
      fee_gross_cents: "10000",
      platform_fee_cents: "1200",
      processing_fee_cents: "320",
      total_creator_deduction_cents: "1520",
      creator_net_cents: "8480",
      processing_fee_enabled: "true",
      processing_fee_bps: "290",
      processing_fee_fixed_cents: "30",
      fee_schedule_version: "test-us-card-v1",
    });
    expect(creatorFeesFromMetadata(metadata, 10_000)).toEqual(original);
  });

  test("uses the historical split when old transactions have no fee metadata", () => {
    expect(creatorFeesFromMetadata(undefined, 10_000)).toEqual({
      grossAmountCents: 10_000,
      platformFeeCents: 1_200,
      processingFeeCents: 0,
      totalCreatorDeductionCents: 1_200,
      creatorNetCents: 8_800,
      processingFeeEnabled: false,
      processingFeeBasisPoints: 0,
      processingFeeFixedCents: 0,
      feeScheduleVersion: LEGACY_FEE_SCHEDULE_VERSION,
    });
  });

  test.each<[string, Record<string, string>]>([
    ["wrong gross", { fee_gross_cents: "9999" }],
    ["non-integer value", { processing_fee_cents: "3.20" }],
    ["inconsistent total", { total_creator_deduction_cents: "1519" }],
    ["inconsistent creator net", { creator_net_cents: "9999" }],
  ])("fails closed for enabled %s metadata", (_label, changed) => {
    const metadata = {
      ...creatorFeeMetadata(calculateCreatorFees(10_000, TEST_SCHEDULE)),
      ...changed,
    };

    expect(() => creatorFeesFromMetadata(metadata, 10_000)).toThrow(
      "Creator-funded processing metadata is incomplete or inconsistent.",
    );
  });

  test("recalculates a later invoice from the immutable schedule, not the first split", () => {
    const first = calculateCreatorFees(10_000, TEST_SCHEDULE);
    const metadata = creatorFeeMetadata(first);

    expect(calculateCreatorFeesFromMetadataSchedule(metadata, 5_000)).toMatchObject({
      grossAmountCents: 5_000,
      platformFeeCents: 600,
      processingFeeCents: 175,
      totalCreatorDeductionCents: 775,
      creatorNetCents: 4_225,
      processingFeeBasisPoints: 290,
      processingFeeFixedCents: 30,
      feeScheduleVersion: "test-us-card-v1",
    });
  });
});

describe("migration refund invariants", () => {
  const migration = readFileSync(
    path.join(process.cwd(), "supabase/schema/019-creator-processing-fees.sql"),
    "utf8",
  );

  test("retains cumulative refunds in a service-only durable table", () => {
    expect(migration).toContain("create table if not exists public.payment_refund_state");
    expect(migration).toMatch(
      /greatest\(\s*payment_refund_state\.refunded_amount_cents/,
    );
    expect(migration).toContain(
      "revoke all on table public.payment_refund_state from public, anon, authenticated",
    );
  });

  test("an early partial refund is removed before recurring earnings are credited", () => {
    expect(migration).toMatch(
      /v_creator_net\s*-\s*coalesce\(v_already_reversed,\s*0\)/,
    );
  });

  test("recurring earnings and installment progress share one idempotent claim", () => {
    expect(migration).toMatch(
      /credit_payment_fee_ledger_earnings[\s\S]*earnings_credited_at is null[\s\S]*paid_count = coalesce\(paid_count, 0\) \+ 1[\s\S]*access_granted = true[\s\S]*earnings_credited_at = now\(\)/,
    );
  });

  test("declares the prior earnings-credit column as an idempotent prerequisite", () => {
    expect(migration).toContain(
      "add column if not exists earnings_credited_cents integer",
    );
  });

  test("the recurring credit RPC rejects one-time ledgers and purchases", () => {
    expect(migration).toMatch(
      /credit_payment_fee_ledger_earnings[\s\S]*stripe_invoice_id is not null[\s\S]*subscription_id is not null/,
    );
  });

  test("a refund delivered first cannot suppress the one-time installment progress claim", () => {
    expect(migration).toMatch(
      /credit_payment_fee_ledger_earnings[\s\S]*status in \('paid', 'refunded'\)[\s\S]*paid_count = coalesce\(paid_count, 0\) \+ 1/,
    );
  });

  test("partial-refund component rounding is explicitly reconciled to refunded gross", () => {
    expect(migration).toContain("refund_allocation_rounding_cents");
    expect(migration).toMatch(
      /v_rounding_adjustment := v_refunded\s*- v_target_reversed\s*- v_platform_attribution\s*- v_processing_attribution/,
    );
    expect(migration).toMatch(
      /earnings_reversed_cents[\s\S]*refund_allocation_rounding_cents = refunded_amount_cents/,
    );
  });

  test("disputes are retained for audit without an earnings-debit RPC", () => {
    expect(migration).toContain("create table if not exists public.payment_dispute_state");
    expect(migration).toContain("create or replace function public.record_payment_dispute_state");
    expect(migration).toContain("disputed_amount_cents bigint not null default 0");
    expect(migration).not.toContain("apply_payment_dispute_earnings");
  });

  test("buyer-readable rows do not grant access to the creator fee columns", () => {
    expect(migration).toContain(
      "revoke select on table public.orders from anon, authenticated",
    );
    expect(migration).toContain(
      "revoke select on table public.purchases from anon, authenticated",
    );
    expect(migration).toContain("column_name not in (");
    expect(migration).toContain("'processing_fee_cents'");
    expect(migration).toContain("'creator_net_cents'");
  });

  test("a booking cannot retain two simultaneously chargeable payment links", () => {
    expect(migration).toMatch(
      /create unique index if not exists booking_payments_one_live_path_per_booking_uidx[\s\S]*on public\.booking_payments\(booking_id\)[\s\S]*where status in \('pending', 'link_sent', 'completed'\)/,
    );
  });

  test("buyer access surfaces require an active paid entitlement", () => {
    const accessPage = readFileSync(
      path.join(process.cwd(), "app/access/[purchaseId]/page.tsx"),
      "utf8",
    );
    const libraryPage = readFileSync(
      path.join(process.cwd(), "app/library/page.tsx"),
      "utf8",
    );
    const watchPage = readFileSync(
      path.join(process.cwd(), "app/watch/[postId]/page.tsx"),
      "utf8",
    );

    expect(accessPage).toContain("p.access_granted === true");
    for (const source of [libraryPage, watchPage]) {
      expect(source).toContain('.eq("access_granted", true)');
      expect(source).toContain('.in("status", ["paid", "active", "complete"])');
    }
  });
});

describe("product checkout coordination migration", () => {
  const migration = readFileSync(
    path.join(process.cwd(), "supabase/schema/020-product-checkout-idempotency.sql"),
    "utf8",
  );

  test("is atomic, private, and unique per buyer/product identity", () => {
    expect(migration.trimStart()).toMatch(/^begin;/i);
    expect(migration.trimEnd()).toMatch(/commit;$/i);
    expect(migration).toContain("create table if not exists public.product_checkout_attempts");
    expect(migration).toContain("unique (buyer_id, purchase_identity)");
    expect(migration).toContain(
      "revoke all on table public.product_checkout_attempts from public, anon, authenticated",
    );
  });
});
