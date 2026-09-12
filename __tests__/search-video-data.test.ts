import { loadSearchVideos } from "@/lib/searchVideoPlayer";
import { loadFeedOffers } from "@/lib/feedOffers";
import type { SearchPost } from "@/lib/searchTypes";
const mockQueries: Record<string, ReturnType<typeof query>> = {};
function query(data: unknown[]) {
  const result = { data, error: null as null | { message: string } };
  const builder = { select: jest.fn(), in: jest.fn(), is: jest.fn(), eq: jest.fn(), then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve), result };
  for (const method of [builder.select, builder.in, builder.is, builder.eq]) method.mockReturnValue(builder);
  return builder;
}
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({
  from: (table: string) => mockQueries[table], auth: { getSession: async () => ({ data: { session: { user: { id: "viewer" } } }, error: null }) },
}) }));
jest.mock("@/lib/feedOffers", () => ({ loadFeedOffers: jest.fn(async posts => posts) }));
const results: SearchPost[] = ["second", "first", "removed"].map(id => ({ id, creator_id: "creator", creator: { username: "old-name" }, caption: "", content: null, media_url: null, poster_url: null }));
beforeEach(() => {
  jest.clearAllMocks();
  mockQueries.posts = query([{ id: "first", creator_id: "creator" }, { id: "second", creator_id: "creator" }]);
  mockQueries.profiles = query([{ id: "creator", username: "current-name", full_name: "Current Name", avatar_url: "avatar" }]);
  mockQueries.likes = query([{ post_id: "second" }]);
});
test("hydrates only requested visible posts in search order with the viewer's actual likes and current profile", async () => {
  const posts = await loadSearchVideos(results);
  expect(mockQueries.posts.in).toHaveBeenCalledWith("id", ["second", "first", "removed"]);
  expect(mockQueries.posts.is).toHaveBeenCalledWith("hidden_at", null);
  expect(mockQueries.posts.is).toHaveBeenCalledWith("removed_at", null);
  expect(mockQueries.likes.eq).toHaveBeenCalledWith("user_id", "viewer");
  expect(posts.map(post => post.id)).toEqual(["second", "first"]);
  expect(posts[0]).toMatchObject({ is_liked: true, creator_username: "current-name", creator_name: "Current Name", creator_avatar_url: "avatar" });
  expect(posts[1].is_liked).toBe(false);
  expect(loadFeedOffers).toHaveBeenCalledWith(posts);
});
test("failed likes hydration does not silently turn an existing like into an empty heart", async () => {
  mockQueries.likes.result.error = { message: "unavailable" };
  await expect(loadSearchVideos(results)).rejects.toThrow("Could not load videos.");
  expect(loadFeedOffers).not.toHaveBeenCalled();
});
test("mismatched creator metadata is excluded", async () => {
  mockQueries.posts = query([{ id: "second", creator_id: "another-creator" }]);
  expect(await loadSearchVideos(results)).toEqual([]);
});
