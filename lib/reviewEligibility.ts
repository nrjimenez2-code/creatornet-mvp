// lib/reviewEligibility.ts — one definition of "who may review what?"
//
// The authoritative "paid" signal is public.purchases: the webhook /
// confirm-purchase set access_granted=true with status 'paid', and a refund
// flips access_granted=false + status='refunded' (lib/paymentRefunds.ts).
// A purchase is keyed by post_id — an offer IS a post (with a product_id).
//
// v2 (this file): reviews are per OFFER. public.reviews carries post_id
// (supabase/schema/024-reviews-per-post-STAGED.sql), the write gate requires
// a live purchase of THAT post, and the read-time "Verified Purchase" label
// is per post too. Rows written before 024 have post_id NULL; they stay
// visible and keep v1's creator-level label (any live purchase from the
// creator), which is what the creator-level helpers below still serve.
//
// Both the write gate (app/api/reviews) and the labels
// (app/creators/[creatorId]/reviews) derive from the same query shape, so a
// refund removes the label and the right to re-review together.
//
// Like lib/onboardingGate.ts, the viewer lookup lives here (not in the page)
// so the single-auth-flow tripwire's exception list does not grow.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServer } from "@/lib/supabaseServer";

/** Rows in these states no longer count, even if access_granted was once true. */
export const NON_QUALIFYING_PURCHASE_STATUSES = ["refunded", "failed"] as const;

// Messages, the offer shape: lib/reviewMessages.ts (client-safe), re-exported
// so server callers keep one import.
export {
  NO_PURCHASE_FROM_CREATOR_MESSAGE,
  PURCHASE_REQUIRED_CODE,
  PURCHASE_REQUIRED_MESSAGE,
  UNTITLED_OFFER_LABEL,
  type PurchasedPost,
} from "@/lib/reviewMessages";
import { UNTITLED_OFFER_LABEL, type PurchasedPost } from "@/lib/reviewMessages";

/** The service-role client — RLS on purchases is buyer-scoped, and this must answer the same way for every caller. */
type PurchaseReader = Pick<SupabaseClient, "from">;

const notInList = () => `(${NON_QUALIFYING_PURCHASE_STATUSES.join(",")})`;

/** One live purchase row, as much of it as the labels need. */
export type LivePurchase = { buyer_id: string; post_id: string | null };

const offerLabel = (title: unknown): string =>
  typeof title === "string" && title.trim() ? title.trim() : UNTITLED_OFFER_LABEL;

/**
 * Does `buyerId` hold at least one live purchase from `creatorId` (any offer)?
 * v1's creator-level gate. Kept for the legacy label path and for callers
 * that only care about "has this person ever paid this creator".
 * Throws on a query error; the caller decides how to fail.
 */
