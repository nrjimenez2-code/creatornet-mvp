type LikeLookup = {
  data: { post_id: string }[] | null;
  error: unknown;
};

// Keep each PostgREST `in` URL small even for profiles with many posts.
const BATCH_SIZE = 80;

export async function readLikedPostIds(
  postIds: readonly string[],
  load: (ids: string[]) => PromiseLike<LikeLookup>,
): Promise<string[]> {
  const liked: string[] = [];
  for (let offset = 0; offset < postIds.length; offset += BATCH_SIZE) {
    const result = await load(postIds.slice(offset, offset + BATCH_SIZE));
    if (result.error) throw new Error('Could not load profile likes.');
    for (const row of result.data ?? []) {
      if (typeof row.post_id === 'string') liked.push(row.post_id);
    }
  }
  return liked;
}
