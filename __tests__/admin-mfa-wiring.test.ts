import { NextRequest } from "next/server";
const mockIdentity = jest.fn(), mockTrusted = jest.fn(), mockFrom = jest.fn(), mockUpdate = jest.fn();
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: (...args: unknown[]) => mockIdentity(...args) }));
jest.mock("@/lib/trustedSession", () => ({ getTrustedSession: (...args: unknown[]) => mockTrusted(...args) }));
jest.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (...args: unknown[]) => mockFrom(...args) }) }));
import { requireAdmin, adminAuthErrorResponse } from "@/lib/admin/server";
import { runModerationAction, deriveUserStatus } from "@/lib/admin/moderation";

beforeEach(() => {
  jest.clearAllMocks();
  mockIdentity.mockResolvedValue({ id: "owner" });
  mockFrom.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "admin" }, error: null }) }) }), update: mockUpdate });
  mockTrusted.mockResolvedValue({ user: { id: "owner", factors: [] }, accessToken: "fixture.e30.signature" });
});
test("real admin read guard returns meaningful enrollment status", async () => {
  const error = await requireAdmin(new NextRequest("https://site.test/api/admin/reports")).catch(failure => failure);
  const response = adminAuthErrorResponse(error, "fixture");
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "MFA_ENROLLMENT_REQUIRED", securityUrl: "/account/security" });
});
test("same-origin AAL1 admin cannot reach moderation writes", async () => {
  const req = new NextRequest("https://site.test/api/admin/ban", { method: "POST", headers: { origin: "https://site.test", host: "site.test" }, body: JSON.stringify({ userId: "target" }) });
  const response = await runModerationAction(req, { action: "ban_user", targetTable: "profiles", bodyKey: "userId", selectColumns: "banned_at,flag_reason", buildUpdate: () => ({ banned_at: "now" }), deriveStatus: deriveUserStatus });
  expect(response.status).toBe(403);
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockFrom).toHaveBeenCalledTimes(1); // authorization role only
});
test("real administrator guard allows the same user with verified AAL2", async () => {
  mockTrusted.mockResolvedValue({ user: { id: "owner", factors: [{ factor_type: "totp", status: "verified" }] }, accessToken: `fixture.${Buffer.from(JSON.stringify({ sub: "owner", aal: "aal2" })).toString("base64url")}.verified` });
  await expect(requireAdmin(new NextRequest("https://site.test/api/admin/reports"))).resolves.toMatchObject({ user: { id: "owner" } });
});
