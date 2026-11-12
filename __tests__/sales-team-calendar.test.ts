import {createMockClient,type MockClient} from './__mocks__/supabaseQueryMock';
import type {SupabaseClient} from '@supabase/supabase-js';
let db:MockClient;let reservation:Record<string,unknown>|null;const rpc=jest.fn();
jest.mock('@/lib/supabaseAdmin',()=>({get supabaseAdmin(){return db;}}));
import {readTeamCalendarReservation,readTeamGoogleContext,teamNativeBookingUrl,TeamCalendarAppointmentPending} from '@/lib/salesTeams/calendar';
import {authorizeGoogleBooking} from '@/lib/googleBookingAccess';
import {readGoogleBuyerReservation,cancelGoogleBuyerBooking,getGoogleRescheduleOptions} from '@/lib/googleBuyerBookings';
const id=(n:number)=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
const booking=id(1),buyer=id(2),connection=id(3),post=id(4),owner=id(5),reservationId=id(6),membership=id(7),target=id(8);
const origin='https://creatornet.example';const env={...process.env};
const team=()=>({bookingId:booking,connectionId:connection,postId:post,calendarOwnerId:owner,assignmentChanged:false,canReschedule:true,rebookingUrl:null});
const context=()=>({bookingId:booking,creatorId:id(9),buyerId:buyer,postId:post,sourceIdentity:'canonical-source',assignmentRevision:1,membershipId:membership,targetId:target,
 connectionId:connection,calendarOwnerId:owner,accountId:'account',calendarId:'primary',destinationUrl:origin+'/scheduling/book/'+connection,origin,generation:1,reservationId});
