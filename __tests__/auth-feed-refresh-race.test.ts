import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

const cookieKey = "sb-feed-fixture-auth-token";
type Write = { name: string; value: string; clear: boolean };
type Store = { get: (name: string) => { value: string } | undefined; getAll: () => { name: string; value: string }[]; set: (name: string, value: string, options?: { maxAge?: number }) => void };
const mockRequestStore = new AsyncLocalStorage<Store>();
jest.mock("next/headers", () => ({ cookies: async () => mockRequestStore.getStore() }));
let mockDiscoverEnabled = false;
jest.mock("@/lib/discoverServer", () => ({
  ...jest.requireActual("@/lib/discoverServer"),
  discoverEnabled: () => mockDiscoverEnabled,
  createDiscoverSession: async () => "fixture-feed-session",
  readDiscoverPage: async () => ({items:[],hasMore:false,nextOffset:0}),
}));
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));
import { GET } from "@/app/api/feed/route";
import { POST } from "@/app/auth/callback/route";
import { createServerClient } from "@/lib/supabaseServer";

const originalFetch = global.fetch;
const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
afterEach(() => {
  global.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
});
const session = (expired: boolean) => {
  const exp = Math.floor(Date.now() / 1000) + (expired ? -60 : 3600);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return { access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: "fixture-user", exp, role: "authenticated" })}.synthetic`, refresh_token: "synthetic-refresh", expires_at: exp, expires_in: expired ? -60 : 3600, token_type: "bearer", user: { id: "fixture-user", app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: "2026-01-01T00:00:00Z" } };
};
function store(snapshot: Map<string,string>, writes: Write[]): Store {
  return {
    get: name => snapshot.has(name) ? { value: snapshot.get(name)! } : undefined,
    getAll: () => Array.from(snapshot, ([name,value]) => ({name,value})),
    set: (name,value,options) => {
      const clear = options?.maxAge === 0;
      writes.push({name,value,clear});
      if (clear) snapshot.delete(name); else snapshot.set(name,value);
    },
  };
}

test.each([false,true])("expired feed refresh preserves newer sign-out (Discover=%s)", async discover => {
  mockDiscoverEnabled = discover;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://feed-fixture.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic-public-key";
  const browserCookies = new Map([[cookieKey, "base64-" + Buffer.from(JSON.stringify(session(true))).toString("base64url")]]);
  const timeline: object[] = [];
  const record = (operation: string, extra = {}) => timeline.push({at:Date.now(),operation,...extra});
  let arrive!: () => void, release!: (response: Response) => void;
  const arrived = new Promise<void>(resolve => { arrive=resolve; });
  const delayed = new Promise<Response>(resolve => { release=resolve; });
  let refreshes = 0;
  global.fetch = jest.fn(async input => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "feed-fixture.supabase.co") throw Error("Fixture transport rejects every hosted destination");
    if (url.pathname.endsWith("/token")) { refreshes++; record("feed-refresh-start"); arrive(); return delayed; }
    if (url.pathname.endsWith("/user")) return Response.json(session(false).user);
    if (url.pathname === "/rest/v1/rpc/get_feed_v3") { record("feed-rpc"); return Response.json([]); }
    throw Error("Unexpected fixture request");
  });
  const feedWrites: Write[] = [];
  record("feed-request-start");
  const loading = mockRequestStore.run(store(new Map(browserCookies),feedWrites), () => GET(new NextRequest("https://creatornet.test/api/feed?limit=1")));
  await arrived;
  const signoutWrites: Write[] = [];
  const signout = await mockRequestStore.run(store(new Map(browserCookies),signoutWrites), () => POST(new Request("https://creatornet.test/auth/callback", { method:"POST",headers:{Origin:"https://creatornet.test",Host:"creatornet.test","Content-Type":"application/json"},body:JSON.stringify({event:"SIGNED_OUT"}) })));
  expect(signout.status).toBe(200);
  const apply = (writes: Write[]) => { for (const write of writes) { if(write.clear) browserCookies.delete(write.name); else browserCookies.set(write.name,write.value); } };
  apply(signoutWrites);
  expect(browserCookies.has(cookieKey)).toBe(false);
  record("signout-response-applied",{hasSession:false});
  release(Response.json(session(false)));
  record("feed-refresh-response",{status:200});
  const feed = await loading;
  expect(feed.status).toBe(200);
  apply(feedWrites);
  record("feed-response-applied",{hasSession:browserCookies.has(cookieKey)});
  expect(refreshes).toBe(1);
  expect(feedWrites).toEqual([]);
  expect(browserCookies.has(cookieKey)).toBe(false);
  const directory = process.env.AUTH_RACE_EVIDENCE_DIR;
  if (directory) {
    mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,discover ? "auth-regression-discover-refresh.json" : "auth-regression-feed-refresh.json"),JSON.stringify({sdk:"2.112.3",ssr:"0.7.0",controlledLocalTransport:true,discover,timeline,refreshRequests:refreshes,outcome:"signout-preserved",serverAuthenticationAcceptance:"not evaluated"},null,2)+"\n");
  }
});

test("normal server clients still synchronize refreshed cookies", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://feed-fixture.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "synthetic-public-key";
  const writes: Write[] = [];
  let refreshes = 0;
  global.fetch = jest.fn(async input => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "feed-fixture.supabase.co") throw Error("Fixture transport rejects every hosted destination");
    if (url.pathname.endsWith("/token")) { refreshes++; return Response.json(session(false)); }
    if (url.pathname === "/rest/v1/rpc/get_feed_v3") return Response.json([]);
    throw Error("Unexpected fixture request");
  });
  const result = await mockRequestStore.run(store(new Map([[cookieKey,"base64-" + Buffer.from(JSON.stringify(session(true))).toString("base64url")]]),writes), async () => await createServerClient().rpc("get_feed_v3"));
  expect(result.error).toBeNull();
  expect(refreshes).toBe(1);
  expect(writes.some(write => write.name === cookieKey && !write.clear)).toBe(true);
});
