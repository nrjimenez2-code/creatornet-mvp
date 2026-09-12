import { NextRequest } from "next/server";
import { membershipTestContext as context } from "../test-support/membership-fixtures";
import { monthlyCardSetupFixture } from "../test-support/membership-card-setup-fixtures";
import { MONTHLY_CARD_SETUP_CONSENT_VERSION } from "@/lib/membershipCardSetupConsent";
let mockReady = true, mockUser: { id: string } | null;
const mockStatus = jest.fn(), mockPrepare = jest.fn(), mockVerify = jest.fn();
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: async () => mockUser }));
jest.mock("@/lib/membershipCardSetup", () => ({ ...jest.requireActual("@/lib/membershipCardSetup"), membershipCardSetupReady: () => mockReady }));
jest.mock("@/lib/membershipServer", () => ({ membershipServerContext: () => context }));
jest.mock("@/lib/membershipRuntime", () => ({ createMembershipRuntime: () => ({
  currentRenewalRecovery: mockStatus, prepareRenewalCardSetup: mockPrepare, verifyRenewalCardSetup: mockVerify }) }));
import { POST } from "@/app/api/memberships/[membershipId]/renewal-recovery/route";
const { f, r } = monthlyCardSetupFixture(), ctx = { params: Promise.resolve({ membershipId: f.a.id }) };
const request = (body: unknown = { action: "status" }, origin = context.siteOrigin, query = "") =>
  new NextRequest(context.siteOrigin + "/api/memberships/" + f.a.id + "/renewal-recovery" + query,
    { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { jest.clearAllMocks(); mockReady = true; mockUser = { id: f.a.buyer_id };
  mockStatus.mockResolvedValue({ membershipId: f.a.id, renewal: null, setup: null });
  mockPrepare.mockResolvedValue({ membershipId: f.a.id, setupId: r.id, status: "setup_pending" });
  mockVerify.mockResolvedValue({ membershipId: f.a.id, setupId: r.id, status: "card_saved_payment_not_attempted" });
});
test("step 5: status uses the authenticated owner and is private/no-store", async () => {
  const res = await POST(request(), ctx); expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(mockStatus).toHaveBeenCalledWith(f.a.id, f.a.buyer_id); expect(mockPrepare).not.toHaveBeenCalled();
});
test("step 4: current explicit setup consent is forwarded separately from status", async () => {
  expect((await POST(request({ action: "setup", accepted: true, consentVersion: MONTHLY_CARD_SETUP_CONSENT_VERSION }), ctx)).status).toBe(200);
  expect(mockPrepare).toHaveBeenCalledWith(f.a.id, f.a.buyer_id, MONTHLY_CARD_SETUP_CONSENT_VERSION, true); expect(mockStatus).not.toHaveBeenCalled();
});
test("step 5: verification is owned and does not become payment authority", async () => {
  expect((await POST(request({ action: "verify", setupId: r.id }), ctx)).status).toBe(200);
  expect(mockVerify).toHaveBeenCalledWith(f.a.id, f.a.buyer_id, r.id); expect(mockPrepare).not.toHaveBeenCalled();
});
test.each([{ action: "setup" }, { action: "setup", accepted: false, consentVersion: MONTHLY_CARD_SETUP_CONSENT_VERSION },
  { action: "setup", accepted: true, consentVersion: "old" }, { action: "status", buyer_id: "other" }, { action: "verify", setupId: r.id, payment_method: "pm_other" },
  { action: "pay" }, [], null])("steps 4/5: malformed or overriding action %p is rejected", async body => {
    expect((await POST(request(body), ctx)).status).toBe(400); expect(mockPrepare).not.toHaveBeenCalled(); expect(mockVerify).not.toHaveBeenCalled();
  });
test("step 5: cross-origin and query overrides are rejected", async () => {
  expect((await POST(request(undefined, "https://other.example.invalid"), ctx)).status).toBe(403);
  expect((await POST(request(undefined, context.siteOrigin, "?invoice=other"), ctx)).status).toBe(400);
});
test("step 5: unauthenticated users have no recovery authority", async () => {
  mockUser = null; expect((await POST(request(), ctx)).status).toBe(401); expect(mockStatus).not.toHaveBeenCalled();
});
test("step 10: disabled setup schema fails closed", async () => {
  mockReady = false; expect((await POST(request(), ctx)).status).toBe(503); expect(mockStatus).not.toHaveBeenCalled();
});
test("step 8: private provider failures are not returned to the buyer", async () => {
  mockPrepare.mockRejectedValueOnce(Error("Synthetic private detail"));
  const res = await POST(request({ action: "setup", accepted: true, consentVersion: MONTHLY_CARD_SETUP_CONSENT_VERSION }), ctx);
  expect(res.status).toBe(503); expect(await res.text()).not.toContain("Synthetic private detail");
});

