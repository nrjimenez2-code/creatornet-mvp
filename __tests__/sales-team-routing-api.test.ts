import { NextRequest } from "next/server";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMockClient,type MockClient } from "./__mocks__/supabaseQueryMock";
let mockDb:MockClient;
const mockCookie=jest.fn();
jest.mock("@supabase/supabase-js",()=>({createClient:()=>mockDb}));
jest.mock("@/lib/supabaseClient",()=>({createServerSupabase:async()=>({auth:{getUser:mockCookie}})}));
jest.mock("@/lib/discoverBookings",()=>({attributedBookingUrl:(url:string)=>url}));
jest.mock("@/lib/rateLimit",()=>({allowRequest:()=>true}));
import { GET } from "@/app/api/book/route";
import { routeCompletedTeamBooking } from "@/lib/salesTeams/routing";
const creator="00000000-0000-4000-8000-000000000001",buyer="00000000-0000-4000-8000-000000000010",post="00000000-0000-4000-8000-000000000020";
const booked="00000000-0000-4000-8000-000000000025",attribution="00000000-0000-4000-8000-000000000026";
const origin='https://fixture.vercel.app',connection='00000000-0000-4000-8000-000000000030';
const env={...process.env};let enabled=true,sqlError:unknown=null,destination:string;
const request=(token?:string)=>new NextRequest(`https://fixture.vercel.app/api/book?creator_id=${creator}&post_id=${post}${token?`&cn_attribution=${token}`:""}`,
 {headers:{authorization:"Bearer verified"}});
beforeEach(()=>{
 jest.clearAllMocks();enabled=true;sqlError=null;process.env.CREATOR_SALES_TEAM_SCHEMA_READY="true";process.env.CREATOR_SALES_TEAM_READY="true";
 process.env.CREATOR_TEAM_CALENDAR_SCHEMA_READY='true';process.env.CREATOR_TEAM_CALENDAR_READY='true';
 process.env.SCHEDULING_OAUTH_ORIGIN=origin;process.env.GOOGLE_CALENDAR_ENABLED='true';process.env.GOOGLE_CALENDAR_CLIENT_ID='fixture-id';
 process.env.GOOGLE_CALENDAR_CLIENT_SECRET='fixture-secret';process.env.SCHEDULING_TOKEN_ENCRYPTION_KEY='ab'.repeat(32);
 destination=origin+'/scheduling/book/'+connection;
 mockDb=createMockClient(op=>{
  if(op.table==='resolve_original_team_booking_v1')return {data:{state:'legacy'},error:null};
  if(op.table==="sales_team_creator_settings_v1")return {data:{routing_enabled:enabled},error:null};
  if(op.table==="seed_sales_team_booking_v1")return {data:{booking_id:booked,booking_url:destination,assignment:{membership_id:booked,source:"weighted"},scheduling_status:"awaiting_confirmation",lead_reused:true},error:sqlError};
  if(op.table==="posts")return {data:{creator_id:creator,booking_url:"https://calendar.example/unbound"},error:null};
 });
 mockDb.auth.getUser=jest.fn(async()=>({data:{user:{id:buyer}},error:null}));mockCookie.mockResolvedValue({data:{user:{id:buyer}},error:null});
});
afterEach(()=>{process.env={...env};});

test.each([false,true])('the same completed team session cannot become legacy after routing stops (all flags off: %s)',async flagsOff=>{
 enabled=false;
 if(flagsOff)for(const key of ['CREATOR_SALES_TEAM_SCHEMA_READY','CREATOR_SALES_TEAM_READY','CREATOR_TEAM_CALENDAR_SCHEMA_READY','CREATOR_TEAM_CALENDAR_READY','GOOGLE_CALENDAR_ENABLED'])process.env[key]='false';
 const session={id:'cs_original_team',mode:'setup',status:'complete',metadata:{kind:'booking',buyer_user_id:buyer,creator_id:creator,post_id:post}} as unknown as Stripe.Checkout.Session;
 mockDb=createMockClient(op=>{
  if(op.table==='resolve_original_team_booking_v1')return {data:{state:'team',booking_id:booked},error:null};
  if(op.table==='discover_booking_attribution_v1')return {data:{id:attribution,setup_session_id:session.id,user_id:buyer,creator_id:creator,post_id:post,team_source_booking_id:booked},error:null};
  if(op.table==='sales_team_booking_sources_v1')return {data:{creator_id:creator,buyer_id:buyer,post_id:post,source_identity:'attribution:'+attribution,booking_id:booked},error:null};
  if(op.table==='sales_team_creator_settings_v1')return {data:{routing_enabled:false},error:null};
  return undefined;
 });
 await expect(routeCompletedTeamBooking(mockDb as unknown as SupabaseClient,session,attribution)).rejects.toThrow(/review|original|assigned/i);
 expect(mockDb.opsFor('seed_sales_team_booking_v1')).toHaveLength(0);
});

