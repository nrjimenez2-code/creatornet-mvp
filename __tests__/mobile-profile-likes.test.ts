import { readLikedPostIds } from '../lib/mobileProfileLikes';

it('keeps profile like lookups bounded when a creator has hundreds of posts', async () => {
  const postIds = Array.from({ length: 960 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);
  const batchSizes: number[] = [];
  const queryLengths: number[] = [];
  const liked = await readLikedPostIds(postIds, async ids => {
    batchSizes.push(ids.length);
    queryLengths.push(new URLSearchParams({ select: 'post_id', user_id: 'eq.fixture-user', post_id: `in.(${ids.join(',')})` }).toString().length);
    return { data: ids.filter(id => Number.parseInt(id.slice(-12), 16) % 3 === 0).map(post_id => ({ post_id })), error: null };
  });

  expect(batchSizes).toHaveLength(12);
  expect(Math.max(...batchSizes)).toBe(80);
  expect(Math.max(...queryLengths)).toBeLessThan(4_000);
  expect(liked).toHaveLength(320);
  expect(liked[0]).toBe(postIds[0]);
  expect(liked.at(-1)).toBe(postIds[957]);
});

it('fails the whole profile like lookup if any batch fails', async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `post-${i}`);
  await expect(readLikedPostIds(ids, async batch => ({
    data: batch[0] === 'post-0' ? [{ post_id: 'post-0' }] : null,
    error: batch[0] === 'post-80' ? new Error('query failed') : null,
  }))).rejects.toThrow('Could not load profile likes.');
});
