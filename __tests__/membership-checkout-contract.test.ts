import { membershipAgreementFingerprint } from "@/lib/membershipAgreement";
import { assertMembershipCustomer, assertMembershipHeld, assertMembershipSession, buildMembershipCheckout, buildMembershipSubscription,
  membershipBootstrapTimes, readMembershipRecord } from "@/lib/membershipCheckout";
import { membershipFixture } from "../test-support/membership-fixtures";

test("step 4: JSONB key order does not change the accepted agreement fingerprint", () => {
  const { a } = membershipFixture();
  const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse) : value && typeof value === "object" ?
    Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value;
  const reordered = reverse(a.terms);
  expect(membershipAgreementFingerprint(reordered)).toBe(a.fingerprint);
  expect(readMembershipRecord({ ...a, terms: reordered }).id).toBe(a.id);
});
test.each(["buyer_id", "product_id", "monthly_price_cents", "fingerprint", "minimum_months", "auto_renew"])(
  "steps 1/4: a saved %s disagreement fails before provider use", field => {
    const { a } = membershipFixture();
    expect(() => readMembershipRecord({ ...a, [field]: field === "auto_renew" ? false : field.includes("cents") || field.includes("months") ? 7 : "changed" })).toThrow();
  });
test("step 1: checkout collects one month, not the whole minimum, with distinct first/recurring fees", () => {
  const { a } = membershipFixture(), p = buildMembershipCheckout(a, "cus_fixture", "sub_fixture");
  expect(p.mode).toBe("payment"); expect(p.line_items?.[0].price_data?.unit_amount).toBe(10000);
  expect(p.payment_intent_data).toMatchObject({ application_fee_amount: 1520, setup_future_usage: "off_session", transfer_data: { destination: "acct_creator" } });
  expect(a.terms.recurringMonthFees.totalCreatorDeductionCents).toBe(1590);
  const submit = p.custom_text?.submit, message = submit && typeof submit === "object" ? submit.message : "";
  expect(message).toContain("$300.00 total minimum");
  expect(message).toContain("separate confirmation");
  expect(message).toContain("Paid access and support");
});
test("step 1: provider bootstrap has a no-card trial and temporary safety stop, not an installment count", () => {
  const { a } = membershipFixture(), times = membershipBootstrapTimes(a), p = buildMembershipSubscription(a, "cus_fixture", "prod_fixture");
  expect(p.trial_end).toBe(times.start + 48 * 3600); expect(p.cancel_at).toBe(times.cancelAt);
  expect(p.payment_settings?.save_default_payment_method).toBe("off"); expect(p.default_payment_method).toBeUndefined();
  expect(p.application_fee_percent).toBeUndefined(); expect(p.proration_behavior).toBe("none");
});
test("steps 1/8: only the exact held subscription, customer and open unpaid session are accepted", () => {
  const f = membershipFixture(); assertMembershipCustomer(f.customer, f.a, true);
  assertMembershipHeld(f.subscription, f.a, f.customer.id, f.product.id, true); assertMembershipSession(f.session, f.a, false);
});
test.each(["card", "credit", "email", "context"])("step 1: unexpected customer %s fails before payment link publication", change => {
  const f = membershipFixture();
  if (change === "card") f.customer.invoice_settings.default_payment_method = "pm_unexpected";
  if (change === "credit") f.customer.balance = -100;
  if (change === "email") f.customer.email = "unexpected@example.invalid";
  if (change === "context") f.customer.livemode = true;
  expect(() => assertMembershipCustomer(f.customer, f.a, true)).toThrow();
});
test.each(["hold", "destination", "price", "card", "discount", "items"])("step 1: altered subscription %s is rejected", change => {
  const f = membershipFixture(), s = f.subscription;
  if (change === "hold") s.pause_collection = null;
  if (change === "destination") s.transfer_data!.destination = "acct_other";
  if (change === "price") s.items.data[0].price.unit_amount = 50;
  if (change === "card") s.default_payment_method = "pm_other";
  if (change === "discount") s.discounts = ["di_other"];
  if (change === "items") s.items.has_more = true;
  expect(() => assertMembershipHeld(s, f.a, f.customer.id, f.product.id, true)).toThrow();
});
test.each(["amount", "customer", "session", "context", "metadata", "paid"])("steps 1/8: altered checkout %s is rejected", change => {
  const f = membershipFixture();
  if (change === "amount") f.session.amount_total = 50;
  if (change === "customer") f.session.customer = "cus_other";
  if (change === "session") f.session.id = "cs_other";
  if (change === "context") f.session.livemode = true;
  if (change === "metadata") f.session.metadata = {};
  if (change === "paid") f.session.payment_status = "paid";
  expect(() => assertMembershipSession(f.session, f.a, false)).toThrow();
});
