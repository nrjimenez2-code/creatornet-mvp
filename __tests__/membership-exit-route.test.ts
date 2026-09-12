import { NextRequest } from "next/server";
import { membershipFixture, membershipTestContext as context } from "../test-support/membership-fixtures";
let mockUser: { id: string } | null, mockReady = true;
const mockQuote = jest.fn(), mockExit = jest.fn(), mockAuth = jest.fn(async () => mockUser);
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: () => mockAuth() }));
jest.mock("@/lib/membershipExit", () => ({ membershipExitReady: () => mockReady }));
jest.mock("@/lib/membershipServer", () => ({ membershipServerContext: () => context }));
jest.mock("@/lib/membershipRuntime", () => ({ createMembershipRuntime: () => ({ quoteExit: mockQuote, requestExit: mockExit }) }));
import { GET, POST } from "@/app/api/memberships/[membershipId]/exit/route";
const f = membershipFixture(), ctx = { params: Promise.resolve({ membershipId: f.a.id }) };
const request = (body: unknown = { kind: "revoke_debits", accepted: true }, origin = context.siteOrigin) =>
  new NextRequest(context.siteOrigin + "/api/memberships/" + f.a.id + "/exit", {
    method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { jest.clearAllMocks(); mockReady = true; mockUser = { id: f.a.buyer_id };
  mockQuote.mockResolvedValue({ payoffAmountCents: 20000 }); mockExit.mockResolvedValue({ providerStopped: true, balanceWaived: false }); });
test("step 2: authenticated quote uses only the owned route identity", async () => {
  const r = await GET(new NextRequest(context.siteOrigin + "/api/memberships/" + f.a.id + "/exit"), ctx);
  expect(r.status).toBe(200); expect(mockQuote).toHaveBeenCalledWith(f.a.id, f.a.buyer_id); expect(r.headers.get("cache-control")).toBe("private, no-store");
});
test("step 2: explicit debit revocation is separate from payoff acceptance", async () => {
  expect((await POST(request(), ctx)).status).toBe(200);
  expect(mockExit).toHaveBeenCalledWith(f.a.id, f.a.buyer_id, "revoke_debits", true, null);
});
test("step 2: minimum-complete cancellation forwards its exact quote for database comparison", async () => {
  const quote = { revision: 3, payoffAmountCents: 0 };
  expect((await POST(request({ kind: "stop_renewal", accepted: true, quote }), ctx)).status).toBe(200);
  expect(mockExit).toHaveBeenCalledWith(f.a.id, f.a.buyer_id, "stop_renewal", true, quote);
});
test("step 8: locally accepted but unconfirmed provider stop returns pending, not completed", async () => {
  mockExit.mockResolvedValueOnce({ providerStopped: false, billingBlocked: true });
  expect((await POST(request(), ctx)).status).toBe(202);
});
test("step 10: disabled handler provides a support route without dispatch", async () => {
  mockReady = false; const r = await POST(request(), ctx); expect(r.status).toBe(503);
  expect(await r.text()).toContain("support@creatornet.net"); expect(mockAuth).not.toHaveBeenCalled();
});
test("step 5: an unauthenticated actor cannot request an exit", async () => {
  mockUser = null; expect((await POST(request(), ctx)).status).toBe(401); expect(mockExit).not.toHaveBeenCalled();
});
test("step 5: cross-origin exit is refused", async () => {
  expect((await POST(request(undefined, "https://other.example.invalid"), ctx)).status).toBe(403); expect(mockExit).not.toHaveBeenCalled();
});
test.each([{ kind: "revoke_debits", accepted: false }, { kind: "payoff", accepted: true },
  { kind: "stop_renewal", accepted: true }, { kind: "revoke_debits", accepted: true, quote: { amount: 1 } },
  { kind: "revoke_debits", accepted: true, buyer_id: "other" }, { kind: "revoke_debits", accepted: true, amount_cents: 1 }])(
  "steps 2/4: invalid exit authority %p is refused", async body => {
    expect((await POST(request(body), ctx)).status).toBe(409); expect(mockExit).not.toHaveBeenCalled();
  });
test("step 8: rejected cancellation never implies that the minimum was paid", async () => {
  mockExit.mockRejectedValueOnce(Error("Synthetic private detail")); const r = await POST(request({ kind: "stop_renewal", accepted: true, quote: {} }), ctx);
  expect(r.status).toBe(409); expect(await r.text()).not.toContain("Synthetic private detail");
});
