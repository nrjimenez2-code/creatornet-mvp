import { AuthError } from "@supabase/supabase-js";

type StorageAdapter = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const changed = () => new AuthError("Your sign-in changed during authenticator setup. Reload Account security.", 409, "mfa_session_changed");
const changedResponse = () => Response.json({ msg: changed().message, error_code: "mfa_session_changed" }, { status: 409 });
const readToken = (raw: string | null): string | null => {
  try { return raw ? JSON.parse(raw).access_token ?? null : null; }
  catch { return null; }
};

/** Public SDK transport/storage adapters. Only explicit MFA actions register a
 * commit guard; normal login, refresh, sign-out and cookie protocols delegate
 * unchanged. Never store token snapshots anywhere except this closure. */
export function createMfaSessionGuard(key: string, backing: StorageAdapter, authUrl: string, transport: typeof fetch) {
  const authOrigin = new URL(authUrl).origin;
  const factorPath = `${new URL(authUrl).pathname.replace(/\/+$/, "")}/factors`;
  let operation: { token: string; baseline: string } | null = null;
  const pendingCommits = new Map<string, string>();
  const currentTokenMatches = (token: string) => readToken(backing.getItem(key)) === token;
  const storage: StorageAdapter = {
    getItem: name => backing.getItem(name),
    removeItem: name => backing.removeItem(name),
    setItem(name, value) {
      if (name === key) {
        const token = readToken(value);
        const expected = token ? pendingCommits.get(token) : undefined;
        // Synchronous browser-storage comparison and write: no async yield
        // can let a same-tab sign-out/replacement land inside this commit.
        if (expected !== undefined && backing.getItem(key) !== expected) throw changed();
      }
      backing.setItem(name, value);
    },
  };
  const guardedFetch: typeof fetch = async (input, init) => {
    const target = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const targetUrl = new URL(target);
    const factorRequest = targetUrl.origin === authOrigin && (targetUrl.pathname === factorPath || targetUrl.pathname.startsWith(`${factorPath}/`));
    const scope = factorRequest ? operation : null;
    if (scope) {
      const headers = new Headers(init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));
      if (headers.get("authorization") !== `Bearer ${scope.token}` || backing.getItem(key) !== scope.baseline) return changedResponse();
    }
    const response = await transport(input, init);
    if (scope && backing.getItem(key) !== scope.baseline) return changedResponse();
    if (scope && response.ok && targetUrl.pathname.endsWith("/verify")) {
      const result = await response.clone().json();
      if (backing.getItem(key) !== scope.baseline) return changedResponse();
      if (typeof result.access_token === "string") pendingCommits.set(result.access_token, scope.baseline);
    }
    return response;
  };
  async function run<T>(token: string, action: () => Promise<T>): Promise<T> {
    const baseline = backing.getItem(key);
    if (operation || !baseline || !currentTokenMatches(token)) throw changed();
    operation = { token, baseline };
    try { return await action(); }
    finally { operation = null; pendingCommits.clear(); }
  }
  return { storage, fetch: guardedFetch, run, currentTokenMatches };
}
