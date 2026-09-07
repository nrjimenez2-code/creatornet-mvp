/**
 * Blue "Authenticity" check — the admin side.
 *
 * Imports and invokes the REAL /api/admin/verification handler against the
 * recording client: requireAdmin gate (401 / 403), body validation (400),
 * missing request (404), the status machine (409), and the three decisions'
 * side effects — approve stamps profiles.authenticity_verified_at, revoke
 * clears it, reject leaves profiles untouched — each followed by an
 * admin_actions row, or a 500 when that row cannot be written.
 *
 * Mutation-checked (see PR).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";

import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";

let db: MockClient;
let authUser: { id: string } | null = { id: "admin_1" };
let role = "admin";
let requestRow: { id: string; creator_id: string; status: string } | null = null;
let updateReturnsRow = true;
let profileUpdateError: { message: string } | null = null;
let auditInsertError: { message: string } | null = null;

jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: authUser }, error: null }) } }),
  createSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: authUser }, error: null }) } }),
}));

function makeDb() {
  return createMockClient((op: Op) => {
    if (op.table === "profiles" && op.kind === "select") return { data: { role }, error: null };
    if (op.table === "profiles" && op.kind === "update") {
      return profileUpdateError ? { data: null, error: profileUpdateError } : { data: null, error: null };
    }
    if (op.table === "verification_requests" && op.kind === "select") return { data: requestRow, error: null };
    if (op.table === "verification_requests" && op.kind === "update") {
      return { data: updateReturnsRow && requestRow ? { id: requestRow.id } : null, error: null };
    }
    if (op.table === "admin_actions" && op.kind === "insert") {
      return auditInsertError ? { data: null, error: auditInsertError } : { data: null, error: null };
    }
    return undefined;
  });
}

async function decide(body: unknown) {
  const { POST } = await import("@/app/api/admin/verification/route");
  const req = new Request("https://x/api/admin/verification", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req as never);
}

const pending = () => ({ id: "req_1", creator_id: "creator_1", status: "code_issued" });
const approved = () => ({ id: "req_1", creator_id: "creator_1", status: "approved" });

const profileUpdates = () => db.opsFor("profiles").filter((o) => o.kind === "update");
const requestUpdates = () => db.opsFor("verification_requests").filter((o) => o.kind === "update");
const audits = () => db.opsFor("admin_actions").filter((o) => o.kind === "insert");

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  authUser = { id: "admin_1" };
  role = "admin";
  requestRow = null;
  updateReturnsRow = true;
  profileUpdateError = null;
  auditInsertError = null;
  db = makeDb();
});

afterEach(() => jest.restoreAllMocks());

describe("gate", () => {
  it("answers 401 when signed out", async () => {
    authUser = null;
    requestRow = pending();
    const res = await decide({ requestId: "req_1", decision: "approve" });
    expect(res.status).toBe(401);
    expect(db.opsFor("verification_requests")).toHaveLength(0);
  });

  it("answers 403 for a signed-in non-admin and changes nothing", async () => {
    role = "user";
    requestRow = pending();
    const res = await decide({ requestId: "req_1", decision: "approve" });
    expect(res.status).toBe(403);
    expect(db.ops.filter((o) => o.kind !== "select")).toHaveLength(0);
  });
});

describe("validation", () => {
  it("answers 400 for a bad decision, a bad id, or an oversized reason", async () => {
    requestRow = pending();
    expect((await decide({ requestId: "req_1", decision: "ban" })).status).toBe(400);
    expect((await decide({ requestId: "bad,id)", decision: "approve" })).status).toBe(400);
    expect((await decide({ requestId: "req_1", decision: "approve", reason: "x".repeat(501) })).status).toBe(400);
    expect((await decide("nope")).status).toBe(400);
    expect(db.opsFor("verification_requests")).toHaveLength(0);
  });

  it("answers 404 when the request does not exist", async () => {
    requestRow = null;
    const res = await decide({ requestId: "req_missing", decision: "approve" });
    expect(res.status).toBe(404);
    expect(db.ops.filter((o) => o.kind !== "select")).toHaveLength(0);
  });
});

describe("status machine", () => {
  const badMoves: Array<[string, string]> = [
    ["approved", "approve"],
    ["approved", "reject"],
    ["rejected", "approve"],
    ["rejected", "revoke"],
    ["revoked", "revoke"],
    ["revoked", "approve"],
    ["code_issued", "revoke"],
  ];

  it.each(badMoves)("refuses %s → %s with 409 and writes nothing", async (from, decision) => {
    requestRow = { id: "req_1", creator_id: "creator_1", status: from };
    const res = await decide({ requestId: "req_1", decision });
    expect(res.status).toBe(409);
    expect(db.ops.filter((o) => o.kind !== "select")).toHaveLength(0);
  });

  it("answers 409 when another admin decided first (compare-and-set lost)", async () => {
    requestRow = pending();
    updateReturnsRow = false;
    const res = await decide({ requestId: "req_1", decision: "approve" });
    expect(res.status).toBe(409);
    expect(profileUpdates()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });
});

describe("approve", () => {
  it("moves the request, stamps the creator's profile, and writes the audit row", async () => {
    requestRow = pending();
    const res = await decide({ requestId: "req_1", decision: "approve", reason: "  code in bio  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "approved" });

    const [reqUpdate] = requestUpdates();
    expect(reqUpdate.filters).toEqual({ id: "req_1", status: "code_issued" }); // compare-and-set
    expect(reqUpdate.payload).toMatchObject({ status: "approved", decided_by: "admin_1", reason: "code in bio" });
    expect((reqUpdate.payload as { decided_at: string }).decided_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const [profileUpdate] = profileUpdates();
    expect(profileUpdate.filters).toEqual({ id: "creator_1" });
    expect((profileUpdate.payload as { authenticity_verified_at: string }).authenticity_verified_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    );

    expect(audits()).toHaveLength(1);
    expect(audits()[0].payload).toEqual({
      actor_id: "admin_1",
      action: "verification.approve",
      target_table: "verification_requests",
      target_id: "req_1",
      reason: "code in bio",
    });
  });

  it("never echoes the code back to the admin", async () => {
    requestRow = pending();
    const body = await (await decide({ requestId: "req_1", decision: "approve" })).json();
    expect(JSON.stringify(body)).not.toMatch(/CN-/);
    expect(body).not.toHaveProperty("code");
  });
});

describe("revoke", () => {
  it("clears the creator's profile timestamp and audits it", async () => {
    requestRow = approved();
    const res = await decide({ requestId: "req_1", decision: "revoke", reason: "account changed hands" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "revoked" });

    expect(requestUpdates()[0].payload).toMatchObject({ status: "revoked" });
    const [profileUpdate] = profileUpdates();
    expect(profileUpdate.filters).toEqual({ id: "creator_1" });
    expect(profileUpdate.payload).toEqual({ authenticity_verified_at: null });
    expect(audits()[0].payload).toMatchObject({ action: "verification.revoke", target_id: "req_1" });
  });
});

describe("reject", () => {
  it("moves the request and audits, but leaves the profile untouched", async () => {
    requestRow = pending();
    const res = await decide({ requestId: "req_1", decision: "reject", reason: "no code in bio" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "rejected" });

    expect(requestUpdates()[0].payload).toMatchObject({ status: "rejected", reason: "no code in bio" });
    expect(profileUpdates()).toHaveLength(0);
    expect(audits()[0].payload).toMatchObject({ action: "verification.reject" });
  });
});

describe("failure paths stay generic and loud", () => {
  it("answers 500 when the audit row cannot be written", async () => {
    requestRow = pending();
    auditInsertError = { message: "insert failed" };
    const res = await decide({ requestId: "req_1", decision: "approve" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Internal error");
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/AUDIT INSERT FAILED/), expect.anything());
  });

  it("answers 500 when the profile stamp fails", async () => {
    requestRow = pending();
    profileUpdateError = { message: 'column "authenticity_verified_at" does not exist' };
    const res = await decide({ requestId: "req_1", decision: "approve" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Internal error");
    expect(audits()).toHaveLength(0);
  });
});
