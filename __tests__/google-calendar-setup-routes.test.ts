import { NextRequest } from "next/server";
const getUser=jest.fn(), load=jest.fn(), save=jest.fn(), update=jest.fn();
let watch: Record<string,unknown>|null;
const watchId="11111111-1111-4111-8111-111111111111";
const secret="ab".repeat(32);
const originalEnv={...process.env};
jest.mock("@/lib/supabaseConnectAuth",()=>({getAuthenticatedUser:()=>getUser()}));
jest.mock("@/lib/googleCalendarConnection",()=>({getGoogleCalendarSetup:(...args:unknown[])=>load(...args),saveGoogleCalendarSetup:(...args:unknown[])=>save(...args)}));
jest.mock("@/lib/supabaseAdmin",()=>({supabaseAdmin:{rpc:async(name:string,args:unknown)=>{update(name,args);return {error:null};},from:(table:string)=>{
  const chain:any={select:()=>chain,eq:()=>chain,in:async()=>({error:null}),single:async()=>({data:{creator_id:"creator"},error:null}),maybeSingle:async()=>({data:watch,error:null}),update:(values:unknown)=>{update(table,values);return chain;}};
  return chain;
}}}));
import {GET,POST} from "@/app/api/scheduling/google/settings/route";
import {POST as notify} from "@/app/api/scheduling/google/notifications/route";
import {sealSchedulingSecret} from "@/lib/schedulingSecrets";
import {_resetRateLimits} from "@/lib/rateLimit";
beforeEach(()=>{
  jest.clearAllMocks();_resetRateLimits();getUser.mockResolvedValue({id:"creator"});load.mockResolvedValue({calendars:[]});save.mockResolvedValue(undefined);
  Object.assign(process.env,{GOOGLE_CALENDAR_ENABLED:"true",GOOGLE_CALENDAR_CLIENT_ID:"client",GOOGLE_CALENDAR_CLIENT_SECRET:"secret",SCHEDULING_OAUTH_ORIGIN:"https://creatornet.example",SCHEDULING_TOKEN_ENCRYPTION_KEY:"12".repeat(32)});
  watch={id:watchId,connection_id:"connection",resource_id:"resource",status:"active",expires_at:new Date(Date.now()+60000).toISOString(),token_ciphertext:sealSchedulingSecret(secret,`creator:google:watch:${watchId}`)};
});
afterAll(()=>{process.env=originalEnv;});
const request=(origin="https://creatornet.example")=>new NextRequest("https://creatornet.example/api/scheduling/google/settings",{method:"POST",headers:{origin,"Content-Type":"application/json"},body:JSON.stringify({calendarId:"calendar"})});
test("calendar settings require identity, origin and enabled provider",async()=>{
  getUser.mockResolvedValueOnce(null);expect((await GET(request())).status).toBe(401);
  expect((await POST(request("https://attacker.example"))).status).toBe(403);
  process.env.GOOGLE_CALENDAR_ENABLED="false";expect((await POST(request())).status).toBe(503);
  expect(save).not.toHaveBeenCalled();expect(load).not.toHaveBeenCalled();
});
test("settings are saved for the authenticated creator, never a browser supplied identity",async()=>{
  expect((await POST(request())).status).toBe(200);expect(save).toHaveBeenCalledWith("creator",{calendarId:"calendar"});
});
const notification=(token=secret)=>new NextRequest("https://creatornet.example/api/scheduling/google/notifications",{method:"POST",headers:{"x-goog-channel-id":watchId,"x-goog-resource-id":"resource","x-goog-channel-token":token,"x-goog-resource-state":"exists"}});
test("verified Google notifications only request an authoritative calendar fetch",async()=>{
  expect((await notify(notification())).status).toBe(204);
  expect(update).toHaveBeenCalledWith("request_google_calendar_sync_v1",{p_watch:watchId});
  expect(update).toHaveBeenCalledTimes(1);
});
test("forged notifications cannot change state and pending registration asks Google to retry",async()=>{
  expect((await notify(notification("wrong"))).status).toBe(401);expect(update).not.toHaveBeenCalled();
  watch!.resource_id=null;watch!.status="pending";
  expect((await notify(notification())).status).toBe(503);expect(update).not.toHaveBeenCalled();
});
