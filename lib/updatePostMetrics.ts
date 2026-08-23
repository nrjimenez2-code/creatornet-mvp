// lib/updatePostMetrics.ts — server-side helper to increment post_metrics
// counters AND append a row to post_events for windowed analytics.
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export type MetricField =
  | "impressions"
  | "views"
  | "completions"
  | "profile_clicks"
  | "buy_clicks"
  | "checkout_starts"
  | "purchases";

type EventKind =
  | "impression"
  | "view"
  | "completion"
  | "profile_click"
  | "buy_click"
  | "checkout_start";

// Map cumulative-counter field names → per-event log kinds. `purchases` has
// no event-log entry because the orders table is already the source of truth
// for revenue analytics.
const FIELD_TO_EVENT_KIND: Partial<Record<MetricField, EventKind>> = {
  impressions: "impression",
  views: "view",
  completions: "completion",
  profile_clicks: "profile_click",
  buy_clicks: "buy_click",
  checkout_starts: "checkout_start",
};

/** Longest watch time accepted for one event. Nothing on the site is 12 hours long. */
export const MAX_WATCH_SECONDS = 12 * 60 * 60;

/** Largest per-call delta accepted for any one counter. */
export const MAX_METRIC_DELTA = 1000;

function clampDelta(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_METRIC_DELTA, Math.floor(n));
}

export function clampWatchSeconds(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_WATCH_SECONDS, n);
}

/** Postgres/PostgREST "function does not exist" — the SQL has not been applied yet. */
export function isMissingFunction(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? "");
}

export const POST_CONVERSION_WEIGHTS = {
  purchases: 25,
  checkout_starts: 10,
  buy_clicks: 5,
  completions: 3,
  views: 1,
} as const;

/**
 * Atomic path: one RPC that upserts `counter = counter + delta` inside the
 * database and recomputes post_conversion_score on the same row.
 * Returns false if the function is not installed yet.
 */
async function bumpAtomic(
  admin: SupabaseClient,
  postId: string,
  fields: Partial<Record<MetricField, number>>,
  watchSeconds: number
): Promise<boolean> {
  const { error } = await admin.rpc("bump_post_metrics_scored", {
    p_post_id: postId,
    p_impressions: clampDelta(fields.impressions),
    p_views: clampDelta(fields.views),
    p_completions: clampDelta(fields.completions),
    p_profile_clicks: clampDelta(fields.profile_clicks),
    p_buy_clicks: clampDelta(fields.buy_clicks),
    p_checkout_starts: clampDelta(fields.checkout_starts),
    p_purchases: clampDelta(fields.purchases),
    p_watch_seconds: watchSeconds,
  });
  if (!error) return true;
  if (isMissingFunction(error)) return false;
  console.error("[updatePostMetrics] bump_post_metrics_scored error:", error);
  // The function exists but the call failed; do not fall through to the racy
  // path, that would double-apply on a partial failure.
  return true;
}

/**
 * Legacy read-modify-write. Kept only so that merging the code before
 * supabase/schema/006-atomic-counters.sql is applied cannot break metrics.
 * It is racy: concurrent callers can lose increments. Delete once 006 is live.
 */
