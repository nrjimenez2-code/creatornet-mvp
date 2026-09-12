import { planMembershipExit } from "@/lib/membershipCancellation";
const base = { monthlyPriceCents: 10000, paidMonths: 1, paidThrough: "2026-10-09T12:00:00Z",
  minimumEndsAt: "2026-12-09T12:00:00Z", financialReviewRequired: false,
  terms: { version: "monthly-mentorship-v1", minimumMonths: 3, autoRenew: true } };
test("#4 three-month minimum after one paid month has a buyer-confirmed $200 payoff and full paid access", () => {
  expect(planMembershipExit(base)).toEqual({ kind: "buyer_confirmed_payoff", remainingMonths: 2, payoffCents: 20000,
    accessEndsAt: "2026-12-09T12:00:00.000Z", automaticPayoffAuthorized: false, receiptRequiredBeforePayoffCompletion: true });
});
test("#4 no additional minimum is represented by the first paid month, not a free month", () => {
  const result = planMembershipExit({ ...base, terms: { ...base.terms, minimumMonths: 1 } });
  expect(result.kind).toBe("stop_renewal"); expect(result.payoffCents).toBe(0);
  expect(result.accessEndsAt).toBe("2026-10-09T12:00:00.000Z");
});
test.each([3, 4, 12])("#4 once %s months are funded, cancellation has no additional minimum payoff", paidMonths => {
  const result = planMembershipExit({ ...base, paidMonths, paidThrough: "2027-01-09T12:00:00Z" });
  expect(result.payoffCents).toBe(0); expect(result.accessEndsAt).toBe("2027-01-09T12:00:00.000Z");
});
test("#4 optional non-renewal does not erase the selected minimum", () => {
  expect(planMembershipExit({ ...base, terms: { ...base.terms, autoRenew: false } }).payoffCents).toBe(20000);
});
test.each([
  { paidMonths: 0 }, { paidMonths: -1 }, { paidMonths: 1.5 }, { financialReviewRequired: true },
  { monthlyPriceCents: 49 }, { monthlyPriceCents: 100.5 }, { paidThrough: "bad date" },
  { minimumEndsAt: "2026-09-09T12:00:00Z" },
])("#4 uncertain, unpaid or inconsistent financial state cannot create a payoff plan %p", change => {
  expect(() => planMembershipExit({ ...base, ...change })).toThrow();
});
