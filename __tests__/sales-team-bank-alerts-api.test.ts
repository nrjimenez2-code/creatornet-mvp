import {NextRequest} from "next/server";
import {GET,POST} from "../app/api/sales-team/bank-alerts/route";
import {teamBankAlertsSchemaReady,teamBankAlertsReadReady,TeamSalesError} from "../lib/salesTeams/policy";
const auth=jest.fn(),rpc=jest.fn();
jest.mock("@/lib/salesTeams/server",()=>({
 teamRequest:(...args:unknown[])=>auth(...args),teamRpc:(...args:unknown[])=>rpc(...args),
 teamJson:(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"private, no-store"}}),
 teamError:(error:unknown)=>Response.json({error:error instanceof TeamSalesError?error.message:"Review required"},{status:error instanceof TeamSalesError?error.status:409})
}));
const creator="00000000-0000-4000-8000-000000000001",actor="00000000-0000-4000-8000-000000000002",alert="00000000-0000-4000-8000-000000003001";
const origin="https://creatornet.test",body={creator_id:creator,alert_id:alert},previous={...process.env};
const read=(suffix="")=>new NextRequest(`${origin}/api/sales-team/bank-alerts?creator_id=${creator}${suffix}`);
const write=(value:unknown=body,source:string|null=origin)=>new NextRequest(`${origin}/api/sales-team/bank-alerts`,{method:"POST",headers:{"content-type":"application/json",...(source?{origin:source}:{})},body:JSON.stringify(value)});
function enable(){
 for(const key of ["CREATOR_SALES_TEAM_SCHEMA_READY","CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY",
 "CREATOR_TEAM_PAYMENT_SCHEMA_READY","CREATOR_TEAM_LATER_COLLECTION_SCHEMA_READY","CREATOR_TEAM_PAYMENT_LIFECYCLE_SCHEMA_READY","CREATOR_TEAM_COLLECTION_RETRY_SCHEMA_READY",
 "CREATOR_TEAM_SAVED_METHOD_SCHEMA_READY","CREATOR_TEAM_AUTOMATIC_COLLECTION_SCHEMA_READY","CREATOR_TEAM_RECEIPT_SCHEMA_READY","CREATOR_TEAM_EVENT_SCHEMA_READY",
 "CREATOR_TEAM_FINANCIAL_SCHEMA_READY","CREATOR_TEAM_REFUND_DISPATCH_SCHEMA_READY","CREATOR_TEAM_CASH_SCHEMA_READY","CREATOR_TEAM_COMBINED_SETTLEMENT_SCHEMA_READY",
 "CREATOR_TEAM_SURPLUS_RESERVATIONS_SCHEMA_READY","CREATOR_TEAM_SURPLUS_EXECUTION_SCHEMA_READY","CREATOR_TEAM_SURPLUS_RECOVERY_SCHEMA_READY","CREATOR_TEAM_SURPLUS_EVENTS_SCHEMA_READY",
 "CREATOR_TEAM_SURPLUS_DAILY_SCHEMA_READY","CREATOR_TEAM_BENEFICIARY_PAYOUT_SCHEMA_READY","CREATOR_TEAM_PAYOUT_STATEMENTS_SCHEMA_READY","CREATOR_TEAM_BANK_REVIEW_SCHEMA_READY",
 "CREATOR_TEAM_BANK_QUEUE_SCHEMA_READY","CREATOR_TEAM_BANK_ALERTS_SCHEMA_READY","CREATOR_TEAM_BANK_ALERT_READS_READY"])process.env[key]="true";
 process.env.CREATOR_SALES_TEAM_READY="false";
}
beforeEach(()=>{jest.clearAllMocks();for(const key of Object.keys(process.env))if(/^CREATOR_(TEAM|SALES_TEAM)_/.test(key))delete process.env[key];auth.mockResolvedValue({admin:{fixture:true},user:{id:actor}});rpc.mockResolvedValue({entries:[]});});
afterAll(()=>{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);});
test("default-off gates stop requests before authentication",async()=>{expect(teamBankAlertsSchemaReady({})).toBe(false);expect(teamBankAlertsReadReady({})).toBe(false);expect((await GET(read())).status).toBe(404);expect((await POST(write())).status).toBe(409);expect(auth).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();});
test("private bounded history derives actor from verified auth, ignores client role/limit and works with sales off",async()=>{
 enable();const response=await GET(read(`&actor_id=${creator}&limit=999&cursor=${alert}`));expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");
 expect(rpc).toHaveBeenCalledWith({fixture:true},"read_sales_team_bank_alerts_v1",{p_creator_id:creator,p_actor_id:actor,p_cursor:alert,p_limit:20});expect((await response.json()).canMarkRead).toBe(true);
});
test("mark-read can be held separately while history stays readable",async()=>{enable();process.env.CREATOR_TEAM_BANK_ALERT_READS_READY="false";expect((await POST(write())).status).toBe(409);expect(rpc).not.toHaveBeenCalled();expect((await (await GET(read())).json()).canMarkRead).toBe(false);});
test("explicit read receipt uses only actor from authentication and fixed alert identity",async()=>{enable();expect((await POST(write())).status).toBe(200);expect(auth).toHaveBeenCalledWith(expect.any(NextRequest));expect(rpc).toHaveBeenCalledWith({fixture:true},"mark_sales_team_bank_alert_read_v1",{p_creator_id:creator,p_actor_id:actor,p_alert_id:alert});});
test.each([null,"https://unrelated.test"])("Origin %s cannot submit read receipt",async source=>{enable();expect((await POST(write(body,source))).status).toBe(403);expect(auth).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();});
test.each([null,[],{}, {...body,actor_id:creator},{...body,confirm_bank:true},{...body,alert_id:"invalid"},{...body,extra:"x".repeat(1500)}])("malformed or extended request %j cannot reach RPC",async value=>{enable();expect((await POST(write(value))).status).toBe(400);expect(rpc).not.toHaveBeenCalled();});
test("unauthenticated users cannot read or mark",async()=>{enable();auth.mockRejectedValue(new TeamSalesError("UNAUTHORIZED","Sign in",401));expect((await GET(read())).status).toBe(401);expect((await POST(write())).status).toBe(401);expect(rpc).not.toHaveBeenCalled();});
test.each(["BANK_ALERT_ACCESS_DENIED","TEAM_STATEMENT_ACCESS_DENIED"])("SQL authority loss %s is private and denied",async code=>{enable();rpc.mockRejectedValue(new Error(code+" raw-account-detail"));const response=await GET(read());expect(response.status).toBe(403);expect(JSON.stringify(await response.json())).not.toContain("raw-account-detail");});
test("invalid scoped cursor and contract hold are bounded responses",async()=>{enable();rpc.mockRejectedValueOnce(new Error("INVALID_BANK_ALERT_CURSOR"));expect((await GET(read())).status).toBe(400);rpc.mockRejectedValueOnce(new Error("BANK_ALERT_AUTHORITY_REQUIRED"));expect((await POST(write())).status).toBe(409);});