async function bumpRacy(
  admin: SupabaseClient,
  postId: string,
  fields: Partial<Record<MetricField, number>>,
  watchSeconds: number
): Promise<void> {
  console.warn(
    "[updatePostMetrics] bump_post_metrics_scored unavailable, falling back to read-modify-write.",
    "Apply supabase/schema/006-atomic-counters.sql to fix this."
  );
  const { data, error } = await admin
    .from("post_metrics")
    .select(
      "impressions, views, total_watch_seconds, completions, profile_clicks, buy_clicks, checkout_starts, purchases"
    )
    .eq("post_id", postId)
    .maybeSingle();

  if (error) {
    console.error("[updatePostMetrics] fetch error:", error);
    return;
  }

  const base = data ?? {
    impressions: 0,
    views: 0,
    total_watch_seconds: 0,
    completions: 0,
    profile_clicks: 0,
    buy_clicks: 0,
    checkout_starts: 0,
    purchases: 0,
  };

  const impressions = (base.impressions ?? 0) + clampDelta(fields.impressions);
  const views = (base.views ?? 0) + clampDelta(fields.views);
  const completions = (base.completions ?? 0) + clampDelta(fields.completions);
  const profile_clicks = (base.profile_clicks ?? 0) + clampDelta(fields.profile_clicks);
  const buy_clicks = (base.buy_clicks ?? 0) + clampDelta(fields.buy_clicks);
  const checkout_starts = (base.checkout_starts ?? 0) + clampDelta(fields.checkout_starts);
  const purchases = (base.purchases ?? 0) + clampDelta(fields.purchases);
  const total_watch_seconds = (base.total_watch_seconds ?? 0) + watchSeconds;

  const post_conversion_score =
    purchases * POST_CONVERSION_WEIGHTS.purchases +
    checkout_starts * POST_CONVERSION_WEIGHTS.checkout_starts +
    buy_clicks * POST_CONVERSION_WEIGHTS.buy_clicks +
    completions * POST_CONVERSION_WEIGHTS.completions +
    views * POST_CONVERSION_WEIGHTS.views;

  await admin.from("post_metrics").upsert({
    post_id: postId,
    impressions,
    views,
    total_watch_seconds,
    completions,
    profile_clicks,
    buy_clicks,
    checkout_starts,
    purchases,
    post_conversion_score,
    updated_at: new Date().toISOString(),
  });
}

/**
 * Increment one or more metric columns for a post.
 * Also recalculates post_conversion_score and appends rows to post_events
 * (when the table exists) for accurate windowed analytics.
 * Silently no-ops if postId is missing.
 */
export async function updatePostMetrics(
  postId: string | null | undefined,
  fields: Partial<Record<MetricField, number>>,
  watchSeconds?: number,
  userId?: string | null
): Promise<void> {
  if (!postId) return;

  const admin = supabaseAdmin();
  const safeWatch = clampWatchSeconds(watchSeconds);

  try {
    // The creator lookup and the counter bump are independent; run both at
    // once (Promise.all, not a lazy thenable) so this hot path costs one
    // round-trip, not two.
    const [postResult, atomic] = await Promise.all([
      admin.from("posts").select("creator_id").eq("id", postId).maybeSingle(),
      bumpAtomic(admin, postId, fields, safeWatch),
    ]);
    if (!atomic) await bumpRacy(admin, postId, fields, safeWatch);

    // Append per-event rows so windowed analytics (creator_kpis,
    // creator_views_timeseries) reflect what actually happened in the window.
    const creatorId = postResult.data?.creator_id ?? null;
    if (creatorId) {
      const eventRows: {
        post_id: string;
        creator_id: string;
        user_id: string | null;
        kind: EventKind;
        watch_seconds: number | null;
      }[] = [];

      for (const [field, count] of Object.entries(fields) as [
        MetricField,
        number | undefined
      ][]) {
        const kind = FIELD_TO_EVENT_KIND[field];
        const n = clampDelta(count);
        if (!kind || n <= 0) continue;
        for (let i = 0; i < n; i++) {
          eventRows.push({
            post_id: postId,
            creator_id: creatorId,
            user_id: userId ?? null,
            kind,
            watch_seconds:
              kind === "view" || kind === "completion" ? (safeWatch || null) : null,
          });
        }
      }

      if (eventRows.length > 0) {
        const { error: evErr } = await admin.from("post_events").insert(eventRows);
        // Ignore "table does not exist" so old DBs without the migration keep working.
        if (evErr && evErr.code !== "42P01") {
          console.error("[updatePostMetrics] post_events insert error:", evErr);
        }
      }
    }
  } catch (err) {
    console.error("[updatePostMetrics] error:", err);
  }
}
