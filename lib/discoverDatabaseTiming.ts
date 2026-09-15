import { AsyncLocalStorage } from 'node:async_hooks';
import { performance as nodePerformance } from 'node:perf_hooks';

type Timing = { count: number; totalMs: number; maxMs: number; upstreamMs: number; upstreamCount: number; loopStart: ReturnType<typeof nodePerformance.eventLoopUtilization> };
const timing = new AsyncLocalStorage<Timing>();

export function withDiscoverDatabaseTiming<T>(work: () => T): T {
  if (process.env.VERCEL_ENV !== 'preview') return work();
  return timing.run({ count: 0, totalMs: 0, maxMs: 0, upstreamMs: 0, upstreamCount: 0, loopStart: nodePerformance.eventLoopUtilization() }, work);
}

// Only numeric timings are retained. URLs, headers, bodies and credentials are
// never stored. Total is the sum of requests and can overlap when parallel.
export const timedDatabaseFetch: typeof fetch = async (input, init) => {
  const current = timing.getStore();
  if (!current) return fetch(input, init);
  const start = performance.now();
  try {
    const response = await fetch(input, init);
    const upstream = response.headers.get('x-envoy-upstream-service-time');
    if (upstream && /^\d{1,9}(?:\.\d{1,3})?$/.test(upstream)) {
      current.upstreamMs += Number(upstream);
      current.upstreamCount++;
    }
    return response;
  }
  finally {
    const elapsed = performance.now() - start;
    current.count++;
    current.totalMs += elapsed;
    current.maxMs = Math.max(current.maxMs, elapsed);
  }
};

export function discoverDatabaseTimingHeader(): string[] {
  const current = timing.getStore();
  // Process activity during this request includes work for overlapping requests.
  // It distinguishes a busy JS process from idle network/service wait.
  const loop = current ? nodePerformance.eventLoopUtilization(current.loopStart) : null;
  return current ? [
    `dbtotal;dur=${current.totalMs.toFixed(1)}`,
    `dbmax;dur=${current.maxMs.toFixed(1)}`,
    `dbcount;dur=${current.count}`,
    `upstream;dur=${current.upstreamMs.toFixed(1)}`,
    `upstreamcount;dur=${current.upstreamCount}`,
    `loopbusy;dur=${loop!.active.toFixed(1)}`,
    `loopidle;dur=${loop!.idle.toFixed(1)}`,
  ] : [];
}
