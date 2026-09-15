import { AsyncLocalStorage } from 'node:async_hooks';

type Timing = { count: number; totalMs: number; maxMs: number };
const timing = new AsyncLocalStorage<Timing>();

export function withDiscoverDatabaseTiming<T>(work: () => T): T {
  if (process.env.VERCEL_ENV !== 'preview') return work();
  return timing.run({ count: 0, totalMs: 0, maxMs: 0 }, work);
}

// Only numeric timings are retained. URLs, headers, bodies and credentials are
// never stored. Total is the sum of requests and can overlap when parallel.
export const timedDatabaseFetch: typeof fetch = async (input, init) => {
  const current = timing.getStore();
  if (!current) return fetch(input, init);
  const start = performance.now();
  try { return await fetch(input, init); }
  finally {
    const elapsed = performance.now() - start;
    current.count++;
    current.totalMs += elapsed;
    current.maxMs = Math.max(current.maxMs, elapsed);
  }
};

export function discoverDatabaseTimingHeader(): string[] {
  const current = timing.getStore();
  return current ? [
    `dbtotal;dur=${current.totalMs.toFixed(1)}`,
    `dbmax;dur=${current.maxMs.toFixed(1)}`,
    `dbcount;dur=${current.count}`,
  ] : [];
}
