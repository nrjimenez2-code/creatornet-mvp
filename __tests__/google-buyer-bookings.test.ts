import {createMockClient,type MockClient} from "./__mocks__/supabaseQueryMock";
let db:MockClient, local:unknown[], reservation:Record<string,unknown>|null;
const authorize=jest.fn(),busy=jest.fn();
jest.mock("@/lib/supabaseAdmin",()=>({get supabaseAdmin(){return db;}}));
jest.mock("@/lib/googleBookingAccess",()=>({authorizeGoogleBooking:(...args:unknown[])=>authorize(...args)}));
jest.mock("@/lib/googleCalendarConnection",()=>({googleConnectionAccessToken:async()=>"token"}));
jest.mock("@/lib/googleCalendarProvider",()=>({getGoogleBusyIntervals:(...args:unknown[])=>busy(...args)}));
import {submitGoogleBooking,getGoogleBookingOptions} from "@/lib/googleBuyerBookings";
const start="2026-10-01T10:00:00.000Z",end="2026-10-01T10:30:00.000Z";
const policy={timeZone:"UTC",durationMinutes:30,stepMinutes:30,leadMinutes:0,horizonDays:30,bufferBeforeMinutes:0,bufferAfterMinutes:0,windows:[{weekday:4,startMinute:540,endMinute:1020}]};
beforeEach(()=>{
  jest.useFakeTimers().setSystemTime(new Date("2026-10-01T08:00:00Z"));jest.clearAllMocks();local=[];reservation=null;
  authorize.mockResolvedValue({connectionId:'connection',buyerId:'buyer',creatorId:'creator',postId:'video',attributionId:'attribution',purchaseId:null,reservationId:'reservation'});busy.mockResolvedValue([]);
  db=createMockClient(op=>{
    if(op.table==='google_booking_settings_v1')return {data:{calendar_id:'primary',conflict_calendar_ids:['primary'],availability:policy,title:'Call'},error:null};
    if(op.table==='google_reserved_intervals_v1')return {data:local,error:null};
    if(op.table==='google_booking_reservations_v1')return {data:reservation,error:null};
    if(op.table==='enqueue_google_booking_create_v1')reservation={id:'reservation',status:'creating',starts_at:start,ends_at:end,revision:0};
    return {data:'reservation',error:null};
  });
});
afterEach(()=>jest.useRealTimers());
test("offered slots exclude both Google busy time and local holds",async()=>{
  local=[{start,end}];busy.mockResolvedValue([{start:"2026-10-01T10:30:00Z",end:"2026-10-01T11:00:00Z"}]);
  const result=await getGoogleBookingOptions('connection','buyer',{attributionId:'attribution'},{start,end:"2026-10-01T11:30:00Z"});
  expect(result.slots).toEqual([{start:"2026-10-01T11:00:00.000Z",end:"2026-10-01T11:30:00.000Z"}]);
});
test("a busy slot or out-of-hours time cannot reach reservation admission",async()=>{
  busy.mockResolvedValue([{start,end}]);await expect(submitGoogleBooking('connection','buyer',{attributionId:'attribution'},start,end)).rejects.toThrow(/no longer available/);
  expect(db.opsFor('reserve_google_booking_checked_v1')).toHaveLength(0);
  busy.mockResolvedValue([]);await expect(submitGoogleBooking('connection','buyer',{attributionId:'attribution'},'2026-10-01T19:00:00Z','2026-10-01T19:30:00Z')).rejects.toThrow(/no longer available/);
});
test("reservation admission binds the verified source and policy snapshot before queueing",async()=>{
  expect(await submitGoogleBooking('connection','buyer',{attributionId:'attribution'},start,end)).toMatchObject({status:'creating'});
  expect(db.opsFor('reserve_google_booking_checked_v1')[0].payload).toMatchObject({p_buyer:'buyer',p_post:'video',p_attribution:'attribution',p_calendar:'primary',p_policy:policy});
  expect(db.opsFor('enqueue_google_booking_create_v1')[0].payload).toEqual({p_id:'reservation',p_buyer:'buyer'});
});
test("repeating an accepted booking does not enqueue a second mutation",async()=>{
  reservation={id:'reservation',status:'creating',starts_at:start,ends_at:end,revision:0};
  await submitGoogleBooking('connection','buyer',{attributionId:'attribution'},start,end);
  expect(db.opsFor('enqueue_google_booking_create_v1')).toHaveLength(0);expect(busy).not.toHaveBeenCalled();
});
