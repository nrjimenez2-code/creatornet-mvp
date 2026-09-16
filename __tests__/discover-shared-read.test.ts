const cache = jest.fn();
jest.mock('next/cache',()=>({unstable_cache:(...args:unknown[])=>cache(...args)}));
import {discoverSharedRead} from '@/lib/discoverSharedRead';
const previous = process.env.VERCEL;
beforeEach(()=>{process.env.VERCEL='1';cache.mockReset();});
afterAll(()=>{if(previous===undefined)delete process.env.VERCEL;else process.env.VERCEL=previous;});
test('reuses a recent common input without rereading database',async()=>{
 cache.mockReturnValue(async()=>({value:['common'],readAt:Date.now()}));
 const read=jest.fn();
 expect(await discoverSharedRead('inventory',read)).toEqual(['common']);
 expect(read).not.toHaveBeenCalled();
 expect(cache.mock.calls[0][2]).toEqual({revalidate:30});
});
test('stale data after failed revalidation is replaced with a live read',async()=>{
 cache.mockReturnValue(async()=>({value:['stale'],readAt:Date.now()-61000}));
 expect(await discoverSharedRead('inventory',async()=>['fresh'])).toEqual(['fresh']);
});
test('cache availability cannot block database-backed results',async()=>{
 cache.mockReturnValue(async()=>{throw new Error('cache unavailable');});
 expect(await discoverSharedRead('inventory',async()=>['live'])).toEqual(['live']);
});
test('a cache-write failure preserves the already completed database read',async()=>{
 cache.mockImplementation((load:()=>Promise<unknown>)=>async()=>{await load();throw new Error('too large');});
 const read=jest.fn(async()=>['large']);
 expect(await discoverSharedRead('inventory',read)).toEqual(['large']);
 expect(read).toHaveBeenCalledTimes(1);
});
test('database failures are not retried or replaced by stale fallback',async()=>{
 cache.mockImplementation((load:()=>Promise<unknown>)=>load);
 const read=jest.fn(async()=>{throw new Error('database unavailable');});
 await expect(discoverSharedRead('inventory',read)).rejects.toThrow('database unavailable');
 expect(read).toHaveBeenCalledTimes(1);
});

test('an expired entry shares its in-progress background refresh with the foreground read',async()=>{
 let finish!: (value:string[])=>void;
 let background!: Promise<unknown>;
 const read=jest.fn(()=>new Promise<string[]>(resolve=>{finish=resolve;}));
 cache.mockImplementation((load:()=>Promise<unknown>)=>async()=>{
  background=load();
  return {value:['expired'],readAt:Date.now()-61000};
 });
 const result=discoverSharedRead('inventory',read);
 // Let both the background refresh and expired-entry fallback start.
 await new Promise(resolve=>setImmediate(resolve));
 const calls=read.mock.calls.length;
 finish(['fresh']);
 expect(await result).toEqual(['fresh']);
 expect(calls).toBe(1);
 await background;
});

test('an expired entry reuses a refresh that finished before the stale result arrived',async()=>{
 cache.mockImplementation((load:()=>Promise<unknown>)=>async()=>{
  await load();
  return {value:['expired'],readAt:Date.now()-61000};
 });
 const read=jest.fn(async()=>['fresh']);
 expect(await discoverSharedRead('inventory',read)).toEqual(['fresh']);
 expect(read).toHaveBeenCalledTimes(1);
});

test('a failed background refresh is not repeated by the expired-entry fallback',async()=>{
 cache.mockImplementation((load:()=>Promise<unknown>)=>async()=>{
  await load().catch(()=>undefined);
  return {value:['expired'],readAt:Date.now()-61000};
 });
 const read=jest.fn(async()=>{throw new Error('database unavailable');});
 await expect(discoverSharedRead('inventory',read)).rejects.toThrow('database unavailable');
 expect(read).toHaveBeenCalledTimes(1);
});

test('read sharing never survives into a later caller',async()=>{
 cache.mockImplementation((load:()=>Promise<unknown>)=>load);
 const read=jest.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(['recovered']);
 await expect(discoverSharedRead('inventory',read)).rejects.toThrow('temporary');
 expect(await discoverSharedRead('inventory',read)).toEqual(['recovered']);
 expect(read).toHaveBeenCalledTimes(2);
});

test('a stale entry within the freshness bound still returns without waiting for refresh',async()=>{
 let finish!: (value:string[])=>void;
 let background!: Promise<unknown>;
 const read=jest.fn(()=>new Promise<string[]>(resolve=>{finish=resolve;}));
 cache.mockImplementation((load:()=>Promise<unknown>)=>async()=>{
  background=load();
  return {value:['recent'],readAt:Date.now()-31000};
 });
 expect(await discoverSharedRead('inventory',read)).toEqual(['recent']);
 finish(['fresh']);
 await background;
 expect(read).toHaveBeenCalledTimes(1);
});
