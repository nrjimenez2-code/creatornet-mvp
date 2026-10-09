import { mentorshipInstallmentQuote } from "@/lib/mentorshipInstallmentQuote";
import { readMentorshipInstallmentOptions } from "@/lib/mentorshipInstallmentOptions";
const firstPaymentFees = { enabled: true, basisPoints: 290, fixedCents: 30, version: "synthetic-card" };
const renewalFees = { ...firstPaymentFees, basisPoints: 360, version: "synthetic-recurring" };
const product = { id: "product", creator_id: "creator", type: "mentorship", title: "Ten-month service", price_cents: 10001,
  currency: "usd", fixed_service_months: 10, installment_options: [2, 3, 6], active: true };
const args = { product, buyerId: "buyer", postId: "post", paymentCount: 3, firstPaymentFees, renewalFees };
test("quote preserves total cents, ten service months and separate three-payment obligation", () => {
  const quote = mentorshipInstallmentQuote(args);
  expect(quote.terms.payments.map(payment => payment.amountCents)).toEqual([3333, 3333, 3335]);
  expect(quote.terms.payments.reduce((sum, payment) => sum + payment.amountCents, 0)).toBe(10001);
  expect(quote.terms).toMatchObject({ amountCents: 10001, serviceMonths: 10, paymentCount: 3, kind: "fixed_total_installments" });
  expect(quote.terms.billing).not.toContain("One payment");
});
test("only creator-approved counts can be quoted", () => {
  expect(() => mentorshipInstallmentQuote({ ...args, paymentCount: 4 })).toThrow("not approved");
  expect(() => mentorshipInstallmentQuote({ ...args, product: { ...product, installment_options: [] } })).toThrow("not approved");
});
test("withdrawn, self-purchased and monthly offers cannot become fixed-total quotes", () => {
  expect(() => mentorshipInstallmentQuote({ ...args, product: { ...product, active: false } })).toThrow();
  expect(() => mentorshipInstallmentQuote({ ...args, buyerId: product.creator_id })).toThrow();
  expect(() => mentorshipInstallmentQuote({ ...args, product: { ...product, membership_terms: {} } })).toThrow();
});
test.each(["buyer", "price", "fees", "duration", "plan"])("changed %s invalidates the quote fingerprint", field => {
  const changed = { ...args, product: { ...product } };
  if (field === "buyer") changed.buyerId = "different-buyer";
  if (field === "price") changed.product.price_cents++;
  if (field === "fees") changed.renewalFees = { ...renewalFees, basisPoints: 400 };
  if (field === "duration") changed.product.fixed_service_months++;
  if (field === "plan") changed.paymentCount = 2;
  expect(mentorshipInstallmentQuote(changed).fingerprint).not.toBe(mentorshipInstallmentQuote(args).fingerprint);
});
test.each([[3, 2], [2, 2], [1], [25], [2.5], ["3"], [null], [2, 24]].map(value => [value]))("rejects invalid or unaffordable options %p", value => {
  expect(() => readMentorshipInstallmentOptions(value, "mentorship", false, 1000)).toThrow();
});
test("smallest allowed charge boundary is enforced without floating-point pricing", () => {
  expect(readMentorshipInstallmentOptions([2], "mentorship", false, 100)).toEqual([2]);
  expect(() => readMentorshipInstallmentOptions([2], "mentorship", false, 99)).toThrow();
});
