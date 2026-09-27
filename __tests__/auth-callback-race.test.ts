import type { Session, SupabaseClient } from "@supabase/supabase-js";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fixture-public";
const cookieKey = "sb-fixture-auth-token";
type Store = { get: () => undefined; getAll: () => Array<{ name: string }>; set: (name: string, value: string, options?: { maxAge?: number }) => void };
const mockStores: Store[] = [];
let mockDelay: Promise<void>;
let mockArrival: () => void;
jest.mock("next/headers", () => ({ cookies: async () => mockStores.shift() }));
jest.mock("@supabase/ssr", () => ({ createServerClient: (_url: string, _key: string, options: { cookies: Store }) => ({ auth: {
  setSession: async () => { mockArrival(); await mockDelay; options.cookies.set(cookieKey, "fixture-session", {}); return { error: null }; },
  getUser: async () => ({ data: { user: { id: "fixture" } }, error: null }),
} }) }));
import { POST } from "@/app/auth/callback/route";
import { syncBrowserSession } from "@/lib/browserSession";

const session = { access_token: "fixture-access", refresh_token: "fixture-refresh", user: { id: "fixture" } } as Session;
const originalFetch = global.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
afterEach(() => {
  global.fetch = originalFetch;
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});

test.each([false, true])("sign-out wins over an in-flight callback with shared locks = %s", async useLocks => {
  let finish!: () => void;
  mockDelay = new Promise<void>(resolve => { finish = resolve; });
  const arrived = new Promise<void>(resolve => { mockArrival = resolve; });
  let current: Session | null = session;
  const client = { auth: { getSession: async () => ({ data: { session: current }, error: null }) } } as unknown as SupabaseClient;
  const browserCookies = new Map([[cookieKey, "original-session"]]);
  const responses: Array<{ signedOut: boolean }> = [];
  global.fetch = jest.fn(async (_input, init) => {
    const writes: Array<{ name: string; value: string; clear: boolean }> = [];
    mockStores.push({ get: () => undefined, getAll: () => [{ name: cookieKey }], set: (name, value, options) => { writes.push({ name, value, clear: options?.maxAge === 0 }); } });
    const response = await POST(new Request("https://creatornet.test/auth/callback", { ...init, method: "POST", headers: { origin: "https://creatornet.test", host: "creatornet.test", "Content-Type": "application/json" } }));
    for (const write of writes) {
      if (write.clear) browserCookies.delete(write.name);
      else browserCookies.set(write.name, write.value);
    }
    responses.push({ signedOut: !browserCookies.has(cookieKey) });
    return response;
  });
  const lockCalls: string[] = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: useLocks ? { locks: { request: async (name: string, work: () => Promise<void>) => { lockCalls.push(name); await work(); } } } : {} });
  const oldWrite = syncBrowserSession(session, "SIGNED_IN", client);
  await arrived;
  current = null;
  const clearing = syncBrowserSession(null, "SIGNED_OUT", client);
  finish();
  await Promise.all([oldWrite, clearing]);
  expect(browserCookies.has(cookieKey)).toBe(false);
  expect(responses.at(-1)?.signedOut).toBe(true);
  expect(responses[1]?.signedOut).toBe(true);
  if (useLocks) expect(lockCalls).toEqual(["creatornet-session-cookie-sync", "creatornet-session-cookie-sync"]);
});

test.each([false, true])("independent tab queues omit superseded writes with shared locks = %s", async useLocks => {
  let firstSync!: typeof syncBrowserSession, secondSync!: typeof syncBrowserSession;
  jest.isolateModules(() => { firstSync = jest.requireActual("@/lib/browserSession").syncBrowserSession; });
  jest.isolateModules(() => { secondSync = jest.requireActual("@/lib/browserSession").syncBrowserSession; });
  let current: Session | null = session;
  const client = { auth: { getSession: async () => ({ data: { session: current }, error: null }) } } as unknown as SupabaseClient;
  let release!: () => void, arrived!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  const sent: string[] = [];
  global.fetch = jest.fn(async (_input, init) => {
    const event = JSON.parse(String(init?.body)).event;
    sent.push(event);
    if (event === "SIGNED_IN") { arrived(); await delayed; }
    return Response.json({ ok: true });
  });
  let tail = Promise.resolve();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: useLocks ? { locks: { request: (_name: string, work: () => Promise<void>) => {
    const result = tail.then(work); tail = result.catch(() => {}); return result;
  } } } : {} });
  const old = firstSync(session, "SIGNED_IN", client);
  await arrival;
  current = null;
  const out = secondSync(null, "SIGNED_OUT", client);
  const staleQueued = secondSync(session, "SIGNED_IN", client);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(sent).toEqual(useLocks ? ["SIGNED_IN"] : ["SIGNED_IN", "SIGNED_OUT"]);
  release();
  await Promise.all([old, out, staleQueued]);
  expect(sent).toEqual(["SIGNED_IN", "SIGNED_OUT", "SIGNED_OUT"]);
});
