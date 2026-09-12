import { NextRequest } from "next/server";
import { membershipPayoffFixture } from "../test-support/membership-payoff-fixtures";
import { membershipTestContext as context } from "../test-support/membership-fixtures";
let mockUser: { id: string } | null, mockCheckoutReady = true, mockReconcileReady = true;
const mockQuote = jest.fn(), mockPrepare = jest.fn(), mockConfirm = jest.fn(), mockAbandon = jest.fn(), mockAuth = jest.fn(async () => mockUser);
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: () => mockAuth() }));
jest.mock("@/lib/membershipServer", () => ({ membershipServerContext: () => context }));
jest.mock("@/lib/membershipPayoffRuntime", () => ({ membershipPayoffCheckoutReady: () => mockCheckoutReady, membershipPayoffReconciliationReady: () => mockReconcileReady }));
jest.mock("@/lib/membershipRuntime", () => ({ createMembershipRuntime: () => ({ quotePayoff: mockQuote, acceptAndPreparePayoff: mockPrepare,
  confirmPayoff: mockConfirm, abandonPayoff: mockAbandon }) }));
import { GET, POST } from "@/app/api/memberships/[membershipId]/payoff/route";
const f = membershipPayoffFixture(), ctx = { params: Promise.resolve({ membershipId: f.a.id }) };
const consent = { accepted: true, version: f.p.terms.version, fingerprint: f.p.fingerprint };
const req = (body: unknown = { action: "checkout", consent }, origin = context.siteOrigin) => new NextRequest(
  context.siteOrigin + "/api/memberships/" + f.a.id + "/payoff", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { jest.clearAllMocks(); mockCheckoutReady = true; mockReconcileReady = true; mockUser = { id: f.a.buyer_id };
  mockQuote.mockResolvedValue({ terms: f.p.terms, fingerprint: f.p.fingerprint }); mockPrepare.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/synthetic" });
  mockConfirm.mockResolvedValue({ payoffRecorded: false }); mockAbandon.mockResolvedValue({ status: "abandoned" }); });
test("steps 2/4: quote uses owned identity and refuses query overrides", async () => {
  expect((await GET(new NextRequest(context.siteOrigin + "/api/memberships/" + f.a.id + "/payoff"), ctx)).status).toBe(200);
  expect(mockQuote).toHaveBeenCalledWith(f.a.id, f.a.buyer_id);
  expect((await GET(new NextRequest(context.siteOrigin + "/api/memberships/" + f.a.id + "/payoff?amount=1"), ctx)).status).toBe(409);
});
test("step 4: only exact separate consent is forwarded to payoff checkout", async () => {
  expect((await POST(req(), ctx)).status).toBe(200); expect(mockPrepare).toHaveBeenCalledWith(f.a.id, f.a.buyer_id, consent);
});
test("step 8: disabling new checkout leaves captured-payment confirmation available", async () => {
  mockCheckoutReady = false; expect((await POST(req({ action: "confirm", payoff_id: f.p.id }), ctx)).status).toBe(200);
  expect(mockConfirm).toHaveBeenCalledWith(f.a.id, f.a.buyer_id, f.p.id); expect(mockPrepare).not.toHaveBeenCalled();
});
test("step 2: disabling new checkout does not hide an owned existing payoff's recovery view", async () => {
  mockCheckoutReady = false; expect((await GET(new NextRequest(context.siteOrigin + "/api/memberships/" + f.a.id + "/payoff"), ctx)).status).toBe(200);
  expect(mockQuote).toHaveBeenCalledWith(f.a.id, f.a.buyer_id); expect(mockPrepare).not.toHaveBeenCalled();
});
test("step 2: abandonment is explicit, owned and does not initiate checkout", async () => {
  const r = await POST(req({ action: "abandon", payoff_id: f.p.id, confirmed: true }), ctx); expect(r.status).toBe(200);
  expect(mockAbandon).toHaveBeenCalledWith(f.a.id, f.a.buyer_id, f.p.id, true); expect(mockPrepare).not.toHaveBeenCalled();
});
test("step 10: default-off handling blocks access before authentication or provider work", async () => {
  mockReconcileReady = false; expect((await POST(req(), ctx)).status).toBe(503); expect(mockAuth).not.toHaveBeenCalled();
});
test("step 5: unauthenticated and cross-origin requests cannot submit payoff actions", async () => {
  mockUser = null; expect((await POST(req(), ctx)).status).toBe(401); mockUser = { id: f.a.buyer_id };
  expect((await POST(req(undefined, "https://other.example.invalid"), ctx)).status).toBe(403); expect(mockPrepare).not.toHaveBeenCalled();
});
test.each([{ action: "checkout", consent: { ...consent, accepted: false } }, { action: "checkout", consent, amount_cents: 1 },
  { action: "confirm", payoff_id: f.p.id, buyer_id: "other" }, { action: "abandon", payoff_id: f.p.id, confirmed: false },
  { action: "confirm", payoff_id: "cs_not_an_owned_payoff" }, { action: "checkout", consent: { ...consent, extra: true } }])(
  "steps 2/4: unsupported action or browser authority %p is rejected", async body => {
    expect((await POST(req(body), ctx)).status).toBe(409); expect(mockPrepare).not.toHaveBeenCalled(); expect(mockConfirm).not.toHaveBeenCalled(); expect(mockAbandon).not.toHaveBeenCalled();
  });
test("step 8: failed confirmation is not reported as a paid minimum", async () => {
  mockConfirm.mockRejectedValueOnce(Error("Synthetic private detail")); const r = await POST(req({ action: "confirm", payoff_id: f.p.id }), ctx);
  expect(r.status).toBe(409); expect(await r.text()).not.toContain("Synthetic private detail");
});
