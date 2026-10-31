import { NextRequest } from "next/server";
const mockTrusted = jest.fn(), mockProfile = jest.fn(), mockSettings = jest.fn();
jest.mock("@/lib/trustedSession", () => ({ getTrustedSession: (...args: unknown[]) => mockTrusted(...args) }));
jest.mock("@/lib/admin/server", () => ({ adminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mockProfile }) }) }) }) }));
jest.mock("@/lib/release/server", () => ({ loadReleaseSettings: () => mockSettings(), verifiedIdentity: (user: { email_confirmed_at?: string }) => !!user?.email_confirmed_at }));
import { GET } from "@/app/api/account/security/route";
beforeEach(() => {
  jest.clearAllMocks();
  mockTrusted.mockResolvedValue({ user: { id: "owner", email_confirmed_at: "yes", factors: [] }, accessToken: "fixture.e30.signature" });
  mockProfile.mockResolvedValue({ data: { role: "admin", banned_at: null }, error: null });
  mockSettings.mockResolvedValue({ owner_id: "owner" });
});
test("AAL1 owner without factors can reach minimal enrollment status", async () => {
  const response = await GET(new NextRequest("https://site.test/api/account/security"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ userId: "owner", verifiedFactorCount: 0, aal2: false, recent: false });
});
test("non-admin non-owner and banned accounts receive no bootstrap status", async () => {
  mockProfile.mockResolvedValue({ data: { role: "user", banned_at: null }, error: null });
  mockSettings.mockResolvedValue({ owner_id: "other" });
  expect((await GET(new NextRequest("https://site.test"))).status).toBe(403);
  mockSettings.mockResolvedValue({ owner_id: "owner" });
  mockProfile.mockResolvedValue({ data: { role: "admin", banned_at: "now" }, error: null });
  expect((await GET(new NextRequest("https://site.test"))).status).toBe(403);
});
