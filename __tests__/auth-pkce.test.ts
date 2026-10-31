import { createClient, type Session, type User } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Real installed SDK, synthetic storage and transport. No credentials/network.
const storageKey = "auth-pkce-fixture";
const user: User = { id: "fixture-user", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`;
const session: Session = { access_token: token, refresh_token: "fixture-refresh", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalBroadcast = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
beforeEach(() => {
  const warn = console.warn.bind(console);
  jest.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    // Each fixture represents a new page load, with independent storage.
    if (String(args[0]).includes("Multiple GoTrueClient instances")) return;
    warn(...args);
  });
});

function browser(url: string) {
  const location = new URL(url);
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location, history: { state: null, replaceState: (_state: unknown, _unused: string, next: string) => { location.href = next; } },
    addEventListener: () => {}, removeEventListener: () => {},
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} } });
  Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });
}
afterEach(() => {
  jest.restoreAllMocks();
  for (const [name, descriptor] of [["window", originalWindow], ["document", originalDocument], ["BroadcastChannel", originalBroadcast]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function fixture(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const transport = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/user")) return Response.json(user);
    if (path.endsWith("/token") && init?.body) return Response.json(session);
    throw Error("Unexpected fixture request");
  });
  const client = createClient("https://fixture.supabase.co", "fixture-public", {
    auth: { storageKey, persistSession: true, autoRefreshToken: false, detectSessionInUrl: true, flowType: "pkce", storage: {
      getItem: name => values.get(name) ?? null,
      setItem: (name, value) => { values.set(name, value); },
      removeItem: name => { values.delete(name); },
    } },
    global: { fetch: transport },
  });
  return { client, transport, values };
}

test("application browser factory requires PKCE", () => {
  expect(readFileSync(join(__dirname, "../lib/supabaseClient.ts"), "utf8")).toMatch(/flowType:\s*"pkce"/);
});

test("unsolicited implicit fragment cannot establish a session or call Auth", async () => {
  browser(`https://www.creatornet.net/auth#access_token=${token}&refresh_token=attacker-refresh&expires_in=3600&token_type=bearer`);
  const f = fixture();
  expect((await f.client.auth.initialize()).error?.name).toBe("AuthPKCEGrantCodeExchangeError");
  expect((await f.client.auth.getSession()).data.session).toBeNull();
  expect(f.transport).not.toHaveBeenCalled();
});

test("rejected implicit fragment preserves an existing signed-in session", async () => {
  browser(`https://www.creatornet.net/auth#access_token=${token}&refresh_token=attacker-refresh&expires_in=3600&token_type=bearer`);
  const f = fixture({ [storageKey]: JSON.stringify(session) });
  await f.client.auth.initialize();
  expect((await f.client.auth.getSession()).data.session?.refresh_token).toBe("fixture-refresh");
  expect(f.transport).not.toHaveBeenCalled();
});

test("a callback code without this browser's verifier cannot establish a session", async () => {
  browser("https://www.creatornet.net/auth?code=other-browser-code");
  const f = fixture();
  await f.client.auth.initialize();
  expect((await f.client.auth.getSession()).data.session).toBeNull();
  expect(f.transport).not.toHaveBeenCalled();
});

test("OAuth authorization creates a challenge and callback consumes its browser verifier", async () => {
  browser("https://www.creatornet.net/auth");
  const f = fixture();
  await f.client.auth.initialize();
  const result = await f.client.auth.signInWithOAuth({ provider: "google", options: { skipBrowserRedirect: true, redirectTo: "https://www.creatornet.net/auth" } });
  expect(result.error).toBeNull();
  expect(new URL(result.data.url!).searchParams.get("code_challenge")).toBeTruthy();
  expect(new URL(result.data.url!).searchParams.get("code_challenge_method")).toBe("s256");
  const verifierKeys = [...f.values.keys()].filter(key => /-flow-[a-f0-9]+-code-verifier$/.test(key));
  expect(verifierKeys).toHaveLength(1);
  const verifier = JSON.parse(f.values.get(verifierKeys[0])!);
  // Recreate a page load with the persisted verifier and provider callback code.
  const callback = new URL(result.data.url!).searchParams.get("redirect_to")!;
  const url = new URL(callback);
  url.searchParams.set("code", "fixture-auth-code");
  browser(url.toString());
  const second = fixture(Object.fromEntries(f.values));
  expect((await second.client.auth.initialize()).error).toBeNull();
  expect((await second.client.auth.getSession()).data.session?.user.id).toBe(user.id);
  const exchange = second.transport.mock.calls.find(([input]) => String(input).includes("/token"));
  expect(JSON.parse(String(exchange?.[1]?.body))).toMatchObject({ auth_code: "fixture-auth-code", code_verifier: verifier });
  // Default SDK callbacks use and consume its compatible fixed verifier slot.
  expect(second.values.has(`${storageKey}-code-verifier`)).toBe(false);
});

test("email-code explicit setSession remains supported with PKCE enabled", async () => {
  browser("https://www.creatornet.net/auth");
  const f = fixture();
  const result = await f.client.auth.setSession({ access_token: token, refresh_token: "email-code-refresh" });
  expect(result.error).toBeNull();
  expect((await f.client.auth.getSession()).data.session?.refresh_token).toBe("email-code-refresh");
  expect(f.transport).toHaveBeenCalledTimes(1);
  expect(f.transport.mock.calls.every(([input]) => new URL(String(input)).pathname.endsWith("/user"))).toBe(true);
});
