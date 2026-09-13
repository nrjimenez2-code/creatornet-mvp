/** Shared taxonomy. Stored keys are lowercase; labels are presentation only. */
export const INTEREST_LABELS = [
  "Business & Entrepreneurship", "Money & Investing", "Content Creation & Marketing",
  "Technology & AI", "Health & Fitness", "Personal Growth & Relationships",
  "Arts, Design & Hobbies", "Education & Career Skills",
] as const;
export const INTEREST_CATEGORIES = [
  "business & entrepreneurship", "money & investing", "content creation & marketing",
  "technology & ai", "health & fitness", "personal growth & relationships",
  "arts, design & hobbies", "education & career skills",
] as const;
export type InterestCategory = (typeof INTEREST_CATEGORIES)[number];
export type InterestLabel = (typeof INTEREST_LABELS)[number];
/** Old clients remain compatible; aliases never create extra categories. */
export const LEGACY_INTEREST_ALIASES: Record<string, InterestCategory> = {
  entrepreneurship: "business & entrepreneurship",
  "social media growth": "content creation & marketing",
  "content creation": "content creation & marketing",
  "online skills": "education & career skills",
  "self improvement": "personal growth & relationships",
  "tech & ai automation": "technology & ai",
};
const KNOWN = new Set<string>(INTEREST_CATEGORIES);
export function toInterestCategory(raw: unknown): InterestCategory | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return KNOWN.has(key) ? key as InterestCategory : LEGACY_INTEREST_ALIASES[key] ?? null;
}
export function normalizeInterests(raw: unknown): InterestCategory[] {
  return [...new Set((Array.isArray(raw) ? raw : [raw]).map(toInterestCategory)
    .filter((v): v is InterestCategory => v !== null))];
}
export function interestLabel(raw: unknown): InterestLabel | null {
  const key = toInterestCategory(raw);
  return key ? INTEREST_LABELS[INTEREST_CATEGORIES.indexOf(key)] : null;
}
// Legacy callers only. Browser deltas must never authorize conversions.
export const ALLOWED_INTEREST_DELTAS = new Set<number>([1, 2, 3, 4, 5, 10, 15, 25]);
export function isAllowedInterestDelta(delta: unknown): delta is number {
  return typeof delta === "number" && ALLOWED_INTEREST_DELTAS.has(delta);
}
