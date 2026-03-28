// lib/updatePostMetrics.ts — server-side helper to increment post_metrics columns
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

/**
 * Increment one or more metric columns for a post.
 * Also recalculates post_conversion_score after every update.
 * Silently no-ops if postId is missing.
 */
export async function updatePostMetrics(
  postId: string | null | undefined,
  fields: Partial<Record<MetricField, number>>,
  watchSeconds?: number // only used when incrementing views
): Promise<void> {
  if (!postId) return;

  const admin = supabaseAdmin();

  try {
    // Fetch current values
    const { data, error } = await admin
      .from("post_metrics")
      .select("impressions, views, total_watch_seconds, completions, profile_clicks, buy_clicks, checkout_starts, purchases")
      .eq("post_id", postId)
      .maybeSingle();

    if (error) {
      console.error("[updatePostMetrics] fetch error:", error);
      return;
    }

    // Use zeros as base if no row exists yet (old posts created before this feature)
    const base = data ?? {
      impressions: 0, views: 0, total_watch_seconds: 0, completions: 0,
      profile_clicks: 0, buy_clicks: 0, checkout_starts: 0, purchases: 0,
    };

    const impressions    = (base.impressions    ?? 0) + (fields.impressions    ?? 0);
    const views          = (base.views          ?? 0) + (fields.views          ?? 0);
    const completions    = (base.completions    ?? 0) + (fields.completions    ?? 0);
    const profile_clicks = (base.profile_clicks ?? 0) + (fields.profile_clicks ?? 0);
    const buy_clicks     = (base.buy_clicks     ?? 0) + (fields.buy_clicks     ?? 0);
    const checkout_starts= (base.checkout_starts?? 0) + (fields.checkout_starts?? 0);
    const purchases      = (base.purchases      ?? 0) + (fields.purchases      ?? 0);
    const total_watch_seconds = (base.total_watch_seconds ?? 0) + (watchSeconds ?? 0);

    // Recalculate conversion score
    const post_conversion_score =
      purchases * 25 +
      checkout_starts * 10 +
      buy_clicks * 5 +
      completions * 3 +
      views * 1;

    await admin
      .from("post_metrics")
      .upsert({
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
  } catch (err) {
    console.error("[updatePostMetrics] error:", err);
  }
}
