const rpc=jest.fn(),from=jest.fn(),getEvent=jest.fn(),token=jest.fn(),refresh=jest.fn();
jest.mock('server-only',()=>({}));
jest.mock('@/lib/supabaseAdmin',()=>({supabaseAdmin:{rpc:(...a:unknown[])=>rpc(...a),from:(...a:unknown[])=>from(...a)}}));
jest.mock('@/lib/googleCalendarConnection',()=>({googleConnectionAccessToken:(...a:unknown[])=>token(...a),refreshGoogleCalendarConnection:jest.fn(),refreshRejectedGoogleAccessToken:(...a:unknown[])=>refresh(...a)}));
jest.mock('@/lib/googleCalendarProvider',()=>({googleBookingEventId:(id:string)=>'event-'+id,getGoogleBookingEvent:(...a:unknown[])=>getEvent(...a),stopGoogleCalendarWatch:jest.fn(),GoogleCalendarError:class extends Error{status:number;constructor(status:number){super('provider error');this.status=status;}}}));
import {processGoogleCalendarSweep} from '@/lib/googleCalendarReconciliation';
import {GoogleCalendarError} from '@/lib/googleCalendarProvider';
const row={id:'booking',revision:2,event_id:'event-booking',attribution_id:'attribution'};
let rows:typeof row[],release:jest.Mock;
function query(data:unknown){const q:any={then:(resolve:any)=>Promise.resolve({data,error:null}).then(resolve)};for(const name of ['select','eq','in','order','limit','gt'])q[name]=jest.fn(()=>q);q.single=jest.fn(async()=>({data,error:null}));q.update=release;return q;}
beforeEach(()=>{jest.clearAllMocks();rows=[row];release=jest.fn(()=>query(null));from.mockImplementation((table:string)=>query(table==='scheduling_connections_v1'?{creator_id:'creator'}:table==='google_booking_reservations_v1'?rows:null));rpc.mockImplementation(async(name:string)=>({data:name==='claim_google_calendar_sweep_v1'?[{id:'watch',connection_id:'connection',calendar_id:'calendar'}]:true,error:null}));token.mockResolvedValue('token');getEvent.mockResolvedValue({status:'confirmed',etag:'etag',start:{dateTime:'2026-10-01T10:00:00Z'},end:{dateTime:'2026-10-01T10:30:00Z'},extendedProperties:{private:{cn_creator_id:'creator',cn_attribution:'attribution'}}});});
test('authoritative events reconcile under the claimed worker and finish the page',async()=>{expect(await processGoogleCalendarSweep()).toEqual({processed:true,count:1});const worker=rpc.mock.calls[0][1].p_worker;expect(rpc).toHaveBeenCalledWith('reconcile_google_calendar_booking_v1',expect.objectContaining({p_watch:'watch',p_worker:worker,p_revision:2,p_canceled:false}));expect(rpc).toHaveBeenCalledWith('finish_google_calendar_sweep_v1',expect.objectContaining({p_cursor:null}));});
test('deleted events retract confirmation while transient errors preserve cursor for retry',async()=>{getEvent.mockRejectedValueOnce(Object.assign(new Error('gone'),{status:404}));await expect(processGoogleCalendarSweep()).rejects.toThrow('retry');expect(rpc.mock.calls.some(([name])=>name==='finish_google_calendar_sweep_v1')).toBe(false);jest.clearAllMocks();getEvent.mockRejectedValueOnce(new (GoogleCalendarError as any)(404));await processGoogleCalendarSweep();expect(rpc).toHaveBeenCalledWith('reconcile_google_calendar_booking_v1',expect.objectContaining({p_canceled:true,p_etag:null}));});
test('attribution mismatch does not advance the sweep',async()=>{getEvent.mockResolvedValue({status:'confirmed',extendedProperties:{private:{cn_creator_id:'different'}}});await expect(processGoogleCalendarSweep()).rejects.toThrow('retry');expect(rpc.mock.calls.map(([name])=>name)).toEqual(['claim_google_calendar_sweep_v1']);expect(release).toHaveBeenCalledWith({lease_id:null,lease_until:null});});
test('pages process only ten bookings and save the last processed cursor',async()=>{rows=Array.from({length:11},(_,i)=>({...row,id:String(i),event_id:'event-'+i}));await processGoogleCalendarSweep();expect(getEvent).toHaveBeenCalledTimes(10);expect(rpc).toHaveBeenCalledWith('finish_google_calendar_sweep_v1',expect.objectContaining({p_cursor:'9'}));});

test('parallel authorization failures refresh once and preserve the sweep cursor and confirmations',async()=>{
 rows=Array.from({length:5},(_,i)=>({...row,id:String(i),event_id:'event-'+i}));
 getEvent.mockRejectedValue(new GoogleCalendarError(401));
 await expect(processGoogleCalendarSweep()).rejects.toThrow('retry');
 expect(refresh).toHaveBeenCalledTimes(1);expect(refresh).toHaveBeenCalledWith('connection','token');
 expect(rpc.mock.calls.map(([name])=>name)).toEqual(['claim_google_calendar_sweep_v1']);
 expect(release).toHaveBeenCalledWith({lease_id:null,lease_until:null});
});