test('a positive completed-session recovery without an analytics alias reads its canonical destination without seeding a literal lead',async()=>{
 mockDb=createMockClient(op=>{
  if(op.table==='resolve_original_team_booking_v1')return {data:{state:'team',booking_id:booked,booking_url:destination},error:null};
  if(op.table==='sales_team_creator_settings_v1')return {data:{routing_enabled:true},error:null};
 });
 const session={id:'cs_original_team',mode:'setup',status:'complete',metadata:{kind:'booking',buyer_user_id:buyer,creator_id:creator,post_id:post}} as unknown as Stripe.Checkout.Session;
 expect(await routeCompletedTeamBooking(mockDb as unknown as SupabaseClient,session,null)).toEqual({booking_id:booked,booking_url:destination+'?team_booking_id='+booked});
 expect(mockDb.opsFor('seed_sales_team_booking_v1')).toHaveLength(0);
});

test.each([{data:null,error:{code:'PGRST202'}},{data:{state:'held'},error:null},{data:null,error:{code:'42501'}},{data:{state:'unexpected'},error:null}])('failed or unknown original-source reads never become raw fallback: %p',async response=>{
 enabled=false;mockDb=createMockClient(op=>{
  if(op.table==='sales_team_creator_settings_v1')return {data:{routing_enabled:false},error:null};
  if(op.table==='resolve_original_team_booking_v1')return response;
  if(op.table==='posts')return {data:{booking_url:'https://calendar.example/unbound'},error:null};
 });mockDb.auth.getUser=jest.fn(async()=>({data:{user:{id:buyer}},error:null}));
 const result=await GET(request(attribution));expect(result.status).toBe(409);expect(result.headers.get('location')).toBeNull();
 expect(mockDb.ops.some(op=>['posts','next_booking_target','closers','seed_sales_team_booking_v1'].includes(op.table))).toBe(false);
});

test('exact attribution recovery authenticates independently of new-work flags and rejects anonymous or wrong buyers',async()=>{
 for(const key of ['CREATOR_SALES_TEAM_SCHEMA_READY','CREATOR_SALES_TEAM_READY','CREATOR_TEAM_CALENDAR_SCHEMA_READY','CREATOR_TEAM_CALENDAR_READY'])process.env[key]='false';
 (mockDb.auth.getUser as jest.Mock).mockResolvedValueOnce({data:{user:null},error:Error('revoked')});
 expect((await GET(request(attribution))).status).toBe(401);
 expect(mockDb.opsFor('resolve_original_team_booking_v1')).toHaveLength(0);
 mockDb=createMockClient(op=>op.table==='resolve_original_team_booking_v1'?{data:{state:'held'},error:null}:undefined);
 mockDb.auth.getUser=jest.fn(async()=>({data:{user:{id:creator}},error:null}));
 expect((await GET(request(attribution))).status).toBe(409);
 expect(mockDb.opsFor('resolve_original_team_booking_v1')[0].payload).toMatchObject({p_buyer:creator,p_attribution:attribution});
});

