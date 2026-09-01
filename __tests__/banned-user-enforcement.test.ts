/**
 * Banning a user used to do literally nothing: /api/admin/ban set
 * profiles.banned_at and no policy, function or code path ever read it.
 *
 * These import and invoke the real handlers. Mutation-checked.
 *
 * The fail-open test is the important one. Failing closed would turn any
 * transient database error into "nobody on the site can post", which is a far
 * worse outcome than a banned user getting a few more minutes.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";

import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";
import { isUserBanned } from "@/lib/bannedUser";
import { _resetRateLimits } from "@/lib/rateLimit";

let db: MockClient;          // the service-role client
let sessionDb: MockClient;   // the request-scoped client (auth + profiles read)
let authUser: { id: string } | null = { id: "user_1" };
let bannedAt: string | null = null;
let profileLookupError: { message: string } | null = null;

jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => sessionDb,
  createSupabaseServer: () => sessionDb,
}));

function makeSessionDb() {
  const c = createMockClient((op: Op) => {
    if (op.table === "profiles" && op.kind === "select") {
      if (profileLookupError) return { data: null, error: profileLookupError };
      return { data: { banned_at: bannedAt }, error: null };
    }
    return undefined;
  }) as any;
  c.auth = { getUser: async () => ({ data: { user: authUser }, error: null }) };
  return c as MockClient;
}

function jsonReq(body: unknown, ip = "3.3.3.3") {
  return new Request("https://x/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  _resetRateLimits();
  authUser = { id: "user_1" };
  bannedAt = null;
  profileLookupError = null;
  db = createMockClient(() => undefined);
  sessionDb = makeSessionDb();
});

describe("isUserBanned", () => {
  it("reports a banned account", async () => {
    bannedAt = "2026-09-01T00:00:00Z";
    expect(await isUserBanned(sessionDb as any, "user_1")).toBe(true);
  });

  it("reports a normal account as fine", async () => {
    expect(await isUserBanned(sessionDb as any, "user_1")).toBe(false);
  });

  /**
   * THE SAFETY PROPERTY. Reverting to `return true` on error — failing closed —
   * makes every transient database blip a site-wide write outage.
   */
  it("FAILS OPEN when the ban lookup errors", async () => {
    profileLookupError = { message: "connection reset" };
    expect(await isUserBanned(sessionDb as any, "user_1")).toBe(false);
  });

  it("says no without a user id rather than querying", async () => {
    expect(await isUserBanned(sessionDb as any, null)).toBe(false);
    expect(sessionDb.opsFor("profiles")).toHaveLength(0);
  });
});

describe("a banned user cannot create content", () => {
  const cases: Array<{ name: string; load: () => Promise<any>; call: (h: any) => Promise<Response> }> = [
    {
      name: "/api/reviews",
      load: () => import("@/app/api/reviews/route"),
      call: (h) => h.POST(jsonReq({ creator_id: "c1", rating: 5, comment: "hi" })),
    },
    {
      name: "/api/follow",
      load: () => import("@/app/api/follow/route"),
      call: (h) => h.POST(jsonReq({ creator_id: "c1" })),
    },
    {
      name: "/api/posts (create)",
      load: () => import("@/app/api/posts/route"),
      call: (h) => h.POST(jsonReq({ title: "t", video_url: "v" })),
    },
    {
      name: "/api/posts/[postId]/comments",
      load: () => import("@/app/api/posts/[postId]/comments/route"),
      call: (h) => h.POST(jsonReq({ content: "hello" }), { params: Promise.resolve({ postId: "post_1" }) }),
    },
  ];

  for (const c of cases) {
    it(`${c.name} refuses a banned account with 403`, async () => {
      bannedAt = "2026-09-01T00:00:00Z";
      const handler = await c.load();
      const res = await c.call(handler);

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("ACCOUNT_BANNED");
      // and nothing was written anywhere
      const writes = [...db.ops, ...sessionDb.ops].filter((o) => o.kind !== "select");
      expect(writes).toHaveLength(0);
    });

    it(`${c.name} still lets a normal account through the ban check`, async () => {
      bannedAt = null;
      const handler = await c.load();
      const res = await c.call(handler);
      // Whatever happens next, it must not be the ban refusal.
      expect(res.status).not.toBe(403);
    });
  }
});
