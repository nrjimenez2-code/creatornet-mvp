import {NextRequest} from "next/server";
import {GET} from "../app/api/sales-team/bank-review/queue/route";
import {teamBankQueueSchemaReady,TeamSalesError} from "../lib/salesTeams/policy";
const auth=jest.fn(),rpc=jest.fn();
jest.mock("@/lib/salesTeams/server",()=>({
 teamRequest:(...args:unknown[])=>auth(...args),teamRpc:(...args:unknown[])=>rpc(...args),
 teamJson:(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"private, no-store"}}),
 teamError:(error:unknown)=>Response.json({error:error instanceof TeamSalesError?error.message:"Review needs attention"},{status:error instanceof TeamSalesError?error.status:409})
}));
const creator="00000000-0000-4000-8000-000000000001",actor="00000000-0000-4000-8000-000000000002",cursor="00000000-0000-4000-8000-000000003001";
const previous={...process.env};
beforeEach(()=>{jest.clearAllMocks();for(const key of Object.keys(process.env))if(key.startsWith("CREATOR_TEAM_")||key.startsWith("CREATOR_SALES_TEAM_"))delete process.env[key];auth.mockResolvedValue({admin:{fixture:true},user:{id:actor}});rpc.mockResolvedValue({entries:[],outstanding:true,bankConfirmed:false});});
afterAll(()=>{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);});
function enabled(){
 for(const key of ["CREATOR_SALES_TEAM_SCHEMA_READY","CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY",
 "CREATOR_TEAM_PAYMENT_SCHEMA_READY","CREATOR_TEAM_LATER_COLLECTION_SCHEMA_READY","CREATOR_TEAM_PAYMENT_LIFECYCLE_SCHEMA_READY",
 "CREATOR_TEAM_COLLECTION_RETRY_SCHEMA_READY","CREATOR_TEAM_SAVED_METHOD_SCHEMA_READY","CREATOR_TEAM_AUTOMATIC_COLLECTION_SCHEMA_READY",
 "CREATOR_TEAM_RECEIPT_SCHEMA_READY","CREATOR_TEAM_EVENT_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_SCHEMA_READY","CREATOR_TEAM_REFUND_DISPATCH_SCHEMA_READY",
 "CREATOR_TEAM_CASH_SCHEMA_READY","CREATOR_TEAM_COMBINED_SETTLEMENT_SCHEMA_READY","CREATOR_TEAM_SURPLUS_RESERVATIONS_SCHEMA_READY",
 "CREATOR_TEAM_SURPLUS_EXECUTION_SCHEMA_READY","CREATOR_TEAM_SURPLUS_RECOVERY_SCHEMA_READY","CREATOR_TEAM_SURPLUS_EVENTS_SCHEMA_READY",
 "CREATOR_TEAM_SURPLUS_DAILY_SCHEMA_READY","CREATOR_TEAM_BENEFICIARY_PAYOUT_SCHEMA_READY","CREATOR_TEAM_PAYOUT_STATEMENTS_SCHEMA_READY",
 "CREATOR_TEAM_BANK_REVIEW_SCHEMA_READY","CREATOR_TEAM_BANK_QUEUE_SCHEMA_READY"])process.env[key]="true";
 process.env.CREATOR_SALES_TEAM_READY="false";process.env.CREATOR_TEAM_BANK_REVIEW_READY="false";
}
const req=(query=`creator_id=${creator}`)=>new NextRequest("https://creatornet.test/api/sales-team/bank-review/queue?"+query);
test("queue gate defaults off and requires the retained chain; no auth when held",async()=>{
 expect(teamBankQueueSchemaReady({})).toBe(false);expect(teamBankQueueSchemaReady({CREATOR_TEAM_BANK_QUEUE_SCHEMA_READY:"true"})).toBe(false);
 expect((await GET(req())).status).toBe(404);expect(auth).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();
});
test("queue uses verified actor, bounded page and private output with sales and review writes off",async()=>{
 enabled();expect(teamBankQueueSchemaReady()).toBe(true);const response=await GET(req(`creator_id=${creator}&actor_id=${creator}&limit=9999`));
 expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");
 expect(rpc).toHaveBeenCalledWith({fixture:true},"read_sales_team_bank_exception_queue_v1",{p_creator_id:creator,p_actor_id:actor,p_cursor:null,p_limit:20});
});
test("cursor passed only as validated UUID",async()=>{
 enabled();expect((await GET(req(`creator_id=${creator}&cursor=${cursor}`))).status).toBe(200);
 expect(rpc.mock.calls[0][2].p_cursor).toBe(cursor);rpc.mockClear();
 expect((await GET(req(`creator_id=${creator}&cursor=wrong`))).status).toBe(400);expect(rpc).not.toHaveBeenCalled();
});
test("missing creator and missing verified identity cannot reach SQL",async()=>{
 enabled();expect((await GET(req(""))).status).toBe(400);expect(rpc).not.toHaveBeenCalled();
 auth.mockRejectedValue(new TeamSalesError("UNAUTHORIZED","Sign in",401));expect((await GET(req())).status).toBe(401);expect(rpc).not.toHaveBeenCalled();
});
test.each([["TEAM_STATEMENT_ACCESS_DENIED",403],["BANK_REVIEW_ACCESS_DENIED",403],["INVALID_BANK_QUEUE_CURSOR",400]])("minimizes %s",async(code,status)=>{
 enabled();rpc.mockRejectedValue({message:code+" acct_private ba_private txn_private"});const response=await GET(req());
 expect(response.status).toBe(status);expect(JSON.stringify(await response.json())).not.toMatch(/acct_|ba_|txn_/);
});
