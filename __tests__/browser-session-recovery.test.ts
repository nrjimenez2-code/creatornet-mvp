import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { syncBrowserSession, signOutThisDevice, prepareSessionNavigation, authNextPath } from "@/lib/browserSession";
const session = { access_token: "test", refresh_token: "refresh", user: { id: "u" } } as Session;
const request = jest.fn();
const auth = { getUser: jest.fn(), getSession: jest.fn(), signOut: jest.fn() };
const client = { auth } as unknown as SupabaseClient;
beforeEach(() => {
  jest.clearAllMocks(); global.fetch = request;
  request.mockResolvedValue({ ok: true, json: async () => ({ ok: true, userId: "u" }) });
  auth.getUser.mockResolvedValue({ data: { user: session.user }, error: null });
  auth.getSession.mockResolvedValue({ data: { session }, error: null });
  auth.signOut.mockResolvedValue({ error: null });
});
test("ordinary sign-out is device-local and waits for cookie clearing", async () => {
  await signOutThisDevice(client);
  expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ event: "SIGNED_OUT", access_token: null, refresh_token: null });
});
test("valid browser session must establish cookies before navigation is allowed", async () => {
  expect(await prepareSessionNavigation(client)).toBe(true);
  expect(auth.getUser).toHaveBeenCalledTimes(1);
  expect(JSON.parse(request.mock.calls[0][1].body).access_token).toBe("test");
});
test("revoked session is cleared locally and does not permit navigation", async () => {
  auth.getUser.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
  expect(await prepareSessionNavigation(client)).toBe(false);
  expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
});
test("network failure does not sign out or redirect a valid stored user", async () => {
  auth.getUser.mockResolvedValue({ data: { user: null }, error: { status: 503 } });
  await expect(prepareSessionNavigation(client)).rejects.toThrow("Could not verify");
  expect(auth.signOut).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});
test("failed cookie synchronization blocks protected navigation", async () => {
  request.mockResolvedValue({ ok: false });
  await expect(prepareSessionNavigation(client)).rejects.toThrow("synchronize");
});
test("cookies rejected by the browser cannot cause another Profile redirect", async () => {
  request.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) }).mockResolvedValueOnce({ ok: false });
  await expect(prepareSessionNavigation(client)).rejects.toThrow("on this browser");
});
test("sign-out cookie clearing cannot be overtaken by an older sign-in", async () => {
  let finish!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = syncBrowserSession(session);
  const second = syncBrowserSession(null, "SIGNED_OUT");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(request).toHaveBeenCalledTimes(1);
  finish({ ok: true, json: async () => ({ ok: true }) });
  await Promise.all([first, second]);
  expect(JSON.parse(request.mock.calls[1][1].body).event).toBe("SIGNED_OUT");
});
test("only known local Profile destinations are accepted", () => {
  expect(authNextPath("?next=/profile")).toBe("/profile");
  expect(authNextPath("?next=/profile/edit")).toBe("/profile/edit");
  for (const target of ["//evil.test", "https://evil.test", "/\\evil.test", "/unknown"]) expect(authNextPath("?next="+encodeURIComponent(target))).toBeNull();
});
