import { NextRequest, NextResponse } from 'next/server';
const create = jest.fn(async () => 'private-session');
const read = jest.fn(async () => ({items:[],hasMore:false,nextOffset:0}));
jest.mock('@/lib/supabaseServer',()=>({createServerClient:jest.fn()}));
jest.mock('@/lib/discoverServer',()=>({
 discoverEnabled:()=>true,
 discoverIdentity:async()=>({actor:'private-actor',userId:null,cookie:null,token:'private-token'}),
 createDiscoverSession:(...args:unknown[])=>create(...args as []),
 readDiscoverPage:(...args:unknown[])=>read(...args as []),
 setDiscoverCookie:(response:NextResponse)=>response,
}));
import {GET} from '@/app/api/feed/route';
const original=process.env.VERCEL_ENV;
afterEach(()=>{if(original===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=original;jest.clearAllMocks();});
test('preview separates new-session work from pagination without exposing identity',async()=>{
 process.env.VERCEL_ENV='preview';
 const first=await GET(new NextRequest('https://test.invalid/api/feed'));
 expect(first.status).toBe(200);
 const metrics=first.headers.get('server-timing')!.split(', ');
 expect(metrics.map(metric=>metric.split(';')[0])).toEqual([
  'identity','session','page','dbtotal','dbmax','dbcount','upstream','upstreamcount','loopbusy','loopidle','total',
 ]);
 expect(metrics.every(metric=>/^[a-z]+;dur=\d+(?:\.\d+)?$/.test(metric))).toBe(true);
 expect(first.headers.get('server-timing')).not.toMatch(/private/);
 const next=await GET(new NextRequest('https://test.invalid/api/feed?session=private-session'));
 expect(next.headers.get('server-timing')).not.toMatch(/session;|private/);
 expect(create).toHaveBeenCalledTimes(1);
});
test('production does not expose diagnostic timings',async()=>{
 process.env.VERCEL_ENV='production';
 expect((await GET(new NextRequest('https://test.invalid/api/feed'))).headers.has('server-timing')).toBe(false);
});
