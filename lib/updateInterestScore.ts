// lib/updateInterestScore.ts — server-side helper to upsert user interest scores
import "server-only";
import { createClient } from "@supabase/supabase-js";
import { toInterestCategory } from "@/lib/interestCategories";
import { isMissingFunction } from "@/lib/updatePostMetrics";

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/**
 * Increment a user's interest score for a given category.
 *
 * The category must be one of the known interest categories
 * (lib/interestCategories.ts); anything else is ignored so that the
 * user_interest_scores table only ever holds rows the feed can use.
 * Silently no-ops if userId, category or delta is missing.
 */
export async function updateInterestScore(
  userId: string | null,
  category: string | null,
  delta: number
): Promise<void> {
  if (!userId || !category) return;
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta === 0) return;

  const normalizedCategory = toInterestCategory(category);
  if (!normalizedCategory) return;

  const admin = supabaseAdmin();
  const intDelta = Math.trunc(delta);

  try {
    // Atomic path: `score = score + delta` inside the database.
    const { error } = await admin.rpc("bump_interest_score", {
      p_user_id: userId,
      p_category: normalizedCategory,
      p_delta: intDelta,
    });
    if (!error) return;
    if (!isMissingFunction(error)) {
      console.error("[updateInterestScore] bump_interest_score error:", error);
      return;
    }

    // Fallback until supabase/schema/006-atomic-counters.sql is applied.
    // Racy: two concurrent calls can lose one increment.
    console.warn(
      "[updateInterestScore] bump_interest_score unavailable, falling back to read-modify-write.",
      "Apply supabase/schema/006-atomic-counters.sql to fix this."
    );
    const { data } = await admin
      .from("user_interest_scores")
      .select("score")
      .eq("user_id", userId)
      .eq("category", normalizedCategory)
      .maybeSingle();

    if (data) {
      await admin
        .from("user_interest_scores")
        .update({
          score: data.score + intDelta,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .eq("category", normalizedCategory);
    } else {
      await admin
        .from("user_interest_scores")
        .insert({ user_id: userId, category: normalizedCategory, score: intDelta });
    }
  } catch (err) {
    console.error("[updateInterestScore] error:", err);
  }
}
