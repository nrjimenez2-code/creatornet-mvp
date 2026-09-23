import { loadSearchVideos } from "@/lib/searchVideoPlayer";
import { loadFeedOffers } from "@/lib/feedOffers";
import type { SearchPost } from "@/lib/searchTypes";
const mockLikes = query([{ post_id: "second" }]);
const mockGetSession = jest.fn();
const mockFrom = jest.fn((table: string) => {
  if (table !== "likes") throw new Error(`Unexpected direct ${table} read`);
  return mockLikes;
});
function query(data: unknown[]) {
  const result = { data, error: null as null | { message: string } };
  const builder = { select: jest.fn(), in: jest.fn(), eq: jest.fn(), then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve), result };
  for (const method of [builder.select, builder.in, builder.eq]) method.mockReturnValue(builder);
  return builder;
}
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({
  from: (table: string) => mockFrom(table), auth: { getSession: () => mockGetSession() },
}) }));
jest.mock("@/lib/feedOffers", () => ({ loadFeedOffers: jest.fn(async posts => posts) }));
const results: SearchPost[] = ["second", "first", "removed"].map(id => ({ id, creator_id: "creator", creator: { username: "old-name" }, caption: "", content: null, media_url: null, poster_url: null }));
let items: Record<string, unknown>[];
beforeEach(() => {
  jest.clearAllMocks();
  mockLikes.result.error = null;
  mockGetSession.mockResolvedValue({ data: { session: { user: { id: "viewer" } } }, error: null });
  items = ["first", "second"].map(id => ({ id, creator_id: "creator", creator_username: "current-name", creator_name: "Current Name", creator_avatar_url: "avatar", creator_verified: id === "second" }));
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ items }) })) as jest.Mock;
});
test("hydrates requested public videos in search order with the viewer's actual likes", async () => {
  const posts = await loadSearchVideos(results);
  expect(global.fetch).toHaveBeenCalledWith("/api/search/videos", expect.objectContaining({
    method: "POST", body: JSON.stringify({ ids: ["second", "first", "removed"] }),
  }));
  expect(mockFrom).toHaveBeenCalledTimes(1);
  expect(mockLikes.eq).toHaveBeenCalledWith("user_id", "viewer");
  expect(posts.map(post => post.id)).toEqual(["second", "first"]);
  expect(posts[0]).toMatchObject({ is_liked: true, creator_username: "current-name", creator_name: "Current Name", creator_avatar_url: "avatar", creator_verified: true });
  expect(posts[1]).toMatchObject({ is_liked: false, creator_verified: false });
  expect(loadFeedOffers).toHaveBeenCalledWith(posts);
});
test("signed-out viewers can open public search videos without a direct database read", async () => {
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  const posts = await loadSearchVideos(results);
  expect(posts.map(post => post.id)).toEqual(["second", "first"]);
  expect(posts.every(post => post.is_liked === false)).toBe(true);
  expect(mockFrom).not.toHaveBeenCalled();
});
test("failed likes hydration does not silently turn an existing like into an empty heart", async () => {
  mockLikes.result.error = { message: "unavailable" };
  await expect(loadSearchVideos(results)).rejects.toThrow("Could not load videos.");
  expect(loadFeedOffers).not.toHaveBeenCalled();
});
test("mismatched creator metadata is excluded", async () => {
  items = [{ id: "second", creator_id: "another-creator" }];
  expect(await loadSearchVideos(results)).toEqual([]);
});
