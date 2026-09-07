/**
 * lib/offers.ts — the pure product/post → Offers-card mapping behind the
 * creator-profile "Offers" panel.
 *
 * Locks the join rule shared with get_feed_v3 (supabase/schema/014):
 * `products.id = posts.product_id` preferred over
 * `products.product_id = posts.product_id`, price precedence
 * amount_cents > price_cents, inactive/orphan products excluded, and one
 * CONSULTATION pseudo-card per booking-enabled post.
 */

import {
  BOOKING_CARD_DEFAULTS,
  OFFER_COPY,
  buildOffers,
  formatOfferPrice,
  resolvePriceCents,
  type OfferPost,
  type OfferProduct,
} from "@/lib/offers";

const product = (overrides: Partial<OfferProduct> & { id: string }): OfferProduct => ({
  product_id: null,
  title: `Product ${overrides.id}`,
  description: null,
  type: "course",
  amount_cents: 9700,
  price_cents: null,
  currency: "usd",
  thumbnail_url: null,
  active: null,
  ...overrides,
});

const post = (overrides: Partial<OfferPost> & { id: string }): OfferPost => ({
  title: null,
  poster_url: null,
  product_id: null,
  allow_booking: false,
  booking_url: null,
  ...overrides,
});

describe("buildOffers — product cards", () => {
  test("joins a post to its product by products.id", () => {
    const cards = buildOffers(
      [product({ id: "prod_1", title: "Creator Growth Blueprint" })],
      [post({ id: "post_1", product_id: "prod_1", poster_url: "https://cdn/p1.jpg" })],
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      key: "product:prod_1",
      kind: "course",
      label: "COURSE",
      cta: "View course",
      title: "Creator Growth Blueprint",
      priceCents: 9700,
      currency: "usd",
      imageUrl: "https://cdn/p1.jpg",
      postId: "post_1",
      productId: "prod_1",
      bookingUrl: null,
    });
  });

  test("also joins by products.product_id (legacy rows)", () => {
    const cards = buildOffers(
      [product({ id: "row_9", product_id: "legacy_1" })],
      [post({ id: "post_1", product_id: "legacy_1" })],
    );

    expect(cards.map((c) => c.productId)).toEqual(["row_9"]);
  });

  test("prefers the products.id match over a products.product_id match", () => {
    const cards = buildOffers(
      [
        product({ id: "other", product_id: "shared", title: "Wrong" }),
        product({ id: "shared", product_id: null, title: "Right" }),
      ],
      [post({ id: "post_1", product_id: "shared" })],
    );

    expect(cards.map((c) => c.title)).toEqual(["Right"]);
  });

  test("excludes products whose active is explicitly false, keeps null/undefined/true", () => {
    const cards = buildOffers(
      [
        product({ id: "off", active: false }),
        product({ id: "unset", active: null }),
        product({ id: "on", active: true }),
      ],
      [
        post({ id: "p1", product_id: "off" }),
        post({ id: "p2", product_id: "unset" }),
        post({ id: "p3", product_id: "on" }),
      ],
    );

    expect(cards.map((c) => c.productId)).toEqual(["unset", "on"]);
  });

  test("excludes products with no visible post selling them", () => {
    const cards = buildOffers(
      [product({ id: "orphan" }), product({ id: "sold" })],
      [post({ id: "p1", product_id: "sold" }), post({ id: "p2", product_id: null })],
    );

    expect(cards.map((c) => c.productId)).toEqual(["sold"]);
  });

  test("one card per product even when several posts sell it; newest post supplies the image", () => {
    const cards = buildOffers(
      [product({ id: "prod_1" })],
      [
        post({ id: "newest", product_id: "prod_1", poster_url: "https://cdn/new.jpg" }),
        post({ id: "older", product_id: "prod_1", poster_url: "https://cdn/old.jpg" }),
      ],
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].postId).toBe("newest");
    expect(cards[0].imageUrl).toBe("https://cdn/new.jpg");
  });

  test("price falls back from amount_cents to price_cents, and null when neither is positive", () => {
    expect(resolvePriceCents({ amount_cents: 9700, price_cents: 100 })).toBe(9700);
    expect(resolvePriceCents({ amount_cents: 0, price_cents: 4900 })).toBe(4900);
    expect(resolvePriceCents({ amount_cents: null, price_cents: 4900 })).toBe(4900);
    expect(resolvePriceCents({ amount_cents: 0, price_cents: 0 })).toBeNull();
    expect(resolvePriceCents({ amount_cents: null, price_cents: null })).toBeNull();

    const cards = buildOffers(
      [product({ id: "prod_1", amount_cents: 0, price_cents: 4900 })],
      [post({ id: "p1", product_id: "prod_1" })],
    );
    expect(cards[0].priceCents).toBe(4900);
  });

  test("image falls back to the product thumbnail, then null for the type icon", () => {
    const withThumb = buildOffers(
      [product({ id: "a", thumbnail_url: "https://cdn/thumb.jpg" })],
      [post({ id: "p1", product_id: "a", poster_url: null })],
    );
    expect(withThumb[0].imageUrl).toBe("https://cdn/thumb.jpg");

    const none = buildOffers([product({ id: "b" })], [post({ id: "p2", product_id: "b" })]);
    expect(none[0].imageUrl).toBeNull();
  });

  test("maps product types to labels/CTAs; unknown types read as VIDEO", () => {
    const cards = buildOffers(
      [
        product({ id: "c", type: "course" }),
        product({ id: "m", type: "mentorship" }),
        product({ id: "v", type: "video" }),
        product({ id: "x", type: "something-else" }),
      ],
      [
        post({ id: "p1", product_id: "c" }),
        post({ id: "p2", product_id: "m" }),
        post({ id: "p3", product_id: "v" }),
        post({ id: "p4", product_id: "x" }),
      ],
    );

    expect(cards.map((c) => [c.label, c.cta])).toEqual([
      [OFFER_COPY.course.label, OFFER_COPY.course.cta],
      [OFFER_COPY.mentorship.label, OFFER_COPY.mentorship.cta],
      [OFFER_COPY.video.label, OFFER_COPY.video.cta],
      [OFFER_COPY.video.label, OFFER_COPY.video.cta],
    ]);
  });

  test("blank description becomes null; blank title falls back to the post title", () => {
    const cards = buildOffers(
      [product({ id: "a", title: "  ", description: "   " })],
      [post({ id: "p1", product_id: "a", title: "From the post" })],
    );

    expect(cards[0].title).toBe("From the post");
    expect(cards[0].description).toBeNull();
  });

  test("tolerates null inputs", () => {
    expect(buildOffers(null, null)).toEqual([]);
    expect(buildOffers(undefined, [post({ id: "p1", product_id: "x" })])).toEqual([]);
  });
});

