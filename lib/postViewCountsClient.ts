import { normalizeViewCount, POST_VIEW_COUNT_BATCH_SIZE } from "@/lib/postViewCounts";

/** One bounded read per loaded batch. No timer, interaction handler or view write. */
export async function loadPostViewCounts(postIds: readonly string[], options: {
  signal?: AbortSignal;
  purchaseIdByPost?: ReadonlyMap<string, string>;
} = {}) {
  const { signal, purchaseIdByPost } = options;
  const ids = [...new Set(postIds)];
  const counts = new Map<string, number | null>(ids.map(id => [id, null]));
  for (let offset = 0; offset < ids.length; offset += POST_VIEW_COUNT_BATCH_SIZE) {
    if (signal?.aborted) break;
    const batch = ids.slice(offset, offset + POST_VIEW_COUNT_BATCH_SIZE);
    const purchaseIds = purchaseIdByPost
      ? [...new Set(batch.map(id => purchaseIdByPost.get(id)).filter((id): id is string => !!id))]
      : undefined;
    try {
      const response = await fetch("/api/posts/view-counts", {
        method: "POST", credentials: "include", cache: "no-store", signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ postIds: batch, purchaseIds }),
      });
      if (!response.ok) continue;
      const body = await response.json();
      if (!Array.isArray(body.items)) continue;
      const wanted = new Set(batch);
      for (const row of body.items) {
        if (row && wanted.has(row.post_id)) counts.set(row.post_id, normalizeViewCount(row.view_count));
      }
    } catch {
      // A failed decoration read must not hide successfully loaded previews.
    }
  }
  return counts;
}
