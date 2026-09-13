import {createMockClient,type MockClient} from "./__mocks__/supabaseQueryMock";
let db:MockClient;
const readPaid=jest.fn(),verifyPaid=jest.fn();
jest.mock("@/lib/supabaseAdmin",()=>({get supabaseAdmin(){return db;}}));
jest.mock("@/lib/paidCalls",()=>({paidCallsReady:()=>true,readPaidCallAccess:(...args:unknown[])=>readPaid(...args),verifyPaidCallCapture:(...args:unknown[])=>verifyPaid(...args)}));
jest.mock("@/lib/stripeClient",()=>({getStripe:()=>({})}));
import {authorizeGoogleBooking} from "@/lib/googleBookingAccess";
import {googleBookingConnectionFromUrl} from "@/lib/googleBookingUrl";
const connection="11111111-1111-4111-8111-111111111111",post="22222222-2222-4222-8222-222222222222",attribution="33333333-3333-4333-8333-333333333333",purchase="44444444-4444-4444-8444-444444444444";
const origin="https://creatornet.example";
const url=origin+"/scheduling/book/"+connection;
const originalEnv={...process.env};
const paid=()=>({purchase_id:purchase,buyer_id:"buyer",creator_id:"creator",scheduling_url:url});
beforeEach(()=>{
  jest.clearAllMocks();Object.assign(process.env,{GOOGLE_CALENDAR_ENABLED:"true",GOOGLE_CALENDAR_CLIENT_ID:"id",GOOGLE_CALENDAR_CLIENT_SECRET:"secret",SCHEDULING_OAUTH_ORIGIN:origin,SCHEDULING_TOKEN_ENCRYPTION_KEY:"ab".repeat(32)});
  readPaid.mockResolvedValue(paid());verifyPaid.mockResolvedValue(true);
  db=createMockClient(op=>{
    if(op.table==='scheduling_connections_v1')return {data:{creator_id:'creator',status:'connected'},error:null};
    if(op.table==='discover_booking_attribution_v1'&&op.kind==='select')return {data:op.filters.user_id&&op.filters.user_id!=='buyer'?null:{id:attribution,user_id:'buyer',creator_id:'creator',post_id:post,setup_session_id:'cs_verified'},error:null};
    if(op.table==='posts')return {data:{creator_id:'creator',booking_url:url,allow_booking:true,active:true,hidden_at:null,removed_at:null},error:null};
    if(op.table==='purchases')return {data:{post_id:post},error:null};
    return {data:null,error:null};
  });
  const from=db.from;db.from=table=>({...from(table),upsert:(payload:unknown)=>from(table).insert(payload)});
});
afterAll(()=>{process.env=originalEnv;});
test("verified sales-call setup retains buyer, creator and source with a stable reservation ID",async()=>{
  const first=await authorizeGoogleBooking(connection,'buyer',{attributionId:attribution});
  expect(first).toMatchObject({creatorId:'creator',buyerId:'buyer',postId:post,attributionId:attribution,purchaseId:null});
  expect((await authorizeGoogleBooking(connection,'buyer',{attributionId:attribution})).reservationId).toBe(first.reservationId);
  expect(db.opsFor('discover_booking_attribution_v1')[0].filters).toEqual({id:attribution,user_id:'buyer',creator_id:'creator'});
  expect(db.ops.some(op=>op.kind==='insert')).toBe(false);
});
test("another buyer and requests without a verified intent cannot access booking times",async()=>{
  await expect(authorizeGoogleBooking(connection,'other',{attributionId:attribution})).rejects.toThrow(/Complete booking setup/);
  await expect(authorizeGoogleBooking(connection,'buyer',{})).rejects.toThrow(/booking or purchase/);
  await expect(authorizeGoogleBooking(connection,'buyer',{attributionId:attribution,purchaseId:purchase})).rejects.toThrow(/booking or purchase/);
});
test("paid booking requires eligible current capture and preserves the original purchase video",async()=>{
  expect(await authorizeGoogleBooking(connection,'buyer',{purchaseId:purchase})).toMatchObject({postId:post,purchaseId:purchase,attributionId:attribution});
  expect(readPaid).toHaveBeenCalledTimes(2);expect(verifyPaid).toHaveBeenCalledTimes(1);
  expect(db.opsFor('discover_booking_attribution_v1').find(op=>op.kind==='insert')?.payload).toMatchObject({setup_session_id:'paid-call:'+purchase,post_id:post,user_id:'buyer',creator_id:'creator'});
  expect(db.opsFor('discover_events_v1')).toHaveLength(0);
});
test("a paid destination bound to another calendar or an unconfirmed capture cannot create an intent",async()=>{
  readPaid.mockResolvedValueOnce({...paid(),scheduling_url:'https://attacker.example/scheduling/book/'+connection});
  await expect(authorizeGoogleBooking(connection,'buyer',{purchaseId:purchase})).rejects.toThrow(/eligible payment/);
  verifyPaid.mockResolvedValue(false);await expect(authorizeGoogleBooking(connection,'buyer',{purchaseId:purchase})).rejects.toThrow(/eligible payment/);
  expect(db.opsFor('discover_booking_attribution_v1')).toHaveLength(0);
});
test("purchase revocation during provider checks wins before intent creation",async()=>{
  readPaid.mockResolvedValueOnce(paid()).mockResolvedValueOnce(null);
  await expect(authorizeGoogleBooking(connection,'buyer',{purchaseId:purchase})).rejects.toThrow(/access changed/);
  expect(db.opsFor('discover_booking_attribution_v1')).toHaveLength(0);
});
test("native booking URL recognition is bound to the expected origin and route",()=>{
  expect(googleBookingConnectionFromUrl('/scheduling/book/'+connection,origin)).toBe(connection);
  for(const raw of ['https://attacker.example/scheduling/book/'+connection,'https://user:pass@creatornet.example/scheduling/book/'+connection,origin+'/scheduling/book/not-a-uuid'])
    expect(googleBookingConnectionFromUrl(raw,origin)).toBeNull();
});
