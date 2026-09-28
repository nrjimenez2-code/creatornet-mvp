export const INSIGHT_SOURCES = ["discover", "following", "profile", "search", "direct", "unknown"] as const;
export type InsightSource = typeof INSIGHT_SOURCES[number];
export type WatchedInterval = [number, number];
export const insightId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function mergeWatchedIntervals(input: WatchedInterval[]): WatchedInterval[] {
  const result: WatchedInterval[] = [];
  for (const [start, end] of input.slice().sort((a, b) => a[0] - b[0])) {
    const previous = result.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(end, previous[1]);
    else result.push([start, end]);
  }
  return result;
}
export function validInsightUpdate(value: unknown): value is Record<string, unknown> & { sequence: number; seconds: number; intervals: WatchedInterval[] } {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.sequence) && Number(row.sequence) > 0 && Number(row.sequence) <= 1_000_000 &&
    typeof row.seconds === "number" && Number.isFinite(row.seconds) && row.seconds >= 0 && row.seconds <= 43200 &&
    Array.isArray(row.intervals) && row.intervals.length <= 512 && row.intervals.every(interval =>
      Array.isArray(interval) && interval.length === 2 && interval.every(x => typeof x === "number" && Number.isFinite(x)) &&
      interval[0] >= 0 && interval[1] > interval[0] && interval[1] <= 43200);
}
export type InsightAggregate = {
  sessions: number; watch_seconds: number; unique_seconds: number; completions: number; opening: number;
  buckets: number[]; sources: Partial<Record<InsightSource, number>>; collection_started_at: string; updated_at: string;
};
export type VideoInsights = {
  postId: string; title: string; poster: string | null; previewUrl: string | null; duration: number | null;
  collectionStartedAt: string | null; updatedAt: string | null; sampleCount: number; limited: boolean;
  averageWatchTime: number | null; averagePercentageWatched: number | null; completionRate: number | null; threeSecondRetention: number | null;
  retention: { time: number; percentage: number }[]; sources: { source: InsightSource; count: number; percentage: number }[];
};
export function aggregateInsights(aggregate: InsightAggregate | null, duration: number | null) {
  const count = aggregate?.sessions ?? 0;
  const percent = (total: number) => count ? Math.max(0, Math.min(100, total / count * 100)) : null;
  return {
    sampleCount: count, limited: count < 50,
    collectionStartedAt: aggregate?.collection_started_at ?? null, updatedAt: aggregate?.updated_at ?? null,
    averageWatchTime: count ? aggregate!.watch_seconds / count : null,
    averagePercentageWatched: duration ? percent((aggregate?.unique_seconds ?? 0) / duration) : null,
    completionRate: duration ? percent(aggregate?.completions ?? 0) : null,
    threeSecondRetention: duration ? percent(aggregate?.opening ?? 0) : null,
    retention: duration && count ? (aggregate?.buckets ?? []).map((coverage, i, buckets) => ({
      time: i * (duration <= 300 ? 1 : duration / buckets.length), percentage: percent(coverage) ?? 0,
    })) : [],
    sources: INSIGHT_SOURCES.map(source => ({ source, count: aggregate?.sources[source] ?? 0, percentage: percent(aggregate?.sources[source] ?? 0) ?? 0 })),
  };
}
