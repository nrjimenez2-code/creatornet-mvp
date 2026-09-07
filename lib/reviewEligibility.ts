// lib/reviewEligibility.ts — one definition of "who may review this creator?"
//
// Reviews are per creator (public.reviews UNIQUE (reviewer_id, creator_id)).
// Until this file existed any signed-in account could review any creator it
// had never paid. The authoritative "paid" signal is public.purchases: the
// webhook / confirm-purchase set access_granted=true with status 'paid', and a
// refund flips access_granted=false + status='refunded' (lib/paymentRefunds.ts).
//
// Both the write gate (app/api/reviews) and the read-time "Verified Purchase"
// label (app/creators/[creatorId]/reviews) derive from the same query shape,
// so a refund removes the label and the right to re-review together — no
// column on reviews, no migration.
//
// v1 gates on ANY qualifying purchase from the creator, not a specific offer:
// reviews carry no post/product id, and adding one is a prod migration.
//
// Like lib/onboardingGate.ts, the viewer lookup lives here (not in the page)
// so the single-auth-flow tripwire's exception list does not grow.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServer } from "@/lib/supabaseServer";

/** Rows in these states no longer count, even if access_granted was once true. */
export const NON_QUALIFYING_PURCHASE_STATUSES = ["refunded", "failed"] as const;

export const PURCHASE_REQUIRED_CODE = "PURCHASE_REQUIRED";
export const PURCHASE_REQUIRED_MESSAGE =
  "Only customers who bought from this creator can leave a review.";

/** The service-role client — RLS on purchases is buyer-scoped, and this must answer the same way for every caller. */
type PurchaseReader = Pick<SupabaseClient, "from">;

const notInList = () => `(${NON_QUALIFYING_PURCHASE_STATUSES.join(",")})`;

/**
 * Does `buyerId` hold at least one live purchase from `creatorId`?
 * Throws on a query error; the caller decides how to fail (the write gate
 * fails closed — a blip should block a review, never open the gate).
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
 * Which of `reviewerIds` hold a live purchase from `creatorId`. Computed at
 * read time, so a refund drops the label without touching reviews.
 */
export async function verifiedReviewerIds(
  admin: PurchaseReader,
  creatorId: string,
  reviewerIds: string[]
): Promise<Set<string>> {
  if (reviewerIds.length === 0) return new Set();

  const { data, error } = await admin
    .from("purchases")
    .select("buyer_id")
    .eq("creator_id", creatorId)
    .eq("access_granted", true)
    .in("buyer_id", reviewerIds)
    .not("status", "in", notInList());

  if (error) throw error;

  const ids = ((data ?? []) as Array<{ buyer_id: string | null }>)
    .map((row) => row.buyer_id)
    .filter((id): id is string => Boolean(id));
  return new Set(ids);
}

export type ViewerReviewEligibility = {
  /** null when signed out. */
  viewerId: string | null;
  /** true only for a signed-in viewer with a live purchase from this creator. */
  canReview: boolean;
};

/**
 * Server-side: who is looking at this creator's reviews, and may they write
 * one? Signed-out and the creator themself both get canReview=false. A lookup
 * error hides the form (the route is the real gate; this only drives the UI).
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
    return { viewerId: null, canReview: false };
  }

  if (!user) return { viewerId: null, canReview: false };
  if (user.id === creatorId) return { viewerId: user.id, canReview: false };

  try {
    const canReview = await hasQualifyingPurchase(admin, user.id, creatorId);
    return { viewerId: user.id, canReview };
  } catch (err) {
    console.error("[reviewEligibility] purchase lookup failed:", err);
    return { viewerId: user.id, canReview: false };
  }
}
