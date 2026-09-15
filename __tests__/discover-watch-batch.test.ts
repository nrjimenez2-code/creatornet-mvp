import { NextRequest } from 'next/server';
import { createMockClient, type MockClient } from './__mocks__/supabaseQueryMock';
let db:MockClient;
let watched=0;
let duration:number|null=10;
let invalidSession=false;
let hidden=false;
let banned=false;
let recordedKinds:string[]=[];
const recordMany=jest.fn();
const originalVercelEnv=process.env.VERCEL_ENV;
jest.mock('@/lib/supabaseAdmin',()=>({get supabaseAdmin(){return db;}}));
jest.mock('@/lib/discoverServer',()=>({
 discoverEnabled:()=>true,
 discoverEventIdentity:async()=>({actorCandidate:'user:viewer',userId:'viewer',anonymousClaimCheck:process.env.DISCOVER_EVENT_CONTEXT_ENABLED==='true'?'context':'complete'}),
 recordDiscoverEvents:(...args:unknown[])=>recordMany(...args),
 recordDiscoverEvent:jest.fn(),
 DISCOVER_EVENT_POST_COLUMNS:'id,creator_id,caption',
}));
jest.mock('@/lib/rateLimit',()=>({allowRequest:()=>true}));
jest.mock('@/lib/discoverMedia',()=>({verifiedVideoDuration:async()=>duration}));
import {POST} from '@/app/api/feed-events/route';
beforeEach(()=>{
 delete process.env.DISCOVER_EVENT_CONTEXT_ENABLED;
 recordMany.mockReset();watched=0;duration=10;invalidSession=false;hidden=false;banned=false;recordedKinds=[];
 db=createMockClient(op=>{
  if(op.table==='discover_watch_context_v1')return {data:{anonymousClaimChecked:true,post:{id:'post',creator_id:'creator',video_url:'https://media.creatornet.net/videos/test.mp4'},audience:'photography',primaryProducts:[],legacyProducts:[],offerings:[],watched,recordedKinds},error:null};
  if(op.table==='discover_sessions_v1')return {data:invalidSession?null:{post_ids:['post'],expires_at:new Date(Date.now()+3600000).toISOString(),audiences:{post:'photography'}},error:null};
  if(op.table==='posts')return {data:{id:'post',creator_id:'creator',active:true,hidden_at:hidden?'2026-09-15':null,caption:'Portrait photography',video_url:'https://media.creatornet.net/videos/test.mp4'},error:null};
  if(op.table==='profiles')return {data:{banned_at:banned?'2026-09-15':null},error:null};
  if(op.table==='discover_watch_sample_v1')return {data:watched,error:null};
  return {data:null,error:null};
 });
});
afterEach(()=>{delete process.env.DISCOVER_EVENT_CONTEXT_ENABLED;process.env.VERCEL_ENV=originalVercelEnv;});
const request=()=>new NextRequest('https://example.test/api/feed-events',{method:'POST',body:JSON.stringify({session:'session',postId:'post',kind:'watch',watchSeconds:100000})});
test('batches only evidence established by server watch time and verified duration',async()=>{
 watched=9;
 expect((await POST(request())).status).toBe(200);
 expect(recordMany).toHaveBeenCalledTimes(1);
 expect(recordMany).toHaveBeenCalledWith(expect.objectContaining({actor:'user:viewer',audience:'photography'}),[
  {kind:'exposure',entityKey:'session:post'},
  {kind:'qualified_view',entityKey:'session:post'},
  {kind:'completion',entityKey:'session:post'},
 ],expect.objectContaining({id:'post',creator_id:'creator',caption:'Portrait photography'}),undefined);
});
test('inflated browser time cannot add qualified viewing or completion',async()=>{
 watched=1;
 expect((await POST(request())).status).toBe(200);
 expect(recordMany.mock.calls[0][1]).toEqual([{kind:'exposure',entityKey:'session:post'}]);
});
test('unknown duration cannot produce completion and batch failures remain failures',async()=>{
 watched=6;duration=null;
 recordMany.mockRejectedValueOnce(new Error('write failed'));
 expect((await POST(request())).status).toBe(503);
 expect(recordMany.mock.calls[0][1].map((e:{kind:string})=>e.kind)).toEqual(['exposure','qualified_view']);
});