describe("buildOffers — booking pseudo-cards", () => {
  test("a booking-enabled post with a booking_url becomes one CONSULTATION card", () => {
    const cards = buildOffers(
      [],
      [post({ id: "p1", title: "30-Min Strategy Call", allow_booking: true, booking_url: "https://cal.com/x" })],
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      key: "booking:p1",
      kind: "consultation",
      label: "CONSULTATION",
      cta: "Book a call",
      title: "30-Min Strategy Call",
      description: BOOKING_CARD_DEFAULTS.description,
      priceCents: null,
      postId: "p1",
      productId: null,
      bookingUrl: "https://cal.com/x",
    });
  });

  test("posts without allow_booking, or with a blank booking_url, produce no booking card", () => {
    const cards = buildOffers(
      [],
      [
        post({ id: "p1", allow_booking: false, booking_url: "https://cal.com/x" }),
        post({ id: "p2", allow_booking: true, booking_url: "   " }),
        post({ id: "p3", allow_booking: true, booking_url: null }),
      ],
    );

    expect(cards).toEqual([]);
  });

  test("de-duplicates to one booking card per post", () => {
    const dup = post({ id: "p1", allow_booking: true, booking_url: "https://cal.com/x" });
    const cards = buildOffers([], [dup, { ...dup }]);

    expect(cards.map((c) => c.key)).toEqual(["booking:p1"]);
  });

  test("a post that sells a product AND accepts bookings yields both cards, products first", () => {
    const cards = buildOffers(
      [product({ id: "prod_1" })],
      [post({ id: "p1", product_id: "prod_1", allow_booking: true, booking_url: "https://cal.com/x" })],
    );

    expect(cards.map((c) => c.key)).toEqual(["product:prod_1", "booking:p1"]);
  });

  test("untitled booking post uses the default card title", () => {
    const cards = buildOffers([], [post({ id: "p1", allow_booking: true, booking_url: "/api/book?creator_id=c" })]);
    expect(cards[0].title).toBe(BOOKING_CARD_DEFAULTS.title);
  });
});

describe("formatOfferPrice", () => {
  test("whole dollars have no cents; fractional prices show two decimals", () => {
    expect(formatOfferPrice(9700, "usd")).toBe("$97");
    expect(formatOfferPrice(1999, "usd")).toBe("$19.99");
  });
});
