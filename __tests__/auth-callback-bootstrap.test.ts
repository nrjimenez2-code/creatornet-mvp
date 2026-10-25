import type { CookieOptions } from "@supabase/ssr";
import type { Session, User } from "@supabase/supabase-js";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://callback-warning.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic-public";
const key = "sb-callback-warning-auth-token";
type Store = { get: (name: string) => { value: string } | undefined; getAll: () => Array<{ name: string; value: string }>; set: (name: string, value: string, options?: CookieOptions) => void };
let mockStore: Store;
jest.mock("next/headers", () => ({ cookies: async () => mockStore }));
import { POST } from "@/app/auth/callback/route";

const user = (id: string): User => ({ id, aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
function session(id: string, expired = false): Session {
  const expires_at = Math.floor(Date.now() / 1000) + (expired ? -60 : 3600);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return { access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: id, exp: expires_at })}.fixture`, refresh_token: `${id}-refresh`, token_type: "bearer", expires_at, expires_in: expired ? -60 : 3600, user: user(id) };
}
const encodeCookie = (value: Session) => "base64-" + Buffer.from(JSON.stringify(value)).toString("base64url");
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

async function handoff({ event, partial = false, invalid = false, expired = false, chunks = false, malformed = false, rejectRefresh = false, largeIncoming = false, oldExpired = true, rejectAfterSet = false }: { event?: string; partial?: boolean; invalid?: boolean; expired?: boolean; chunks?: boolean; malformed?: boolean; rejectRefresh?: boolean; largeIncoming?: boolean; oldExpired?: boolean; rejectAfterSet?: boolean } = {}) {
  const old = session("old", oldExpired);
  if (chunks) old.user.user_metadata = { fixturePadding: "x".repeat(1000) };
  const oldCookie = malformed ? "base64-malformed" : encodeCookie(old);
  const initial = chunks ? Array.from(oldCookie.matchAll(/.{1,90}/g), (match, index) => [`${key}.${index}`, match[0]] as [string, string]) : [[key, oldCookie] as [string, string]];
  const values = new Map([...initial, [key + "-code-verifier", "existing-verifier"], ["unrelated", "keep"]]);
  const before = new Map(values);
  const writes: Array<{ name: string; clear: boolean }> = [];
  mockStore = {
    get: name => values.has(name) ? { value: values.get(name)! } : undefined,
    getAll: () => Array.from(values, ([name, value]) => ({ name, value })),
    set: (name, value, options) => { const clear = options?.maxAge === 0; writes.push({ name, clear }); if (clear) values.delete(name); else values.set(name, value); },
  };
  let releaseOld: (() => void) | undefined;
  const refreshes: string[] = [], verifications: string[] = [];
  const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
  const warningLog = jest.spyOn(console, "warn").mockImplementation(() => {});
  global.fetch = jest.fn(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "callback-warning.supabase.co") throw Error("Fixture rejects all hosted destinations");
    if (url.pathname.endsWith("/token")) {
      const refresh = JSON.parse(String(init?.body)).refresh_token;
      refreshes.push(refresh);
      if (refresh === "old-refresh") return new Promise<Response>(resolve => { releaseOld = () => resolve(Response.json(session("old"))); });
      if (rejectRefresh) return Response.json({ code: "refresh_token_not_found", message: "Invalid refresh token" }, { status: 400 });
      return Response.json(session("fresh"));
    }
    if (url.pathname.endsWith("/user")) {
      const token = new Headers(init?.headers).get("Authorization")!.slice("Bearer ".length);
      const id = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
      verifications.push(id);
      return invalid || (rejectAfterSet && verifications.length > 1) ? Response.json({ code: "bad_jwt", message: "Invalid JWT" }, { status: 401 }) : Response.json({ ...user(id), user_metadata: largeIncoming ? { fixturePadding: "x".repeat(9000) } : {} });
    }
    throw Error("Unexpected fixture request");
  });
  const fresh = session("fresh", expired);
  const body = event ? { event } : { access_token: fresh.access_token, ...(partial ? {} : { refresh_token: fresh.refresh_token }) };
  const response = await POST(new Request("https://creatornet.test/auth/callback", { method: "POST", headers: { Origin: "https://creatornet.test", Host: "creatornet.test", "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  await turn();
  releaseOld?.();
  await turn(); await turn();
  return { response, values, before, writes, refreshes, verifications, errors: errorLog.mock.calls.map(call => (call[0] as Error)?.name), warnings: warningLog.mock.calls.map(call => (call[0] as Error)?.name) };
}

test("explicit fresh sign-in does not refresh an old cookie or emit discarded-refresh errors", async () => {
  const result = await handoff();
  expect(result.response.status).toBe(200);
  expect(result.verifications).toEqual(["fresh", "fresh"]);
  expect({ oldRefreshRequests: result.refreshes.length, errorNames: result.errors }).toEqual({ oldRefreshRequests: 0, errorNames: [] });
  expect(result.warnings).toEqual([]);
  const saved = JSON.parse(Buffer.from(result.values.get(key)!.slice("base64-".length), "base64url").toString());
  expect(saved.user.id).toBe("fresh");
});

test("sign-out clears existing cookies without starting old-session recovery", async () => {
  const result = await handoff({ event: "SIGNED_OUT" });
  expect(result.response.status).toBe(200);
  expect(result.values.has(key)).toBe(false);
  expect(result.refreshes).toEqual([]);
  expect(result.verifications).toEqual([]);
  expect(result.errors).toEqual([]);
});

test("incomplete handoff does not contact Auth or change existing cookies", async () => {
  const result = await handoff({ partial: true });
  expect(result.response.status).toBe(400);
  expect(result.refreshes).toEqual([]);
  expect(result.verifications).toEqual([]);
  expect(result.values).toEqual(result.before);
});

test("fresh handoff removes every old chunk while preserving other cookies and PKCE verifier", async () => {
  const result = await handoff({ chunks: true });
  expect(result.before.has(key + ".5")).toBe(true);
  expect(result.response.status).toBe(200);
  expect(Array.from(result.values.keys()).filter(name => name.startsWith(key + "."))).toEqual([]);
  expect(result.values.get(key + "-code-verifier")).toBe("existing-verifier");
  expect(result.values.get("unrelated")).toBe("keep");
  expect(result.refreshes).toEqual([]);
});

test("invalid supplied credentials remain rejected without removing the previous cookies", async () => {
  const result = await handoff({ invalid: true });
  expect(result.response.status).toBe(400);
  expect(result.values).toEqual(result.before);
  expect(result.refreshes).toEqual([]);
});

test("an expired supplied session refreshes only the supplied credentials", async () => {
  const result = await handoff({ expired: true });
  expect(result.response.status).toBe(200);
  expect(result.refreshes).toEqual(["fresh-refresh"]);
  expect(result.verifications).toEqual(["fresh"]);
});

test("a malformed old cookie cannot interfere with a verified incoming session", async () => {
  const result = await handoff({ malformed: true });
  expect(result.response.status).toBe(200);
  expect(result.verifications).toEqual(["fresh", "fresh"]);
  expect(result.refreshes).toEqual([]);
  expect(result.errors).toEqual([]);
});

test.each([false, true])("genuinely rejected supplied refresh cannot replace prior cookies (expired=%s)", async oldExpired => {
  const result = await handoff({ expired: true, rejectRefresh: true, oldExpired });
  expect(result.response.status).toBe(400);
  expect(result.refreshes).toEqual(["fresh-refresh"]);
  expect(result.values).toEqual(result.before);
});

test("failure of the final identity check cannot commit pending cookie writes", async () => {
  const result = await handoff({ rejectAfterSet: true, oldExpired: false });
  expect(result.response.status).toBe(401);
  expect(result.verifications).toEqual(["fresh", "fresh"]);
  expect(result.values).toEqual(result.before);
  expect(result.writes).toEqual([]);
});

test("a larger verified incoming session replaces the old base cookie with complete chunks", async () => {
  const result = await handoff({ largeIncoming: true });
  expect(result.response.status).toBe(200);
  expect(result.values.has(key)).toBe(false);
  const incoming = Array.from(result.values).filter(([name]) => /^\d+$/.test(name.slice(key.length + 1)) && name.startsWith(key + "."));
  expect(incoming.length).toBeGreaterThan(1);
  const saved = incoming.sort(([a], [b]) => Number(a.slice(key.length + 1)) - Number(b.slice(key.length + 1))).map(([, value]) => value).join("");
  expect(JSON.parse(Buffer.from(saved.slice("base64-".length), "base64url").toString()).user.id).toBe("fresh");
  expect(result.values.get(key + "-code-verifier")).toBe("existing-verifier");
  expect(result.refreshes).toEqual([]);
});
