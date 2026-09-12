import { NextRequest } from "next/server";
import { GET, POST } from "../app/api/admin/installments/route";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
const actor = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333", origin = "https://synthetic-checkout.vercel.app";
const context = { mode: "test", siteOrigin: origin }, terms = { version: "exact-cents-context-v2", title: "Synthetic plan", totalCents: 199900, paymentCount: 3 };
const stop = jest.fn(), observe = jest.fn(), parse = jest.fn();
let db: ReturnType<typeof createMockClient>, authorized: boolean, protocol: string, wrongTerms: boolean;
const savedEnv = { ...process.env };
jest.mock("../lib/admin/server", () => ({ requireAdmin: async () => {
  if (!authorized) throw Error("Denied"); return { user: { id: actor }, admin: db };
}, adminAuthErrorResponse: () => new Response(null, { status: 403 }) }));
jest.mock("../lib/installments/contextServer", () => ({ exactContextServerConfig: () => ({ approvedContext: context }) }));
jest.mock("../lib/installments/contextRuntime", () => ({ createExactContextRuntime: () => ({ observeContext: observe }),
  createExactContextBillingStop: () => ({ stopBilling: stop }) }));
jest.mock("../lib/installments/contextReservation", () => ({ ...jest.requireActual("../lib/installments/contextReservation"),
  readExactContextReservation: (...args: unknown[]) => parse(...args) }));
jest.mock("../lib/stripeClient", () => ({ getStripe: () => { throw Error("Legacy SDK must not be constructed"); } }));
beforeEach(() => {
  jest.clearAllMocks(); authorized = true; protocol = terms.version; wrongTerms = false;
  process.env = { ...savedEnv, NEXT_PUBLIC_SITE_URL: origin, CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY: "true",
    CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY: "true", CREATOR_EXACT_INSTALLMENTS_CONTEXT_ADMIN_READY: "true" };
  db = createMockClient(op => {
    if (op.table === "exact_installment_agreements") {
      const row = { id, terms: { ...terms, version: protocol, bookingPaymentId: id, ...(wrongTerms ? { totalCents: 1 } : {}) }, status: "active", purchase_id: id };
      return { data: op.filters.id ? row : [row], error: null };
    }
    if (op.table === "exact_installment_context_reservations_v2") return { data: [{ id, terms, context }], error: null };
    return { data: [], error: null };
  });
  observe.mockResolvedValue({ contextEvidence: "synthetic-proof" }); parse.mockReturnValue({ id, terms });
  stop.mockResolvedValue({ status: "collection_stopped" });
});
afterEach(() => { process.env = { ...savedEnv }; });
const input = { agreementId: id, requestId, confirmation: "STOP_FUTURE_BILLING" };
const req = (body: unknown = input, site = origin) => new NextRequest(origin + "/api/admin/installments", {
  method: "POST", headers: { origin: site, "content-type": "application/json" }, body: JSON.stringify(body) });
const get = () => GET(new NextRequest(origin + "/api/admin/installments"));
test("#3 existing admin POST preserves exact authenticated actor, request and same engine response", async () => {
  const r = await POST(req()); expect(r.status).toBe(200); expect(await r.json()).toEqual({ status: "collection_stopped" });
  expect(stop).toHaveBeenCalledWith(id, actor, requestId); expect(r.headers.get("cache-control")).toContain("no-store");
});
test.each(["busy", "reconciliation_required"])("#3 pending context stop %s stays pending", async status => {
  stop.mockResolvedValue({ status }); const r = await POST(req()); expect(r.status).toBe(202); expect(await r.json()).toEqual({ status });
});
test.each(["disabled", "unknown", "auth", "origin", "confirmation"])("#3 context stop %s cannot dispatch", async fault => {
  if (fault === "disabled") process.env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_ADMIN_READY = "false";
  if (fault === "unknown") protocol = "future-unapproved";
  if (fault === "auth") authorized = false;
  const r = await POST(req(fault === "confirmation" ? { ...input, confirmation: "yes" } : input, fault === "origin" ? "https://foreign.test" : origin));
  expect(r.status).toBeGreaterThanOrEqual(400); expect(stop).not.toHaveBeenCalled();
});
test("#3 context admin GET reuses the existing review contract, with independent context evidence and no stop", async () => {
  const r = await get(); expect(r.status).toBe(200); expect(await r.json()).toEqual({ plans: [{ id, title: terms.title,
    status: "active", totalCents: 199900, paymentCount: 3, purchaseId: id, holds: [], recoveries: [], stop: null }], nextCursor: null });
  expect(parse).toHaveBeenCalledWith({ id, terms, context }, "synthetic-proof"); expect(stop).not.toHaveBeenCalled();
});
test("#3 mismatched persisted admin terms cannot be presented as a safe empty queue", async () => {
  wrongTerms = true; const r = await get(); expect(r.status).toBe(503); expect(stop).not.toHaveBeenCalled();
});
test("#3 a lost context stop response remains reviewable without raw errors or a replacement request", async () => {
  stop.mockRejectedValue(Error("SECRET provider payload")); const r = await POST(req()); expect(r.status).toBe(409);
  expect(await r.text()).not.toContain("SECRET"); expect(stop).toHaveBeenCalledTimes(1);
});
