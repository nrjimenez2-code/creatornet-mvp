import { buildOffers, mapProfileGalleryPosts, type OfferProduct } from "@/lib/offers";
const terms = { version: "monthly-mentorship-v1", minimumMonths: 3, autoRenew: true };
const product: OfferProduct = { id: "product", product_id: "alias", creator_id: "creator", title: "A-M1",
  type: "mentorship", membership_terms: terms, price_cents: 10000, active: true };
const post = { id: "post", product_id: "alias", creator_id: "creator", price_cents: 123,
  allow_booking: true, booking_url: "https://booking.invalid", poster_url: "poster.jpg" };
const project = (products: OfferProduct[] | null = [product], posts = [post]) => mapProfileGalleryPosts(posts, products, "creator");
test("gallery and Offers use the same owned product/terms, overriding stale monthly post pricing", () => {
  const [gallery] = project(), [offer] = buildOffers([product], [post]);
  expect(gallery).toMatchObject({ product_id: offer.productId, product_type: "mentorship", monthlyTerms: offer.monthlyTerms,
    price_cents: offer.priceCents, purchaseOptionsReady: true, booking_url: post.booking_url, poster_url: post.poster_url });
  expect(post.price_cents).toBe(123);
});
test("every linked post is enriched even when Offers deduplicates its product", () => {
  const posts = [post, { ...post, id: "second" }];
  expect(project([product], posts).map(p => [p.id, p.purchaseOptionsReady])).toEqual([["post", true], ["second", true]]);
  expect(buildOffers([product], posts).filter(p => p.productId)).toHaveLength(1);
});
test("canonical id wins over an alias and preserves its identity", () => {
  const other = { ...product, id: "alias", product_id: null, price_cents: 20000 };
  expect(project([product, other])[0]).toMatchObject({ product_id: "alias", price_cents: 20000 });
});
test.each([
  ["missing product", []],
  ["failed product read", null],
  ["creator mismatch", [{ ...product, creator_id: "other" }]],
  ["missing creator", [{ ...product, creator_id: null }]],
  ["inactive", [{ ...product, active: false }]],
  ["malformed terms", [{ ...product, membership_terms: { ...terms, minimumMonths: 0 } }]],
  ["monthly terms on course", [{ ...product, type: "course" }]],
  ["conflicting fixed duration", [{ ...product, fixed_service_months: 10 }]],
  ["missing price", [{ ...product, price_cents: null }]],
  ["fractional price", [{ ...product, price_cents: 100.5 }]],
] as [string, OfferProduct[] | null][])("%s blocks Buy without dropping media or Book", (_name, products) => {
  expect(project(products)[0]).toMatchObject({ id: post.id, monthlyTerms: null, purchaseOptionsReady: false,
    allow_booking: true, booking_url: post.booking_url, poster_url: post.poster_url });
});
test("an invalid canonical row cannot fall back to another active product's alias", () => {
  expect(project([product, { ...product, id: "alias", active: false }])[0].purchaseOptionsReady).toBe(false);
});
test("a post owned by someone else cannot borrow this creator's product", () => {
  expect(project([product], [{ ...post, creator_id: "other" }])[0].purchaseOptionsReady).toBe(false);
});
test.each(["course", "video", "mentorship", "call"])("ordinary/fixed %s retains post pricing and free Book", type => {
  expect(project([{ ...product, type, membership_terms: null, fixed_service_months: type === "call" ? null : 10 }])[0])
    .toMatchObject({ product_type: type, monthlyTerms: null, price_cents: 123, purchaseOptionsReady: true, allow_booking: true });
});
