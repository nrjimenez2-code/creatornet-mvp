/**
 * A signed-out visitor must see WHO made each post.
 *
 * This has now regressed twice. Migration 060 / PR #153 was applied to
 * production specifically so the public front door stopped rendering the
 * generic "Creator" placeholder, and the Discover feed path then reintroduced
 * it by gating creator identity on `userId`:
 *
 *     creator_name: userId ? p.profile?.full_name : null
 *
 * For an anonymous visitor that is always null, so every card on the marketplace
 * home page read "Creator". The data was already loaded — `creator_verified`
 * one line below reads the same `p.profile` with no gate — so it was fetched and
 * thrown away.
 *
 * Creator identity is public: creator profile pages render it to anyone, and the
 * legacy get_feed_v3 path returns it to anon. This test drives the REAL
 * readDiscoverPage with userId=null so a future gate fails here instead of on
 * the live home page.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";

import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";

let db: MockClient;

jest.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return db;
  },
}));

const POST = {
  id: "post-1",
  creator_id: "creator-1",
  product_id: null,
  offering_id: null,
  title: "demo post",
  interests: ["technology & ai"],
  hashtags: ["#demo"],
  created_at: "2026-09-15T00:00:00Z",
  video_url: "https://media.creatornet.net/videos/creator-1/1.mp4",
  poster_url: "https://media.creatornet.net/thumbnails/creator-1/1.jpg",
  price_cents: 3000,
  allow_booking: false,
  booking_url: null,
  likes_count: 2,
  comments_count: 1,
  shares_count: 1,
  purchase_count: 0,
  hidden_at: null,
  removed_at: null,
  active: true,
};

const PROFILE = {
  id: "creator-1",
  full_name: "Noah Jimenez",
  username: "noahjimenezz",
  avatar_url: "https://example.test/avatar.jpg",
  banned_at: null,
  stripe_account_id: "acct_123",
  stripe_onboarding_complete: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  db = createMockClient((op) => {
    if (op.table === "discover_sessions_v1")
      return {
        data: {
          post_ids: [POST.id],
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        error: null,
      };
    if (op.table === "posts") return { data: [POST], error: null };
    if (op.table === "profiles") return { data: [PROFILE], error: null };
    if (op.table === "products" || op.table === "offerings") return { data: [], error: null };
    return undefined;
  });
});

describe("Discover feed, signed out", () => {
  it("returns the creator's name, username and avatar to an anonymous visitor", async () => {
    const { readDiscoverPage } = await import("@/lib/discoverServer");

    // userId = null is the whole point: this is a signed-out visitor.
    const page = await readDiscoverPage("session-1", "actor-1", 0, 10, null);

    expect(page.items).toHaveLength(1);
    const item = page.items[0] as Record<string, unknown>;

    expect(item.creator_name).toBe("Noah Jimenez");
    expect(item.creator_username).toBe("noahjimenezz");
    expect(item.creator_avatar_url).toBe("https://example.test/avatar.jpg");
  });

  it("still marks per-viewer personalization as absent when signed out", async () => {
    const { readDiscoverPage } = await import("@/lib/discoverServer");
    const page = await readDiscoverPage("session-1", "actor-1", 0, 10, null);
    const item = page.items[0] as Record<string, unknown>;

    // These genuinely require a viewer and must NOT be faked by the fix above.
    expect(item.is_liked).toBe(false);
    expect(item.is_following).toBe(false);
  });
});
