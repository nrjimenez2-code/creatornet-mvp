import { createClient, type Session, type User } from "@supabase/supabase-js";
import { prepareSessionNavigation } from "@/lib/browserSession";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
function evidence(name: string, value: unknown) {
  if (process.env.AUTH_RACE_EVIDENCE_DIR) writeFileSync(join(process.env.AUTH_RACE_EVIDENCE_DIR, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
}

// Real locked SDK and application helper, synthetic Auth transport and storage.
// No provider credentials or external requests. Release is still gated on real tabs.
const key = "auth-race-fixture";
const user = (id: string): User => ({ id, aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
const token = (id: string) => `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`;
const session = (id: string, revision: string): Session => ({ access_token: token(id), refresh_token: revision, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: user(id) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
type Trace = { operation: string; tab: string; at?: number; event?: string; hasSession?: boolean; errorName?: string; status?: number };
async function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => { values.set(name, value); }, removeItem: (name: string) => { values.delete(name); } };
  const traces: Trace[] = [];
  const pending: Array<ReturnType<typeof deferred<Response>>> = [];
  const arrivals: Array<ReturnType<typeof deferred<void>>> = [deferred(), deferred()];
  const clients = ["tab-a", "tab-b"].map(tab => createClient("https://fixture.supabase.co", "fixture-public", {
    auth: { storage, storageKey: key, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/token")) {
        traces.push({ operation: "refresh-start", tab, at: Date.now() });
        const delayed = deferred<Response>(); pending.push(delayed); arrivals[pending.length - 1]?.resolve();
        const response = await delayed.promise;
        traces.push({ operation: "refresh-response", tab, status: response.status, at: Date.now() });
        return response;
      }
      if (path.endsWith("/logout")) return new Response(null, { status: 204 });
      if (path.endsWith("/user")) {
        traces.push({ operation: "verify-user", tab });
        const jwt = String(new Headers(init?.headers).get("Authorization")).replace(/^Bearer /, "");
        const id = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).sub;
        return Response.json(user(id));
      }
      throw Error("Unexpected fixture request");
    } },
  }));
  await Promise.all(clients.map(client => client.auth.getSession()));
  await Promise.all(clients.map((client, index) => new Promise<void>(resolve => {
    client.auth.onAuthStateChange((event, value) => {
      traces.push({ operation: "auth-event", tab: `tab-${index === 0 ? "a" : "b"}`, event, hasSession: !!value });
      if (event === "INITIAL_SESSION") resolve();
    });
  })));
  const original = session("original", "original-refresh");
  await clients[0].auth.setSession(original);
  return { clients, storage, traces, pending, arrivals, values };
}

test("two tabs: the real SDK discards the later refresh and preserves the winner", async () => {
  const f = await fixture();
  const first = f.clients[0].auth.refreshSession();
  await f.arrivals[0].promise;
  const second = f.clients[1].auth.refreshSession();
  await f.arrivals[1].promise;
  f.pending[0].resolve(Response.json(session("original", "winner-refresh")));
  expect((await first).error).toBeNull();
  f.pending[1].resolve(Response.json(session("original", "stale-refresh")));
  const discarded = await second;
  expect(discarded.error).toMatchObject({ name: "AuthRefreshDiscardedError", status: 409, message: "Refresh result discarded: session state changed mid-flight (e.g., concurrent signOut)" });
  expect((await f.clients[0].auth.getSession()).data.session?.refresh_token).toBe("winner-refresh");
  expect(f.pending).toHaveLength(2);
  evidence("auth-baseline-two-tabs", { sdk: "2.112.3", error: { name: discarded.error?.name, status: discarded.error?.status, message: discarded.error?.message }, timeline: f.traces, storageOutcome: "winner-preserved", refreshRequests: f.pending.length });
});

test("sign-out wins over a pending real SDK refresh", async () => {
  const f = await fixture();
  const refreshing = f.clients[0].auth.refreshSession();
  await f.arrivals[0].promise;
  await f.clients[1].auth.signOut({ scope: "local" });
  f.pending[0].resolve(Response.json(session("original", "stale-refresh")));
  expect((await refreshing).error?.name).toBe("AuthRefreshDiscardedError");
  expect((await f.clients[0].auth.getSession()).data.session).toBeNull();
  expect(f.pending).toHaveLength(1);
  evidence("auth-baseline-signout-refresh", { sdk: "2.112.3", timeline: f.traces, storageOutcome: "signed-out", refreshRequests: f.pending.length });
});

test("navigation verifies the replacement after login replaces its pending refresh", async () => {
  const f = await fixture();
  f.values.set(key, JSON.stringify({ ...session("original", "original-refresh"), expires_at: Math.floor(Date.now() / 1000) - 1 }));
  const originalFetch = global.fetch;
  global.fetch = jest.fn(async (_input, init) => Response.json(init?.method === "POST" ? { ok: true } : { ok: true, userId: "replacement" }));
  const navigating = prepareSessionNavigation(f.clients[0]);
  // Attach rejection handler immediately while the response is delayed.
  const result = navigating.catch(error => error);
  await f.arrivals[0].promise;
  await f.clients[1].auth.setSession(session("replacement", "replacement-refresh"));
  f.pending[0].resolve(Response.json(session("original", "stale-refresh")));
  expect(await result).toBe(true);
  expect((await f.clients[0].auth.getSession()).data.session?.user.id).toBe("replacement");
  expect(f.pending).toHaveLength(1);
  expect(f.traces.filter(trace => trace.operation === "verify-user" && trace.tab === "tab-a")).toHaveLength(2);
  global.fetch = originalFetch;
});
