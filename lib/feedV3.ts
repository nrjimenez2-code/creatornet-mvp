// lib/feedV3.ts — types + pure mapping for the get_feed_v3 RPC.
// One RPC row carries everything FeedList used to assemble from 7 round trips.

export type FeedTab = "following" | "discover";

/** Row shape returned by public.get_feed_v3 (supabase/schema/014-feed-v3-rpc.sql). */
export type FeedV3Row = {
  post_id: string;
  creator_id: string | null;
  product_id: string | null;
  price_cents: number | null;
  title: string | null;
  video_url: string | null;
  poster_url: string | null;
  interests: string[] | null;
  hashtags: string[] | null;
  created_at: string | null;
  likes_count: number | null;
  comments_count: number | null;
  shares_count: number | null;
  allow_booking: boolean | null;
  booking_url: string | null;
  creator_name: string | null;
  creator_username: string | null;
  creator_avatar_url: string | null;
  product_type: string | null;
  product_price_cents: number | null;
  is_liked: boolean | null;
  is_following: boolean | null;
};

/** What FeedList renders per card (moved here from FeedList so it stays testable). */
export type PostRow = {
  id: string;
  creator_id: string | null;
  product_id: string | null;
  price_cents: number | null;
  creator_name?: string | null;
  /** Handle for /profile/[username] */
  creator_username?: string | null;
  creator_avatar_url?: string | null;
  title: string | null;
  video_url: string | null;
  poster_url: string | null;
  content: string | null;
  interests: string[] | null;
  hashtags?: string[] | null;
  created_at: string | null;
  product_type?: string | null;
  is_following?: boolean | null;
  likes_count?: number | null;
  comments_count?: number | null;
  shares_count?: number | null;
  is_liked?: boolean | null;
  allow_booking?: boolean | null;
  booking_url?: string | null;
  /** When false, hide buy CTA (optional; omitted = allow). */
  creator_can_sell?: boolean | null;
};

/** Hosts that often time out or fail; don't request video from them (show poster only to avoid console errors). */
const UNRELIABLE_VIDEO_HOSTS = ["sample-videos.com"];

export function isUnreliableVideoUrl(url: string | null): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return UNRELIABLE_VIDEO_HOSTS.some((bad) => host === bad || host.endsWith("." + bad));
  } catch {
    return false;
  }
}

/**
 * Price precedence, unchanged from the old waterfall: the post's own price wins
 * when positive, otherwise the product's derived price, otherwise 0.
 */
export function resolvePriceCents(
  postPriceCents: number | null | undefined,
  productPriceCents: number | null | undefined
): number {
  if (typeof postPriceCents === "number" && postPriceCents > 0) return postPriceCents;
  if (typeof productPriceCents === "number" && productPriceCents > 0) return productPriceCents;
  return typeof postPriceCents === "number" ? postPriceCents : 0;
}

/**
 * Keep only real strings from a Postgres text[] — a NULL array element is
 * legal in the database and would otherwise crash render code that calls
 * string methods on it. Exported because FeedList's realtime handler maps
 * raw postgres_changes rows without going through mapFeedV3Row.
 */
export function stringArrayOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((t): t is string => typeof t === "string");
}

/** Map one RPC row to the shape FeedList renders. Pure — no fetches. */
export function mapFeedV3Row(r: FeedV3Row): PostRow {
  const trimmedVideo = typeof r.video_url === "string" ? r.video_url.trim() : null;
  const videoUrl = trimmedVideo && !isUnreliableVideoUrl(trimmedVideo) ? trimmedVideo : null;
  return {
    id: r.post_id,
    creator_id: r.creator_id ?? null,
    product_id: r.product_id ?? null,
    price_cents: resolvePriceCents(r.price_cents, r.product_price_cents),
    title: r.title ?? null,
    video_url: videoUrl,
    poster_url: typeof r.poster_url === "string" ? r.poster_url.trim() : null,
    content: r.title ?? "",
    interests: stringArrayOrNull(r.interests) ?? [],
    hashtags: stringArrayOrNull(r.hashtags),
    created_at: r.created_at ?? null,
    likes_count: r.likes_count ?? 0,
    comments_count: r.comments_count ?? 0,
    shares_count: r.shares_count ?? 0,
    allow_booking: r.allow_booking ?? false,
    booking_url: r.booking_url ?? null,
    product_type: r.product_id ? r.product_type ?? null : null,
    // Same display-name precedence as the old /api/profiles path: a creator
    // with no full_name shows their username, not the generic "Creator".
    creator_name: r.creator_name ?? r.creator_username ?? null,
    creator_username: r.creator_username ?? null,
    creator_avatar_url: r.creator_avatar_url ?? null,
    is_liked: r.is_liked ?? false,
    is_following: r.is_following ?? false,
  };
}

/** Map + drop rows with no renderable media (server filters too; belt and suspenders). */
export function mapFeedV3Rows(rows: unknown): PostRow[] {
  if (!Array.isArray(rows)) return [];
  return (rows as FeedV3Row[])
    .filter((r) => r && typeof r.post_id === "string" && r.post_id.length > 0)
    .map(mapFeedV3Row)
    .filter((p) => p.video_url || p.poster_url);
}

/**
 * Render window for feed virtualization: only posts within `radius` of the
 * active index mount a full VideoCard (and its <video>); the rest render a
 * lightweight placeholder that keeps scroll-snap geometry intact.
 */
export const RENDER_WINDOW_RADIUS = 2;

export function isWithinRenderWindow(
  index: number,
  activeIndex: number,
  radius: number = RENDER_WINDOW_RADIUS
): boolean {
  const anchor = activeIndex < 0 ? 0 : activeIndex;
  return Math.abs(index - anchor) <= radius;
}
