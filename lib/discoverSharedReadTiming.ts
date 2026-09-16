import { AsyncLocalStorage } from 'node:async_hooks';
import type { DiscoverSharedReadObservation } from './discoverSharedRead';

type Scope = 'inventory' | 'evidence' | 'write';
const COUNTERS = ['calls', 'errors', 'joins', 'bypass', 'fresh', 'stale', 'expired', 'invalid',
  'cacheerror', 'fallback', 'reuse', 'completed', 'loads', 'loaderrors',
  'waitcount', 'cachewaitcount', 'readwaitcount'] as const;
const DURATIONS = ['wait', 'cachewait', 'readwait'] as const;
type Metric = typeof COUNTERS[number] | typeof DURATIONS[number];
type Bucket = Record<Metric, number>;
const PREFIX = { inventory: 'inv', evidence: 'evi', write: 'sessionstore' } as const;
const METRICS = [...COUNTERS, ...DURATIONS];
const SCOPES = ['inventory', 'evidence', 'write'] as const;
const metricsFor = (scope: Scope): readonly Metric[] => scope === 'write' ? ['calls', 'errors', 'waitcount', 'wait'] : METRICS;
export const DISCOVER_SHARED_READ_METRICS = Object.freeze(SCOPES.flatMap(scope => metricsFor(scope).map(metric => PREFIX[scope] + metric)));
type Store = { closed: boolean; buckets: Record<Scope, Bucket> };
const storage = new AsyncLocalStorage<Store>();

// The route supplies the existing diagnostic gate. No keys, identities, query
// values, results or per-read lists enter this fixed-size request-local store.
export function withDiscoverSharedReadTiming<T>(enabled: boolean, work: () => T): T {
  if (!enabled) return storage.exit(work);
  const bucket = () => Object.fromEntries(METRICS.map(metric => [metric, 0])) as Bucket;
  return storage.run({ closed: false, buckets: { inventory: bucket(), evidence: bucket(), write: bucket() } }, work);
}

function now(): number | null {
  try { const value = performance.now(); return Number.isFinite(value) ? value : null; }
  catch { return null; }
}
function add(store: Store, bucket: Bucket, metric: Metric, amount: number) {
  if (!store.closed && METRICS.includes(metric) && Number.isFinite(amount) && amount >= 0)
    bucket[metric] = Math.min(Number.MAX_SAFE_INTEGER, bucket[metric] + amount);
}

export function observeDiscoverSharedRead<T>(scope: Scope,
  work: (observation?: DiscoverSharedReadObservation) => Promise<T>): Promise<T> {
  const store = storage.getStore();
  if (!store || store.closed) return work();
  const bucket = store.buckets[scope];
  const duration = (metric: 'wait' | 'cachewait' | 'readwait', started: number | null) => {
    const ended = now();
    if (started !== null && ended !== null && ended >= started) {
      add(store, bucket, metric, ended - started);
      add(store, bucket, `${metric}count`, 1);
    }
  };
  const observation: DiscoverSharedReadObservation = {
    event(event) { add(store, bucket, event === 'join' ? 'joins' : event, 1); },
    async measure(kind, read) {
      const started = now();
      if (kind === 'read') add(store, bucket, 'loads', 1);
      try { return await read(); }
      catch (error) { if (kind === 'read') add(store, bucket, 'loaderrors', 1); throw error; }
      finally { duration(kind === 'read' ? 'readwait' : 'cachewait', started); }
    },
  };
  const started = now();
  add(store, bucket, 'calls', 1);
  // A joiner observes its own wait/outcome only. The owner alone reports its
  // cache envelope and physical loader; these sums may overlap across reads.
  return (async () => {
    try { return await work(observation); }
    catch (error) { add(store, bucket, 'errors', 1); throw error; }
    finally { duration('wait', started); }
  })();
}

export function discoverSharedReadTimingHeader(): string[] {
  const store = storage.getStore();
  if (!store) return [];
  // Background revalidation may outlive the response. Freeze the snapshot so
  // late work cannot change a completed request's diagnostics or another request.
  store.closed = true;
  return SCOPES.flatMap(scope => {
    const bucket = store.buckets[scope];
    if (bucket.calls === 0) return [];
    return metricsFor(scope).map(metric => `${PREFIX[scope]}${metric};dur=${bucket[metric].toFixed(1)}`);
  });
}
