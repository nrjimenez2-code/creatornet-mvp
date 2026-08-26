// lib/postCounters.ts — race-free like counting
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingFunction } from "@/lib/updatePostMetrics";

/**
 * Move a post's like count by exactly one, without a lost-update race.
 *
 * ## The race this replaces
 *
 * The like route used to do: SELECT likes_count → add or subtract one in
 * JavaScript → UPDATE with the computed value. Two people liking the same post
 * at the same moment both read N and both write N+1, so the post ends on N+1
 * instead of N+2. Under-counting also feeds the recommendation logic bad data,
 * which is exactly what the pre-launch spec flags in Priority 4.
 *
 * ## How this avoids it
 *
 * `bump_post_likes` does the arithmetic inside a single UPDATE statement
 * (`likes_count = greatest(0, coalesce(likes_count,0) + p_delta) ... RETURNING`),
 * so Postgres serialises concurrent callers on the row itself. There is no
 * read-then-write window, and the new value comes back in the same round trip.
 *
 * ## Fallback, and why it exists
 *
 * `bump_post_likes` ships as a database function that the founder runs by hand
 * (his database, his SQL editor — this side has read-only access by design). If
 * it has not been created yet, the RPC 404s and we fall back to the old
 * read-modify-write so that liking keeps working. The fallback is racy; it is
 * there so that merging this before the SQL runs cannot break the button.
 *
 * Once the SQL is applied the fallback stops being reachable and can be deleted.
 * `usedFallback` is returned so a caller (or a log scan) can tell which path ran.
 */
export async function bumpPostLikes(
  admin: SupabaseClient,
  postId: string,
  delta: 1 | -1
): Promise<{ count: number | null; usedFallback: boolean }> {
  const { data, error } = await admin.rpc("bump_post_likes", {
    p_post_id: postId,
    p_delta: delta,
  });

  if (!error && typeof data === "number") {
    return { count: data, usedFallback: false };
  }
  if (error && !isMissingFunction(error)) {
    // The function exists and the call failed (permissions, bad id). Do not
    // paper over that with the racy path; report it.
    console.error("[post-counters] bump_post_likes error:", error.message);
    return { count: null, usedFallback: false };
  }

  console.warn(
    "[post-counters] bump_post_likes unavailable, falling back to a racy read-modify-write.",
    "Apply docs/plan/sql/02-counters.sql to fix this.",
    error?.message ?? "(no error message)"
  );

  const { data: post, error: readErr } = await admin
    .from("posts")
    .select("likes_count")
    .eq("id", postId)
    .single();

  if (readErr || !post) {
    return { count: null, usedFallback: true };
  }

  const current = (post.likes_count as number) ?? 0;
  const next = Math.max(0, current + delta);

  const { error: writeErr } = await admin
    .from("posts")
    .update({ likes_count: next })
    .eq("id", postId);

  return { count: writeErr ? null : next, usedFallback: true };
}

/**
 * Same contract as bumpPostLikes, for posts.comments_count.
 * Atomic via `bump_post_comments` (supabase/schema/006-atomic-counters.sql);
 * falls back to the old read-modify-write until that SQL is applied.
 */
export async function bumpPostComments(
  admin: SupabaseClient,
  postId: string,
  delta: 1 | -1
): Promise<{ count: number | null; usedFallback: boolean }> {
  const { data, error } = await admin.rpc("bump_post_comments", {
    p_post_id: postId,
    p_delta: delta,
  });

  if (!error && typeof data === "number") {
    return { count: data, usedFallback: false };
  }
  if (error && !isMissingFunction(error)) {
    // The function exists and the call failed (permissions, bad id). Do not
    // paper over that with the racy path; report it.
    console.error("[post-counters] bump_post_comments error:", error.message);
    return { count: null, usedFallback: false };
  }

  console.warn(
    "[post-counters] bump_post_comments unavailable, falling back to a racy read-modify-write.",
    "Apply supabase/schema/006-atomic-counters.sql to fix this.",
    error?.message ?? "(no error message)"
  );

  const { data: post, error: readErr } = await admin
    .from("posts")
    .select("comments_count")
    .eq("id", postId)
    .single();

  if (readErr || !post) {
    return { count: null, usedFallback: true };
  }

  const current = (post.comments_count as number) ?? 0;
  const next = Math.max(0, current + delta);

  const { error: writeErr } = await admin
    .from("posts")
    .update({ comments_count: next })
    .eq("id", postId);

  return { count: writeErr ? null : next, usedFallback: true };
}
