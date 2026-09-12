process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fake";
const set = jest.fn(), setSession = jest.fn(), getUser = jest.fn(), signOut = jest.fn();
jest.mock("next/headers", () => ({ cookies: async () => ({ get: jest.fn(), set, getAll: () => [
  { name: "sb-project-auth-token.0" }, { name: "sb-project-auth-token.1" }, { name: "unrelated" },
] }) }));
jest.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { setSession, getUser, signOut } }) }));
import { POST } from "@/app/auth/callback/route";
const call = (body: object, origin = "https://creatornet.net") => POST(new Request("https://creatornet.net/auth/callback", {
  method: "POST", headers: { origin, host: "creatornet.net", "Content-Type": "application/json" }, body: JSON.stringify(body),
}));
beforeEach(() => { jest.clearAllMocks(); setSession.mockResolvedValue({ error: null }); getUser.mockResolvedValue({ data: { user: { id: "u" } }, error: null }); });
test("signed-out synchronization clears cookie chunks without revoking any session", async () => {
  expect((await call({ event: "SIGNED_OUT" })).status).toBe(200);
  expect(set.mock.calls.map(c => c[0])).toEqual(["sb-project-auth-token.0", "sb-project-auth-token.1"]);
  expect(signOut).not.toHaveBeenCalled();
});
test("cross-origin requests cannot clear cookies", async () => {
  expect((await call({ event: "SIGNED_OUT" }, "https://evil.test")).status).toBe(403);
  expect(set).not.toHaveBeenCalled(); expect(signOut).not.toHaveBeenCalled();
});
test("a session rejected by Auth cannot report synchronized success", async () => {
  getUser.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
  expect((await call({ access_token: "test", refresh_token: "refresh" })).status).toBe(401);
});
