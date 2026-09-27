// Temporary opt-in diagnostics. Never accepts sessions, tokens, URLs or provider text.
type AuthTrace = {
  operation: string;
  phase: "start" | "end" | "event";
  operationId?: string;
  event?: string;
  hasSession?: boolean;
  status?: number;
  errorName?: string;
};
let sequence = 0;
let tabId: string | undefined;
const stagingUrl = "https://nwqfofezfzljhxolkycz.supabase.co";
function stagingDelay(parameter: string): number {
  if (typeof window === "undefined" || process.env.NEXT_PUBLIC_SUPABASE_URL !== stagingUrl || !enabled()) return 0;
  const value = Number(new URLSearchParams(window.location.search).get(parameter));
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 0), 5000) : 0;
}
function enabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    // Explicit staging QA opt-in; persists only in this tab's session storage.
    if (new URLSearchParams(window.location.search).get("authTrace") === "1") window.sessionStorage.setItem("cn.auth.trace", "1");
    return process.env.NEXT_PUBLIC_AUTH_DIAGNOSTICS === "1" || window.sessionStorage.getItem("cn.auth.trace") === "1";
  }
  catch { return false; }
}
export function traceAuth(trace: AuthTrace): void {
  if (!enabled()) return;
  try {
    tabId ??= window.sessionStorage.getItem("cn.auth.trace.tab") ?? crypto.randomUUID();
    window.sessionStorage.setItem("cn.auth.trace.tab", tabId);
    // Explicit projection: no arbitrary object or raw error can reach the console.
    console.info("[auth-trace]", JSON.stringify({ at: Date.now(), tabId, operationId: trace.operationId,
      operation: trace.operation, phase: trace.phase, event: trace.event,
      hasSession: trace.hasSession, status: trace.status, errorName: trace.errorName }));
  } catch { /* diagnostics must not affect authentication */ }
}
type TraceResult = { hasSession?: boolean; status?: number; errorName?: string };
export function startAuthTrace(operation: string) {
  const operationId = `${operation}:${++sequence}`;
  traceAuth({ operation, operationId, phase: "start" });
  const headers: Record<string, string> = enabled() && tabId ? { "X-CN-Auth-Operation": operationId, "X-CN-Auth-Tab": tabId } : {};
  const callbackDelay = operation.startsWith("cookie-sync-") ? stagingDelay("authCallbackDelayMs") : 0;
  if (callbackDelay) headers["X-CN-Auth-Delay"] = String(callbackDelay);
  return Object.assign((result?: TraceResult) => traceAuth({ operation, operationId, phase: "end", ...result }), { headers });
}
export const authDiagnosticFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, "https://diagnostics.invalid").pathname;
  const operation = path.endsWith("/token") ? "refresh" : path.endsWith("/user") ? "verify-user" : "auth-request";
  if (!path.startsWith("/auth/v1/")) return fetch(input, init);
  const finish = startAuthTrace(operation);
  try {
    const response = await fetch(input, init);
    const delay = stagingDelay(operation === "refresh" ? "authRefreshDelayMs" : "authVerifyDelayMs");
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    finish({ status: response.status }); return response;
  }
  catch (error) { finish({ errorName: "NetworkError" }); throw error; }
};

/** Staging-only, one-shot expiry metadata injection for a fresh QA session. */
export const authDiagnosticStorage = {
  getItem(name: string): string | null {
    const raw = window.localStorage.getItem(name);
    const marker = new URLSearchParams(window.location.search).get("authExpireOnce");
    if (raw && marker && enabled() && process.env.NEXT_PUBLIC_SUPABASE_URL === stagingUrl &&
      name === "sb-nwqfofezfzljhxolkycz-auth-token" && window.sessionStorage.getItem("cn.auth.expiry-fixture") !== marker) {
      try {
        const value = JSON.parse(raw);
        if (value.access_token && value.refresh_token) {
          window.sessionStorage.setItem("cn.auth.expiry-fixture", marker);
          const expired = JSON.stringify({ ...value, expires_at: Math.floor(Date.now() / 1000) - 1 });
          window.localStorage.setItem(name, expired);
          traceAuth({ operation: "fixture-expiry-metadata", phase: "event", hasSession: true });
          return expired;
        }
      } catch { /* retain untouched storage when fixture injection is unavailable */ }
    }
    return raw;
  },
  setItem(name: string, value: string) { window.localStorage.setItem(name, value); },
  removeItem(name: string) { window.localStorage.removeItem(name); },
};
