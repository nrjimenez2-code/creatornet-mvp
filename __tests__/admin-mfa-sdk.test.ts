import { createClient, type User } from "@supabase/supabase-js";
import { syncBrowserSession } from "@/lib/browserSession";

test("locked SDK verification upgrades the session and emits a cookie-sync-compatible event", async () => {
  const user = { id: "fixture-owner", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z", factors: [] } as User;
  const token = (aal: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: user.id, aal, exp: Math.floor(Date.now() / 1000) + 3600, amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }] })).toString("base64url")}.fixture`;
  const session = (aal: string) => ({ user: { ...user, factors: aal === "aal2" ? [{ id: "factor", status: "verified", factor_type: "totp" }] : [] }, access_token: token(aal), refresh_token: "synthetic-refresh", expires_in: 3600, token_type: "bearer" });
  const requests: string[] = [];
  const client = createClient("https://fixture.supabase.co", "fixture-public", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async input => {
      const path = new URL(String(input)).pathname; requests.push(path);
      if (path.endsWith("/user")) return Response.json(user);
      if (path.endsWith("/challenge")) return Response.json({ id: "challenge", type: "totp", expires_at: Math.floor(Date.now() / 1000) + 300 });
      if (path.endsWith("/verify")) return Response.json(session("aal2"));
      throw Error("Unexpected fixture network request");
    } },
  });
  await client.auth.setSession(session("aal1"));
  const events: string[] = [];
  client.auth.onAuthStateChange(event => { events.push(event); });
  const result = await client.auth.mfa.challengeAndVerify({ factorId: "factor", code: "123456" });
  expect(result.error).toBeNull();
  expect(events).toContain("MFA_CHALLENGE_VERIFIED");
  expect((await client.auth.mfa.getAuthenticatorAssuranceLevel()).data?.currentLevel).toBe("aal2");
  expect(requests.filter(path => path.endsWith("/verify"))).toHaveLength(1);
  const originalFetch = global.fetch;
  const cookieWrite = jest.fn().mockResolvedValue(Response.json({ ok: true }));
  global.fetch = cookieWrite;
  try {
    const upgraded = (await client.auth.getSession()).data.session;
    await syncBrowserSession(upgraded, "MFA_CHALLENGE_VERIFIED", client);
    expect(JSON.parse(cookieWrite.mock.calls[0][1].body)).toMatchObject({ event: "MFA_CHALLENGE_VERIFIED", access_token: result.data?.access_token });
  } finally { global.fetch = originalFetch; }
});
