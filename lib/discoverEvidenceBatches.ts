import type { DiscoverEvidence } from './discoverRanking';

// This bounds one session's foreground reads, not the database pool or other
// instances. Keep batches ordered and settle a whole window before advancing.
export async function readDiscoverEvidenceBatches(
  postIds: readonly string[],
  read: (postIds: string[]) => Promise<DiscoverEvidence[]>,
  overlap = false,
): Promise<DiscoverEvidence[]> {
  const evidence: DiscoverEvidence[] = [];
  const width = overlap ? 2 : 1;
  for (let offset = 0; offset < postIds.length; offset += 200 * width) {
    if (!overlap) {
      evidence.push(...await read(postIds.slice(offset, offset + 200)));
      continue;
    }
    const pending: Promise<DiscoverEvidence[]>[] = [];
    for (let index = offset; index < Math.min(offset + 400, postIds.length); index += 200) {
      const batchIds = postIds.slice(index, index + 200);
      // Capture synchronous failures too, so another started read still drains.
      pending.push(Promise.resolve().then(() => read(batchIds)));
    }
    const settled = await Promise.allSettled(pending);
    for (const result of settled) {
      if (result.status === 'rejected') throw result.reason;
      evidence.push(...result.value);
    }
  }
  return evidence;
}