const admin=()=>db as unknown as SupabaseClient;
beforeEach(()=>{
 process.env={...env,CREATOR_SALES_TEAM_SCHEMA_READY:'true',CREATOR_SALES_TEAM_READY:'true',CREATOR_TEAM_CALENDAR_SCHEMA_READY:'true',CREATOR_TEAM_CALENDAR_READY:'true',
 SCHEDULING_OAUTH_ORIGIN:origin,GOOGLE_CALENDAR_ENABLED:'true',GOOGLE_CALENDAR_CLIENT_ID:'id',GOOGLE_CALENDAR_CLIENT_SECRET:'synthetic',SCHEDULING_TOKEN_ENCRYPTION_KEY:'ab'.repeat(32)};
 reservation=null;rpc.mockReset().mockImplementation(async(name:string)=>({data:name==='read_team_google_booking_v1'?context():team(),error:null}));
 db=createMockClient(op=>({data:op.table==='google_booking_reservations_v1'?reservation:null,error:null}));db.rpc=rpc;
});
afterEach(()=>{process.env={...env};});
test('team authorization preserves calendar-owner identity and never invents legacy financial attribution',async()=>{
 expect(await authorizeGoogleBooking(connection,buyer,{teamBookingId:booking})).toMatchObject({creatorId:owner,postId:post,attributionId:null,purchaseId:null,reservationId,teamBookingId:booking});
 expect(db.ops).toEqual([]);expect(rpc).toHaveBeenCalledWith('read_team_google_booking_v1',expect.objectContaining({p_booking:booking,p_buyer:buyer,p_connection:connection}));
});
test.each(['buyerId','connectionId','bookingId'])('an RPC context with mismatched %s fails closed',async key=>{
 rpc.mockResolvedValue({data:{...context(),[key]:id(99)},error:null});
 await expect(readTeamGoogleContext(admin(),booking,buyer,connection)).rejects.toThrow('appointment needs review');
});
test('original appointment conflict contains only a controlled management URL',async()=>{
 rpc.mockResolvedValue({data:{blockedBy:{connectionId:connection,reservationId}},error:null});
 await expect(readTeamGoogleContext(admin(),booking,buyer,connection)).rejects.toMatchObject({code:'TEAM_CALENDAR_ORIGINAL_APPOINTMENT_PENDING',manageUrl:origin+'/scheduling/book/'+connection+'?reservation_id='+reservationId});
 expect(new TeamCalendarAppointmentPending('unused')).toBeInstanceOf(Error);
});
test('team routing fails closed without native scheduling configuration',()=>{
 delete process.env.SCHEDULING_OAUTH_ORIGIN;
 expect(()=>teamNativeBookingUrl('https://calendly.com/closer/call',booking)).toThrow('calendar');
});
test.each(['https://calendly.com/closer/call','https://cal.com/closer/call',origin+'/scheduling/book/'+connection+'?cn_attribution=old',origin+'/scheduling/book/'+connection+'#slot',origin+'/scheduling/book/../book/'+connection])('unsupported or noncanonical stored team destinations are held: %s',raw=>{
 expect(()=>teamNativeBookingUrl(raw,booking)).toThrow('calendar');
});
test('native URLs contain only the canonical team intent and accept an exact relative destination',()=>{
 for(const raw of [origin+'/scheduling/book/'+connection,'/scheduling/book/'+connection])
  expect(teamNativeBookingUrl(raw,booking)).toBe(origin+'/scheduling/book/'+connection+'?team_booking_id='+booking);
});
test.each(['CREATOR_TEAM_CALENDAR_READY','CREATOR_TEAM_CALENDAR_SCHEMA_READY','GOOGLE_CALENDAR_ENABLED'])('team URL issuance stops when %s is disabled',key=>{
 process.env[key]='false';
 expect(()=>teamNativeBookingUrl(origin+'/scheduling/book/'+connection,booking)).toThrow('calendar');
});
test('new-work shutdown suppresses reschedule and rebooking without suppressing original identity reads',async()=>{
 process.env.CREATOR_TEAM_CALENDAR_READY='false';rpc.mockResolvedValue({data:{...team(),rebookingUrl:origin+'/scheduling/book/'+connection+'?team_booking_id='+booking},error:null});
 delete process.env.SCHEDULING_OAUTH_ORIGIN;
 expect(await readTeamCalendarReservation(admin(),reservationId,buyer)).toMatchObject({canReschedule:false,rebookingUrl:null});
});
test('schema-off legacy reads avoid new RPCs while persisted team obligations require an identity read',async()=>{
 process.env.CREATOR_TEAM_CALENDAR_SCHEMA_READY='false';
 expect(await readTeamCalendarReservation(admin(),reservationId,buyer)).toBeNull();expect(rpc).not.toHaveBeenCalled();
 expect(await readTeamCalendarReservation(admin(),reservationId,buyer,true)).toMatchObject({canReschedule:false});
});
test('persisted team status, saved access and buyer cancellation survive both readiness flags off',async()=>{
 process.env.CREATOR_TEAM_CALENDAR_SCHEMA_READY='false';process.env.CREATOR_TEAM_CALENDAR_READY='false';
 reservation={id:reservationId,team_calendar_binding_id:reservationId,connection_id:connection,original_post_id:post,attribution_id:null,purchase_id:null,status:'confirmed',revision:0,starts_at:'2026-12-01T10:00:00Z',ends_at:'2026-12-01T10:30:00Z'};
 expect(await readGoogleBuyerReservation(reservationId,buyer)).toMatchObject({status:'confirmed',canReschedule:false});
 expect(await authorizeGoogleBooking(connection,buyer,{reservationId})).toMatchObject({creatorId:owner,reservationId,attributionId:null,purchaseId:null});
 await cancelGoogleBuyerBooking(reservationId,buyer,0);
 expect(rpc).toHaveBeenCalledWith('request_google_booking_change_v1',{p_id:reservationId,p_buyer:buyer,p_revision:0,p_action:'cancel'});
 await expect(getGoogleRescheduleOptions(reservationId,buyer,{start:'2026-12-01T11:00:00Z',end:'2026-12-01T11:30:00Z'})).rejects.toThrow('original closer');
 expect(rpc.mock.calls.some(([name])=>name==='read_team_google_booking_v1')).toBe(false);
});
test('a persisted marker cannot silently fall through to legacy ownership when its binding is missing',async()=>{
 process.env.CREATOR_TEAM_CALENDAR_SCHEMA_READY='false';rpc.mockResolvedValue({data:null,error:null});
 reservation={id:reservationId,team_calendar_binding_id:reservationId,attribution_id:null,purchase_id:null,status:'confirmed'};
 await expect(readGoogleBuyerReservation(reservationId,buyer)).rejects.toThrow('identity changed');
 await expect(authorizeGoogleBooking(connection,buyer,{reservationId})).rejects.toThrow('attribution changed');
});
test.each([origin+'/scheduling/book/'+connection+'?team_booking_id='+id(99),'https://attacker.example/scheduling/book/'+connection+'?team_booking_id='+booking])('replacement URL identity is checked: %s',async rebookingUrl=>{
 rpc.mockResolvedValue({data:{...team(),rebookingUrl},error:null});
 await expect(readTeamCalendarReservation(admin(),reservationId,buyer)).rejects.toThrow('appointment needs review');
});
