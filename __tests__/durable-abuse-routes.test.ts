import { NextRequest } from "next/server";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
let mockDb:ReturnType<typeof createMockClient>;
const user="11111111-1111-4111-8111-111111111111",operation="22222222-2222-4222-8222-222222222222";
let mockIdentity={id:user,email_confirmed_at:"2026-01-01",is_anonymous:false};
let mockDiscoverEnabled=true,mockViewer:{id:string}|null={id:user};
const mockAdmit=jest.fn(),mockSign=jest.fn(),mockHead=jest.fn(),mockProvider=jest.fn(),mockFeedRead=jest.fn(),mockFeedCreate=jest.fn();
jest.mock("@/lib/abuse/admission",()=>({...jest.requireActual("@/lib/abuse/admission"),admitRequest:(...args:unknown[])=>mockAdmit(...args)}));
jest.mock("@/lib/supabaseAdmin",()=>({get supabaseAdmin(){return mockDb;}}));
jest.mock("@/lib/supabaseConnectAuth",()=>({getAuthenticatedUser:async()=>({id:user})}));
jest.mock("@/lib/supabaseClient",()=>({createServerSupabase:async()=>({auth:{getUser:async()=>({data:{user:mockIdentity}})}})}));
jest.mock("@/lib/supabaseServer",()=>({createServerClient:()=>({rpc:mockFeedRead,auth:{getUser:async()=>({data:{user:mockViewer},error:null})}})}));
jest.mock("@/lib/rateLimit",()=>({allowRequest:()=>true,clientKey:()=>"test"}));
jest.mock("@/lib/premiumReadiness",()=>({premiumPostingReady:()=>true,premiumSchemaReady:()=>true}));
jest.mock("@/lib/privateVideoProvider",()=>({createPrivateStreamUpload:(...args:unknown[])=>mockProvider(...args),PrivateUploadRejected:class extends Error{}}));
jest.mock("@/lib/discoverServer",()=>({discoverEnabled:()=>mockDiscoverEnabled,discoverIdentity:async()=>({actor:"user:"+user,userId:user}),createDiscoverSession:(...args:unknown[])=>mockFeedCreate(...args),readDiscoverPage:(...args:unknown[])=>mockFeedRead(...args),setDiscoverCookie:(r:Response)=>r}));
jest.mock("@/lib/r2",()=>({createPresignedUploadUrl:(...args:unknown[])=>mockSign(...args),headR2Object:(...args:unknown[])=>mockHead(...args),r2PublicUrl:(key:string)=>"https://media.test/"+key}));
import { AdmissionError } from "@/lib/abuse/admission";
import { POST as presign } from "@/app/api/upload/presign/route";
import { POST as premium } from "@/app/api/private-videos/route";
import { GET as feed } from "@/app/api/feed/route";
import { POST as search } from "@/app/api/search/perform/route";
const req=(path:string,body:unknown)=>new NextRequest("https://app.test"+path,{method:"POST",headers:{Origin:"https://app.test",Host:"app.test"},body:JSON.stringify(body)});
const publicBody={filename:"video.mp4",folder:"videos",size:100,contentType:"video/mp4",uploadContract:"create-only-v1",operationId:operation};
const privateBody={name:"private.mp4",size:29999999999,duration:36000,fingerprint:"a".repeat(64)};
beforeEach(()=>{
 jest.clearAllMocks();mockDb=createMockClient(op=>({data:op.table==="profiles"?{banned_at:null}:null,error:null}));
 mockIdentity={id:user,email_confirmed_at:"2026-01-01",is_anonymous:false};
 mockDiscoverEnabled=true;mockViewer={id:user};
 mockAdmit.mockImplementation(async(_req:unknown,_action:unknown,_identity:unknown,upload?:{resource:string})=>({resource:upload?.resource??null,reused:false}));
 mockSign.mockResolvedValue("https://local.invalid/put");mockHead.mockResolvedValue({size:100,contentType:"video/mp4"});
 mockFeedCreate.mockResolvedValue("session");mockFeedRead.mockResolvedValue({items:[],hasMore:false});
 mockProvider.mockResolvedValue({uid:"1".repeat(32),url:"https://provider.invalid/put"});
});
test.each([429,503] as const)("admission failure %s prevents feed ranking/search/storage/provider work",async status=>{
 mockAdmit.mockRejectedValue(new AdmissionError(status,17));
 expect((await feed(new NextRequest("https://app.test/api/feed"))).status).toBe(status);
 expect((await search(req("/api/search/perform",{q:"video"}))).status).toBe(status);
 expect((await presign(req("/api/upload/presign",publicBody))).status).toBe(status);
 expect((await premium(req("/api/private-videos",privateBody))).status).toBe(status);
 expect(mockFeedCreate).not.toHaveBeenCalled();expect(mockFeedRead).not.toHaveBeenCalled();expect(mockSign).not.toHaveBeenCalled();expect(mockHead).not.toHaveBeenCalled();expect(mockProvider).not.toHaveBeenCalled();
 expect(mockDb.ops.some(op=>op.kind==="insert")).toBe(false);
});
test("feed paging does not spend a new-session budget",async()=>{
 await feed(new NextRequest("https://app.test/api/feed?session=original"));
 expect(mockAdmit.mock.calls.map(args=>args[1])).toEqual(["feed_page"]);expect(mockFeedCreate).not.toHaveBeenCalled();
 await feed(new NextRequest("https://app.test/api/feed"));expect(mockAdmit.mock.calls.map(args=>args[1])).toEqual(["feed_page","feed_page","feed_session"]);
});
test.each([true,false])("legacy feed uses only the verified actor through the service bridge (signed in=%s)",async signedIn=>{
 mockDiscoverEnabled=false;mockViewer=signedIn?{id:user}:null;
 mockDb=createMockClient(()=>({data:[],error:null}));
 expect((await feed(new NextRequest("https://app.test/api/feed?p_actor=victim&p_user_id=victim&tab=following"))).status).toBe(200);
 expect(mockAdmit).toHaveBeenCalledWith(expect.anything(),"feed_page",signedIn?`user:${user}`:null);
 expect(mockDb.opsFor("get_feed_for_actor_v1")[0].payload).toEqual({p_actor:signedIn?user:null,p_tab:"following",p_limit:20,p_offset:0});
});
test("public upload retries reuse a flat launch key and verify 412 only against their existing reservation",async()=>{
 const first=await presign(req("/api/upload/presign",publicBody));expect(first.status).toBe(200);
 const {key}=await first.json();expect(key).toBe(`videos/${user}/launch_${operation}.mp4`);
 mockAdmit.mockResolvedValue({resource:key,reused:true});
 const recovered=await presign(req("/api/upload/presign",{...publicBody,verifyExisting:true}));expect(await recovered.json()).toMatchObject({alreadyUploaded:true,key});
 expect(mockSign).toHaveBeenCalledTimes(1);expect(mockHead).toHaveBeenCalledWith(key);
 mockHead.mockResolvedValue({size:101,contentType:"video/mp4"});expect((await presign(req("/api/upload/presign",{...publicBody,verifyExisting:true}))).status).toBe(503);
});
test("old clients get a refresh message and 412 without prior admission cannot become success",async()=>{
 expect((await presign(req("/api/upload/presign",{...publicBody,uploadContract:undefined}))).status).toBe(409);expect(mockAdmit).not.toHaveBeenCalled();
 expect((await presign(req("/api/upload/presign",{...publicBody,verifyExisting:true}))).status).toBe(409);expect(mockHead).not.toHaveBeenCalled();expect(mockSign).not.toHaveBeenCalled();
});
test.each([{filename:{}},{filename:"x".repeat(256)},{contentType:{}},{contentType:"x".repeat(101)}])("malformed upload fields fail before quota: %p",async fields=>{
 expect((await presign(req("/api/upload/presign",{...publicBody,...fields}))).status).toBe(400);
 expect(mockAdmit).not.toHaveBeenCalled();expect(mockSign).not.toHaveBeenCalled();expect(mockHead).not.toHaveBeenCalled();
});
test("anonymous, unverified and banned accounts cannot spend upload quota",async()=>{
 mockIdentity.is_anonymous=true;expect((await presign(req("/api/upload/presign",publicBody))).status).toBe(403);
 mockIdentity.is_anonymous=false;mockIdentity.email_confirmed_at="";expect((await presign(req("/api/upload/presign",publicBody))).status).toBe(403);
 mockIdentity.email_confirmed_at="2026-01-01";mockDb=createMockClient(()=>({data:{banned_at:"2026-01-01"},error:null}));
 expect((await presign(req("/api/upload/presign",publicBody))).status).toBe(403);
 expect(mockAdmit).not.toHaveBeenCalled();expect(mockSign).not.toHaveBeenCalled();expect(mockHead).not.toHaveBeenCalled();
});
test("existing uncertain private upload recovers before quota or provider creation",async()=>{
 mockDb=createMockClient(op=>({data:op.table==="profiles"?{banned_at:null}:op.table==="private_video_assets"?{id:operation,status:"creating",size_bytes:privateBody.size}:null,error:null}));
 expect((await premium(req("/api/private-videos",privateBody))).status).toBe(202);
 expect(mockAdmit).not.toHaveBeenCalled();expect(mockProvider).not.toHaveBeenCalled();
});
test("new private maximum reserves bytes and provider seconds; failed asset claim never dispatches",async()=>{
 mockDb=createMockClient(op=>({data:op.table==="profiles"?{banned_at:null}:null,error:op.kind==="insert"?{code:"23505"}:null}));
 expect((await premium(req("/api/private-videos",privateBody))).status).toBe(409);
 expect(mockAdmit).toHaveBeenCalledWith(expect.anything(),"premium_upload",`user:${user}`,expect.objectContaining({bytes:29999999999,seconds:36000}));
 expect(mockProvider).not.toHaveBeenCalled();
});
