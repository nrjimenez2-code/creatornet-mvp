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
  'identity','session','page','dbtotal','dbmax','dbcount','upstream','upstreamcount',
  'dbtransportcount','dbrequestcount','dbsendcount','dbresponsecount',
  'loopbusy','loopidle','invocation','routeage','uptime','total',
 ]);
 expect(metrics.every(metric=>/^[a-z]+;dur=\d+(?:\.\d+)?$/.test(metric))).toBe(true);
 expect(first.headers.get('server-timing')).not.toMatch(/private/);
 const next=await GET(new NextRequest('https://test.invalid/api/feed?session=private-session'));
 expect(next.headers.get('server-timing')).not.toMatch(/session;|private/);
 const ordinal=(response:NextResponse)=>Number(response.headers.get('server-timing')!.match(/invocation;dur=(\d+)/)![1]);
 expect(ordinal(next)).toBe(ordinal(first)+1);
 expect(create).toHaveBeenCalledTimes(1);
});
test('production does not expose diagnostic timings',async()=>{
 process.env.VERCEL_ENV='production';
 expect((await GET(new NextRequest('https://test.invalid/api/feed'))).headers.has('server-timing')).toBe(false);
});
test('temporary production timing goes only to logs and leaves the feed response unchanged',async()=>{
 const previous=process.env.DISCOVER_TIMING_LOG_UNTIL;
 const info=jest.spyOn(console,'info').mockImplementation(()=>{});
 try {
  process.env.VERCEL_ENV='production';
  process.env.DISCOVER_TIMING_LOG_UNTIL=new Date(Date.now()+60_000).toISOString();
  const response=await GET(new NextRequest('https://test.invalid/api/feed'));
  expect(response.headers.has('server-timing')).toBe(false);
  expect(await response.json()).toEqual({items:[],hasMore:false,nextOffset:0,session:'private-session',actorToken:'private-token'});
  expect(info).toHaveBeenCalledTimes(1);
  const entry=JSON.parse(info.mock.calls[0][1]);
  expect(entry).toMatchObject({route:'feed',status:200,metrics:{dbcount:0,total:expect.any(Number),invocation:expect.any(Number)}});
  expect(JSON.stringify(info.mock.calls)).not.toMatch(/private-actor|private-session|private-token/);
 } finally {
  info.mockRestore();
  if(previous===undefined)delete process.env.DISCOVER_TIMING_LOG_UNTIL;
  else process.env.DISCOVER_TIMING_LOG_UNTIL=previous;
 }
});
