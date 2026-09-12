import { assertMembershipActivated, assertMembershipInvoice, membershipActivationParams, membershipInvoiceConfiguration,
  membershipInvoicePayParams, membershipRenewalPeriod, inspectMembershipRenewalCapture, readMembershipFirstProof } from "@/lib/membershipRenewal";
import { membershipRenewalFixture } from "../test-support/membership-renewal-fixtures";
test("step 1: January-31 service stays on March-31 even when the held provider invoice arrives on March-28", () => {
  const f = membershipRenewalFixture(Date.UTC(2026, 0, 31, 12) / 1000, 2), p = membershipRenewalPeriod(f.a);
  expect(new Date(p.start * 1000).toISOString()).toBe("2026-03-31T12:00:00.000Z");
  expect(new Date(p.end * 1000).toISOString()).toBe("2026-04-30T12:00:00.000Z");
  expect(new Date(p.providerStart * 1000).toISOString()).toBe("2026-03-28T12:00:00.000Z");
  expect(new Date(p.providerEnd * 1000).toISOString()).toBe("2026-04-28T12:00:00.000Z");
});
test("step 1: renewing memberships are not limited to a 24-installment schedule", () => {
  const f = membershipRenewalFixture(Date.UTC(2026, 0, 31, 12) / 1000, 25);
  expect(new Date(membershipRenewalPeriod(f.a).start * 1000).toISOString()).toBe("2028-02-29T12:00:00.000Z");
});
test("step 1: activation preserves the collection hold and uses only the captured card", () => {
  const f = membershipRenewalFixture(); expect(readMembershipFirstProof(f.a, f.proof)).toMatchObject({ paymentMethodId: "pm_fixture" });
  expect(membershipActivationParams(f.a, f.proof)).toMatchObject({ cancel_at: "", proration_behavior: "none",
    default_payment_method: "pm_fixture", pause_collection: { behavior: "keep_as_draft" } });
  expect(assertMembershipActivated(f.subscription, f.a, f.product.id, f.proof)).toBe("si_fixture");
});
test("step 1: nonrenewing activation has an explicit agreed service end", () => {
  const f = membershipRenewalFixture(); f.a.auto_renew = false;
  expect(membershipActivationParams(f.a, f.proof).cancel_at).toBe(membershipRenewalPeriod(f.a, 3).end);
  expect(() => membershipRenewalPeriod(f.a, 4)).toThrow("No agreed renewal");
});
test.each(["card", "anchor", "destination", "context"])("step 8: first-payment %s mismatch cannot activate renewals", field => {
  const f = membershipRenewalFixture(), changed = { ...f.proof };
  if (field === "card") changed.paymentMethodId = "wrong";
  if (field === "anchor") changed.paidAt += 1;
  if (field === "destination") changed.destinationId = "acct_other";
  if (field === "context") changed.paymentContext = { ...changed.paymentContext, stripeAccountId: "acct_other" };
  expect(() => readMembershipFirstProof(f.a, changed)).toThrow();
});
test.each(["hold", "card", "price", "metadata", "destination"])("step 8: changed active subscription %s is rejected", field => {
  const f = membershipRenewalFixture();
  if (field === "hold") f.subscription.pause_collection = null;
  if (field === "card") f.subscription.default_payment_method = "pm_other";
  if (field === "price") f.subscription.items.data[0].price.unit_amount = 50;
  if (field === "metadata") f.subscription.metadata = {};
  if (field === "destination") f.subscription.transfer_data!.destination = "acct_other";
  expect(() => assertMembershipActivated(f.subscription, f.a, f.product.id, f.proof)).toThrow();
});
test("steps 1/7: the invoice receives exact recurring fees, not a percentage or first-month fee", () => {
  const f = membershipRenewalFixture(), params = membershipInvoiceConfiguration(f.a, f.proof, 2);
  expect(params.application_fee_amount).toBe(1590); expect(params.transfer_data).toEqual({ destination: "acct_creator" });
  expect(membershipInvoicePayParams(f.proof)).toEqual({ payment_method: "pm_fixture", off_session: true, forgive: false, paid_out_of_band: false });
});
test("step 1: a raw held invoice is not considered configured until its exact service period and fees match", () => {
  const f = membershipRenewalFixture(Date.UTC(2026, 0, 31, 12) / 1000, 2);
  assertMembershipInvoice(f.invoice, f.a, f.proof, 3, f.product.id, "held", "si_fixture");
  Object.assign(f.invoice, membershipInvoiceConfiguration(f.a, f.proof, 3));
  expect(() => assertMembershipInvoice(f.invoice, f.a, f.proof, 3, f.product.id, "configured")).toThrow();
  f.invoice.lines.data[0].period = { start: f.period.start, end: f.period.end };
  assertMembershipInvoice(f.invoice, f.a, f.proof, 3, f.product.id, "configured");
});
test.each(["amount", "period", "invoiceOwner", "metadata", "tax", "extraLine"])("steps 1/8: configured invoice %s mismatch prevents payment", field => {
  const f = membershipRenewalFixture(); Object.assign(f.invoice, membershipInvoiceConfiguration(f.a, f.proof, 2));
  if (field === "amount") f.invoice.amount_due = 50;
  if (field === "period") f.invoice.lines.data[0].period.end++;
  if (field === "invoiceOwner") f.invoice.customer = "cus_other";
  if (field === "metadata") f.invoice.metadata = {};
  if (field === "tax") f.invoice.automatic_tax.enabled = true;
  if (field === "extraLine") f.invoice.lines.data.push(f.invoice.lines.data[0]);
  expect(() => assertMembershipInvoice(f.invoice, f.a, f.proof, 2, f.product.id, "configured")).toThrow();
});
test("steps 1/8: captured renewal records the real charge, invoice and agreed service boundaries", () => {
  const f = membershipRenewalFixture(); Object.assign(f.invoice, membershipInvoiceConfiguration(f.a, f.proof, 2)); f.capture();
  const result = inspectMembershipRenewalCapture(f.a, f.proof, 2, f.invoice, f.invoicePayment, f.paymentIntent, f.charge, f.balance, "req_fixture");
  expect(result.providerProof).toMatchObject({ invoiceId: "in_fixture", paymentIntentId: "pi_renewal", paymentMethodId: "pm_fixture",
    applicationFeeAmountCents: 1590, collectionRequestId: "req_fixture" });
});
