import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const context = new AsyncLocalStorage<{ operationId: string; tabId?: string; diagnostic: boolean }>();
const enabled = () => process.env.AUTH_DIAGNOSTICS === "1" || context.getStore()?.diagnostic === true;
function safeId(value: string | null | undefined): string | undefined {
  return value && /^[a-zA-Z0-9:_-]{1,100}$/.test(value) ? value : undefined;
}
function trace(operation: string, phase: string, status?: number) {
  if (enabled()) {
    const current = context.getStore();
    console.info("[auth-trace-server]", { at: Date.now(), operationId: current?.operationId, tabId: current?.tabId, operation, phase, status });
  }
}
export async function traceAuthCallback<T extends Response>(req: Request | undefined, operation: string, run: () => Promise<T>): Promise<T> {
  const suppliedId = safeId(req?.headers.get("X-CN-Auth-Operation"));
  const diagnostic = process.env.AUTH_DIAGNOSTICS === "1" || (process.env.VERCEL_ENV === "preview" && !!suppliedId);
  if (!diagnostic) return run();
  const operationId = suppliedId ?? randomUUID();
  const tabId = safeId(req?.headers.get("X-CN-Auth-Tab"));
  const rawDelay = Number(req?.headers.get("X-CN-Auth-Delay"));
  const delay = process.env.VERCEL_ENV === "preview" &&
    process.env.NEXT_PUBLIC_SUPABASE_URL === "https://nwqfofezfzljhxolkycz.supabase.co" && Number.isFinite(rawDelay)
    ? Math.min(Math.max(Math.floor(rawDelay), 0), 5000) : 0;
  return context.run({ operationId, tabId, diagnostic }, async () => {
    trace(operation, "start");
    try {
      const response = await run();
      if (delay && operation === "callback-sync") await new Promise(resolve => setTimeout(resolve, delay));
      trace(operation, "end", response.status); return response;
    }
    catch (error) { trace(operation, "failed"); throw error; }
  });
}
export const serverAuthDiagnosticFetch: typeof fetch = async (input, init) => {
  if (!enabled()) return fetch(input, init);
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
  const operation = path.endsWith("/token") ? "server-refresh" : path.endsWith("/user") ? "server-verify" : "server-auth";
  trace(operation, "start");
  try { const response = await fetch(input, init); trace(operation, "end", response.status); return response; }
  catch (error) { trace(operation, "failed"); throw error; }
};
export function traceAuthCookieWrite(clearing: boolean) { trace(clearing ? "cookie-clear" : "cookie-set", "event"); }
