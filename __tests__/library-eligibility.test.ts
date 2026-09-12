import { NextRequest } from "next/server";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";
let db: MockClient, user: { id: string } | null;
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { from: (t: string) => db.from(t), rpc: (n: string, a: unknown) => db.rpc(n, a) } }));
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: async () => user }));
import { POST } from "@/app/api/library/eligibility/route";
const saved = { ...process.env };
let rows: Array<{ id: string; buyer_id: string; status: string; access_granted: boolean }>;
let entitlements: Record<string, unknown>, rpcError: boolean;
beforeEach(() => {
  user = { id: "buyer" }; rpcError = false;
  process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = "true";
  process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = "true";
  rows = ["monthly", "timed", "legacy"].map(id => ({ id, buyer_id: "buyer", status: "active", access_granted: id === "legacy" }));
  entitlements = { monthly: { allowed: true, maxAgeSeconds: 20 }, timed: { applicable: true, allowed: true, maxAgeSeconds: 5 },
    legacy: { applicable: false, allowed: true, maxAgeSeconds: 3600 } };
  db = createMockClient(op => {
    if (op.table === "purchases") return { data: rows, error: null };
    if (op.kind === "rpc") {
      const id = (op.payload as { p_purchase_id: string }).p_purchase_id;
      return { data: op.table === "read_fixed_service_entitlement_v1" && id === "monthly"
        ? { applicable: false, allowed: false, maxAgeSeconds: 0 } : entitlements[id], error: rpcError ? { message: "unavailable" } : null };
    }
    return undefined;
  });
});
afterAll(() => { process.env = saved; });
const request = (purchaseIds: unknown = rows.map(r => r.id)) => POST(new NextRequest("https://site.invalid/api/library/eligibility?buyer_id=other", {
  method: "POST", body: JSON.stringify({ purchaseIds, buyer_id: "other" }),
}));
test("lists active monthly/timed raw-false and legacy purchases through real shared reader", async () => {
  const response = await request();
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await response.json()).purchaseIds).toEqual(["monthly", "timed", "legacy"]);
  expect(db.opsFor("purchases")[0].filters).toEqual({ buyer_id: "buyer" });
  expect(db.opsFor("purchases")[0].inFilters).toEqual([{ column: "id", values: ["monthly", "timed", "legacy"] }]);
  for (const op of db.ops.filter(op => op.kind === "rpc")) expect(op.payload).toMatchObject({ p_buyer_id: "buyer" });
  expect(db.ops.some(op => op.kind === "update")).toBe(false);
});
test.each(["expired", "refunded", "disputed", "pending", "financial-hold"])("reader-denied %s purchase is omitted", async status => {
  rows[0].status = status; entitlements.monthly = { allowed: false, maxAgeSeconds: 0 };
  expect((await (await request()).json()).purchaseIds).toEqual(["timed", "legacy"]);
});
test("paid exit remains discoverable when the reader allows remaining paid time", async () => {
  rows[0].status = "complete";
  expect((await (await request()).json()).purchaseIds).toContain("monthly");
});
test("wrong owner is never sent to the entitlement reader", async () => {
  rows[0].buyer_id = "other";
  expect((await (await request()).json()).purchaseIds).not.toContain("monthly");
  expect(db.ops.filter(op => op.kind === "rpc").some(op => (op.payload as any).p_purchase_id === "monthly")).toBe(false);
});
test.each([null, { allowed: true, maxAgeSeconds: 0 }, { allowed: true, maxAgeSeconds: 3601 }, { allowed: true, maxAgeSeconds: "30" }])("malformed reader result %p fails closed", async value => {
  entitlements.monthly = value;
  expect((await (await request()).json()).purchaseIds).not.toContain("monthly");
});
test("reader errors fail closed even on apparently allowed data", async () => {
  rpcError = true; expect((await (await request()).json()).purchaseIds).toEqual([]);
});
test.each([[false, false, ["legacy"]], [true, false, ["monthly", "legacy"]], [false, true, ["timed", "legacy"]]])(
  "reader readiness monthly=%s fixed=%s", async (monthly, fixed, expected) => {
    process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = String(monthly);
    process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = String(fixed);
    // Monthly-only reader sees timed raw access=false.
    if (!fixed) entitlements.timed = { allowed: false, maxAgeSeconds: 0 };
    expect((await (await request()).json()).purchaseIds).toEqual(expected);
    if (!monthly && !fixed) expect(db.ops.filter(op => op.kind === "rpc")).toHaveLength(0);
  });
test("preserves legacy status exclusions", async () => {
  rows[2].status = "refunded";
  expect((await (await request()).json()).purchaseIds).not.toContain("legacy");
});
test("unauthenticated requests do not query purchases", async () => {
  user = null; expect((await request()).status).toBe(401); expect(db.ops).toHaveLength(0);
});
test.each([null, [""], Array(101).fill("id")])("invalid request %p is rejected", async ids => {
  expect((await request(ids)).status).toBe(400); expect(db.ops).toHaveLength(0);
});
