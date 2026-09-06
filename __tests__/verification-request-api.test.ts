/**
 * Blue "Authenticity" check — the creator side.
 *
 * 1. lib/verification.ts: code shape/alphabet, handle + platform validators,
 *    the status machine.
 * 2. /api/verification (REAL handler, recording client): rate limit first,
 *    then 401 / 403 banned / 400 / 409 one-open-request / 201 with a code,
 *    and GET hides the code once the request is decided.
 *
 * Mutation-checked (see PR): with the 409 guard removed the "one open
 * request" test fails.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";

import { _resetRateLimits } from "@/lib/rateLimit";
import {
  ALLOWED_TRANSITIONS,
  CODE_PATTERN,
  OPEN_STATUSES,
  VERIFICATION_INSTRUCTIONS,
  canTransition,
  generateCode,
  isVerificationPlatform,
  normalizeHandle,
  profileUrlFor,
} from "@/lib/verification";
import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";

let db: MockClient;
let authUser: { id: string } | null = { id: "creator_1" };
let bannedAt: string | null = null;
let newestRequest: Record<string, unknown> | null = null;
let insertError: { message: string } | null = null;

jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: authUser }, error: null }) } }),
  createSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: authUser }, error: null }) } }),
}));

function makeDb() {
  return createMockClient((op: Op) => {
    if (op.table === "profiles" && op.kind === "select") {
      return { data: { banned_at: bannedAt }, error: null };
    }
    if (op.table === "verification_requests" && op.kind === "select") {
      return { data: newestRequest, error: null };
    }
    if (op.table === "verification_requests" && op.kind === "insert") {
      if (insertError) return { data: null, error: insertError };
      const payload = op.payload as Record<string, unknown>;
      return {
        data: { id: "req_new", ...payload, reason: null, created_at: "2026-09-06T00:00:00Z", decided_at: null },
        error: null,
      };
    }
    return undefined;
  });
}

let ipCounter = 0;
/** A fresh address per request unless the test wants to share one. */
function post(body: unknown, ip = `10.0.0.${++ipCounter}`) {
  return new Request("https://x/api/verification", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  }) as never;
}

function get(ip = `10.1.0.${++ipCounter}`) {
  return new Request("https://x/api/verification", { headers: { "x-forwarded-for": ip } }) as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimits();
  authUser = { id: "creator_1" };
  bannedAt = null;
  newestRequest = null;
  insertError = null;
  db = makeDb();
});

// ---------------------------------------------------------------------------
// lib/verification.ts
// ---------------------------------------------------------------------------

describe("generateCode", () => {
  it("makes CN-XXXX-XXXX from the unambiguous alphabet, every time", () => {
    for (let i = 0; i < 500; i++) {
      const code = generateCode();
      expect(code).toMatch(CODE_PATTERN);
      expect(code).not.toMatch(/[01IO]/);
    }
  });

  it("does not repeat itself", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateCode()));
    expect(codes.size).toBe(200);
  });
});

describe("validators", () => {
  it("accepts only instagram and tiktok", () => {
    expect(isVerificationPlatform("instagram")).toBe(true);
    expect(isVerificationPlatform("tiktok")).toBe(true);
    for (const bad of ["youtube", "Instagram", "", null, 3]) {
      expect(isVerificationPlatform(bad)).toBe(false);
    }
  });

  it("normalises handles: trims, drops one leading @, rejects junk", () => {
    expect(normalizeHandle("  @noah.jimenez_1 ")).toBe("noah.jimenez_1");
    expect(normalizeHandle("a")).toBe("a");
    expect(normalizeHandle("x".repeat(30))).toBe("x".repeat(30));
    for (const bad of ["", "@", "@@name", "x".repeat(31), "has space", "semi;colon", "slash/x", 42, null]) {
      expect(normalizeHandle(bad)).toBeNull();
    }
  });

  it("builds the profile link the admin opens", () => {
    expect(profileUrlFor("instagram", "noah")).toBe("https://www.instagram.com/noah/");
    expect(profileUrlFor("tiktok", "noah.j")).toBe("https://www.tiktok.com/@noah.j");
  });
});

describe("status machine", () => {
  it("approve/reject need a pending code, revoke needs an approval", () => {
    expect(ALLOWED_TRANSITIONS).toEqual({
      approve: ["code_issued"],
      reject: ["code_issued"],
      revoke: ["approved"],
    });
    expect(canTransition("code_issued", "approve")).toBe(true);
    expect(canTransition("code_issued", "reject")).toBe(true);
    expect(canTransition("approved", "revoke")).toBe(true);
    expect(canTransition("approved", "approve")).toBe(false);
    expect(canTransition("rejected", "approve")).toBe(false);
    expect(canTransition("revoked", "revoke")).toBe(false);
    expect(canTransition("code_issued", "revoke")).toBe(false);
  });

  it("a pending code or an approval blocks a new request; rejected/revoked do not", () => {
    expect([...OPEN_STATUSES].sort()).toEqual(["approved", "code_issued"]);
  });

  it("the instructions say where the code goes (bio) — the one place to change the channel", () => {
    expect(VERIFICATION_INSTRUCTIONS).toMatch(/bio/i);
  });
});

// ---------------------------------------------------------------------------
// POST /api/verification
// ---------------------------------------------------------------------------

