import {NextRequest} from 'next/server';
const auth=jest.fn(),options=jest.fn(),submit=jest.fn(),allow=jest.fn();
jest.mock('@/lib/supabaseConnectAuth',()=>({getAuthenticatedUser:(...args:unknown[])=>auth(...args)}));
jest.mock('@/lib/googleBuyerBookings',()=>({getGoogleBookingOptions:(...args:unknown[])=>options(...args),submitGoogleBooking:(...args:unknown[])=>submit(...args)}));
jest.mock('@/lib/rateLimit',()=>({allowRequest:(...args:unknown[])=>allow(...args)}));
jest.mock('@/lib/schedulingConfig',()=>({googleCalendarAvailable:()=>true,schedulingOrigin:()=> 'https://creatornet.example'}));
import {GET,POST} from '@/app/api/scheduling/google/book/[connection]/route';
import {TeamCalendarAppointmentPending} from '@/lib/salesTeams/calendar';
const origin='https://creatornet.example',url=origin+'/api/scheduling/google/book/connection',ctx={params:Promise.resolve({connection:'connection'})};
beforeEach(()=>{jest.clearAllMocks();auth.mockResolvedValue({id:'buyer'});allow.mockReturnValue(true);options.mockResolvedValue({slots:[],reservation:null});submit.mockResolvedValue({id:'reservation',status:'creating'});});
test('authenticated GET and POST carry exact team intent with no-store responses',async()=>{
 const response=await GET(new NextRequest(url+'?team_booking_id=booking'),ctx);
 expect(options).toHaveBeenCalledWith('connection','buyer',expect.objectContaining({teamBookingId:'booking'}),expect.anything());expect(response.headers.get('cache-control')).toBe('private, no-store');
 const result=await POST(new NextRequest(url,{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({teamBookingId:'booking',start:'start',end:'end'})}),ctx);
 expect(result.status).toBe(202);expect(submit).toHaveBeenCalledWith('connection','buyer',expect.objectContaining({teamBookingId:'booking'}),'start','end');
});
test.each(['GET','POST'])('%s preserves the controlled original-appointment conflict',async method=>{
 const manage=origin+'/scheduling/book/connection?reservation_id=original';options.mockRejectedValue(new TeamCalendarAppointmentPending(manage));submit.mockRejectedValue(new TeamCalendarAppointmentPending(manage));
 const response=method==='GET'?await GET(new NextRequest(url),ctx):await POST(new NextRequest(url,{method:'POST',headers:{origin},body:'{}'}),ctx);
 expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:'TEAM_CALENDAR_ORIGINAL_APPOINTMENT_PENDING',manageUrl:manage});expect(response.headers.get('cache-control')).toContain('no-store');
});
test('authentication, origin and rate controls stop work before accessing appointment data',async()=>{
 auth.mockResolvedValueOnce(null);expect((await GET(new NextRequest(url),ctx)).status).toBe(401);
 expect((await POST(new NextRequest(url,{method:'POST',headers:{origin:'https://attacker.example'},body:'{}'}),ctx)).status).toBe(403);
 allow.mockReturnValue(false);expect((await GET(new NextRequest(url),ctx)).status).toBe(429);expect(options).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();
});
test('controlled conflict responses never expose changed exception-message text',async()=>{
 const pending=new TeamCalendarAppointmentPending(origin+'/scheduling/book/connection?reservation_id=original');pending.message='private provider detail';options.mockRejectedValue(pending);
 const response=await GET(new NextRequest(url),ctx);const body=await response.json();
 expect(body.error).toBe('Your earlier appointment stays with its original closer. Cancel it before booking with your new closer.');expect(JSON.stringify(body)).not.toContain('private provider detail');
});
