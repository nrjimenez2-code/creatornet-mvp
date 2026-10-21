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
const env={...process.env};let enabled=true,sqlError:unknown=null;
const request=(token?:string)=>new NextRequest(`https://fixture.vercel.app/api/book?creator_id=${creator}&post_id=${post}${token?`&cn_attribution=${token}`:""}`,
 {headers:{authorization:"Bearer verified"}});
beforeEach(()=>{
 jest.clearAllMocks();enabled=true;sqlError=null;process.env.CREATOR_SALES_TEAM_SCHEMA_READY="true";process.env.CREATOR_SALES_TEAM_READY="true";
 mockDb=createMockClient(op=>{
  if(op.table==="sales_team_creator_settings_v1")return {data:{routing_enabled:enabled},error:null};
  if(op.table==="seed_sales_team_booking_v1")return {data:{booking_id:booked,booking_url:"https://calendar.example/assigned",assignment:{membership_id:booked,source:"weighted"},scheduling_status:"awaiting_confirmation",lead_reused:true},error:sqlError};
  if(op.table==="posts")return {data:{booking_url:"https://calendar.example/unbound"},error:null};
 });
 mockDb.auth.getUser=jest.fn(async()=>({data:{user:{id:buyer}},error:null}));mockCookie.mockResolvedValue({data:{user:{id:buyer}},error:null});
});
afterEach(()=>{process.env={...env};});

test("the selected durable calendar precedes explicit and legacy destinations",async()=>{
 const response=await GET(request());expect(response.status).toBe(302);expect(response.headers.get("location")).toBe("https://calendar.example/assigned");
 expect(response.headers.get("cache-control")).toContain("no-store");
 expect(mockDb.ops.map(op=>op.table)).toEqual(["sales_team_creator_settings_v1","seed_sales_team_booking_v1"]);
 expect(mockDb.ops[1].payload).toEqual({p_creator_id:creator,p_buyer_id:buyer,p_post_id:post,p_source_kind:"lead",p_source_id:null});
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
