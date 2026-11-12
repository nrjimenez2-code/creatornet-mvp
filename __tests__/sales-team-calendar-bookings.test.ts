import {NextRequest} from 'next/server';
import {createMockClient,type MockClient} from './__mocks__/supabaseQueryMock';
let db:MockClient;
jest.mock('@supabase/supabase-js',()=>({...jest.requireActual('@supabase/supabase-js'),createClient:()=>db}));
jest.mock('@/lib/supabaseClient',()=>({createServerSupabase:jest.fn()}));
jest.mock('@/lib/rateLimit',()=>({allowRequest:()=>true}));
import {readTeamBookings} from '@/lib/salesTeams/server';
const id=(n:number)=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
const creator=id(1),actor=id(2),membership=id(3),booking=id(4),buyer=id(5),post=id(6),target=id(7);
const env={...process.env};let enriched=false,reassigned=false,revoked=false,identityChanged=false;
beforeEach(()=>{
 process.env={...env,CREATOR_SALES_TEAM_SCHEMA_READY:'true',CREATOR_TEAM_CALENDAR_SCHEMA_READY:'true'};
 enriched=false;reassigned=false;revoked=false;identityChanged=false;
 db=createMockClient(op=>{
  if(op.table==='sales_team_memberships_v1')return {data:{id:membership,creator_id:creator,user_id:actor,role:'closer',status:'active'},error:null};
  if(op.table==='sales_team_assignments_v1')return {data:[{booking_id:booking,membership_id:enriched&&reassigned?id(99):membership,target_id:target,revision:enriched&&reassigned?2:1}],error:null};
  if(op.table==='bookings')return {data:[{id:booking,creator_id:creator,buyer_id:enriched&&identityChanged?id(99):buyer,post_id:post}],error:null};
  if(op.table==='posts')return {data:[{id:post,title:'Offer'}],error:null};
  if(op.table==='profiles')return {data:[{id:buyer,full_name:'Private buyer'}],error:null};
  return {data:null,error:null};
 });
 db.auth.getUser=jest.fn().mockResolvedValue({data:{user:{id:actor}},error:null});
 db.rpc=jest.fn(async(name:string)=>{
  if(name==='sales_team_actor_role_v1')return {data:enriched&&revoked?null:'closer',error:null};
  if(name==='sales_team_member_ready_v1')return {data:true,error:null};
  if(name==='read_team_booking_scheduling_v1'){enriched=true;return {data:[{bookingId:booking,buyerId:buyer,postId:post,teamManaged:true,scheduling:[{provider:'google',status:'scheduled',assignmentRevision:1,membershipId:membership,targetId:target,scheduledAt:'2026-11-08T10:00:00Z',requestedAt:null,observedAt:'2026-11-07T10:00:00Z',previousAssignment:false}]}],error:null};}
  throw new Error('Unexpected RPC '+name);
 });
});
afterEach(()=>{process.env={...env};});
const read=()=>readTeamBookings(new NextRequest('https://creatornet.example/api/sales-team/bookings?creator_id='+creator,{headers:{authorization:'Bearer synthetic'}}));
test('exact canonical scheduling is returned only to the current assigned closer',async()=>{
 const response=await read();const body=await response.json();expect(response.status).toBe(200);expect(body.bookings).toHaveLength(1);
 expect(body.bookings[0].scheduling).toEqual([expect.objectContaining({status:'scheduled',membershipId:membership,previousAssignment:false})]);
 expect(response.headers.get('cache-control')).toContain('no-store');
});
test.each(['reassignment','booking identity change'])('%s during async scheduling removes stale buyer and appointment details',async change=>{
 reassigned=change==='reassignment';identityChanged=change==='booking identity change';
 const response=await read();expect(response.status).toBe(200);expect(await response.json()).toMatchObject({bookings:[]});
});
test('role revocation during async scheduling denies the response',async()=>{
 revoked=true;expect((await read()).status).toBe(403);
});
test('schema-off listing avoids new scheduling RPCs',async()=>{
 process.env.CREATOR_TEAM_CALENDAR_SCHEMA_READY='false';const body=await (await read()).json();expect(body.bookings[0].scheduling).toEqual([]);
 expect(jest.mocked(db.rpc).mock.calls.some(([name])=>name==='read_team_booking_scheduling_v1')).toBe(false);
});
