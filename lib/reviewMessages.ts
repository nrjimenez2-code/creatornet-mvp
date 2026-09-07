// lib/reviewMessages.ts — the client-safe half of lib/reviewEligibility.ts.
//
// components/ReviewForm.tsx ("use client") needs the refusal message and the
// offer shape, but lib/reviewEligibility.ts imports lib/supabaseServer
// (next/headers), which cannot be bundled for the browser. Nothing in this
// file may import from a server module.

export const PURCHASE_REQUIRED_CODE = "PURCHASE_REQUIRED";
export const PURCHASE_REQUIRED_MESSAGE =
  "Only customers who bought this offer can leave a review.";
/** The page's note for a signed-in viewer with no live purchase from this creator at all. */
export const NO_PURCHASE_FROM_CREATOR_MESSAGE =
  "Only customers who bought one of this creator's offers can leave a review.";

/** Shown wherever an offer's title is missing (posts.title is nullable). */
export const UNTITLED_OFFER_LABEL = "Untitled offer";

/** An offer the viewer may review: the post they paid for, labelled by its title. */
export type PurchasedPost = { post_id: string; title: string };
