/**
 * Hidden / removed posts must be gone from every consumer-facing discovery
 * surface, not just the feed.
 *
 * The admin board sets posts.hidden_at (hide) and posts.removed_at (remove).
 * get_feed_v2/get_feed_v3 and the sitemap already exclude both, but search,
 * tag pages and the public creator profile did not — so "hide" was not a real
 * moderation control.
 *
 * These tests import and invoke the REAL handlers / page module and assert on
 * what each one asked the database for: every select against "posts" must
 * carry BOTH `hidden_at IS NULL` and `removed_at IS NULL`. Mutation-checked:
 * dropping the onlyVisiblePosts() call from any one surface fails its test.
 *
 * The client surfaces (app/watch/[postId], components/ContinueWatching) are
 * covered in hidden-posts-not-discoverable-client.test.ts (needs jsdom).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon_fake";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";

import type { NextRequest } from "next/server";
import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";
import { _resetRateLimits } from "@/lib/rateLimit";

let db: MockClient;

jest.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return db;
  },
}));
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}));
jest.mock("@/lib/posthogServer", () => ({ trackServerEvent: jest.fn() }));
jest.mock("@/lib/updateInterestScore", () => ({ updateInterestScore: jest.fn() }));
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
// The page returns JSX we never render; keep its client children out of it.
jest.mock("@/components/BackButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ProfileShareButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ProfilePostsGallery", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/FollowButton", () => ({ __esModule: true, default: () => null }));

const CREATOR = { id: "c1", username: "noah", full_name: "Noah", avatar_url: null, tagline: null, bio: null };

/** Both moderation columns must be constrained with `.is(col, null)`. */
function expectModerationFilter(op: Op) {
  expect(op.table).toBe("posts");
  expect(op.kind).toBe("select");
  expect(op.isFilters).toEqual(
    expect.arrayContaining([
      { column: "hidden_at", value: null },
      { column: "removed_at", value: null },
    ])
  );
}

function postReads() {
  return db.opsFor("posts").filter((o) => o.kind === "select");
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  _resetRateLimits();
  db = createMockClient(() => undefined);
});

describe("/api/search/perform", () => {
  const post = (q: string) =>
    new Request("https://x/api/search/perform", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "5.5.5.5" },
      body: JSON.stringify({ q }),
    });

  it("#tag search: both posts reads exclude hidden and removed posts", async () => {
    const { POST } = await import("@/app/api/search/perform/route");
    const res = await POST(post("#yoga"));
    expect(res.status).toBe(200);

    const reads = postReads();
    expect(reads).toHaveLength(2);
    expect(reads.map((r) => Object.keys(r.filters)).flat()).toEqual(
      expect.arrayContaining(["hashtags", "content"])
    );
    reads.forEach(expectModerationFilter);
  });

  it("name search with a matching creator: the by-creator read excludes them", async () => {
    db = createMockClient((op) =>
      op.table === "profiles" && op.kind === "select" ? { data: [CREATOR], error: null } : undefined
    );
    const { POST } = await import("@/app/api/search/perform/route");
    const res = await POST(post("noah"));
    expect(res.status).toBe(200);

    const reads = postReads();
    expect(reads).toHaveLength(1);
    expect(reads[0].inFilters).toEqual([{ column: "creator_id", values: [CREATOR.id] }]);
    expectModerationFilter(reads[0]);
  });

  it("name search with no creator: the caption read AND the suggested-posts read exclude them", async () => {
    db = createMockClient((op) => {
      if (op.table !== "profiles" || op.kind !== "select") return undefined;
      // The two ilike lookups find nobody; the unfiltered "suggest 6" finds one.
      const isNameLookup = "username" in op.filters || "full_name" in op.filters;
      return { data: isNameLookup ? [] : [CREATOR], error: null };
    });
    const { POST } = await import("@/app/api/search/perform/route");
    const res = await POST(post("zzz-nobody"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ noUserFound: true });

    const reads = postReads();
    expect(reads).toHaveLength(2);
    expect(reads[0].filters).toHaveProperty("content", "%zzz-nobody%");
    expect(reads[1].inFilters).toEqual([{ column: "creator_id", values: [CREATOR.id] }]);
    reads.forEach(expectModerationFilter);
  });
});

describe("/api/search/suggest", () => {
  it("hashtag suggestions are not derived from hidden or removed posts", async () => {
    const { GET } = await import("@/app/api/search/suggest/route");
    const res = await GET(new Request("https://x/api/search/suggest?q=yo"));
    expect(res.status).toBe(200);

    const reads = postReads();
    expect(reads).toHaveLength(1);
    expect(reads[0].columns).toBe("hashtags");
    expectModerationFilter(reads[0]);
  });
});

describe("/api/tag/[hashtag]", () => {
  it("all five posts reads exclude hidden and removed posts", async () => {
    const { GET } = await import("@/app/api/tag/[hashtag]/route");
    // The handler only touches req.nextUrl.searchParams.
    const req = { nextUrl: new URL("https://x/api/tag/yoga?limit=5") } as unknown as NextRequest;
    const res = await GET(req, { params: Promise.resolve({ hashtag: "yoga" }) });
    expect(res.status).toBe(200);

    const reads = postReads();
    expect(reads).toHaveLength(5);
    // hashtags ilike, content ilike, interests contains x3 — all still there.
    expect(reads.map((r) => Object.keys(r.filters).filter((k) => k !== "hidden_at" && k !== "removed_at"))).toEqual([
      ["hashtags"],
      ["content"],
      ["interests"],
      ["interests"],
      ["interests"],
    ]);
    reads.forEach(expectModerationFilter);
  });
});

describe("/creators/[creatorId] (public profile page)", () => {
  it("lists only the creator's visible posts", async () => {
    db = createMockClient((op) =>
      op.table === "profiles" && op.kind === "select" ? { data: CREATOR, error: null } : undefined
    );
    const { default: Page } = await import("@/app/creators/[creatorId]/page");
    const element = await Page({ params: Promise.resolve({ creatorId: CREATOR.id }) });
    expect(element).toBeTruthy();

    const reads = postReads();
    expect(reads).toHaveLength(1);
    expect(reads[0].filters).toHaveProperty("creator_id", CREATOR.id);
    expectModerationFilter(reads[0]);
  });
});

describe("the helper itself", () => {
  it("applies exactly the two IS NULL filters, in a way PostgREST can serve", async () => {
    const { onlyVisiblePosts } = await import("@/lib/visiblePosts");
    await onlyVisiblePosts(db.from("posts").select("id"));
    const [op] = postReads();
    expect(op.isFilters).toEqual([
      { column: "hidden_at", value: null },
      { column: "removed_at", value: null },
    ]);
  });
});
