// lib/interestCategories.ts — the closed set of interest categories.
//
// Interest scores drive the personalised feed (get_feed_v2 joins
// user_interest_scores.category against LOWER(posts.interests[*])). A row
// with a category that no post will ever carry is dead weight at best; at
// worst it is a write path anyone can spam. The list below mirrors the
// onboarding picker in app/onboarding/page.tsx, lowercased, which is exactly
// the form already stored in production.

export const INTEREST_CATEGORIES = [
  "entrepreneurship",
  "money & investing",
  "social media growth",
  "content creation",
  "online skills",
  "health & fitness",
  "self improvement",
  "tech & ai automation",
] as const;

export type InterestCategory = (typeof INTEREST_CATEGORIES)[number];

const KNOWN = new Set<string>(INTEREST_CATEGORIES);

/**
 * Normalise a raw category string to its canonical stored form, or null if
 * it is not one of the known categories. Whitespace and case are forgiven;
 * nothing else is.
 */
export function toInterestCategory(raw: unknown): InterestCategory | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return KNOWN.has(key) ? (key as InterestCategory) : null;
}

/**
 * The score deltas the product spec allows (docs/MY_TASKS.md, Task 2).
 * Anything else from a client is rejected rather than clamped, so a bad
 * caller cannot nudge scores by arbitrary or negative amounts.
 */
export const ALLOWED_INTEREST_DELTAS = new Set<number>([1, 2, 3, 4, 5, 10, 15, 25]);

export function isAllowedInterestDelta(delta: unknown): delta is number {
  return typeof delta === "number" && ALLOWED_INTEREST_DELTAS.has(delta);
}