test.each(['invalid session','hidden post','banned creator'])('%s cannot advance watch time or record events',async(reason)=>{
 invalidSession=reason==='invalid session';hidden=reason==='hidden post';banned=reason==='banned creator';
 expect((await POST(request())).status).toBe(403);
 expect(db.opsFor('discover_watch_sample_v1')).toHaveLength(0);
 expect(recordMany).not.toHaveBeenCalled();
});

test('combined context does not advance watch time a second time in the route',async()=>{
 process.env.DISCOVER_EVENT_CONTEXT_ENABLED='true';watched=9;
 expect((await POST(request())).status).toBe(200);
 expect(db.opsFor('discover_watch_context_v1')).toHaveLength(1);
 expect(db.opsFor('discover_watch_sample_v1')).toHaveLength(0);
 expect(recordMany.mock.calls[0][1].map((e:{kind:string})=>e.kind)).toEqual(['exposure','qualified_view','completion']);
});

test('existing receipts skip duplicate writes while a new completion is still recorded',async()=>{
 process.env.DISCOVER_EVENT_CONTEXT_ENABLED='true';watched=6;
 recordedKinds=['exposure','qualified_view'];
 expect((await POST(request())).status).toBe(200);
 expect(db.opsFor('discover_watch_context_v1')).toHaveLength(1);
 expect(recordMany).not.toHaveBeenCalled();
 watched=9;
 expect((await POST(request())).status).toBe(200);
 expect(recordMany.mock.calls[0][1]).toEqual([{kind:'completion',entityKey:'session:post'}]);
});

test('preview event timings contain only numeric phases and production has no header',async()=>{
 process.env.VERCEL_ENV='preview';
 const response=await POST(request());
 const header=response.headers.get('server-timing')!;
 expect(header).toMatch(/identity;dur=[\d.]+/);
 expect(header).toMatch(/context;dur=[\d.]+/);
 expect(header).toMatch(/write;dur=[\d.]+/);
 expect(header).toMatch(/dbcount;dur=\d+/);
 expect(header).toMatch(/routeage;dur=[\d.]+/);
 expect(header).toMatch(/uptime;dur=[\d.]+/);
 const nextHeader=(await POST(request())).headers.get('server-timing')!;
 const ordinal=(value:string)=>Number(value.match(/invocation;dur=(\d+)/)![1]);
 expect(ordinal(nextHeader)).toBe(ordinal(header)+1);
 expect(header.split(', ').every(metric=>/^[a-z]+;dur=\d+(?:\.\d+)?$/.test(metric))).toBe(true);
 expect(header).not.toMatch(/viewer|creator|post|session|https|100000/);
 process.env.VERCEL_ENV='production';
 expect((await POST(request())).headers.get('server-timing')).toBeNull();
});
test('temporary production timing preserves watch evidence without public diagnostics',async()=>{
 const previous=process.env.DISCOVER_TIMING_LOG_UNTIL;
 const info=jest.spyOn(console,'info').mockImplementation(()=>{});
 try {
  process.env.VERCEL_ENV='production';
  process.env.DISCOVER_TIMING_LOG_UNTIL=new Date(Date.now()+60_000).toISOString();
  watched=6;
  const response=await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.has('server-timing')).toBe(false);
  expect(recordMany.mock.calls[0][1].map((event:{kind:string})=>event.kind)).toEqual(['exposure','qualified_view']);
  expect(info).toHaveBeenCalledTimes(1);
  const entry=JSON.parse(info.mock.calls[0][1]);
  expect(entry).toMatchObject({route:'feed-events',status:200,metrics:{context:expect.any(Number),total:expect.any(Number)}});
  expect(JSON.stringify(info.mock.calls)).not.toMatch(/viewer|creator|https|100000/);
 } finally {
  info.mockRestore();
  if(previous===undefined)delete process.env.DISCOVER_TIMING_LOG_UNTIL;
  else process.env.DISCOVER_TIMING_LOG_UNTIL=previous;
 }
});
