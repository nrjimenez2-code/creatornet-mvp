// lib/updatePostMetrics.ts — server-side helper to increment post_metrics
// counters AND append a row to post_events for windowed analytics.
import "server-only";
import { createClient } from "@supabase/supabase-js";

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

type MetricField =
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

  try {
    const [metricsResult, postResult] = await Promise.all([
      admin
        .from("post_metrics")
        .select(
          "impressions, views, total_watch_seconds, completions, profile_clicks, buy_clicks, checkout_starts, purchases"
        )
        .eq("post_id", postId)
        .maybeSingle(),
      admin.from("posts").select("creator_id").eq("id", postId).maybeSingle(),
    ]);

    if (metricsResult.error) {
      console.error("[updatePostMetrics] fetch error:", metricsResult.error);
      return;
    }

    const base = metricsResult.data ?? {
      impressions: 0,
      views: 0,
      total_watch_seconds: 0,
      completions: 0,
      profile_clicks: 0,
      buy_clicks: 0,
      checkout_starts: 0,
      purchases: 0,
    };

    const impressions = (base.impressions ?? 0) + (fields.impressions ?? 0);
    const views = (base.views ?? 0) + (fields.views ?? 0);
    const completions = (base.completions ?? 0) + (fields.completions ?? 0);
    const profile_clicks = (base.profile_clicks ?? 0) + (fields.profile_clicks ?? 0);
    const buy_clicks = (base.buy_clicks ?? 0) + (fields.buy_clicks ?? 0);
    const checkout_starts = (base.checkout_starts ?? 0) + (fields.checkout_starts ?? 0);
    const purchases = (base.purchases ?? 0) + (fields.purchases ?? 0);
    const total_watch_seconds = (base.total_watch_seconds ?? 0) + (watchSeconds ?? 0);

    const post_conversion_score =
      purchases * 25 +
      checkout_starts * 10 +
      buy_clicks * 5 +
      completions * 3 +
      views * 1;

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
        if (!kind || !count || count <= 0) continue;
        for (let i = 0; i < count; i++) {
          eventRows.push({
            post_id: postId,
            creator_id: creatorId,
            user_id: userId ?? null,
            kind,
            watch_seconds:
              kind === "view" || kind === "completion"
                ? watchSeconds ?? null
                : null,
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
