import {NextRequest} from "next/server";
const user=jest.fn(),rpc=jest.fn();
jest.mock("@/lib/supabaseConnectAuth",()=>({getAuthenticatedUser:()=>user()}));
jest.mock("@/lib/supabaseAdmin",()=>({supabaseAdmin:{rpc:(...args:unknown[])=>rpc(...args)}}));
import {GET} from "@/app/api/scheduling/google/bookings/route";
const originalEnv={...process.env};
beforeEach(()=>{jest.clearAllMocks();process.env.GOOGLE_CALENDAR_ENABLED='true';user.mockResolvedValue({id:'signed-in-user'});rpc.mockResolvedValue({data:[],error:null});});
afterAll(()=>{process.env=originalEnv;});
const request=(query='')=>GET(new NextRequest('https://creatornet.example/api/scheduling/google/bookings'+query));
test("the dashboard actor comes from authentication, never query parameters",async()=>{
 expect((await request('?role=creator&actor=someone-else')).status).toBe(200);
 expect(rpc).toHaveBeenCalledWith('list_google_bookings_v1',{p_actor:'signed-in-user',p_role:'creator',p_before:null,p_before_id:null});
});
test("signed-out and invalid pagination requests cannot read the booking table",async()=>{
 user.mockResolvedValueOnce(null);expect((await request()).status).toBe(401);
 expect((await request('?role=admin')).status).toBe(400);expect((await request('?before=2026-10-01')).status).toBe(400);expect(rpc).not.toHaveBeenCalled();
});
test("the extra fetched row supplies a cursor without being duplicated in the page",async()=>{
 const rows=Array.from({length:21},(_,i)=>({id:String(i),created_at:'2026-10-01T00:00:00Z'}));rpc.mockResolvedValue({data:rows,error:null});
 const body=await(await request()).json();expect(body.bookings).toHaveLength(20);expect(body.next).toEqual({before:rows[19].created_at,before_id:rows[19].id});
});
