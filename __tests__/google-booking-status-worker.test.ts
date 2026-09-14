import {NextRequest} from "next/server";
const user=jest.fn(),read=jest.fn(),processJob=jest.fn(),available=jest.fn(),cancel=jest.fn(),maintain=jest.fn(),sweep=jest.fn();
jest.mock("@/lib/supabaseConnectAuth",()=>({getAuthenticatedUser:()=>user()}));
jest.mock("@/lib/googleBuyerBookings",()=>({readGoogleBuyerReservation:(...args:unknown[])=>read(...args),cancelGoogleBuyerBooking:(...args:unknown[])=>cancel(...args)}));
jest.mock("@/lib/googleBookingJobs",()=>({processNextGoogleBookingJob:()=>processJob()}));
jest.mock("@/lib/schedulingConfig",()=>({googleCalendarAvailable:()=>available(),schedulingOrigin:()=>"https://creatornet.example"}));
jest.mock("@/lib/googleCalendarReconciliation",()=>({maintainGoogleCalendarWatches:()=>maintain(),processGoogleCalendarSweep:()=>sweep()}));
import {GET as status,DELETE as cancelRoute} from "@/app/api/scheduling/google/reservations/[reservation]/route";
import {GET as worker} from "@/app/api/scheduling/google/jobs/route";
const id="11111111-1111-4111-8111-111111111111",secret="a".repeat(32);
const originalEnv={...process.env};
beforeEach(()=>{jest.clearAllMocks();maintain.mockResolvedValue(undefined);sweep.mockResolvedValue({processed:false});user.mockResolvedValue({id:'buyer'});read.mockResolvedValue(null);available.mockReturnValue(true);process.env.CRON_SECRET=secret;processJob.mockResolvedValue({processed:false});});
afterAll(()=>{process.env=originalEnv;});
const request=()=>new NextRequest('https://creatornet.example/api/scheduling/google/reservations/'+id);
test("status checks bind the reservation to the signed-in buyer",async()=>{
  expect((await status(request(),{params:Promise.resolve({reservation:id})})).status).toBe(404);
  expect(read).toHaveBeenCalledWith(id,'buyer');
  read.mockResolvedValue({id,status:'creating'});const response=await status(request(),{params:Promise.resolve({reservation:id})});
  expect(await response.json()).toEqual({reservation:{id,status:'creating'}});expect(response.headers.get('cache-control')).toContain('no-store');
});
test("signed-out requests cannot read booking status",async()=>{
  user.mockResolvedValue(null);expect((await status(request(),{params:Promise.resolve({reservation:id})})).status).toBe(401);expect(read).not.toHaveBeenCalled();
});
const cron=(authorization?:string)=>worker(new Request('https://creatornet.example/api/scheduling/google/jobs',{headers:authorization?{authorization}:{}}));
test("worker rejects missing, incorrect and unconfigured cron credentials",async()=>{
  expect((await cron()).status).toBe(401);expect((await cron('Bearer wrong')).status).toBe(401);delete process.env.CRON_SECRET;expect((await cron('Bearer '+secret)).status).toBe(401);expect(processJob).not.toHaveBeenCalled();
});
test("disabled Google never processes jobs and enabled worker stops at an empty queue",async()=>{
  available.mockReturnValueOnce(false);expect(await (await cron('Bearer '+secret)).json()).toEqual({processed:0,enabled:false});expect(processJob).not.toHaveBeenCalled();
  processJob.mockResolvedValueOnce({processed:true,retry:true}).mockResolvedValueOnce({processed:false});
  expect(await (await cron('Bearer '+secret)).json()).toEqual({processed:1,retries:1});expect(processJob).toHaveBeenCalledTimes(5);
});
test("worker bounds each batch even with a continuously busy queue",async()=>{
  processJob.mockResolvedValue({processed:true});expect(await (await cron('Bearer '+secret)).json()).toEqual({processed:40,retries:0});expect(processJob).toHaveBeenCalledTimes(40);
});


test("cancellation requires the same origin and uses the authenticated buyer",async()=>{
  const req=(origin:string)=>new NextRequest('https://creatornet.example/api/scheduling/google/reservations/'+id,{method:'DELETE',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({revision:2,buyerId:'forged'})});
  expect((await cancelRoute(req('https://attacker.example'),{params:Promise.resolve({reservation:id})})).status).toBe(403);
  expect(cancel).not.toHaveBeenCalled();cancel.mockResolvedValue({id,status:'canceling'});
  expect((await cancelRoute(req('https://creatornet.example'),{params:Promise.resolve({reservation:id})})).status).toBe(202);
  expect(cancel).toHaveBeenCalledWith(id,'buyer',2);
});
