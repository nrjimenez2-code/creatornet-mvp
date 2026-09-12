import { NextRequest } from "next/server";
import { membershipTestContext as context } from "../test-support/membership-fixtures";
let mockReady = true, mockUser: { id: string } | null;
const mockChallenge = jest.fn(), mockStatus = jest.fn();
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: async () => mockUser }));
jest.mock("@/lib/membershipRenewalRecovery", () => ({ membershipRenewalRecoveryReady: () => mockReady }));
jest.mock("@/lib/membershipServer", () => ({ membershipServerContext: () => context }));
jest.mock("@/lib/membershipRuntime", () => ({ createMembershipRuntime: () => ({
  readRenewalBankChallenge: mockChallenge, readRenewalRecovery: mockStatus }) }));
import { POST } from "@/app/api/memberships/[membershipId]/bank-verification/route";
const id = "40000000-0000-4000-8000-000000000001", buyer = "40000000-0000-4000-8000-000000000002", ctx = { params: Promise.resolve({ membershipId: id }) };
const request = (body: unknown = { action: "challenge", invoiceId: "in_original" }, origin = context.siteOrigin, query = "") =>
  new NextRequest(context.siteOrigin + "/api/memberships/" + id + "/bank-verification" + query,
    { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { jest.clearAllMocks(); mockReady = true; mockUser = { id: buyer };
  mockChallenge.mockResolvedValue({ status: "bank_verification_ready", membershipId: id, clientSecret: "pi_original_secret_fixture" });
  mockStatus.mockResolvedValue({ membershipId: id, outcome: "paid_accounted" }); });
test("steps 5/8: challenge is authenticated, owned and never cacheable", async () => {
  const result = await POST(request(), ctx); expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(result.headers.get("pragma")).toBe("no-cache"); expect(mockChallenge).toHaveBeenCalledWith(id, buyer, "in_original");
});
test("step 8: checking payment does not release another challenge", async () => {
  const result = await POST(request({ action: "status", invoiceId: "in_original" }), ctx);
  expect(result.status).toBe(200); expect(mockStatus).toHaveBeenCalledWith(id, buyer, "in_original"); expect(mockChallenge).not.toHaveBeenCalled();
});
test.each([{ action: "pay", invoiceId: "in_original" }, { action: "challenge", invoiceId: "in_original", buyerId: buyer },
  { action: "challenge", invoiceId: "in_original", clientSecret: "other" }, { action: "challenge", invoiceId: "in_original", paymentMethodId: "pm_other" },
  { action: "challenge", invoiceId: "in_original", amountCents: 1 }, { action: "challenge", invoiceId: "../other" }, null, []])(
  "steps 4/5: invalid or overriding request %p is rejected", async body => {
    expect((await POST(request(body), ctx)).status).toBe(400); expect(mockChallenge).not.toHaveBeenCalled();
  });
test("step 5: origin, query and signed-in owner are required", async () => {
  expect((await POST(request(undefined, "https://other.example.invalid"), ctx)).status).toBe(403);
  expect((await POST(request(undefined, context.siteOrigin, "?secret=other"), ctx)).status).toBe(400);
  mockUser = null; expect((await POST(request(), ctx)).status).toBe(401); expect(mockChallenge).not.toHaveBeenCalled();
});
test("step 10: disabled recovery schema fails closed", async () => {
  mockReady = false; expect((await POST(request(), ctx)).status).toBe(503); expect(mockChallenge).not.toHaveBeenCalled();
});
test("step 8: provider error details and secrets are never reflected in failures", async () => {
  mockChallenge.mockRejectedValueOnce(Error("pi_original_secret_private"));
  const result = await POST(request(), ctx); expect(result.status).toBe(503); expect(await result.text()).not.toContain("secret_private");
});
