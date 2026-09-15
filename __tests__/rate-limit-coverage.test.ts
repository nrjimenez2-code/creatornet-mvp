/**
 * Rate limiting: does the ROUTE actually use the limiter?
 *
 * __tests__/data-accuracy.test.ts already proves the token bucket in
 * lib/rateLimit.ts refills and blocks correctly. What it cannot prove is that
 * any route calls it — and until this commit only 3 of 32 mutating routes did.
 *
 * These tests import and invoke the real handlers and drive them past the
 * limit, so they fail if a guard is dropped, mis-keyed, or placed after the
 * work it is supposed to protect. They also assert the guard SHORT-CIRCUITS:
 * a refused request must not reach the database at all, otherwise the limit
 * costs as much as the work it is declining.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";

import { NextRequest } from "next/server";
import { _resetRateLimits } from "@/lib/rateLimit";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";

let db: MockClient;
let authUser: { id: string } | null = { id: "user_1" };

jest.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return db;
  },
}));
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: authUser }, error: null }) } }),
  createSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: authUser }, error: null }) } }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimits();
  db = createMockClient(() => undefined);
  authUser = { id: "user_1" };
});

/** A request from a fixed address, so clientKey() is stable across calls. */
function reqFrom(ip: string, url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/search/perform is rate limited", () => {
  // Matches SEARCH_RATE in the route.
  const LIMIT = 60;

  it("serves up to the limit, then answers 429 with a Retry-After", async () => {
    const { POST } = await import("@/app/api/search/perform/route");

    for (let i = 0; i < LIMIT; i++) {
      const res = await POST(reqFrom("9.9.9.1", "https://x/api/search/perform", { q: "" }));
      expect(res.status).toBe(200);
    }

    const blocked = await POST(reqFrom("9.9.9.1", "https://x/api/search/perform", { q: "" }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    await expect(blocked.json()).resolves.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("does not touch the database once it is limiting", async () => {
    const { POST } = await import("@/app/api/search/perform/route");
    for (let i = 0; i < LIMIT; i++) {
      await POST(reqFrom("9.9.9.2", "https://x/api/search/perform", { q: "coffee" }));
    }
    const opsBefore = db.ops.length;
    await POST(reqFrom("9.9.9.2", "https://x/api/search/perform", { q: "coffee" }));
    expect(db.ops.length).toBe(opsBefore);
  });

  it("limits per address, so one abuser cannot lock out everyone else", async () => {
    const { POST } = await import("@/app/api/search/perform/route");
    for (let i = 0; i < LIMIT + 1; i++) {
      await POST(reqFrom("9.9.9.3", "https://x/api/search/perform", { q: "" }));
    }
    const other = await POST(reqFrom("9.9.9.4", "https://x/api/search/perform", { q: "" }));
    expect(other.status).toBe(200);
  });
});

describe("/api/reviews is rate limited", () => {
  // Matches REVIEW_RATE in the route. Tightest limit in the app: reviews move
  // a creator's public rating.
  const LIMIT = 10;

  it("answers 429 past the limit, before doing any auth or database work", async () => {
    const { POST } = await import("@/app/api/reviews/route");

    for (let i = 0; i < LIMIT; i++) {
      await POST(reqFrom("8.8.8.1", "https://x/api/reviews", { creator_id: "c1", rating: 5 }) as never);
    }

    const opsBefore = db.ops.length;
    const blocked = await POST(
      reqFrom("8.8.8.1", "https://x/api/reviews", { creator_id: "c1", rating: 5 }) as never
    );
    expect(blocked.status).toBe(429);
    expect(db.ops.length).toBe(opsBefore);
  });
});

/**
 * A GET from a fixed address, so clientKey() is stable across calls.
 * Must be a real NextRequest: the route reads req.nextUrl.searchParams, and a
 * plain Request would throw there — which would make the "never reached the
 * database" assertion below pass for the wrong reason.
 */
function getFrom(ip: string, url: string) {
  return new NextRequest(url, { method: "GET", headers: { "x-forwarded-for": ip } });
}

describe("/api/tag/[hashtag] is rate limited", () => {
  // Matches the limit in the route. This one is public and unauthenticated, and
  // every call fans out into five parallel service-role queries against posts,
  // so an unthrottled caller costs five times what it looks like.
  const LIMIT = 90;

  const call = async (ip: string) => {
    const { GET } = await import("@/app/api/tag/[hashtag]/route");
    return GET(getFrom(ip, "https://x/api/tag/fitness") as never, {
      params: Promise.resolve({ hashtag: "fitness" }),
    });
  };

  it("answers 429 past the limit, without touching the database", async () => {
    for (let i = 0; i < LIMIT; i++) {
      expect((await call("7.7.7.1")).status).not.toBe(429);
    }

    const opsBefore = db.ops.length;
    const blocked = await call("7.7.7.1");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(db.ops.length).toBe(opsBefore);
  });

  it("limits per address, so one abuser cannot lock out everyone else", async () => {
    for (let i = 0; i < LIMIT + 1; i++) await call("7.7.7.2");
    expect((await call("7.7.7.3")).status).not.toBe(429);
  });
});
