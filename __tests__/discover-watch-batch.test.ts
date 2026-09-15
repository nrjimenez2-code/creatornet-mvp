import { NextRequest } from 'next/server';
import { createMockClient, type MockClient } from './__mocks__/supabaseQueryMock';
let db:MockClient;
let watched=0;
let duration:number|null=10;
let invalidSession=false;
let hidden=false;
let banned=false;
const recordMany=jest.fn();
jest.mock('@/lib/supabaseAdmin',()=>({get supabaseAdmin(){return db;}}));
jest.mock('@/lib/discoverServer',()=>({
 discoverEnabled:()=>true,
 discoverIdentity:async()=>({actor:'user:viewer',userId:'viewer'}),
 recordDiscoverEvents:(...args:unknown[])=>recordMany(...args),
 recordDiscoverEvent:jest.fn(),
 DISCOVER_EVENT_POST_COLUMNS:'id,creator_id,caption',
}));
jest.mock('@/lib/rateLimit',()=>({allowRequest:()=>true}));
jest.mock('@/lib/discoverMedia',()=>({verifiedVideoDuration:async()=>duration}));
import {POST} from '@/app/api/feed-events/route';
beforeEach(()=>{
 recordMany.mockReset();watched=0;duration=10;invalidSession=false;hidden=false;banned=false;
 db=createMockClient(op=>{
  if(op.table==='discover_sessions_v1')return {data:invalidSession?null:{post_ids:['post'],expires_at:new Date(Date.now()+3600000).toISOString(),audiences:{post:'photography'}},error:null};
  if(op.table==='posts')return {data:{id:'post',creator_id:'creator',active:true,hidden_at:hidden?'2026-09-15':null,caption:'Portrait photography',video_url:'https://media.creatornet.net/videos/test.mp4'},error:null};
  if(op.table==='profiles')return {data:{banned_at:banned?'2026-09-15':null},error:null};
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
