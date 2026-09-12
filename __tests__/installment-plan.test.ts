import { calculateInstallmentPlan } from "../lib/installmentPlan";
import {
  calculateCreatorFees,
  exactSubscriptionApplicationFeePercent,
  type ProcessingFeeSchedule,
} from "../lib/money";

// Explicit synthetic schedule, not an assertion about current live Stripe prices.
const schedule: ProcessingFeeSchedule = {
  enabled: true,
  basisPoints: 360,
  fixedCents: 30,
  version: "test-us-card-plus-billing",
};

describe("exact-cent installment planning (not collection)", () => {
  test.each([
    [10000, 3, [3333, 3333, 3334]],
    [99900, 3, [33300, 33300, 33300]],
    [199900, 3, [66633, 66633, 66634]],
    [500000, 3, [166666, 166666, 166668]],
    [12000, 3, [4000, 4000, 4000]],
    [500000, 5, [100000, 100000, 100000, 100000, 100000]],
    [600000, 6, [100000, 100000, 100000, 100000, 100000, 100000]],
    [10001, 6, [1666, 1666, 1666, 1666, 1666, 1671]],
    [101, 2, [50, 51]],
  ])("preserves total %i in %i payments", (total, count, expected) => {
    const plan = calculateInstallmentPlan(total as number, count as number, schedule);
    expect(plan.payments.map((payment) => payment.amountCents)).toEqual(expected);
    expect(plan.payments.reduce((sum, payment) => sum + payment.amountCents, 0)).toBe(total);
    expect(plan.payments.map((payment) => payment.number)).toEqual(
      Array.from({ length: count as number }, (_, index) => index + 1),
    );
    expect(plan.finalAmountCents).toBe((expected as number[]).at(-1));
  });

  test("uses existing exact-cent fee calculation separately on every payment", () => {
    const plan = calculateInstallmentPlan(10000, 3, schedule);
    for (const payment of plan.payments) {
      expect(payment.fees).toEqual(calculateCreatorFees(payment.amountCents, schedule));
      expect(payment.fees.processingFeeFixedCents).toBe(30);
      expect(payment.fees.grossAmountCents).toBe(payment.amountCents);
      expect(payment.fees.creatorNetCents + payment.fees.totalCreatorDeductionCents)
        .toBe(payment.amountCents);
    }
  });

  test("does not bypass the existing Stripe percentage guard", () => {
    const plan = calculateInstallmentPlan(99900, 3, schedule);
    expect(plan.payments[0].fees.totalCreatorDeductionCents).toBe(5225);
    expect(() => exactSubscriptionApplicationFeePercent(plan.payments[0].fees)).toThrow();
  });

  test("a rounded percentage is not a general solution for high-ticket plans", () => {
    const plan = calculateInstallmentPlan(199900, 3, schedule);
    for (const payment of plan.payments) {
      expect(payment.fees.totalCreatorDeductionCents).toBe(10425);
      expect(() => exactSubscriptionApplicationFeePercent(payment.fees)).toThrow();

      // Pure mathematical counterexample, NOT an assertion that every Stripe
      // application fee uses this rounding rule. Even granting nearest-cent
      // rounding, none of the allowed 0.00–100.00% values produces 10425 cents
      // on either 66633 or 66634 cents. Do not replace the strict guard with
      // Math.round(percent * 100) and call arbitrary pricing supported.
      const matches: number[] = [];
      for (let basisPoints = 0; basisPoints <= 10000; basisPoints += 1) {
        const roundedCents =
          (BigInt(payment.amountCents) * BigInt(basisPoints) + 5000n) / 10000n;
        if (roundedCents === BigInt(payment.fees.totalCreatorDeductionCents)) {
          matches.push(basisPoints);
        }
      }
      expect(matches).toEqual([]);
    }
  });

  test("retains legacy disabled processing semantics without inventing a fee", () => {
    const plan = calculateInstallmentPlan(10000, 3, {
      enabled: false, basisPoints: 0, fixedCents: 0, version: "platform-only-v1",
    });
    expect(plan.payments.every((payment) => payment.fees.processingFeeCents === 0)).toBe(true);
  });

  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid total %s", (total) => {
      expect(() => calculateInstallmentPlan(total, 3, schedule)).toThrow();
    },
  );

  test.each([0, 1, 25, -1, 2.5, NaN, Infinity])("rejects invalid count %s", (count) => {
    expect(() => calculateInstallmentPlan(10000, count, schedule)).toThrow();
  });

  test("rejects any regular payment below the existing minimum", () => {
    expect(() => calculateInstallmentPlan(1199, 24, schedule)).toThrow(/50 cents/);
  });

  test("calculates near-safe-integer totals without intermediate floating-point drift", () => {
    const plan = calculateInstallmentPlan(Number.MAX_SAFE_INTEGER, 24, schedule);
    expect(plan.payments.reduce((sum, payment) => sum + BigInt(payment.amountCents), 0n))
      .toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  test("fails on a bad fee schedule rather than substituting a rate", () => {
    expect(() => calculateInstallmentPlan(10000, 3, { ...schedule, version: "" })).toThrow();
    expect(() => calculateInstallmentPlan(10000, 3, { ...schedule, fixedCents: 99999 })).toThrow();
  });

  test("retains the calculated snapshot if the caller later changes its schedule", () => {
    const input = { ...schedule };
    const plan = calculateInstallmentPlan(10000, 3, input);
    input.fixedCents = 500;
    expect(plan.payments[0].fees.processingFeeFixedCents).toBe(30);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.payments)).toBe(true);
    expect(Object.isFrozen(plan.payments[0].fees)).toBe(true);
  });

  test("preserves totals and fee reconciliation across representative cent remainders", () => {
    for (let count = 2; count <= 24; count += 1) {
      for (let remainder = 0; remainder < count; remainder += 1) {
        const total = count * 9999 + remainder;
        const plan = calculateInstallmentPlan(total, count, schedule);
        expect(plan.payments.reduce((sum, payment) => sum + payment.amountCents, 0)).toBe(total);
        expect(plan.finalAmountCents - plan.regularAmountCents).toBe(remainder);
        expect(plan.payments.every((payment) => Number.isSafeInteger(payment.amountCents))).toBe(true);
      }
    }
  });
});
