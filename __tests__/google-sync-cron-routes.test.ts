const sweep=jest.fn(),maintain=jest.fn(),available=jest.fn();
jest.mock('@/lib/googleCalendarReconciliation',()=>({processGoogleCalendarSweep:()=>sweep(),maintainGoogleCalendarWatches:()=>maintain()}));
jest.mock('@/lib/schedulingConfig',()=>({googleCalendarAvailable:()=>available()}));
import {GET as sync} from '@/app/api/scheduling/google/sync/route';
import {GET as maintenance} from '@/app/api/scheduling/google/maintenance/route';
const oldSecret=process.env.CRON_SECRET,secret='a'.repeat(32);
const request=(auth=true)=>new Request('https://creatornet.example/api/scheduling/google/sync',{headers:auth?{authorization:'Bearer '+secret}:{}});
beforeEach(()=>{jest.resetAllMocks();process.env.CRON_SECRET=secret;available.mockReturnValue(true);sweep.mockResolvedValue({processed:false});maintain.mockResolvedValue(undefined);});
afterAll(()=>{if(oldSecret===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=oldSecret;});
test('both endpoints require cron authorization and honor disabled provider configuration',async()=>{
 expect((await sync(request(false))).status).toBe(401);expect((await maintenance(request(false))).status).toBe(401);
 available.mockReturnValue(false);expect(await (await sync(request())).json()).toEqual({processed:0,enabled:false});expect(await (await maintenance(request())).json()).toEqual({enabled:false});expect(sweep).not.toHaveBeenCalled();expect(maintain).not.toHaveBeenCalled();
});
test('sync bounds pages independently of maintenance and reports partial failures',async()=>{
 sweep.mockResolvedValue({processed:true});expect(await (await sync(request())).json()).toEqual({processed:20});expect(sweep).toHaveBeenCalledTimes(20);expect(maintain).not.toHaveBeenCalled();
 sweep.mockRejectedValue(new Error('retry'));expect((await sync(request())).status).toBe(503);
});
test('maintenance errors cannot prevent the separate sync endpoint from running',async()=>{
 maintain.mockRejectedValue(new Error('renewal failed'));expect((await maintenance(request())).status).toBe(503);expect((await sync(request())).status).toBe(200);expect(sweep).toHaveBeenCalled();
});
