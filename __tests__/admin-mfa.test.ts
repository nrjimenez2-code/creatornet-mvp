import { NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";
const mockTrusted = jest.fn();
jest.mock("@/lib/trustedSession", () => ({ getTrustedSession: (...args: unknown[]) => mockTrusted(...args) }));
import { requireAdminMfa, trustedMfaStatus } from "@/lib/adminMfa";
const now = Math.floor(Date.now() / 1000);
const fixture = (claims: Record<string, unknown> = {}, factors = [{ id: "factor", factor_type: "totp", status: "verified" }]) => ({ user: { id: "owner", factors } as unknown as User, accessToken: `fixture.${Buffer.from(JSON.stringify({ sub: "owner", aal: "aal2", amr: [{ method: "totp", timestamp: now }], ...claims })).toString("base64url")}.verified` });
const request = (method: string) => new NextRequest("https://site.test/api/admin/ban", { method });
beforeEach(() => { jest.resetAllMocks(); mockTrusted.mockResolvedValue(fixture()); });
test("verified AAL2 accepts reads and fresh mutations", async () => {
  await expect(requireAdminMfa("owner", request("GET"))).resolves.toBeTruthy();
  await expect(requireAdminMfa("owner", request("POST"))).resolves.toBeTruthy();
});
test("AAL1 and missing AAL never gain admin access even when a factor exists", async () => {
  for (const aal of ["aal1", undefined]) {
    mockTrusted.mockResolvedValue(fixture({ aal }));
    await expect(requireAdminMfa("owner", request("GET"))).rejects.toMatchObject({ status: 403, code: "MFA_REQUIRED" });
  }
});
test("zero factors requires enrollment rather than bypassing assurance", async () => {
  mockTrusted.mockResolvedValue(fixture({}, []));
  await expect(requireAdminMfa("owner")).rejects.toMatchObject({ code: "MFA_ENROLLMENT_REQUIRED" });
});
test("a different verified user cannot lend assurance to the owner", async () => {
  mockTrusted.mockResolvedValue({ ...fixture(), user: { ...fixture().user, id: "other" } });
  await expect(requireAdminMfa("owner")).rejects.toMatchObject({ code: "MFA_REQUIRED" });
});
test.each([now - 601, now + 120, "future"])("stale or invalid timestamp %s cannot mutate", async timestamp => {
  mockTrusted.mockResolvedValue(fixture({ amr: [{ method: "totp", timestamp }] }));
  await expect(requireAdminMfa("owner", request("POST"))).rejects.toMatchObject({ code: "MFA_REFRESH_REQUIRED" });
  await expect(requireAdminMfa("owner", request("GET"))).resolves.toBeTruthy();
});
test("malformed or mismatched subject claims and unverified factors are rejected", () => {
  expect(trustedMfaStatus({ ...fixture(), accessToken: "not-a-jwt" }).aal2).toBe(false);
  expect(trustedMfaStatus(fixture({ sub: "other" })).aal2).toBe(false);
  expect(trustedMfaStatus(fixture({}, [{ id: "factor", factor_type: "totp", status: "unverified" }])).aal2).toBe(false);
});
