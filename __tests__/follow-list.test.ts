/**
 * /api/users/[userId]/follows — the follower / following list behind the
 * clickable profile counts.
 *
 * Imports and invokes the REAL handler against the recording client, so these
 * fail if the guard order changes, the keyset slice is dropped, or a missing
 * profile row makes a follower vanish. Mutation-checked (see PR).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";

import { _resetRateLimits } from "@/lib/rateLimit";
import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";

let db: MockClient;
let authUser: { id: string } | null = { id: "viewer_1" };
let followRows: Array<Record<string, string>> = [];
let profileRows: Array<Record<string, string | null>> = [];

jest.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return db;
  },
}));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: authUser }, error: null }) } }),
}));

function makeDb() {
  return createMockClient((op: Op) => {
    if (op.table === "follows" && op.kind === "select") return { data: followRows, error: null };
    if (op.table === "profiles" && op.kind === "select") return { data: profileRows, error: null };
    return undefined;
  });
}

/** n follower rows of `target`, newest first, second-apart so cursors are unambiguous. */
function followers(n: number, target = "target_1") {
  return Array.from({ length: n }, (_, i) => ({
    follower_id: `u${String(i + 1).padStart(2, "0")}`,
    following_id: target,
    created_at: `2026-09-04T10:00:${String(59 - i).padStart(2, "0")}.000000+00:00`,
  }));
}

function profilesFor(rows: Array<Record<string, string>>, col = "follower_id") {
  return rows.map((r) => ({ id: r[col], username: `name_${r[col]}`, full_name: null, avatar_url: null }));
}

async function get(userId: string, query: string, ip = "7.7.7.1") {
  const { GET } = await import("@/app/api/users/[userId]/follows/route");
  const req = new Request(`https://x/api/users/${userId}/follows${query}`, {
    headers: { "x-forwarded-for": ip },
  });
  return GET(req as never, { params: Promise.resolve({ userId }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimits();
  authUser = { id: "viewer_1" };
  followRows = [];
  profileRows = [];
  db = makeDb();
});

describe("guards", () => {
  it("answers 401 when signed out, without touching the database", async () => {
    authUser = null;
    const res = await get("target_1", "?type=followers");
    expect(res.status).toBe(401);
    expect(db.ops).toHaveLength(0);
  });

  it("answers 400 for a type that is not followers or following", async () => {
    const res = await get("target_1", "?type=friends");
    expect(res.status).toBe(400);
    expect(db.ops).toHaveLength(0);
  });

  it("answers 400 for a missing type", async () => {
    expect((await get("target_1", "")).status).toBe(400);
  });

  it("answers 400 for an unsafe user id", async () => {
    const res = await get("bad,id)", "?type=followers");
    expect(res.status).toBe(400);
    expect(db.ops).toHaveLength(0);
  });

  it("answers 400 for a malformed cursor rather than interpolating it", async () => {
    for (const bad of ["nope", "2026-09-04T10:00:00Z|bad,id", "not-a-time|u01", "|u01"]) {
      const res = await get("target_1", `?type=followers&cursor=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
    }
    expect(db.ops).toHaveLength(0);
  });

  it("is rate limited before auth or database work", async () => {
    const LIMIT = 60; // FOLLOW_LIST_RATE in the route
    for (let i = 0; i < LIMIT; i++) {
      expect((await get("target_1", "?type=followers", "7.7.7.9")).status).toBe(200);
    }
    const opsBefore = db.ops.length;
    const blocked = await get("target_1", "?type=followers", "7.7.7.9");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(db.ops.length).toBe(opsBefore);
  });
});

describe("pagination", () => {
  it("returns 25 items and a nextCursor when 26 rows come back", async () => {
    followRows = followers(26);
    profileRows = profilesFor(followRows);

    const res = await get("target_1", "?type=followers");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items).toHaveLength(25);
    expect(body.items[0]).toEqual({ id: "u01", username: "name_u01", full_name: null, avatar_url: null });
    expect(body.items[24].id).toBe("u25");
    // cursor = created_at|otherId of the LAST row on the page, not the 26th
    expect(body.nextCursor).toBe(`${followRows[24].created_at}|u25`);

    // and only the 25 shown were hydrated
    const profileOp = db.opsFor("profiles")[0];
    expect(profileOp.inFilters[0].values).toHaveLength(25);
    expect(profileOp.inFilters[0].values).not.toContain("u26");
  });

  it("ends with nextCursor null on the last page", async () => {
    followRows = followers(3);
    profileRows = profilesFor(followRows);

    const body = await (await get("target_1", "?type=followers")).json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["u01", "u02", "u03"]);
    expect(body.nextCursor).toBeNull();
  });

  it("applies the keyset (created_at desc, other id desc) from the cursor", async () => {
    followRows = followers(1);
    const cursor = "2026-09-04T10:00:35.000000+00:00|u25";
    const res = await get("target_1", `?type=followers&cursor=${encodeURIComponent(cursor)}`);
    expect(res.status).toBe(200);

    const followsOp = db.opsFor("follows")[0];
    expect(followsOp.filters.following_id).toBe("target_1");
    expect(followsOp.orFilters).toEqual([
      "created_at.lt.2026-09-04T10:00:35.000000+00:00,and(created_at.eq.2026-09-04T10:00:35.000000+00:00,follower_id.lt.u25)",
    ]);
  });

  it("caps limit at 25 and ignores nonsense", async () => {
    followRows = followers(26);
    profileRows = profilesFor(followRows);
    expect((await (await get("target_1", "?type=followers&limit=500")).json()).items).toHaveLength(25);
    expect((await (await get("target_1", "?type=followers&limit=abc")).json()).items).toHaveLength(25);

    followRows = followers(3);
    const small = await (await get("target_1", "?type=followers&limit=2")).json();
    expect(small.items).toHaveLength(2);
    expect(small.nextCursor).toBe(`${followRows[1].created_at}|u02`);
  });
});

describe("following (the mirror image)", () => {
  it("filters on follower_id and reads following_id", async () => {
    followRows = [
      { follower_id: "target_1", following_id: "c9", created_at: "2026-09-04T10:00:59.000000+00:00" },
    ];
    profileRows = [{ id: "c9", username: "creator9", full_name: "Creator Nine", avatar_url: "https://a/x.png" }];

    const body = await (await get("target_1", "?type=following")).json();
    expect(db.opsFor("follows")[0].filters).toEqual({ follower_id: "target_1" });
    expect(db.opsFor("follows")[0].columns).toContain("following_id");
    expect(body.items).toEqual([
      { id: "c9", username: "creator9", full_name: "Creator Nine", avatar_url: "https://a/x.png" },
    ]);
  });
});

describe("hydration", () => {
  it("keeps a follower whose profile row is missing, with null fields", async () => {
    followRows = followers(2);
    profileRows = profilesFor([followRows[1]]); // only u02 has a profile

    const body = await (await get("target_1", "?type=followers")).json();
    expect(body.items).toEqual([
      { id: "u01", username: null, full_name: null, avatar_url: null },
      { id: "u02", username: "name_u02", full_name: null, avatar_url: null },
    ]);
  });

  it("does not query profiles when there is nothing to hydrate", async () => {
    const body = await (await get("target_1", "?type=followers")).json();
    expect(body).toEqual({ items: [], nextCursor: null });
    expect(db.opsFor("profiles")).toHaveLength(0);
  });
});
