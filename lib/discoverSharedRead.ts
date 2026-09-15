import { unstable_cache } from 'next/cache';

// This is only for actor-independent ranking inputs, never response pages,
// identity, entitlements, moderation checks or personal event history.
export async function discoverSharedRead<T>(key: string, read: () => Promise<T>): Promise<T> {
 if (process.env.VERCEL !== '1') return read();
 let completed: {value:T} | undefined;
 let readFailed = false;
 const cached = unstable_cache(async () => {
  let value:T;
  try { value = await read(); } catch (error) { readFailed=true; throw error; }
  completed = {value};
  return {value, readAt:Date.now()};
 }, ['discover-input-v1', process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.VERCEL_GIT_COMMIT_SHA ?? '', key], {revalidate:30});
 try {
  const result = await cached();
  // A failed background refresh must not retain ranking inputs indefinitely.
  if (result && typeof result.readAt === 'number' && Date.now()-result.readAt <= 60000)
   return result.value;
 } catch (error) {
  if (readFailed) throw error;
  // Cache failure/oversized entries must not turn a successful DB read into 503.
  if (completed) return completed.value;
 }
 return read();
}
