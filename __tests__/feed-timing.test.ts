import { NextRequest, NextResponse } from 'next/server';
const create = jest.fn(async () => 'private-session');
const createPage = jest.fn(async () => ({session:'private-session',result:{items:[],hasMore:false,nextOffset:0}}));
const read = jest.fn(async () => ({items:[],hasMore:false,nextOffset:0}));
jest.mock('@/lib/supabaseServer',()=>({createServerClient:jest.fn()}));
jest.mock('@/lib/discoverServer',()=>({
 discoverEnabled:()=>true,
 discoverIdentity:async()=>({actor:'private-actor',userId:null,cookie:null,token:'private-token'}),
 createDiscoverSession:(...args:unknown[])=>create(...args as []),
 createDiscoverSessionWithFirstPage:(...args:unknown[])=>createPage(...args as []),
 readDiscoverPage:(...args:unknown[])=>read(...args as []),
 setDiscoverCookie:(response:NextResponse)=>response,
}));
import {GET} from '@/app/api/feed/route';
import { observeDiscoverSharedRead, discoverSharedReadTimingHeader } from '@/lib/discoverSharedReadTiming';
const original=process.env.VERCEL_ENV;
const originalCreatePage=process.env.DISCOVER_CREATE_PAGE_ENABLED;
afterEach(()=>{if(originalCreatePage===undefined)delete process.env.DISCOVER_CREATE_PAGE_ENABLED;else process.env.DISCOVER_CREATE_PAGE_ENABLED=originalCreatePage;});

test('combined creation is flag-gated, uses the resolved identity, and leaves later pages on their owned-read path',async()=>{
 process.env.DISCOVER_CREATE_PAGE_ENABLED='true';
 const first=await GET(new NextRequest('https://test.invalid/api/feed?offset=0&limit=20'));
 expect(first.status).toBe(200);
 expect(await first.json()).toMatchObject({session:'private-session',actorToken:'private-token'});
 expect(createPage.mock.calls[0].slice(0,6)).toEqual(['private-actor',null,'discover',undefined,0,20]);
 expect(create).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
 await GET(new NextRequest('https://test.invalid/api/feed?session=private-session&offset=20'));
 expect(createPage).toHaveBeenCalledTimes(1);expect(read).toHaveBeenCalledTimes(1);
 delete process.env.DISCOVER_CREATE_PAGE_ENABLED;
 await GET(new NextRequest('https://test.invalid/api/feed'));
 expect(create).toHaveBeenCalledTimes(1);
});

