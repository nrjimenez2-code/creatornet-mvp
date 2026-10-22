import {NextRequest} from "next/server";
import {createMockClient} from "./__mocks__/supabaseQueryMock";
const mockRead=jest.fn(),mockRefresh=jest.fn(),mockStart=jest.fn(),mockComposition=jest.fn(),mockCookie=jest.fn();
let db:ReturnType<typeof createMockClient>;
jest.mock("@supabase/supabase-js",()=>({createClient:()=>db}));
jest.mock("@/lib/supabaseClient",()=>({createServerSupabase:async()=>({auth:{getUser:mockCookie}})}));
jest.mock("@/lib/rateLimit",()=>({allowRequest:()=>true}));
jest.mock("@/lib/salesTeams/recipients",()=>({readTeamRecipientStatus:(...args:unknown[])=>mockRead(...args),refreshTeamRecipient:(...args:unknown[])=>mockRefresh(...args),startTeamRecipientOnboarding:(...args:unknown[])=>mockStart(...args)}));
jest.mock("@/lib/salesTeams/context",()=>({createTeamPaymentContext:()=>mockComposition()}));
import {GET,POST} from "@/app/api/sales-team/recipient/route";
const actor="00000000-0000-4000-8000-000000000002",requestId="00000000-0000-4000-8000-000000000003",env={...process.env};
const status={status:"not_started",transfersActive:false,payoutsReady:false,verifiedAt:null};
const request=(body?:unknown,headers:Record<string,string>={})=>new NextRequest("https://fixture.vercel.app/api/sales-team/recipient?user_id=forged",{
 method:body?"POST":"GET",headers:{authorization:"Bearer verified",origin:"https://fixture.vercel.app","content-type":"application/json",...headers},...(body?{body:JSON.stringify(body)}:{})});
beforeEach(()=>{
 jest.clearAllMocks();
 for(const key of ["CREATOR_SALES_TEAM_SCHEMA_READY","CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY","CREATOR_TEAM_RECIPIENT_SCHEMA_READY"])process.env[key]="true";
 delete process.env.CREATOR_SALES_TEAM_READY;delete process.env.CREATOR_TEAM_RECIPIENT_ONBOARDING_READY;
 db=createMockClient(op=>op.table==="sales_team_onboarding_links_v1"?{data:{id:requestId,status:"unknown",expires_at:null},error:null}:undefined);
 db.auth.getUser=jest.fn(async()=>({data:{user:{id:actor}},error:null}));
 mockRead.mockResolvedValue(status);mockRefresh.mockResolvedValue({status,setup:null});mockStart.mockResolvedValue({status,url:"https://connect.stripe.com/setup/synthetic"});mockComposition.mockReturnValue({kind:"verified-composition"});
});
afterEach(()=>{process.env={...env};});
test("default-off schema never composes provider access",async()=>{
 delete process.env.CREATOR_TEAM_RECIPIENT_SCHEMA_READY;expect((await GET(request())).status).toBe(404);expect((await POST(request({action:"onboard",request_id:requestId}))).status).toBe(404);expect(mockComposition).not.toHaveBeenCalled();
});
test("own status stays available with new activity disabled and never returns account or setup URLs",async()=>{
 const response=await GET(request());expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");
 expect(await response.json()).toEqual({recipient:status,onboarding:{id:requestId,status:"unknown",expires_at:null},onboardingEnabled:false});
 expect(mockRead).toHaveBeenCalledWith(db,actor);expect(db.ops[0].filters).toEqual({user_id:actor});expect(mockComposition).not.toHaveBeenCalled();
});
test("capability refresh remains available while new onboarding is paused",async()=>{
 expect((await POST(request({action:"refresh"}))).status).toBe(200);expect(mockRefresh).toHaveBeenCalledWith({kind:"verified-composition"},actor);expect(mockStart).not.toHaveBeenCalled();
 expect((await POST(request({action:"onboard",request_id:requestId}))).status).toBe(409);expect(mockStart).not.toHaveBeenCalled();
});
test.each(["account_id","user_id","email","return_url","api"])("caller-supplied %s cannot choose recipient parameters",async key=>{
 process.env.CREATOR_TEAM_RECIPIENT_ONBOARDING_READY="true";
 expect((await POST(request({action:"onboard",request_id:requestId,[key]:"forged"}))).status).toBe(400);expect(mockComposition).not.toHaveBeenCalled();
});
test("setup uses only the authenticated identity and the stable request ID",async()=>{
 process.env.CREATOR_TEAM_RECIPIENT_ONBOARDING_READY="true";
 expect((await POST(request({action:"onboard",request_id:requestId}))).status).toBe(200);
 expect(mockStart).toHaveBeenCalledWith({kind:"verified-composition"},actor,requestId);
});
test("cross-origin or invalid bearer requests never use a cookie fallback or provider",async()=>{
 expect((await POST(request({action:"refresh"},{origin:"https://foreign.test"}))).status).toBe(403);
 db.auth.getUser=jest.fn(async()=>({data:{user:null},error:Error("invalid")}));expect((await POST(request({action:"refresh"}))).status).toBe(401);
 expect(mockCookie).not.toHaveBeenCalled();expect(mockComposition).not.toHaveBeenCalled();
});
