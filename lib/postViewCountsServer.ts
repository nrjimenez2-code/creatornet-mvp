import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeViewCount, POST_VIEW_COUNT_BATCH_SIZE } from "@/lib/postViewCounts";

/** Call only after authorizing the preview rows. Never reads viewer identities. */
export async function readPostViewCounts(admin: SupabaseClient, postIds: readonly string[]) {
  const ids = [...new Set(postIds)];
  const counts = new Map<string, number | null>(ids.map(id => [id, null]));
  for (let offset = 0; offset < ids.length; offset += POST_VIEW_COUNT_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + POST_VIEW_COUNT_BATCH_SIZE);
    try {
      const { data, error } = await admin.rpc("get_post_view_counts_v1", { p_post_ids: batch });
      if (error || !Array.isArray(data)) throw new Error("View reader unavailable");
      const wanted = new Set(batch);
      for (const row of data) {
        if (row && wanted.has(row.post_id)) counts.set(row.post_id, normalizeViewCount(row.view_count));
      }
    } catch {
      console.warn("[post-view-counts] recorded view counts unavailable");
    }
  }
  return counts;
}

export async function enrichPostViewCounts<T extends { id: string }>(admin: SupabaseClient, posts: readonly T[]) {
  const counts = await readPostViewCounts(admin, posts.map(post => post.id));
  return posts.map(post => ({ ...post, view_count: counts.get(post.id) ?? null }));
}
