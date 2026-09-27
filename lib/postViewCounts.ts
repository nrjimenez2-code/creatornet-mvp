/** Recorded views, not unique viewers. Null means the reader was unavailable. */
export type VideoPreviewCounts = { view_count?: number | null };
export const POST_VIEW_COUNT_BATCH_SIZE = 100;

export function normalizeViewCount(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function formatViewCount(value: number | null | undefined): string {
  const count = normalizeViewCount(value);
  if (count === null) return "—";
  if (count < 10_000) return count.toLocaleString("en-US");
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(count);
}

export function viewCountLabel(value: number | null | undefined): string {
  const count = normalizeViewCount(value);
  return count === null ? "Views unavailable" : `${count.toLocaleString("en-US")} ${count === 1 ? "view" : "views"}`;
}