test("the selected durable calendar precedes explicit and legacy destinations",async()=>{
 const response=await GET(request());expect(response.status).toBe(302);expect(response.headers.get("location")).toBe(destination+'?team_booking_id='+booked);
 expect(response.headers.get("cache-control")).toContain("no-store");
 expect(mockDb.ops.map(op=>op.table)).toEqual(["sales_team_creator_settings_v1","resolve_original_team_booking_v1","seed_sales_team_booking_v1"]);
 expect(mockDb.opsFor('seed_sales_team_booking_v1')[0].payload).toEqual({p_creator_id:creator,p_buyer_id:buyer,p_post_id:post,p_source_kind:"lead",p_source_id:null});
});
test.each(['CREATOR_TEAM_CALENDAR_READY','CREATOR_TEAM_CALENDAR_SCHEMA_READY','GOOGLE_CALENDAR_ENABLED','SCHEDULING_OAUTH_ORIGIN'])('an enrolled team stops before seeding when %s is unavailable',async key=>{
 delete process.env[key];const response=await GET(request());
 expect(response.status).toBe(409);expect(response.headers.get('location')).toBeNull();
 expect(mockDb.opsFor('seed_sales_team_booking_v1')).toHaveLength(0);
 expect(mockDb.ops.some(op=>['posts','next_booking_target','closers'].includes(op.table))).toBe(false);
});
test.each(['https://calendly.com/new-closer/call','https://cal.com/new-closer/call'])('a reused assignment cannot expose unsupported replacement %s',async raw=>{
 destination=raw;const response=await GET(request());
 expect(response.status).toBe(409);expect(response.headers.get('location')).toBeNull();
 expect(await response.text()).not.toContain(raw);
 expect(mockDb.opsFor('seed_sales_team_booking_v1')).toHaveLength(1);
 expect(mockDb.ops.some(op=>['posts','next_booking_target','closers'].includes(op.table))).toBe(false);
});
test("an enrolled team never falls through on revoked auth, disabled sales or rejected attribution",async()=>{
 (mockDb.auth.getUser as jest.Mock).mockResolvedValueOnce({data:{user:null},error:Error("revoked")});expect((await GET(request())).status).toBe(401);expect(mockCookie).not.toHaveBeenCalled();
 delete process.env.CREATOR_SALES_TEAM_READY;expect((await GET(request())).status).toBe(409);
 process.env.CREATOR_SALES_TEAM_READY="true";sqlError=Error("BOOKING_SOURCE_MISMATCH");expect((await GET(request(attribution))).status).toBe(409);
 expect(mockDb.ops.some(op=>["posts","next_booking_target","closers"].includes(op.table))).toBe(false);
});
test("malformed attribution fails before routing SQL; non-enrolled creators retain their explicit destination",async()=>{
 expect((await GET(request("forged"))).status).toBe(400);
 expect(mockDb.opsFor("seed_sales_team_booking_v1")).toHaveLength(0);
 enabled=false;const response=await GET(request());expect(response.status).toBe(302);expect(response.headers.get("location")).toBe("https://calendar.example/unbound");
});
test("verified zero checkout completion uses its original buyer and attribution source",async()=>{
 const session={mode:"payment",status:"complete",payment_status:"no_payment_required",amount_total:0,currency:"usd",payment_intent:null,subscription:null,
  metadata:{kind:"free_booking_v1",buyer_id:buyer,creator_id:creator,post_id:post,free_booking_id:booked}} as unknown as Stripe.Checkout.Session;
 expect((await routeCompletedTeamBooking(mockDb as unknown as SupabaseClient,session,attribution))?.booking_id).toBe(booked);
 expect(mockDb.opsFor("seed_sales_team_booking_v1")[0].payload).toMatchObject({p_buyer_id:buyer,p_source_kind:"attribution",p_source_id:attribution});
 expect(await routeCompletedTeamBooking(mockDb as unknown as SupabaseClient,{...session,amount_total:1},attribution)).toBeNull();
 expect(mockDb.opsFor("seed_sales_team_booking_v1")).toHaveLength(1);
});
test('verified completed setup remains recoverable against its original identity when its assigned provider is unsupported',async()=>{
 destination='https://calendly.com/new-closer/call';
 const session={id:'seti-original',mode:'setup',status:'complete',metadata:{kind:'booking',buyer_user_id:buyer,creator_id:creator,post_id:post}} as unknown as Stripe.Checkout.Session;
 await expect(routeCompletedTeamBooking(mockDb as unknown as SupabaseClient,session,attribution)).rejects.toThrow('calendar');
 expect(mockDb.opsFor('seed_sales_team_booking_v1')[0].payload).toMatchObject({p_buyer_id:buyer,p_source_kind:'attribution',p_source_id:attribution});
});
test.each([{creator_id:creator,post_id:post},{creatorId:creator,postId:post},{post_id:post},{postId:post}])('historical setup ownership is verified before enrolled hold or non-enrolled legacy recovery: %p',async metadata=>{
 const session={id:'cs_original_legacy',mode:'setup',status:'complete',metadata:{...metadata,buyer_id:buyer}} as unknown as Stripe.Checkout.Session;
 await expect(routeCompletedTeamBooking(mockDb as unknown as SupabaseClient,session,null)).rejects.toThrow('original booking setup needs review');
 expect(mockDb.opsFor('seed_sales_team_booking_v1')).toHaveLength(0);
 enabled=false;expect(await routeCompletedTeamBooking(mockDb as unknown as SupabaseClient,session,null)).toBeNull();
});
test('a historical setup with conflicting supplied and actual creator never falls through to a raw destination',async()=>{
 enabled=false;
 const session={mode:'setup',status:'complete',metadata:{creator_id:buyer,post_id:post,buyer_id:buyer}} as unknown as Stripe.Checkout.Session;
 await expect(routeCompletedTeamBooking(mockDb as unknown as SupabaseClient,session,null)).rejects.toThrow('original booking setup needs review');
 expect(mockDb.opsFor('sales_team_creator_settings_v1')).toHaveLength(0);expect(mockDb.opsFor('seed_sales_team_booking_v1')).toHaveLength(0);
});
