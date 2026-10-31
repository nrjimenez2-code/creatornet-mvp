import { createClient } from "@supabase/supabase-js";
import { createMfaSessionGuard } from "@/lib/mfaSessionGuard";
const key = "mfa-race-fixture";
const expiry = Math.floor(Date.now() / 1000) + 3600;
const token = (id: string, aal = "aal1") => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: id, aal, exp: expiry })).toString("base64url")}.fixture`;
const user = (id: string) => ({ id, aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
const session = (id: string, aal = "aal1") => ({ user: user(id), access_token: token(id, aal), refresh_token: `refresh-${id}-${aal}`, expires_in: 3600, token_type: "bearer" });
async function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => { values.set(name, value); }, removeItem: (name: string) => { values.delete(name); } };
  let finish!: (response: Response) => void, arrived!: () => void;
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  const response = new Promise<Response>(resolve => { finish = resolve; });
  const transport = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/user")) {
      const jwt = new Headers(init?.headers).get("authorization")!.slice(7);
      return Response.json(user(JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).sub));
    }
    if (path.endsWith("/challenge")) return Response.json({ id: "challenge" });
    if (path.endsWith("/verify")) { arrived(); return response; }
    if (path.endsWith("/logout")) return new Response(null, { status: 204 });
    throw Error("Unexpected fixture request");
  });
  const guard = createMfaSessionGuard(key, storage, "https://fixture.supabase.co/auth/v1", transport);
  const client = createClient("https://fixture.supabase.co", "fixture-public", { auth: { storage: guard.storage, storageKey: key, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: guard.fetch } });
  await client.auth.setSession(session("owner"));
  const events: string[] = []; client.auth.onAuthStateChange(event => { events.push(event); });
  const start = () => guard.run(token("owner"), () => client.auth.mfa.challengeAndVerify({ factorId: "factor", code: "123456" }));
  return { client, guard, transport, arrival, finish, start, events, values };
}
test.each(["signout", "replacement", "other-tab-storage"])("real SDK delayed MFA cannot overwrite %s", async change => {
  const f = await fixture();
  const verification = f.start();
  await f.arrival;
  if (change === "signout") await f.client.auth.signOut({ scope: "local" });
  else if (change === "replacement") await f.client.auth.setSession(session("replacement"));
  else f.values.set(key, JSON.stringify({ ...session("other-tab"), expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  f.finish(Response.json(session("owner", "aal2")));
  expect((await verification).error?.code).toBe("mfa_session_changed");
  expect((await f.client.auth.getSession()).data.session?.user.id ?? null).toBe(change === "signout" ? null : change === "replacement" ? "replacement" : "other-tab");
  expect(f.events).not.toContain("MFA_CHALLENGE_VERIFIED");
});
test("unchanged real SDK MFA succeeds and preserves its normal event", async () => {
  const f = await fixture(); const verification = f.start(); await f.arrival;
  f.finish(Response.json(session("owner", "aal2")));
  expect((await verification).error).toBeNull();
  expect((await f.client.auth.getSession()).data.session?.access_token).toBe(token("owner", "aal2"));
  expect(f.events).toContain("MFA_CHALLENGE_VERIFIED");
});
test("the storage adapter rejects a change after the response check but before SDK commit", async () => {
  const f = await fixture();
  const attempted = f.guard.run(token("owner"), async () => {
    const response = f.guard.fetch("https://fixture.supabase.co/auth/v1/factors/factor/verify", { headers: { authorization: `Bearer ${token("owner")}` } });
    await f.arrival; f.finish(Response.json(session("owner", "aal2"))); await response;
    f.values.delete(key);
    f.guard.storage.setItem(key, JSON.stringify(session("owner", "aal2")));
  });
  await expect(attempted).rejects.toMatchObject({ code: "mfa_session_changed" });
  expect(f.values.has(key)).toBe(false);
});
test("a changed account cannot send a factor mutation using the original action", async () => {
  const f = await fixture();
  const result = await f.guard.run(token("owner"), async () => {
    f.values.set(key, JSON.stringify(session("replacement")));
    return f.guard.fetch("https://fixture.supabase.co/auth/v1/factors", { headers: { authorization: `Bearer ${token("replacement")}` } });
  });
  expect(result.status).toBe(409);
  expect(await result.json()).toMatchObject({ error_code: "mfa_session_changed" });
  expect(f.transport.mock.calls.some(([input]) => String(input).endsWith("/factors"))).toBe(false);
});
