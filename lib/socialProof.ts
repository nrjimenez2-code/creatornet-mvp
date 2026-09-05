// lib/socialProof.ts — pure "126 students / 38 purchases" social-proof copy.
// Reads posts.purchase_count (maintained atomically by credit_purchase_earnings
// / reverse_purchase_earnings; browsers cannot write it). Nothing here fetches.

/**
 * Minimum purchase_count before the line renders. Noah to choose; suggested 5.
 * MAX_SAFE_INTEGER = feature OFF: no card can ever reach it, so shipped UI is unchanged.
 */
export const SOCIAL_PROOF_MIN_COUNT = Number.MAX_SAFE_INTEGER;

const COURSE_TYPE = "course";

function nounFor(productType: string | null | undefined, count: number): string {
  const isCourse = typeof productType === "string" && productType.toLowerCase() === COURSE_TYPE;
  if (isCourse) return count === 1 ? "student" : "students";
  return count === 1 ? "purchase" : "purchases";
}

/**
 * Same as formatSocialProof but with an explicit threshold — exists so tests
 * can exercise the on/off boundary while the shipped constant stays OFF.
 */
export function formatSocialProofWithMin(
  count: number | null | undefined,
  productType: string | null | undefined,
  min: number
): string | null {
  if (typeof count !== "number" || Number.isNaN(count)) return null;
  if (count < min) return null;
  return `${count} ${nounFor(productType, count)}`;
}

/** "1 student" / "N students" for courses, "1 purchase" / "N purchases" otherwise; null when hidden. */
export function formatSocialProof(
  count: number | null | undefined,
  productType: string | null | undefined
): string | null {
  return formatSocialProofWithMin(count, productType, SOCIAL_PROOF_MIN_COUNT);
}