test('combined creation failure does not retry an insert on the legacy path',async()=>{
 process.env.DISCOVER_CREATE_PAGE_ENABLED='true';
 createPage.mockRejectedValueOnce(new Error('database failure'));
 const log=jest.spyOn(console,'error').mockImplementation(()=>{});
 try {
  const response=await GET(new NextRequest('https://test.invalid/api/feed'));
  expect(response.status).toBe(503);
  expect(createPage).toHaveBeenCalledTimes(1);
  expect(create).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
 } finally {log.mockRestore();}
});
afterEach(()=>{if(original===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=original;jest.clearAllMocks();});
test('preview separates new-session work from pagination without exposing identity',async()=>{
 process.env.VERCEL_ENV='preview';
 const first=await GET(new NextRequest('https://test.invalid/api/feed'));
 expect(first.status).toBe(200);
 const metrics=first.headers.get('server-timing')!.split(', ');
 expect(metrics.map(metric=>metric.split(';')[0])).toEqual([
  'identity','session','page','dbtotal','dbmax','dbcount','upstream','upstreamcount',
  'servicejwtcount','serviceparsecount','serviceplancount','servicetransactioncount','serviceresponsecount',
  'dbtransportcount','dbrequestcount','dbsendcount','dbresponsecount',
  'loopbusy','loopidle','invocation','routeage','uptime','total',
 ]);
 expect(metrics.every(metric=>/^[a-z]+;dur=\d+(?:\.\d+)?$/.test(metric))).toBe(true);
 for(const phase of ['jwt','parse','plan','transaction','response']) {
  expect(metrics).toContain(`service${phase}count;dur=0`);
  expect(metrics.some(metric=>metric.startsWith(`service${phase};`))).toBe(false);
 }
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

test('preview forwards numeric session subphases and production disables the callback',async()=>{
 process.env.VERCEL_ENV='preview';
 create.mockImplementationOnce(async (...args: unknown[]) => {
  (args[4] as (name:string, duration:number)=>void)('sessionevidence', 42.5);
  return 'private-session';
 });
 const response=await GET(new NextRequest('https://test.invalid/api/feed'));
 expect(response.headers.get('server-timing')).toContain('sessionevidence;dur=42.5');
 const previous=process.env.DISCOVER_TIMING_LOG_UNTIL;
 try {
  process.env.VERCEL_ENV='production';
  delete process.env.DISCOVER_TIMING_LOG_UNTIL;
  await GET(new NextRequest('https://test.invalid/api/feed'));
  expect((create.mock.calls.at(-1) as unknown[])?.[4]).toBeUndefined();
 } finally {
  if(previous!==undefined)process.env.DISCOVER_TIMING_LOG_UNTIL=previous;
 }
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

test.each(['preview', 'production-disabled', 'production-enabled'])('shared-read diagnostics use only the existing route gate (%s)', async mode => {
 const previous = process.env.DISCOVER_TIMING_LOG_UNTIL;
 const info = jest.spyOn(console, 'info').mockImplementation(() => {});
 try {
  process.env.VERCEL_ENV = mode === 'preview' ? 'preview' : 'production';
  if (mode === 'production-enabled') process.env.DISCOVER_TIMING_LOG_UNTIL = new Date(Date.now()+60_000).toISOString();
  else delete process.env.DISCOVER_TIMING_LOG_UNTIL;
  create.mockImplementationOnce(() => observeDiscoverSharedRead('inventory', async observation => {
   expect(Boolean(observation)).toBe(mode !== 'production-disabled');
   observation?.event('fresh');
   return 'private-session';
  }));
  const response = await GET(new NextRequest('https://test.invalid/api/feed'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({items:[],hasMore:false,nextOffset:0,session:'private-session',actorToken:'private-token'});
  if (mode === 'preview') {
   expect(response.headers.get('server-timing')).toContain('invfresh;dur=1.0');
   expect(info).not.toHaveBeenCalled();
  } else {
   expect(response.headers.has('server-timing')).toBe(false);
   if (mode === 'production-enabled') {
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(info.mock.calls[0][1]).metrics).toMatchObject({ invcalls: 1, invfresh: 1, invloads: 0 });
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/private/);
   } else expect(info).not.toHaveBeenCalled();
  }
  expect(discoverSharedReadTimingHeader()).toEqual([]);
 } finally {
  info.mockRestore();
  if (previous === undefined) delete process.env.DISCOVER_TIMING_LOG_UNTIL;
  else process.env.DISCOVER_TIMING_LOG_UNTIL = previous;
 }
});

test('preview error response retains numeric write failure diagnostics without exposing the error', async () => {
 process.env.VERCEL_ENV = 'preview';
 const error = jest.spyOn(console, 'error').mockImplementation(() => {});
 create.mockImplementationOnce(() => observeDiscoverSharedRead('write', async () => { throw new Error('private-write-detail'); }));
 try {
  const response = await GET(new NextRequest('https://test.invalid/api/feed'));
  expect(response.status).toBe(503);
  expect(response.headers.get('server-timing')).toContain('sessionstoreerrors;dur=1.0');
  expect(response.headers.get('server-timing')).not.toMatch(/private/);
  expect(await response.json()).toEqual({error:'Could not load this feed. Refresh to try again.'});
 } finally { error.mockRestore(); }
});
