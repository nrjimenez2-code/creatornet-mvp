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
