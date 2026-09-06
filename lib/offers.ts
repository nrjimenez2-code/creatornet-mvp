// lib/offers.ts
//
// Pure, server-safe mapping from a creator's `products` + visible `posts`
// rows to the cards the profile "Offers" panel renders. No I/O here so the
// join rule is unit-testable and the page can compute it inside its existing
// Promise.all.
//
// Join rule (same as supabase/schema/014-feed-v3-rpc.sql, ~127-129):
//   a post sells product P when  P.id = post.product_id
//                            or  P.product_id = post.product_id
//   and an `id` match is preferred over a `product_id` match.
//
// "Booking" is not a product type: a post with allow_booking + booking_url
// becomes a CONSULTATION pseudo-card that starts the $0 Stripe setup session
// exactly like VideoCard's Book button.

export type OfferProduct = {
  id: string;
  product_id?: string | null;
  creator_id?: string | null;
  title: string | null;
  description?: string | null;
  type: string | null;
  amount_cents?: number | null;
  price_cents?: number | null;
  currency?: string | null;
  thumbnail_url?: string | null;
  /** null = never set by the composer; only an explicit false hides it. */
  active?: boolean | null;
};

export type OfferPost = {
  id: string;
  title?: string | null;
  poster_url?: string | null;
  product_id?: string | null;
  allow_booking?: boolean | null;
  booking_url?: string | null;
};

export type OfferKind = "course" | "mentorship" | "video" | "consultation";

export type OfferCard = {
  /** Stable React key: `product:<id>` or `booking:<postId>`. */
  key: string;
  kind: OfferKind;
  /** Uppercase type label shown above the title (COURSE / MENTORSHIP / …). */
  label: string;
  title: string;
  description: string | null;
  /** null = no price line (booking cards). */
  priceCents: number | null;
  currency: string;
  /** Linked post's poster, else product thumbnail, else null (type icon). */
  imageUrl: string | null;
  /** The visible post this card is sold through. */
  postId: string;
  /** Product row id (products.id); null for booking cards. */
  productId: string | null;
  /** posts.booking_url; set only on booking cards. */
  bookingUrl: string | null;
  /** Call-to-action text. */
  cta: string;
};

/**
 * Card copy per kind. ONE place to change labels or CTAs.
 * A product `type` not listed here falls back to VIDEO.
 */
export const OFFER_COPY: Record<OfferKind, { label: string; cta: string }> = {
  course: { label: "COURSE", cta: "View course" },
  mentorship: { label: "MENTORSHIP", cta: "Book mentorship" },
  video: { label: "VIDEO", cta: "Buy video" },
  consultation: { label: "CONSULTATION", cta: "Book a call" },
};

/** Default title/description for booking pseudo-cards (post has no title). */
export const BOOKING_CARD_DEFAULTS = {
  title: "1-on-1 call",
  description: "Pick a time that works for you.",
} as const;

const DEFAULT_CURRENCY = "usd";

function kindOf(type: string | null | undefined): OfferKind {
  const t = (type ?? "").toLowerCase();
  if (t === "course" || t === "mentorship") return t;
  return "video";
}

/** Same precedence as the feed RPC: amount_cents when > 0, else price_cents when > 0. */
export function resolvePriceCents(product: Pick<OfferProduct, "amount_cents" | "price_cents">): number | null {
  const amount = Number(product.amount_cents);
  if (Number.isFinite(amount) && amount > 0) return amount;
  const price = Number(product.price_cents);
  if (Number.isFinite(price) && price > 0) return price;
  return null;
}

/** Products whose `active` is explicitly false are hidden; null/undefined count as active. */
function isActive(product: OfferProduct): boolean {
  return product.active !== false;
}

/**
 * Picks the product a post sells: an `id` match wins over a `product_id`
 * match (feed RPC: `order by (pr.id = p.product_id) desc`).
 */
function productForPost(post: OfferPost, products: readonly OfferProduct[]): OfferProduct | null {
  const wanted = post.product_id;
  if (!wanted) return null;
  const byId = products.find((p) => p.id === wanted);
  if (byId) return byId;
  return products.find((p) => p.product_id != null && p.product_id === wanted) ?? null;
}

function productCard(product: OfferProduct, post: OfferPost): OfferCard {
  const kind = kindOf(product.type);
  const copy = OFFER_COPY[kind];
  return {
    key: `product:${product.id}`,
    kind,
    label: copy.label,
    title: (product.title ?? "").trim() || (post.title ?? "").trim() || "Untitled offer",
    description: (product.description ?? "").trim() || null,
    priceCents: resolvePriceCents(product),
    currency: (product.currency ?? "").trim().toLowerCase() || DEFAULT_CURRENCY,
    imageUrl: post.poster_url || product.thumbnail_url || null,
    postId: post.id,
    productId: product.id,
    bookingUrl: null,
    cta: copy.cta,
  };
}

function bookingCard(post: OfferPost): OfferCard {
  const copy = OFFER_COPY.consultation;
  return {
    key: `booking:${post.id}`,
    kind: "consultation",
    label: copy.label,
    title: (post.title ?? "").trim() || BOOKING_CARD_DEFAULTS.title,
    description: BOOKING_CARD_DEFAULTS.description,
    priceCents: null,
    currency: DEFAULT_CURRENCY,
    imageUrl: post.poster_url || null,
    postId: post.id,
    productId: null,
    bookingUrl: (post.booking_url ?? "").trim() || null,
    cta: copy.cta,
  };
}

/**
 * Builds the Offers panel cards.
 *
 * - `posts` must already be the creator's VISIBLE posts (onlyVisiblePosts),
 *   newest first — a product without a visible post is never shown.
 * - One card per product (first/newest post wins for the image).
 * - One booking card per booking-enabled post with a booking_url, even when
 *   the same post also sells a product.
 * - Order: product cards in post order, then booking cards.
 */
export function buildOffers(
  products: readonly OfferProduct[] | null | undefined,
  posts: readonly OfferPost[] | null | undefined,
): OfferCard[] {
  const productRows = (products ?? []).filter(isActive);
  const postRows = posts ?? [];

  const seenProducts = new Set<string>();
  const productCards = postRows.reduce<OfferCard[]>((cards, post) => {
    const product = productForPost(post, productRows);
    if (!product || seenProducts.has(product.id)) return cards;
    seenProducts.add(product.id);
    return [...cards, productCard(product, post)];
  }, []);

  const seenBookingPosts = new Set<string>();
  const bookingCards = postRows.reduce<OfferCard[]>((cards, post) => {
    if (post.allow_booking !== true) return cards;
    if (!(post.booking_url ?? "").trim()) return cards;
    if (seenBookingPosts.has(post.id)) return cards;
    seenBookingPosts.add(post.id);
    return [...cards, bookingCard(post)];
  }, []);

  return [...productCards, ...bookingCards];
}

/** "$97" for whole dollars, "$19.99" otherwise. */
export function formatOfferPrice(priceCents: number, currency: string): string {
  const dollars = priceCents / 100;
  const digits = Number.isInteger(dollars) ? 0 : 2;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(dollars);
  } catch {
    return `$${dollars.toFixed(digits)}`;
  }
}
