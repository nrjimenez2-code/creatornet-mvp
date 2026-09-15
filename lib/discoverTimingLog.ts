const MAX_LOGS_PER_ROUTE_MODULE = 64;
const MAX_WINDOW_MS = 2 * 60 * 60 * 1000;
const ALLOWED_METRICS = new Set([
  'identity', 'session', 'page', 'context', 'sample', 'media', 'write',
  'dbtotal', 'dbmax', 'dbcount', 'upstream', 'upstreamcount',
  'dbtransportcount', 'dbrequestcount', 'dbsendcount', 'dbresponsecount',
  'dbprepare', 'dbdispatch', 'dbresponse', 'dbresponsemax', 'dbresume',
  'loopbusy', 'loopidle', 'invocation', 'routeage', 'uptime', 'total',
]);

function productionLoggingEnabled(): boolean {
  if (process.env.VERCEL_ENV !== 'production') return false;
  const configured = process.env.DISCOVER_TIMING_LOG_UNTIL;
  if (!configured || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(configured)) return false;
  const remaining = Date.parse(configured) - Date.now();
  return Number.isFinite(remaining) && remaining > 0 && remaining <= MAX_WINDOW_MS;
}

export function discoverTimingEnabled(): boolean {
  return process.env.VERCEL_ENV === 'preview' || productionLoggingEnabled();
}

// Vercel associates this log with its request. Never include request inputs,
// actor/session identifiers, media URLs, headers or exception details here.
export function createDiscoverTimingLogger(route: 'feed' | 'feed-events') {
  let remainingLogs = MAX_LOGS_PER_ROUTE_MODULE;
  return (status: number, values: readonly string[]): void => {
    if (!productionLoggingEnabled() || remainingLogs === 0 ||
        !Number.isInteger(status) || status < 100 || status > 599) return;
    const metrics: Record<string, number> = {};
    for (const value of values.slice(0, 40)) {
      const match = /^([a-z]+);dur=(\d{1,16}(?:\.\d{1,3})?)$/.exec(value);
      if (!match || !ALLOWED_METRICS.has(match[1])) continue;
      const duration = Number(match[2]);
      const combined = (metrics[match[1]] ?? 0) + duration;
      if (Number.isFinite(combined) && combined <= Number.MAX_SAFE_INTEGER)
        metrics[match[1]] = combined;
    }
    if (Object.keys(metrics).length === 0) return;
    remainingLogs--;
    try {
      console.info('[discover-timing]', JSON.stringify({ route, status, metrics }));
    } catch { /* Diagnostics must not turn a completed request into a failure. */ }
  };
}
