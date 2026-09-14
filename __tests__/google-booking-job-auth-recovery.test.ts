const refresh=jest.fn(),processOperation=jest.fn(),updates:Record<string,unknown>[]=[];
jest.mock('server-only',()=>({}));
jest.mock('@/lib/googleCalendarConnection',()=>({googleConnectionAccessToken:async()=> 'rejected-token',refreshRejectedGoogleAccessToken:(...args:unknown[])=>refresh(...args)}));
jest.mock('@/lib/googleBookingProcessor',()=>({processGoogleBookingOperation:(...args:unknown[])=>processOperation(...args)}));
jest.mock('@/lib/googleBookingAccess',()=>({authorizeGoogleBooking:jest.fn()}));
jest.mock('@/lib/googleCalendarProvider',()=>({GoogleCalendarError:class extends Error{status:number;constructor(status:number){super('calendar error');this.status=status;}get requiresReconnect(){return this.status===401;}}}));
jest.mock('@/lib/supabaseAdmin',()=>({supabaseAdmin:{rpc:async()=>({data:[{id:'job',reservation_id:'reservation',revision:1,action:'reschedule',lease_until:'2100-01-01T00:00:00Z',attempts:1}],error:null}),from:(table:string)=>{
 const data=table==='google_booking_reservations_v1'?{id:'reservation',connection_id:'connection',buyer_id:'buyer',revision:1,status:'rescheduling'}:table==='scheduling_connections_v1'?{creator_id:'creator',status:'connected'}:{title:'Call',availability:{},conflict_calendar_ids:[]};
 const q:any={then:(resolve:any)=>Promise.resolve({data,error:null}).then(resolve),single:async()=>({data,error:null}),update:(values:Record<string,unknown>)=>{updates.push(values);return q;}};for(const key of ['select','eq','gt'])q[key]=()=>q;return q;
}}}));
import {processNextGoogleBookingJob} from '@/lib/googleBookingJobs';
import {GoogleCalendarError} from '@/lib/googleCalendarProvider';
beforeEach(()=>{updates.length=0;jest.clearAllMocks();refresh.mockResolvedValue(undefined);processOperation.mockImplementation(async(_job:any,ports:any)=>{await ports.loadReservation('reservation');throw new (GoogleCalendarError as any)(401);});});
test('a rejected Google token triggers guarded refresh and keeps the operation queued for reconciliation',async()=>{expect(await processNextGoogleBookingJob()).toEqual({processed:true,retry:true});expect(refresh).toHaveBeenCalledWith('connection','rejected-token');expect(updates).toHaveLength(1);expect(updates[0]).toMatchObject({status:'retry',last_error_code:'google_booking_reconciliation_required'});});
test('a revoked grant or transient provider error never releases the reserved booking',async()=>{refresh.mockRejectedValueOnce(new Error('reconnect required'));await processNextGoogleBookingJob();expect(updates[0].status).toBe('retry');refresh.mockClear();processOperation.mockImplementationOnce(async()=>{throw new (GoogleCalendarError as any)(503);});await processNextGoogleBookingJob();expect(refresh).not.toHaveBeenCalled();expect(updates.every(value=>value.status==='retry')).toBe(true);});
