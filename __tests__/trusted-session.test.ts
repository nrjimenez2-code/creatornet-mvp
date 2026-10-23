import { NextRequest } from "next/server";
const getUser = jest.fn(), getSession = jest.fn();
const mockFactory = jest.fn();
jest.mock("@/lib/supabaseServer", () => ({ createServerClient: (...args: unknown[]) => mockFactory(...args) }));
import { getTrustedSession } from "@/lib/trustedSession";
beforeEach(() => { jest.resetAllMocks(); mockFactory.mockReturnValue({ auth: { getUser, getSession } }); });

test("valid bearer binds its verified user and exact token without reading cookies", async () => {
  getUser.mockResolvedValue({ data: { user: { id: "bearer-user" } }, error: null });
  expect(await getTrustedSession(new NextRequest("https://site.test", { headers: { authorization: "Bearer verified-bearer" } }))).toEqual({ user: { id: "bearer-user" }, accessToken: "verified-bearer" });
  expect(getUser).toHaveBeenCalledWith("verified-bearer"); expect(getSession).not.toHaveBeenCalled();
  expect(mockFactory).toHaveBeenCalledWith(expect.objectContaining({ readOnlyAuthCookies: true }));
});
test("invalid bearer falls back to independently verified cookie token, never cookie user metadata", async () => {
  getUser.mockResolvedValueOnce({ data: { user: null }, error: {} }).mockResolvedValueOnce({ data: { user: { id: "cookie-user" } }, error: null });
  getSession.mockResolvedValue({ data: { session: { access_token: "verified-cookie", user: { id: "forged-user" } } }, error: null });
  expect(await getTrustedSession(new NextRequest("https://site.test", { headers: { authorization: "Bearer invalid" } }))).toEqual({ user: { id: "cookie-user" }, accessToken: "verified-cookie" });
  expect(getUser.mock.calls).toEqual([["invalid"], ["verified-cookie"]]);
});
test("forged cookie session with invalid token is refused", async () => {
  getSession.mockResolvedValue({ data: { session: { access_token: "forged" } }, error: null });
  getUser.mockResolvedValue({ data: { user: null }, error: {} });
  expect(await getTrustedSession()).toBeNull();
});
