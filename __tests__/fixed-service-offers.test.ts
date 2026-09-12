import { buildOffers, type OfferProduct } from "@/lib/offers";
import { fixedServiceDescription } from "@/lib/fixedServiceTerms";
import { fixedServiceOffersReady, fixedServiceSchemaReady, readFixedServiceOfferMonths } from "@/lib/fixedServiceOffers";

const NOW = Date.parse("2028-01-31T14:15:16Z") / 1000;
const flags = [
  "CREATOR_FIXED_SERVICE_SCHEMA_READY",
  "CREATOR_FIXED_SERVICE_OFFERS_READY",
  "CREATOR_FIXED_SERVICE_CONTEXT_READY",
  "CREATOR_FIXED_SERVICE_ONE_TIME_READY",
] as const;
const originalEnv = { ...process.env };
beforeEach(() => { for (const flag of flags) delete process.env[flag]; });
afterEach(() => { process.env = { ...originalEnv }; });

test.each(["video", "course", "mentorship"])("reads an independent ten-month %s service", type => {
  expect(readFixedServiceOfferMonths(10, type, false, NOW)).toBe(10);
});
test("service duration is not capped at the installment engine's 24 payments", () => {
  expect(readFixedServiceOfferMonths(25, "mentorship", false, NOW)).toBe(25);
});
test.each([undefined, null])("absence %s never infers a service length", value => {
  expect(readFixedServiceOfferMonths(value, "mentorship", false, NOW)).toBeNull();
  expect(readFixedServiceOfferMonths(value, "mentorship", true, NOW)).toBeNull();
});
test.each([0, -1, 1.5, "10", "", {}, [], true, NaN, Infinity, 2147483648])("rejects invalid service duration %p", value => {
  expect(() => readFixedServiceOfferMonths(value, "course", false, NOW)).toThrow();
});
test("rejects a duration that cannot fit the supported calendar rather than wrapping its date", () => {
  expect(() => readFixedServiceOfferMonths(2147483647, "course", false, NOW)).toThrow();
});
test.each(["call", "unknown"])("does not add fixed service terms to %s", type => {
  expect(() => readFixedServiceOfferMonths(10, type, false, NOW)).toThrow(/fixed-price/);
});
test("does not combine fixed service and monthly membership", () => {
  expect(() => readFixedServiceOfferMonths(10, "mentorship", true, NOW)).toThrow(/fixed-price/);
});
test("creation starts closed", () => {
  expect(fixedServiceOffersReady()).toBe(false);
  expect(fixedServiceSchemaReady()).toBe(false);
});
test.each(flags)("creation needs %s, not only the other gates", flag => {
  for (const key of flags) process.env[key] = "true";
  delete process.env[flag];
  expect(fixedServiceOffersReady()).toBe(false);
});
test("all explicit gates are required and the string false is not truthy", () => {
  for (const key of flags) process.env[key] = "true";
  expect(fixedServiceOffersReady()).toBe(true);
  process.env.CREATOR_FIXED_SERVICE_ONE_TIME_READY = "false";
  expect(fixedServiceOffersReady()).toBe(false);
});
test("stopping new offers keeps schema/history reads available", () => {
  for (const key of flags) process.env[key] = "true";
  process.env.CREATOR_FIXED_SERVICE_OFFERS_READY = "false";
  expect(fixedServiceSchemaReady()).toBe(true);
  expect(fixedServiceOffersReady()).toBe(false);
});

const product: OfferProduct = {
  id: "fixed-product", creator_id: "creator", title: "Ten-month mentorship",
  type: "mentorship", price_cents: 1000000, currency: "usd", active: true,
};
const post = { id: "post", product_id: product.id };
test.each([1, 4, 10])("offer copy keeps ten service months independent of %s payments", paymentCount => {
  const row = { ...product, fixed_service_months: 10, plan_months: paymentCount };
  const [card] = buildOffers([row], [post]);
  expect(card.serviceDescription).toBe(fixedServiceDescription(10));
  expect(card.priceCents).toBe(1000000);
  expect(card.productId).toBe(product.id);
});
test("legacy products and free-booking cards get no fabricated duration", () => {
  const cards = buildOffers([product], [{ ...post, allow_booking: true, booking_url: "https://scheduler.example/free" }]);
  expect(cards).toHaveLength(2);
  expect(cards.every(card => card.serviceDescription === undefined)).toBe(true);
});
