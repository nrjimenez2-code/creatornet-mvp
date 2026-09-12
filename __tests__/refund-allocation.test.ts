import {
  calculateRefundAllocation,
  reasonMatchesResponsibility,
} from "@/lib/refundAllocation";

const base = {
  grossAmountCents: 10_000,
  platformFeeCents: 1_200,
  processingFeeCents: 320,
  creatorNetCents: 8_480,
  refundedBeforeCents: 0,
  applicationFeeRefundedBeforeCents: 0,
};

describe("refund allocation", () => {
  test("full creator-responsible refund leaves processing with CreatorNet", () => {
    expect(
      calculateRefundAllocation({
        ...base,
        requestedRefundAmountCents: 10_000,
        responsibility: "creator",
      }),
    ).toMatchObject({
      customerRefundCents: 10_000,
      creatorEarningsReversalCents: 8_480,
      creatorBalanceImpactCents: 8_800,
      platformFeeRefundCents: 1_200,
      processingFeeAllocationCents: 320,
      applicationFeeRefundAmountCents: 1_200,
      applicationFeeRefundTargetCents: 1_200,
      remainingRefundableCents: 0,
    });
  });

  test("full platform-responsible refund returns platform and processing allocations", () => {
    expect(
      calculateRefundAllocation({
        ...base,
        requestedRefundAmountCents: 10_000,
        responsibility: "platform",
      }),
    ).toMatchObject({
      customerRefundCents: 10_000,
      creatorEarningsReversalCents: 8_480,
      creatorBalanceImpactCents: 8_480,
      platformFeeRefundCents: 1_200,
      processingFeeAllocationCents: 320,
      applicationFeeRefundAmountCents: 1_520,
      applicationFeeRefundTargetCents: 1_520,
    });
  });

  test.each([
    ["creator", 2_200, 300],
    ["platform", 2_120, 380],
  ] as const)("partial %s-responsible refund is exact", (responsibility, impact, feeRefund) => {
    expect(
      calculateRefundAllocation({
        ...base,
        requestedRefundAmountCents: 2_500,
        responsibility,
      }),
    ).toMatchObject({
      customerRefundCents: 2_500,
      platformFeeRefundCents: 300,
      processingFeeAllocationCents: 80,
      creatorEarningsReversalCents: 2_120,
      creatorBalanceImpactCents: impact,
      applicationFeeRefundAmountCents: feeRefund,
      remainingRefundableCents: 7_500,
    });
  });

  test("many partial refunds end at the same exact totals as one full refund", () => {
    let refundedBeforeCents = 0;
    let applicationFeeRefundedBeforeCents = 0;
    const totals = { platform: 0, processing: 0, creator: 0, appFee: 0 };
    for (const requestedRefundAmountCents of [3_333, 3_333, 3_334]) {
      const allocation = calculateRefundAllocation({
        ...base,
        refundedBeforeCents,
        applicationFeeRefundedBeforeCents,
        requestedRefundAmountCents,
        responsibility: "platform",
      });
      totals.platform += allocation.platformFeeRefundCents;
      totals.processing += allocation.processingFeeAllocationCents;
      totals.creator += allocation.creatorEarningsReversalCents;
      totals.appFee += allocation.applicationFeeRefundAmountCents;
      refundedBeforeCents = allocation.cumulativeCustomerRefundTargetCents;
      applicationFeeRefundedBeforeCents = allocation.applicationFeeRefundTargetCents;
    }
    expect(totals).toEqual({ platform: 1_200, processing: 320, creator: 8_480, appFee: 1_520 });
  });

  test("mixed responsibility assigns each processing increment only once", () => {
    const creatorRefund = calculateRefundAllocation({
      ...base,
      requestedRefundAmountCents: 5_000,
      responsibility: "creator",
    });
    const platformRefund = calculateRefundAllocation({
      ...base,
      refundedBeforeCents: creatorRefund.cumulativeCustomerRefundTargetCents,
      applicationFeeRefundedBeforeCents: creatorRefund.applicationFeeRefundTargetCents,
      requestedRefundAmountCents: 5_000,
      responsibility: "platform",
    });
    expect(creatorRefund.applicationFeeRefundAmountCents).toBe(600);
    expect(platformRefund.applicationFeeRefundAmountCents).toBe(760);
    expect(
      creatorRefund.processingFeeAllocationCents +
        platformRefund.processingFeeAllocationCents,
    ).toBe(320);
    expect(
      creatorRefund.creatorBalanceImpactCents +
        platformRefund.creatorBalanceImpactCents,
    ).toBe(8_640);
  });

  test("one-cent allocations retain deterministic rounding residuals", () => {
    const first = calculateRefundAllocation({
      grossAmountCents: 3,
      platformFeeCents: 1,
      processingFeeCents: 1,
      creatorNetCents: 1,
      refundedBeforeCents: 0,
      applicationFeeRefundedBeforeCents: 0,
      requestedRefundAmountCents: 1,
      responsibility: "creator",
    });
    const second = calculateRefundAllocation({
      grossAmountCents: 3,
      platformFeeCents: 1,
      processingFeeCents: 1,
      creatorNetCents: 1,
      refundedBeforeCents: 1,
      applicationFeeRefundedBeforeCents: 0,
      requestedRefundAmountCents: 1,
      responsibility: "platform",
    });
    expect(first.applicationFeeRefundAmountCents).toBeLessThanOrEqual(1);
    expect(second.applicationFeeRefundAmountCents).toBeLessThanOrEqual(1);
    expect(first.platformFeeRefundCents).toBeGreaterThanOrEqual(0);
    expect(first.processingFeeAllocationCents).toBeGreaterThanOrEqual(0);
    expect(second.platformFeeRefundCents).toBeGreaterThanOrEqual(0);
    expect(second.processingFeeAllocationCents).toBeGreaterThanOrEqual(0);
  });

  test("over-refunds and invalid immutable splits are rejected", () => {
    expect(() =>
      calculateRefundAllocation({
        ...base,
        refundedBeforeCents: 9_000,
        requestedRefundAmountCents: 1_001,
        responsibility: "creator",
      }),
    ).toThrow(/remaining refundable/);
    expect(() =>
      calculateRefundAllocation({
        ...base,
        creatorNetCents: 8_481,
        requestedRefundAmountCents: 100,
        responsibility: "creator",
      }),
    ).toThrow(/split/);
  });

  test("reason and responsibility policy is enforced", () => {
    expect(reasonMatchesResponsibility("creator_non_delivery", "creator")).toBe(true);
    expect(reasonMatchesResponsibility("creator_non_delivery", "platform")).toBe(false);
    expect(reasonMatchesResponsibility("duplicate_charge", "platform")).toBe(true);
    expect(reasonMatchesResponsibility("legally_required", "creator")).toBe(true);
    expect(reasonMatchesResponsibility("legally_required", "platform")).toBe(true);
  });
});
