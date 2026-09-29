import { NextRequest } from "next/server";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
const mockUser=jest.fn(),mockRpc=jest.fn(),mockEligible=jest.fn(),mockMedia=jest.fn();
let mockPost:any,mockSession:any;
const mockDb=createMockClient(op=>({data:op.table==="posts"?mockPost:op.table==="purchases"?[{id:"purchase",buyer_id:"viewer",status:"paid",access_granted:true}]:mockSession,error:null}));
jest.mock("@/lib/supabaseAdmin",()=>({supabaseAdmin:{from:(table:string)=>mockDb.from(table),rpc:(...args:unknown[])=>mockRpc(...args)}}));
jest.mock("@/lib/supabaseConnectAuth",()=>({getAuthenticatedUser:()=>mockUser()}));
jest.mock("@/lib/libraryAccess",()=>({isLibraryPurchaseEligible:(...args:unknown[])=>mockEligible(...args)}));
import { POST as start } from "@/app/api/video-insights/sessions/route";
import { POST as event } from "@/app/api/video-insights/events/route";
import { GET as read } from "@/app/api/posts/[postId]/insights/route";
import { _resetRateLimits } from "@/lib/rateLimit";
import { hashInsightSecret } from "@/lib/videoInsightsServer";
const postId="11111111-1111-4111-8111-111111111111",sessionId="33333333-3333-4333-8333-333333333333",secret="a".repeat(64);
const descriptor={key:"videos/test.mp4",contentVersion:`sha256:${"d".repeat(64)}`,durationSeconds:10,originalUrl:"https://media.creatornet.net/videos/test.mp4",processedMp4Url:`https://media.creatornet.net/feed-auto/${"d".repeat(64)}.mp4`};
const body=()=>({postId,sessionId,secret,source:"discover",surface:"feed",startedAt:Date.now()});
const request=(path:string,input:unknown,headers?:Record<string,string>)=>new NextRequest(`https://creatornet.net/api/video-insights/${path}`,{method:"POST",headers,body:JSON.stringify(input)});
const get=()=>read(new NextRequest(`https://creatornet.net/api/posts/${postId}/insights`),{params:Promise.resolve({postId})});
beforeEach(()=>{
  process.env.VIDEO_INSIGHTS_COLLECTION_ENABLED="true";process.env.VIDEO_INSIGHTS_UI_ENABLED="true";process.env.NEXT_PUBLIC_VIDEO_INSIGHTS_UI_ENABLED="true";
  _resetRateLimits();mockDb.ops.length=0;mockUser.mockReset().mockResolvedValue({id:"viewer"});mockEligible.mockReset().mockResolvedValue(true);
  mockPost={id:postId,creator_id:"owner",title:"Video",video_url:descriptor.originalUrl,poster_url:null,removed_at:null,hidden_at:null};
  mockSession={post_id:postId,media_version:`${descriptor.contentVersion}:10`,surface:"feed",started_at:new Date().toISOString()};
  mockMedia.mockReset().mockResolvedValue({ok:true,json:async()=>descriptor});global.fetch=mockMedia;
  mockRpc.mockReset().mockResolvedValue({data:null,error:null});
});
afterAll(()=>{delete process.env.VIDEO_INSIGHTS_COLLECTION_ENABLED;delete process.env.VIDEO_INSIGHTS_UI_ENABLED;delete process.env.NEXT_PUBLIC_VIDEO_INSIGHTS_UI_ENABLED;});
test("both endpoints default off, UI and collection gates are independent",async()=>{
  delete process.env.VIDEO_INSIGHTS_COLLECTION_ENABLED;expect((await start(request("sessions",body()))).status).toBe(404);
  expect((await event(request("events",{}))).status).toBe(404);expect(mockDb.ops).toHaveLength(0);
  mockUser.mockResolvedValue({id:"owner"});expect((await get()).status).toBe(200);
  delete process.env.VIDEO_INSIGHTS_UI_ENABLED;expect((await get()).status).toBe(404);
});
test("unauthenticated and non-owner reads are denied before metrics are returned",async()=>{
  mockUser.mockResolvedValue(null);expect((await get()).status).toBe(401);
  mockUser.mockResolvedValue({id:"viewer"});expect((await get()).status).toBe(404);expect(mockRpc).not.toHaveBeenCalled();
});
test("signed-in creators cannot generate their own sessions",async()=>{
  mockUser.mockResolvedValue({id:"owner"});expect((await start(request("sessions",body()))).status).toBe(403);expect(mockRpc).not.toHaveBeenCalled();
});
test("paid watch surface reuses library eligibility and fails closed",async()=>{
  mockEligible.mockResolvedValue(false);expect((await start(request("sessions",{...body(),surface:"watch"}))).status).toBe(403);
  expect(mockEligible).toHaveBeenCalled();expect(mockRpc).not.toHaveBeenCalled();
});
test("public sales-preview collection stays available without buying the attached product",async()=>{
  expect((await start(request("sessions",body()))).status).toBe(200);expect(mockEligible).not.toHaveBeenCalled();
  expect(mockRpc).toHaveBeenCalledWith("start_video_insight_session_v1",expect.objectContaining({p_actor:hashInsightSecret("user:viewer"),p_token:hashInsightSecret(secret),p_duration:10}));
});
test("anonymous identity is established before counting a session and tokens are bound to the cookie actor",async()=>{
  mockUser.mockResolvedValue(null);
  const response=await start(request("sessions",body()));expect(await response.json()).toEqual({identityReady:true});expect(mockRpc).not.toHaveBeenCalled();
  const cookie=response.cookies.get("cn_video_actor")!.value;
  const resumed=await start(request("sessions",body(),{cookie:`cn_video_actor=${cookie}`}));expect(resumed.status).toBe(200);
  expect(mockRpc).toHaveBeenCalledWith("start_video_insight_session_v1",expect.objectContaining({p_actor:hashInsightSecret(`anonymous:${cookie}`)}));
});
test("wrong/missing token lookup never reads another session's post",async()=>{
  mockSession=null;
  expect((await event(request("events",{sessionId,secret,sequence:1,seconds:2,intervals:[[0,2]]}))).status).toBe(403);
  expect(mockDb.opsFor("posts")).toHaveLength(0);expect(mockRpc).not.toHaveBeenCalled();
  expect(mockDb.opsFor("video_insight_sessions_v1")[0].filters).toMatchObject({actor_hash:hashInsightSecret("user:viewer"),token_hash:hashInsightSecret(secret)});
});
test("replacement media and expired purchase access deny new updates",async()=>{
  mockSession.media_version="old";
  expect((await event(request("events",{sessionId,secret,sequence:1,seconds:2,intervals:[[0,2]]}))).status).toBe(409);
  mockSession.media_version=`${descriptor.contentVersion}:10`;mockSession.surface="watch";mockEligible.mockResolvedValue(false);
  expect((await event(request("events",{sessionId,secret,sequence:1,seconds:2,intervals:[[0,2]]}))).status).toBe(403);
});
test("streamed body limit and origin validation prevent writes",async()=>{
  expect((await start(request("sessions",{...body(),filler:"x".repeat(33000)}))).status).toBe(413);
  expect((await start(request("sessions",body(),{origin:"https://attacker.example"}))).status).toBe(403);expect(mockRpc).not.toHaveBeenCalled();
});
test("owner response uses private no-store, current media and never returns raw sessions",async()=>{
  mockUser.mockResolvedValue({id:"owner"});
  mockRpc.mockResolvedValue({data:{sessions:2,watch_seconds:9,unique_seconds:9,completions:1,opening:1,buckets:Array(10).fill(1),sources:{discover:2},collection_started_at:"2026-09-27",updated_at:"2026-09-27"},error:null});
  const response=await get();const result=await response.json();expect(response.headers.get("cache-control")).toContain("no-store");
  expect(result).toMatchObject({sampleCount:2,averageWatchTime:4.5,averagePercentageWatched:45,completionRate:50,threeSecondRetention:50});
  expect(result).not.toHaveProperty("sessions");expect(result).not.toHaveProperty("actor_hash");expect(mockDb.opsFor("video_insight_sessions_v1")).toHaveLength(0);
});
