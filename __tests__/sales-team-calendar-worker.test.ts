import {createMockClient,type MockClient} from './__mocks__/supabaseQueryMock';
let db:MockClient;const run=jest.fn(),token=jest.fn(),rpc=jest.fn();
jest.mock('@/lib/supabaseAdmin',()=>({get supabaseAdmin(){return db;}}));
jest.mock('@/lib/googleCalendarConnection',()=>({googleConnectionAccessToken:(...a:unknown[])=>token(...a),refreshRejectedGoogleAccessToken:jest.fn()}));
jest.mock('@/lib/googleBookingProcessor',()=>({processGoogleBookingOperation:(...a:unknown[])=>run(...a)}));
import {processNextGoogleBookingJob} from '@/lib/googleBookingJobs';
const id=(n:number)=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
const jobId=id(1),reservationId=id(2),connection=id(3),buyer=id(4),post=id(5),owner=id(6),booking=id(7);
const env={...process.env};let recover=false,missing=false,action='reschedule';
beforeEach(()=>{
 process.env={...env,CREATOR_SALES_TEAM_SCHEMA_READY:'false',CREATOR_TEAM_CALENDAR_SCHEMA_READY:'false',CREATOR_TEAM_CALENDAR_READY:'false'};
 recover=false;missing=false;action='reschedule';token.mockReset().mockResolvedValue('token');run.mockReset().mockImplementation(async(job,ports)=>{await ports.loadReservation(reservationId);await ports.beginMutation(job);});
 rpc.mockReset().mockImplementation(async(name:string)=>{
  if(name==='claim_google_booking_job_v1')return {data:[{id:jobId,reservation_id:reservationId,revision:1,action,lease_until:'2100-01-01T00:00:00Z',attempts:1}],error:null};
  if(name==='read_team_calendar_reservation_v1')return {data:missing?null:{bookingId:booking,connectionId:connection,postId:post,calendarOwnerId:owner,assignmentChanged:true,canReschedule:false,rebookingUrl:null},error:null};
  if(name==='recover_unsent_team_calendar_job_v1')return {data:recover,error:null};
  if(name==='begin_google_booking_mutation_v1')return {data:null,error:null};
  throw new Error('Unexpected RPC '+name);
 });
 db=createMockClient(op=>({data:op.table==='google_booking_reservations_v1'?{id:reservationId,team_calendar_binding_id:reservationId,connection_id:connection,buyer_id:buyer,original_post_id:post,status:'rescheduling',revision:1}:
 op.table==='scheduling_connections_v1'?{creator_id:owner,status:'connected'}:op.table==='google_booking_settings_v1'?{title:'Call',availability:{},conflict_calendar_ids:[]}:null,error:null}));db.rpc=rpc;
 const from=db.from;db.from=table=>{const value=from(table);return {...value,update:(payload:unknown)=>{
  const chain=value.update(payload);chain.gt=(column:string,expected:unknown)=>chain.filter(column,'gt',expected);return chain;
 }};};
});
afterEach(()=>{process.env={...env};});
test('persisted unsent team work is recovered before credentials or provider I/O even with schema flags off',async()=>{
 recover=true;expect(await processNextGoogleBookingJob()).toEqual({processed:true});expect(token).not.toHaveBeenCalled();
 expect(rpc).toHaveBeenCalledWith('read_team_calendar_reservation_v1',{p_id:reservationId,p_buyer:buyer});
 expect(rpc).toHaveBeenCalledWith('recover_unsent_team_calendar_job_v1',expect.objectContaining({p_job:jobId,p_new_work_enabled:false}));
 expect(rpc.mock.calls.some(([name])=>name==='begin_google_booking_mutation_v1')).toBe(false);
});
test('a missing immutable binding cannot reach credentials or mutations',async()=>{
 missing=true;expect(await processNextGoogleBookingJob()).toEqual({processed:true,retry:true});expect(token).not.toHaveBeenCalled();
 expect(db.opsFor('google_booking_jobs_v1').find(op=>op.kind==='update')?.payload).toMatchObject({status:'retry'});
});
test('possibly delivered team work retains reconciliation while shutdown prevents another reschedule mutation',async()=>{
 expect(await processNextGoogleBookingJob()).toEqual({processed:true,retry:true});expect(token).toHaveBeenCalledWith(connection);
 expect(rpc.mock.calls.some(([name])=>name==='begin_google_booking_mutation_v1')).toBe(false);
});
test('original buyer cancellation can reach final database admission while new-work flags are closed',async()=>{
 action='cancel';expect(await processNextGoogleBookingJob()).toEqual({processed:true});
 expect(rpc).toHaveBeenCalledWith('begin_google_booking_mutation_v1',expect.objectContaining({p_job:jobId}));
});
