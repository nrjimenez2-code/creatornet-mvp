import { unstable_cache } from 'next/cache';

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
 }, ['discover-input-v1', process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.VERCEL_GIT_COMMIT_SHA ?? '', key], {revalidate:30});
 try {
  const result = await (observation ? observation.measure('cache', cached) : cached());
  // A failed background refresh must not retain ranking inputs indefinitely.
  if (result && typeof result.readAt === 'number') {
   const age = Date.now()-result.readAt;
   if (age <= 60000) { event(age <= 30000 ? 'fresh' : 'stale'); return result.value; }
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
