import { unstable_cache } from 'next/cache';

// Avoid a remote cache lookup for every viewer of the same public inputs.
// Expiration remains anchored to the original read, never to a cache hit.
const localInputs = new Map<string, {value: unknown; readAt: number; bytes: number}>();
const LOCAL_BYTES = 8 * 1024 * 1024;
let localBytes = 0;
function forget(key: string) {
 const old = localInputs.get(key);
 if (old) { localBytes -= old.bytes; localInputs.delete(key); }
}
function remember(key: string, value: unknown, readAt: number) {
 const age = Date.now() - readAt;
 if (!Number.isFinite(age) || age < 0 || age > 30000) return;
 let bytes: number;
 try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { return; }
 if (bytes > LOCAL_BYTES) return;
 forget(key);
 while (localInputs.size >= 16 || localBytes + bytes > LOCAL_BYTES) forget(localInputs.keys().next().value!);
 localInputs.set(key, {value, readAt, bytes}); localBytes += bytes;
}

export type DiscoverSharedReadObservation = {
 event(event: 'join' | 'bypass' | 'fresh' | 'stale' | 'expired' | 'invalid' | 'cacheerror' | 'fallback' | 'reuse' | 'completed'): void;
 measure<T>(kind: 'cache' | 'read', work: () => Promise<T>): Promise<T>;
};

// This is only for actor-independent ranking inputs, never response pages,
// identity, entitlements, moderation checks or personal event history.
export async function discoverSharedRead<T>(key: string, read: () => Promise<T>, observation?: DiscoverSharedReadObservation): Promise<T> {
 const event = (value: Parameters<DiscoverSharedReadObservation['event']>[0]) => {
  try { observation?.event(value); } catch { /* Numeric diagnostics cannot fail a read. */ }
 };
 const observedRead = () => observation ? observation.measure('read', read) : read();
 if (process.env.VERCEL !== '1') { event('bypass'); return observedRead(); }
 const cacheKeys = ['discover-input-v1', process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.VERCEL_GIT_COMMIT_SHA ?? '', key];
 const localKey = key === 'inventory' || key.startsWith('evidence:') ? JSON.stringify(cacheKeys) : null;
 if (localKey) {
  const local = localInputs.get(localKey);
  if (local) {
   const age = Date.now() - local.readAt;
   if (age >= 0 && age <= 30000) { event('fresh'); return local.value as T; }
   forget(localKey);
  }
 }
 let completed: {value:T} | undefined;
 let readFailed = false;
 // Next can return a stale entry while already refreshing it in the background.
 // If that entry exceeds our freshness bound, join that same read instead of
 // issuing a second DB scan. This promise lives only for this invocation; it
 // never retains completed inputs or failures for a later caller.
 let pendingRead: Promise<T> | undefined;
 const readOnce = () => {
  if (pendingRead) { event('reuse'); return pendingRead; }
  return pendingRead = Promise.resolve().then(observedRead);
 };
 const cached = unstable_cache(async () => {
  let value:T;
  try { value = await readOnce(); } catch (error) { readFailed=true; throw error; }
  completed = {value};
  return {value, readAt:Date.now()};
 }, cacheKeys, {revalidate:30});
 try {
  const result = await (observation ? observation.measure('cache', cached) : cached());
  // A failed background refresh must not retain ranking inputs indefinitely.
  if (result && typeof result.readAt === 'number') {
   const age = Date.now()-result.readAt;
   if (age >= 0 && age <= 60000) {
    if (localKey) remember(localKey, result.value, result.readAt);
    event(age <= 30000 ? 'fresh' : 'stale'); return result.value;
   }
   event(Number.isFinite(age) ? 'expired' : 'invalid');
  } else event('invalid');
 } catch (error) {
  if (readFailed) throw error;
  event('cacheerror');
  // Cache failure/oversized entries must not turn a successful DB read into 503.
  if (completed) { event('completed'); return completed.value; }
 }
 event('fallback');
 return readOnce();
}
