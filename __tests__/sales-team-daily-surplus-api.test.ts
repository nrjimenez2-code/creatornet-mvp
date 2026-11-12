import {readFileSync} from "node:fs";
import {GET} from "@/app/api/sales-team/surplus/route";
const compose=jest.fn(),run=jest.fn(),secret="synthetic-daily-surplus-cron-secret-32",composition={kind:"owned-composition"};
jest.mock("@/lib/salesTeams/context",()=>({createTeamPaymentContext:()=>compose()}));
jest.mock("@/lib/salesTeams/dailySurplus",()=>({runTeamDailySurplus:(...args:unknown[])=>run(...args)}));
const env={...process.env},request=(authorization=`Bearer ${secret}`)=>new Request("https://fixture.invalid/api/sales-team/surplus",{headers:{authorization}});
beforeEach(()=>{
 jest.clearAllMocks();process.env.CRON_SECRET=secret;compose.mockReturnValue(composition);run.mockResolvedValue({status:"complete",bankConfirmed:false});
 const source=readFileSync("lib/salesTeams/policy.ts","utf8");for(const key of source.match(/CREATOR_[A-Z_]+READY/g)??[])delete process.env[key];
 for(const key of source.match(/CREATOR_[A-Z_]+SCHEMA_READY/g)??[])process.env[key]="true";delete process.env.CREATOR_TEAM_SURPLUS_DAILY_SCHEMA_READY;
});
afterEach(()=>{process.env={...env};});
test.each(["","Bearer wrong","Basic synthetic"])("authorization %s cannot compose provider access or consume a slot",async authorization=>{
 expect((await GET(request(authorization))).status).toBe(401);expect(compose).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});
test("missing or short configured secret is not authorization",async()=>{process.env.CRON_SECRET="short";expect((await GET(request("Bearer short"))).status).toBe(401);expect(compose).not.toHaveBeenCalled();});
test("the default-off daily schema gate stops before composition",async()=>{expect((await GET(request())).status).toBe(409);expect(compose).not.toHaveBeenCalled();});
test("original recovery can run privately while new-money authority is off",async()=>{
 process.env.CREATOR_TEAM_SURPLUS_DAILY_SCHEMA_READY="true";const response=await GET(request());expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");
 expect(run).toHaveBeenCalledWith(composition,{admitNew:false});expect(await response.json()).toMatchObject({bankConfirmed:false});
});
test("fresh execution needs the existing reservation and execution switches",async()=>{
 process.env.CREATOR_TEAM_SURPLUS_DAILY_SCHEMA_READY="true";process.env.CREATOR_TEAM_SURPLUS_RESERVATIONS_READY="true";process.env.CREATOR_TEAM_SURPLUS_EXECUTION_READY="true";
 await GET(request());expect(run).toHaveBeenLastCalledWith(composition,{admitNew:true});delete process.env.CREATOR_TEAM_SURPLUS_RESERVATIONS_READY;
 await GET(request());expect(run).toHaveBeenLastCalledWith(composition,{admitNew:false});
});
test("a missing predecessor schema holds even with the new daily gate on",async()=>{
 process.env.CREATOR_TEAM_SURPLUS_DAILY_SCHEMA_READY="true";delete process.env.CREATOR_TEAM_SURPLUS_EVENTS_SCHEMA_READY;expect((await GET(request())).status).toBe(409);expect(compose).not.toHaveBeenCalled();
});
test("errors expose no provider or financial payload",async()=>{
 process.env.CREATOR_TEAM_SURPLUS_DAILY_SCHEMA_READY="true";run.mockRejectedValue(Error("private-provider-payload"));const log=jest.spyOn(console,"error").mockImplementation(()=>{});
 try{const response=await GET(request());expect(response.status).toBe(409);expect(JSON.stringify(await response.json())).not.toContain("private-provider-payload");}finally{log.mockRestore();}
});
