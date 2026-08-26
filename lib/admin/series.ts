/**
 * Time-series helpers for Admin Launch Board charts.
 *
 * All series are DERIVED from the row data (orders, users, videos) so a chart
 * can never disagree with the tables or stat cards next to it. Everything is
 * anchored to the demo "today" instead of Date.now() so server and client
 * render identical SVG (no hydration mismatch).
 *
 * INTEGRATION: in the real app these become small SQL aggregates
 * (e.g. `select date_trunc('day', created_at), sum(gross_cents) ...`) — the
 * chart components take plain number[] and need no changes.
 */

/** Demo "today" — matches the newest timestamps in mock-data. */
export const DEMO_TODAY_ISO = "2026-08-01T23:59:59Z";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayIndexFromEnd(iso: string, endIso: string): number {
  const end = new Date(endIso).setUTCHours(0, 0, 0, 0);
  const day = new Date(iso).setUTCHours(0, 0, 0, 0);
  return Math.round((end - day) / MS_PER_DAY);
}

/**
 * Bucket items into daily totals for the trailing `days` window ending at
 * `endIso` (inclusive). Returns oldest → newest.
 */
export function dailyTotals<T>(
  items: T[],
  getIso: (item: T) => string,
  getValue: (item: T) => number,
  days: number,
  endIso: string = DEMO_TODAY_ISO,
): number[] {
  const buckets = new Array<number>(days).fill(0);
  for (const item of items) {
    const fromEnd = dayIndexFromEnd(getIso(item), endIso);
    const index = days - 1 - fromEnd;
    if (index >= 0 && index < days) {
      buckets[index] += getValue(item);
    }
  }
  return buckets;
}

/** Running total of a daily series, starting from `base`. */
export function accumulate(series: number[], base = 0): number[] {
  let running = base;
  return series.map((value) => {
    running += value;
    return running;
  });
}

/** Short axis labels ("Jul 26") for the trailing `days` window. */
export function dayLabels(days: number, endIso: string = DEMO_TODAY_ISO): string[] {
  const end = new Date(endIso);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(end.getTime() - (days - 1 - index) * MS_PER_DAY);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  });
}
