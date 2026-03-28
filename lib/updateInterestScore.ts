// lib/updateInterestScore.ts — server-side helper to upsert user interest scores
import "server-only";
import { createClient } from "@supabase/supabase-js";

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/**
 * Increment a user's interest score for a given category.
 * Silently no-ops if userId or category is missing.
 */
export async function updateInterestScore(
  userId: string | null,
  category: string | null,
  delta: number
): Promise<void> {
  if (!userId || !category || !delta) return;

  const normalizedCategory = category.trim().toLowerCase();
  const admin = supabaseAdmin();

  try {
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
          score: data.score + delta,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .eq("category", normalizedCategory);
    } else {
      await admin
        .from("user_interest_scores")
        .insert({ user_id: userId, category: normalizedCategory, score: delta });
    }
  } catch (err) {
    console.error("[updateInterestScore] error:", err);
  }
}
