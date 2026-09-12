import { fixedServiceEndAt, fixedServiceDescription, readFixedServiceMonths } from "../lib/fixedServiceTerms";
import { buildFixedTotalCheckoutPayload } from "../lib/installments/checkoutContract";
import { FIXED_PURCHASE_CONSENT_VERSION } from "../lib/installments/purchaseConsent";
import { buildExactContextCustomerPlan } from "../lib/installments/contextBootstrap";
import { readExactContextReservation } from "../lib/installments/contextReservation";

const epoch = (value: string) => Date.parse(value) / 1000;
test.each([
  ["2028-01-31T14:15:16Z", 1, "2028-02-29T14:15:16Z"],
  ["2027-01-31T14:15:16Z", 1, "2027-02-28T14:15:16Z"],
  ["2028-01-31T14:15:16Z", 2, "2028-03-31T14:15:16Z"],
  ["2028-02-29T14:15:16Z", 12, "2029-02-28T14:15:16Z"],
  ["2028-12-31T23:59:59Z", 25, "2031-01-31T23:59:59Z"],
] as const)("service calendar %s + %i months = %s", (start, months, end) => {
  expect(fixedServiceEndAt(epoch(start), months)).toBe(epoch(end));
});
test.each([undefined, null, 0, -1, 1.5, "10", NaN, Infinity, 2147483648])("invalid service months %p are not defaulted", value => {
  expect(() => readFixedServiceMonths(value)).toThrow();
});
test.each([0, -1, NaN, Infinity, 253402300800])("invalid first capture %p cannot define a period", value => {
  expect(() => fixedServiceEndAt(value, 1)).toThrow();
});
test("supported-date overflow fails before a purchase request can be built", () => {
  expect(() => fixedServiceEndAt(epoch("9999-12-01T00:00:00Z"), 1)).toThrow();
  expect(() => fixedServiceEndAt(epoch("2028-01-01T00:00:00Z"), 2147483647)).toThrow();
});
const fee = { enabled: true, basisPoints: 290, fixedCents: 30, version: "local" };
test.each([4, 10])("a 10-month service retains the same full price over %i installments", paymentCount => {
  const params = buildFixedTotalCheckoutPayload({ customerId: "cus_Synthetic", destinationId: "acct_Synthetic",
    title: "Mentorship", totalCents: 1000000, paymentCount, firstPaymentFeeSchedule: fee,
    renewalFeeSchedule: fee, origin: "https://synthetic.vercel.app" }, {}, FIXED_PURCHASE_CONSENT_VERSION, 10);
  expect(params.line_items?.[0].price_data?.unit_amount).toBe(1000000 / paymentCount);
  const submit = params.custom_text?.submit;
  if (!submit || typeof submit !== "object") throw Error("Missing disclosure");
  expect(submit.message).toContain(fixedServiceDescription(10));
  expect(submit.message).toContain("$10000.00 USD");
  expect(params.consent_collection?.terms_of_service).toBe("required");
});
test("a timed service cannot bypass versioned acceptance", () => {
  expect(() => buildFixedTotalCheckoutPayload({ customerId: "cus_Synthetic", destinationId: "acct_Synthetic",
    title: "Mentorship", totalCents: 1000000, paymentCount: 4, firstPaymentFeeSchedule: fee,
    renewalFeeSchedule: fee, origin: "https://synthetic.vercel.app" }, {}, undefined, 10)).toThrow();
});
function fixture() {
  const ids = { reservation: "11111111-1111-4111-8111-111111111111", booking: "22222222-2222-4222-8222-222222222222",
    product: "33333333-3333-4333-8333-333333333333", post: "44444444-4444-4444-8444-444444444444",
    buyer: "55555555-5555-4555-8555-555555555555", creator: "66666666-6666-4666-8666-666666666666" };
  const context = { version: "exact-payment-context-v1", mode: "test", platformAccountId: "acct_Synthetic",
    supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa", siteOrigin: "https://synthetic.vercel.app" };
  const evidence = { approvedContext: context, vercelEnvironment: "preview", stripeSecretKeyMode: "test",
    stripePublishableKeyMode: "test", observedPlatformAccountId: context.platformAccountId, observedSupabaseProjectRef: context.supabaseProjectRef,
    configuredSupabaseUrl: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co", configuredSiteOrigin: context.siteOrigin };
  const terms: Record<string, unknown> = { version: "exact-cents-context-v2", currency: "usd", bookingId: ids.booking,
    productId: ids.product, postId: ids.post, buyerId: ids.buyer, creatorId: ids.creator, destinationId: "acct_Creator",
    title: "Mentorship", totalCents: 1000000, paymentCount: 4, firstPaymentFeeSchedule: fee, renewalFeeSchedule: fee };
  const reservation = { id: ids.reservation, booking_id: ids.booking, context, terms, status: "reserved_not_issuable",
    created_at: "2026-09-01T12:00:00Z" };
  const plan = () => buildExactContextCustomerPlan({ reservationRow: reservation, contextEvidence: evidence, actorId: ids.creator });
  return { reservation, evidence, plan, terms };
}
test("legacy, consent-only and service-bearing terms have distinct immutable hash contracts", () => {
  const f = fixture(), legacy = f.plan();
  f.terms.purchaseConsentVersion = FIXED_PURCHASE_CONSENT_VERSION;
  const consent = f.plan(); f.terms.serviceMonths = 10; const service = f.plan();
  expect(new Set([legacy.termsHash, consent.termsHash, service.termsHash]).size).toBe(3);
  expect(service.contextHash).toBe(legacy.contextHash);
  const snapshot = readExactContextReservation(f.reservation, f.evidence);
  expect(snapshot.terms).toMatchObject({ serviceMonths: 10, paymentCount: 4, totalCents: 1000000 });
  expect(Object.isFrozen(snapshot.terms)).toBe(true);
  f.terms.serviceMonths = 11; expect(f.plan().termsHash).not.toBe(service.termsHash);
});
test.each([null, undefined, 0, -1, 1.5, "10"])("a present invalid duration %p does not become legacy access", value => {
  const f = fixture(); f.terms.purchaseConsentVersion = FIXED_PURCHASE_CONSENT_VERSION; f.terms.serviceMonths = value;
  expect(f.plan).toThrow();
});
test("duration without consent and duration getters are rejected", () => {
  const f = fixture(); f.terms.serviceMonths = 10; expect(f.plan).toThrow();
  delete f.terms.serviceMonths; f.terms.purchaseConsentVersion = FIXED_PURCHASE_CONSENT_VERSION;
  const getter = jest.fn(() => 10);
  Object.defineProperty(f.terms, "serviceMonths", { enumerable: true, get: getter });
  expect(f.plan).toThrow(); expect(getter).not.toHaveBeenCalled();
});