describe("POST /api/verification", () => {
  it("is rate limited to 5 an hour per address, before auth or database work", async () => {
    const { POST } = await import("@/app/api/verification/route");
    authUser = null; // so a non-limited call would 401, never 429
    for (let i = 0; i < 5; i++) {
      expect((await POST(post({ platform: "instagram", handle: "a" }, "5.5.5.5"))).status).toBe(401);
    }
    const opsBefore = db.ops.length;
    const blocked = await POST(post({ platform: "instagram", handle: "a" }, "5.5.5.5"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("3600");
    expect(db.ops.length).toBe(opsBefore);
  });

  it("answers 401 when signed out, without touching the database", async () => {
    const { POST } = await import("@/app/api/verification/route");
    authUser = null;
    const res = await POST(post({ platform: "instagram", handle: "a" }));
    expect(res.status).toBe(401);
    expect(db.ops).toHaveLength(0);
  });

  it("refuses a banned account with 403 and writes nothing", async () => {
    const { POST } = await import("@/app/api/verification/route");
    bannedAt = "2026-09-01T00:00:00Z";
    const res = await POST(post({ platform: "instagram", handle: "a" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ACCOUNT_BANNED");
    expect(db.ops.filter((o) => o.kind !== "select")).toHaveLength(0);
  });

  it("answers 400 for a bad platform or handle", async () => {
    const { POST } = await import("@/app/api/verification/route");
    expect((await POST(post({ platform: "youtube", handle: "a" }))).status).toBe(400);
    expect((await POST(post({ platform: "tiktok", handle: "has space" }))).status).toBe(400);
    expect((await POST(post({ platform: "tiktok" }))).status).toBe(400);
    expect(db.opsFor("verification_requests")).toHaveLength(0);
  });

  it("answers 409 while a code is still waiting to be checked", async () => {
    const { POST } = await import("@/app/api/verification/route");
    newestRequest = {
      id: "req_1", platform: "instagram", handle: "noah", code: "CN-AAAA-BBBB",
      status: "code_issued", reason: null, created_at: "2026-09-05T00:00:00Z", decided_at: null,
    };
    const res = await POST(post({ platform: "instagram", handle: "noah" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("REQUEST_OPEN");
    expect(body.request.code).toBe("CN-AAAA-BBBB"); // still usable, so still shown
    expect(db.opsFor("verification_requests").filter((o) => o.kind === "insert")).toHaveLength(0);
  });

  it("answers 409 when already verified", async () => {
    const { POST } = await import("@/app/api/verification/route");
    newestRequest = {
      id: "req_1", platform: "tiktok", handle: "noah", code: "CN-AAAA-BBBB",
      status: "approved", reason: null, created_at: "2026-09-05T00:00:00Z", decided_at: "2026-09-06T00:00:00Z",
    };
    const res = await POST(post({ platform: "tiktok", handle: "noah" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ALREADY_VERIFIED");
  });

  it("lets a rejected creator try again", async () => {
    const { POST } = await import("@/app/api/verification/route");
    newestRequest = {
      id: "req_1", platform: "tiktok", handle: "noah", code: "CN-AAAA-BBBB",
      status: "rejected", reason: "code not in bio", created_at: "2026-09-05T00:00:00Z", decided_at: "2026-09-06T00:00:00Z",
    };
    const res = await POST(post({ platform: "tiktok", handle: "noah" }));
    expect(res.status).toBe(201);
  });

  it("issues a code: 201, CN-XXXX-XXXX, stored under the caller with the normalised handle", async () => {
    const { POST } = await import("@/app/api/verification/route");
    const res = await POST(post({ platform: "instagram", handle: "@Noah.Jimenez " }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.request.status).toBe("code_issued");
    expect(body.request.code).toMatch(CODE_PATTERN);
    expect(body.request.handle).toBe("Noah.Jimenez");
    expect(body.instructions).toBe(VERIFICATION_INSTRUCTIONS);

    const insert = db.opsFor("verification_requests").find((o) => o.kind === "insert");
    expect(insert?.payload).toMatchObject({
      creator_id: "creator_1", // from the session, never the body
      platform: "instagram",
      handle: "Noah.Jimenez",
      status: "code_issued",
    });
    expect((insert?.payload as { code: string }).code).toBe(body.request.code);
  });

  it("answers a generic 500 when the insert fails (no database text leaks)", async () => {
    const { POST } = await import("@/app/api/verification/route");
    insertError = { message: 'relation "verification_requests" does not exist' };
    const res = await POST(post({ platform: "instagram", handle: "a" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(/relation/);
  });
});

// ---------------------------------------------------------------------------
// GET /api/verification
// ---------------------------------------------------------------------------

describe("GET /api/verification", () => {
  it("answers 401 when signed out", async () => {
    const { GET } = await import("@/app/api/verification/route");
    authUser = null;
    expect((await GET(get())).status).toBe(401);
    expect(db.ops).toHaveLength(0);
  });

  it("returns null plus the instructions when the creator never asked", async () => {
    const { GET } = await import("@/app/api/verification/route");
    const body = await (await GET(get())).json();
    expect(body).toEqual({ request: null, instructions: VERIFICATION_INSTRUCTIONS });
    expect(db.opsFor("verification_requests")[0]?.filters).toEqual({ creator_id: "creator_1" });
  });

  it("shows the code while pending, hides it once decided", async () => {
    const { GET } = await import("@/app/api/verification/route");
    const base = {
      id: "req_1", platform: "instagram", handle: "noah", code: "CN-AAAA-BBBB",
      reason: null, created_at: "2026-09-05T00:00:00Z", decided_at: null,
    };

    newestRequest = { ...base, status: "code_issued" };
    expect((await (await GET(get())).json()).request.code).toBe("CN-AAAA-BBBB");

    for (const status of ["approved", "rejected", "revoked"]) {
      newestRequest = { ...base, status };
      const body = await (await GET(get())).json();
      expect(body.request.status).toBe(status);
      expect(body.request.code).toBeNull();
    }
  });
});
