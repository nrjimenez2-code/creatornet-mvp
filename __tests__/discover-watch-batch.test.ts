import { NextRequest } from 'next/server';
import { createMockClient, type MockClient } from './__mocks__/supabaseQueryMock';
let db:MockClient;
let watched=0;
let duration:number|null=10;
const recordMany=jest.fn();
jest.mock('@/lib/supabaseAdmin',()=>({get supabaseAdmin(){return db;}}));
jest.mock('@/lib/discoverServer',()=>({
 discoverEnabled:()=>true,
 discoverIdentity:async()=>({actor:'user:viewer',userId:'viewer'}),
 recordDiscoverEvents:(...args:unknown[])=>recordMany(...args),
 recordDiscoverEvent:jest.fn(),
}));
jest.mock('@/lib/rateLimit',()=>({allowRequest:()=>true}));
jest.mock('@/lib/discoverMedia',()=>({verifiedVideoDuration:async()=>duration}));
import {POST} from '@/app/api/feed-events/route';
beforeEach(()=>{
 recordMany.mockReset();watched=0;duration=10;
 db=createMockClient(op=>{
  if(op.table==='discover_sessions_v1')return {data:{post_ids:['post'],expires_at:new Date(Date.now()+3600000).toISOString(),audiences:{post:'photography'}},error:null};
  if(op.table==='posts')return {data:{creator_id:'creator',active:true,video_url:'https://media.creatornet.net/videos/test.mp4'},error:null};
  if(op.table==='profiles')return {data:{banned_at:null},error:null};
  if(op.table==='discover_watch_sample_v1')return {data:watched,error:null};
  return {data:null,error:null};
 });
});
const request=()=>new NextRequest('https://example.test/api/feed-events',{method:'POST',body:JSON.stringify({session:'session',postId:'post',kind:'watch',watchSeconds:100000})});
test('batches only evidence established by server watch time and verified duration',async()=>{
 watched=9;
 expect((await POST(request())).status).toBe(200);
 expect(recordMany).toHaveBeenCalledTimes(1);
 expect(recordMany).toHaveBeenCalledWith(expect.objectContaining({actor:'user:viewer',audience:'photography'}),[
  {kind:'exposure',entityKey:'session:post'},
  {kind:'qualified_view',entityKey:'session:post'},
  {kind:'completion',entityKey:'session:post'},
 ]);
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
