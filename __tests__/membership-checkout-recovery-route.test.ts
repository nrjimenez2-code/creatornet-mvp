import { NextRequest } from "next/server";
import { membershipTestContext as context } from "../test-support/membership-fixtures";
import { checkoutRecoveryFixture } from "../test-support/membership-checkout-recovery-fixtures";
let mockAbandonReady = true;
const mockAbandon = jest.fn();
jest.mock("@/lib/membershipInitialAbandonment", () => ({ membershipInitialAbandonmentReady: () => mockAbandonReady }));
let mockReady = true, mockUser: { id: string } | null;
const mockReconcile = jest.fn(), mockResume = jest.fn(), mockAuth = jest.fn(async () => mockUser);
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: () => mockAuth() }));
jest.mock("@/lib/membershipCheckoutRecovery", () => ({
  membershipCheckoutRecoveryReady: () => mockReady,
  BOOTSTRAP_STAGES: ["customer", "product", "subscription", "hold", "checkout"],
}));
jest.mock("@/lib/membershipServer", () => ({ membershipServerContext: () => context }));
jest.mock("@/lib/membershipRuntime", () => ({ createMembershipRuntime: () => ({ reconcileFirstCheckout: mockReconcile, resumeFirstCheckout: mockResume, abandonFirstCheckout: mockAbandon }) }));
import { POST } from "@/app/api/memberships/[membershipId]/recovery/route";
const f = checkoutRecoveryFixture(), ctx = { params: Promise.resolve({ membershipId: f.a.id }) };
const request = (body: unknown = { action: "reconcile" }, origin = context.siteOrigin, query = "") => new NextRequest(context.siteOrigin + "/api/memberships/" + f.a.id + "/recovery" + query,
  { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { jest.clearAllMocks(); mockReady = true; mockAbandonReady = true; mockAbandon.mockResolvedValue({ ...f.projection, status: "abandoned", canResume: false }); mockUser = { id: f.a.buyer_id }; mockReconcile.mockResolvedValue(f.projection); mockResume.mockResolvedValue(f.projection); });
test("step 5: owned recovery takes its actor only from authentication and disables caching", async () => {
  const response = await POST(request(), ctx); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mockReconcile).toHaveBeenCalledWith(f.a.id, f.a.buyer_id); expect(mockResume).not.toHaveBeenCalled();
});
test("step 4: explicit original checkout resumption is separate from a recovery check", async () => {
  expect((await POST(request({ action: "resume", confirmed: true }), ctx)).status).toBe(200);
  expect(mockResume).toHaveBeenCalledWith(f.a.id, f.a.buyer_id, true); expect(mockReconcile).not.toHaveBeenCalled();
});
test.each([{ action: "resume" }, { action: "resume", confirmed: false }, { action: "reconcile", confirmed: true },
  { action: "reconcile", buyer_id: "foreign" }, { action: "resume", confirmed: true, amount: 1 }, { action: "new_purchase" }, [], null])(
  "steps 4/5: malformed or overriding recovery request %p is refused", async body => {
    expect((await POST(request(body), ctx)).status).toBe(400); expect(mockReconcile).not.toHaveBeenCalled(); expect(mockResume).not.toHaveBeenCalled();
  });
test("step 5: cross-origin and URL-overridden requests are refused", async () => {
  expect((await POST(request(undefined, "https://other.example.invalid"), ctx)).status).toBe(403);
  expect((await POST(request(undefined, context.siteOrigin, "?buyer_id=other"), ctx)).status).toBe(400); expect(mockReconcile).not.toHaveBeenCalled();
});
test("step 5: unauthenticated recovery has no provider authority", async () => {
  mockUser = null; expect((await POST(request(), ctx)).status).toBe(401); expect(mockReconcile).not.toHaveBeenCalled();
});
test("step 10: disabled recovery does not even resolve account authority", async () => {
  mockReady = false; expect((await POST(request(), ctx)).status).toBe(503); expect(mockAuth).not.toHaveBeenCalled();
});
test("step 8: persistence/provider failure stays pending without leaking private details", async () => {
  mockReconcile.mockRejectedValueOnce(Error("Synthetic secret detail")); const response = await POST(request(), ctx);
  expect(response.status).toBe(503); const text = await response.text(); expect(text).not.toContain("Synthetic secret detail"); expect(text).toContain("Do not start a second purchase");
});

test("steps 4/5: unpaid close-out requires explicit intent and uses only the authenticated owner", async () => {
  expect((await POST(request({ action: "abandon", confirmed: true }), ctx)).status).toBe(200);
  expect(mockAbandon).toHaveBeenCalledWith(f.a.id, f.a.buyer_id, true);
  expect(mockReconcile).not.toHaveBeenCalled(); expect(mockResume).not.toHaveBeenCalled();
});
test.each([{ action: "abandon" }, { action: "abandon", confirmed: false }, { action: "abandon", confirmed: true, buyer_id: "foreign" }])(
  "steps 4/5: close-out refuses missing or overridden intent %p", async body => {
    expect((await POST(request(body), ctx)).status).toBe(400); expect(mockAbandon).not.toHaveBeenCalled();
  });
test("step 10: unpaid close-out has its own disabled-by-default gate", async () => {
  mockAbandonReady = false; expect((await POST(request({ action: "abandon", confirmed: true }), ctx)).status).toBe(503);
  expect(mockAbandon).not.toHaveBeenCalled();
});