export async function hasQualifyingPurchase(
  admin: PurchaseReader,
  buyerId: string,
  creatorId: string
): Promise<boolean> {
  const { data, error } = await admin
    .from("purchases")
    .select("id")
    .eq("buyer_id", buyerId)
    .eq("creator_id", creatorId)
    .eq("access_granted", true)
    .not("status", "in", notInList())
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

/**
 * Does `buyerId` hold a live purchase of exactly `postId`? The write gate.
 * Throws on a query error; the route fails closed (a blip should block a
 * review, never open the gate).
 */
export async function hasQualifyingPurchaseForPost(
  admin: PurchaseReader,
  buyerId: string,
  postId: string
): Promise<boolean> {
  const { data, error } = await admin
    .from("purchases")
    .select("id")
    .eq("buyer_id", buyerId)
    .eq("post_id", postId)
    .eq("access_granted", true)
    .not("status", "in", notInList())
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

/**
 * Does `postId` exist and belong to `creatorId`? A review names both, and a
 * post from someone else must be a 400, not a 403 — it is a malformed
 * request, not a missing purchase. Ownership is posts.creator_id, the same
 * column lib/checkoutGuards.ts trusts.
 */
export async function isPostOwnedByCreator(
  admin: PurchaseReader,
  postId: string,
  creatorId: string
): Promise<boolean> {
  const { data, error } = await admin
    .from("posts")
    .select("id, creator_id")
    .eq("id", postId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data) && String((data as { creator_id?: unknown }).creator_id ?? "") === creatorId;
}

/**
 * The offers `buyerId` may review on `creatorId`'s page: every post they hold
 * a live purchase of, restricted to posts that belong to that creator. Two
 * queries rather than an embed so the shape stays plain and mockable.
 * Order follows the posts query (no guarantee); the form preselects the first.
 */
export async function viewerPurchasedPosts(
  admin: PurchaseReader,
  buyerId: string,
  creatorId: string
): Promise<PurchasedPost[]> {
  const { data: rows, error } = await admin
    .from("purchases")
    .select("post_id")
    .eq("buyer_id", buyerId)
    .eq("creator_id", creatorId)
    .eq("access_granted", true)
    .not("status", "in", notInList());

  if (error) throw error;

  const postIds = Array.from(
    new Set(
      ((rows ?? []) as Array<{ post_id: string | null }>)
        .map((row) => row.post_id)
        .filter((id): id is string => Boolean(id))
    )
  );
  if (postIds.length === 0) return [];

  const { data: posts, error: postsError } = await admin
    .from("posts")
    .select("id, title")
    .in("id", postIds)
    .eq("creator_id", creatorId);

  if (postsError) throw postsError;

  return ((posts ?? []) as Array<{ id: string; title: string | null }>).map((post) => ({
    post_id: String(post.id),
    title: offerLabel(post.title),
  }));
}

/**
 * Every live purchase any of `reviewerIds` holds from `creatorId`, with the
 * post it unlocked. One query feeds both label shapes (see isVerifiedPurchase).
 * Computed at read time, so a refund drops the label without touching reviews.
 */
export async function livePurchasesByReviewers(
  admin: PurchaseReader,
  creatorId: string,
  reviewerIds: string[]
): Promise<LivePurchase[]> {
  if (reviewerIds.length === 0) return [];

  const { data, error } = await admin
    .from("purchases")
    .select("buyer_id, post_id")
    .eq("creator_id", creatorId)
    .eq("access_granted", true)
    .in("buyer_id", reviewerIds)
    .not("status", "in", notInList());

  if (error) throw error;

  return ((data ?? []) as Array<{ buyer_id: string | null; post_id: string | null }>)
    .filter((row): row is { buyer_id: string; post_id: string | null } => Boolean(row.buyer_id))
    .map((row) => ({ buyer_id: row.buyer_id, post_id: row.post_id ?? null }));
}

/**
 * Which of `reviewerIds` hold a live purchase from `creatorId` (any offer).
 * v1's creator-level label, now derived from livePurchasesByReviewers.
 */
export async function verifiedReviewerIds(
  admin: PurchaseReader,
  creatorId: string,
  reviewerIds: string[]
): Promise<Set<string>> {
  const rows = await livePurchasesByReviewers(admin, creatorId, reviewerIds);
  return new Set(rows.map((row) => row.buyer_id));
}

/**
 * Should this review wear the "Verified Purchase" label?
 * - A per-offer review (post_id set): only if the reviewer holds a live
 *   purchase of THAT post.
 * - A legacy review (post_id null, written before 024): v1's rule — any live
 *   purchase from the creator.
 */
export function isVerifiedPurchase(
  purchases: LivePurchase[],
  reviewerId: string,
  postId: string | null
): boolean {
  if (postId) {
    return purchases.some((row) => row.buyer_id === reviewerId && row.post_id === postId);
  }
  return purchases.some((row) => row.buyer_id === reviewerId);
}

export type ViewerReviewEligibility = {
  /** null when signed out. */
  viewerId: string | null;
  /** true only for a signed-in viewer with at least one reviewable offer. */
  canReview: boolean;
  /** The offers the viewer may review; empty unless canReview. */
  purchasedPosts: PurchasedPost[];
};

const NOT_ELIGIBLE = (viewerId: string | null): ViewerReviewEligibility => ({
  viewerId,
  canReview: false,
  purchasedPosts: [],
});

/**
 * Server-side: who is looking at this creator's reviews, and which offers may
 * they review? Signed-out and the creator themself both get canReview=false.
 * A lookup error hides the form (the route is the real gate; this only drives
 * the UI).
 */
export async function getViewerReviewEligibility(
  admin: PurchaseReader,
  creatorId: string
): Promise<ViewerReviewEligibility> {
  let user: { id: string } | null = null;
  try {
    const supabase = await createSupabaseServer();
    user = (await supabase.auth.getUser()).data.user;
  } catch (err) {
    // Treat an auth-lookup failure as signed-out: the form still renders and
    // the route stays the real gate. A cosmetic check must never 500 the page.
    console.error("[reviewEligibility] auth lookup failed:", err);
    return NOT_ELIGIBLE(null);
  }

  if (!user) return NOT_ELIGIBLE(null);
  if (user.id === creatorId) return NOT_ELIGIBLE(user.id);

  try {
    const purchasedPosts = await viewerPurchasedPosts(admin, user.id, creatorId);
    return { viewerId: user.id, canReview: purchasedPosts.length > 0, purchasedPosts };
  } catch (err) {
    console.error("[reviewEligibility] purchase lookup failed:", err);
    return NOT_ELIGIBLE(user.id);
  }
}
