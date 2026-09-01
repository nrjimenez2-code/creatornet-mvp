/**
 * /api/posts/creators — the one unauthenticated, service-role route whose only
 * bound on its own workload was the request body.
 *
 * Imports and invokes the real handler. Mutation-checked.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";

import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";
import { _resetRateLimits } from "@/lib/rateLimit";

let db: MockClient;
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));

function req(body: unknown, ip = "1.2.3.4") {
  return new Request("https://x/api/posts/creators", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  _resetRateLimits();
  db = createMockClient((op: Op) =>
    op.table === "posts" && op.kind === "select" ? { data: [], error: null } : undefined
  );
});

describe("/api/posts/creators", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  /**
   * Reverts to: no .slice(). An anonymous caller could then hand the
   * service-role client 100k ids to build one enormous IN (...) query.
   */
  it("caps how many ids one request can ask about", async () => {
    const { POST } = await import("@/app/api/posts/creators/route");
    const ids = Array.from({ length: 5000 }, (_, i) => uuid(i));

    const res = await POST(req({ postIds: ids }));
    expect(res.status).toBe(200);

    const sent = db.opsFor("posts")[0].inFilters[0].values;
    expect(sent.length).toBe(200);
    expect(sent.length).toBeLessThan(ids.length);
  });

  /**
   * Reverts to: filtering only on `typeof id === "string"`, which lets junk
   * through to a uuid column and errors the whole batch.
   */
  it("drops ids that are not safe identifiers", async () => {
    const { POST } = await import("@/app/api/posts/creators/route");
    await POST(req({ postIds: [uuid(1), "a,b)--", "'; drop table posts;--", uuid(2)] }));

    const sent = db.opsFor("posts")[0].inFilters[0].values;
    expect(sent).toEqual([uuid(1), uuid(2)]);
  });

  it("still answers a normal request", async () => {
    db = createMockClient((op: Op) =>
      op.table === "posts" && op.kind === "select"
        ? { data: [{ id: uuid(1), creator_id: "c1" }], error: null }
        : undefined
    );
    const { POST } = await import("@/app/api/posts/creators/route");
    const res = await POST(req({ postIds: [uuid(1)] }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ creators: { [uuid(1)]: "c1" } });
  });

  it("returns an empty result rather than querying for an empty list", async () => {
    const { POST } = await import("@/app/api/posts/creators/route");
    const res = await POST(req({ postIds: [] }));
    expect(res.status).toBe(200);
    expect(db.opsFor("posts")).toHaveLength(0);
  });

  /** Reverts to: no rate limit on an unauthenticated service-role route. */
  it("refuses a caller that floods it", async () => {
    const { POST } = await import("@/app/api/posts/creators/route");
    let last = 200;
    for (let i = 0; i < 70; i++) {
      last = (await POST(req({ postIds: [uuid(1)] }, "9.9.9.9"))).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  it("does not penalise a different caller", async () => {
    const { POST } = await import("@/app/api/posts/creators/route");
    for (let i = 0; i < 70; i++) await POST(req({ postIds: [uuid(1)] }, "8.8.8.8"));
    const other = await POST(req({ postIds: [uuid(1)] }, "7.7.7.7"));
    expect(other.status).toBe(200);
  });
});
