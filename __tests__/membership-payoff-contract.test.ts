import { buildMembershipPayoffTerms, membershipPayoffFingerprint, buildMembershipPayoffCheckout, readMembershipPayoff,
  assertMembershipPayoffSession, inspectMembershipPayoffCapture } from "@/lib/membershipPayoff";
import { membershipPayoffFixture } from "../test-support/membership-payoff-fixtures";
test("steps 2/4: one payoff is exactly the remaining minimum with one Checkout processing fee", () => {
  const f = membershipPayoffFixture(), t = buildMembershipPayoffTerms(f.a, f.exitQuote);
  expect(t.amountCents).toBe(20000); expect(t.remainingMonths).toBe(2); expect(t.fees.platformFeeCents).toBe(2400);
  expect(t.fees.processingFeeCents).toBe(610); expect(t.fees.creatorNetCents).toBe(16990);
  expect(t.periodEnd).toBe(f.exitQuote.minimumEnd); expect(t.renewalsStopAfterPayoff).toBe(true);
});
test.each([{ payoffAmountCents: 50 }, { remainingMonths: 1 }, { revision: 999 }, { reviewReasons: ["collection_in_flight_or_review"] }])(
  "steps 2/4: uncertain or altered exit quote %p cannot become payoff terms", change => {
    const f = membershipPayoffFixture(); expect(() => buildMembershipPayoffTerms(f.a, { ...f.exitQuote, ...change })).toThrow("current, settled");
  });
test("step 4: JSONB key reordering cannot change the payoff fingerprint", () => {
  const f = membershipPayoffFixture(), reordered = Object.fromEntries(Object.entries(f.p.terms).reverse());
  expect(membershipPayoffFingerprint(reordered)).toBe(f.p.fingerprint); expect(readMembershipPayoff({ ...f.p, terms: reordered }, f.a).id).toBe(f.p.id);
});
test("step 4: saved payoff cannot change its amount or period after acceptance", () => {
  const f = membershipPayoffFixture(); expect(() => readMembershipPayoff({ ...f.p, terms: { ...f.p.terms, amountCents: 10000 } }, f.a)).toThrow();
});
test("steps 2/4: payoff Checkout is a separate one-time payment and never saves fresh recurring authority", () => {
  const f = membershipPayoffFixture(), p = buildMembershipPayoffCheckout(f.a, f.p);
  expect(p.mode).toBe("payment"); expect(p.payment_intent_data?.setup_future_usage).toBeUndefined();
  expect(p.payment_intent_data?.application_fee_amount).toBe(3010); expect(p.payment_intent_data?.metadata?.operation_kind).toBe("payoff");
  expect(p.metadata?.creatornet_membership_payoff_id).toBe(f.p.id); expect(p.success_url).toContain("payoff_id=" + f.p.id);
});
test("step 8: owned captured payoff yields one exact ledger proof and remaining-period coverage", () => {
  const f = membershipPayoffFixture(), value = inspectMembershipPayoffCapture(f.a, f.p, f.session, f.pi, f.charge, f.balance);
  expect(value.proof).toMatchObject({ payoffId: f.p.id, capturedAmountCents: 20000, periodStart: f.p.terms.periodStart, periodEnd: f.p.terms.periodEnd });
  expect(value.stripeFee).toMatchObject({ actualStripeFeeCents: 610, applicationFeeAmountCents: 3010 });
});
test.each(["customer", "amount", "fee", "future", "metadata", "capture", "balance", "session"] as const)(
  "step 8: wrong payoff %s evidence cannot grant paid service", change => {
    const f = membershipPayoffFixture();
    if (change === "customer") f.pi.customer = "cus_other";
    if (change === "amount") f.pi.amount_received = 10000;
    if (change === "fee") f.pi.application_fee_amount = 1;
    if (change === "future") f.pi.setup_future_usage = "off_session";
    if (change === "metadata") f.pi.metadata.creatornet_membership_payoff_id = f.a.id;
    if (change === "capture") f.charge.captured = false;
    if (change === "balance") f.balance.net = 1;
    if (change === "session") f.session.id = "cs_other";
    expect(() => inspectMembershipPayoffCapture(f.a, f.p, f.session, f.pi, f.charge, f.balance)).toThrow();
  });
test("step 8: unpaid checkout cannot be interpreted as a captured payoff", () => {
  const f = membershipPayoffFixture(false); expect(() => assertMembershipPayoffSession(f.session, f.a, f.p, true)).toThrow();
  expect(() => assertMembershipPayoffSession(f.session, f.a, f.p, false)).not.toThrow();
});
