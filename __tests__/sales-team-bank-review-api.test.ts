import {NextRequest} from "next/server";
import {GET,POST} from "../app/api/sales-team/bank-review/route";
import {teamBankReviewSchemaReady,teamBankReviewReady,teamBankReviewActionsSchemaReady,teamBankReviewActionsReady,TeamSalesError} from "../lib/salesTeams/policy";
const auth=jest.fn(),rpc=jest.fn();
jest.mock("@/lib/salesTeams/server",()=>({
 teamRequest:(...args:unknown[])=>auth(...args),teamRpc:(...args:unknown[])=>rpc(...args),
 teamJson:(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"private, no-store"}}),
 teamError:(error:unknown)=>Response.json({error:error instanceof TeamSalesError?error.message:"Review needs attention",code:error instanceof TeamSalesError?error.code:"TEAM_REVIEW_REQUIRED"},{status:error instanceof TeamSalesError?error.status:409})
}));
const creator="00000000-0000-4000-8000-000000000001",actor="00000000-0000-4000-8000-000000000002",request="00000000-0000-4000-8000-000000003001",review="00000000-0000-4000-8000-000000003002";
const origin="https://creatornet.test",body={creator_id:creator,request_id:request,review_id:review,action:"acknowledged",state_sha256:"a".repeat(64)};
const read=()=>new NextRequest(`${origin}/api/sales-team/bank-review?creator_id=${creator}&request_id=${request}`);
const write=(value:unknown=body,source:string|null=origin)=>new NextRequest(`${origin}/api/sales-team/bank-review`,{method:"POST",headers:{"content-type":"application/json",...(source?{origin:source}:{})},body:JSON.stringify(value)});
const previous={...process.env};
beforeEach(()=>{jest.clearAllMocks();for(const key of Object.keys(process.env))if(key.startsWith("CREATOR_TEAM_")||key.startsWith("CREATOR_SALES_TEAM_"))delete process.env[key];auth.mockResolvedValue({admin:{fixture:true},user:{id:actor}});rpc.mockResolvedValue({bankConfirmed:false,outstanding:true});});
afterAll(()=>{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);});
function enabled(){
 // Satisfy the retained schema chain, then explicitly keep new sales off.
 for(const key of ["CREATOR_SALES_TEAM_SCHEMA_READY","CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY",
  "CREATOR_TEAM_PAYMENT_SCHEMA_READY","CREATOR_TEAM_LATER_COLLECTION_SCHEMA_READY","CREATOR_TEAM_PAYMENT_LIFECYCLE_SCHEMA_READY",
  "CREATOR_TEAM_COLLECTION_RETRY_SCHEMA_READY","CREATOR_TEAM_SAVED_METHOD_SCHEMA_READY","CREATOR_TEAM_AUTOMATIC_COLLECTION_SCHEMA_READY",
  "CREATOR_TEAM_RECEIPT_SCHEMA_READY","CREATOR_TEAM_EVENT_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_SCHEMA_READY","CREATOR_TEAM_REFUND_DISPATCH_SCHEMA_READY",
  "CREATOR_TEAM_CASH_SCHEMA_READY","CREATOR_TEAM_COMBINED_SETTLEMENT_SCHEMA_READY","CREATOR_TEAM_SURPLUS_RESERVATIONS_SCHEMA_READY",
  "CREATOR_TEAM_SURPLUS_EXECUTION_SCHEMA_READY","CREATOR_TEAM_SURPLUS_RECOVERY_SCHEMA_READY","CREATOR_TEAM_SURPLUS_EVENTS_SCHEMA_READY",
  "CREATOR_TEAM_SURPLUS_DAILY_SCHEMA_READY","CREATOR_TEAM_BENEFICIARY_PAYOUT_SCHEMA_READY","CREATOR_TEAM_PAYOUT_STATEMENTS_SCHEMA_READY"])process.env[key]="true";
 process.env.CREATOR_SALES_TEAM_READY="false";
 process.env.CREATOR_TEAM_BANK_REVIEW_SCHEMA_READY="true";process.env.CREATOR_TEAM_BANK_REVIEW_READY="true";
}

test("new review gates require the complete retained schema chain and default off",()=>{
 expect(teamBankReviewSchemaReady({})).toBe(false);expect(teamBankReviewReady({CREATOR_TEAM_BANK_REVIEW_SCHEMA_READY:"true",CREATOR_TEAM_BANK_REVIEW_READY:"true"})).toBe(false);
});
test("disabled routes do not authenticate or invoke RPC",async()=>{expect((await GET(read())).status).toBe(404);expect((await POST(write())).status).toBe(409);expect(auth).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();});
test("read history derives actor from verified auth, stays private and permits new-sales-off history",async()=>{
 enabled();expect(teamBankReviewSchemaReady()).toBe(true);const response=await GET(read());expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");
 expect(rpc).toHaveBeenCalledWith({fixture:true},"read_sales_team_bank_exception_v1",{p_creator_id:creator,p_actor_id:actor,p_request_id:request,p_cursor:null,p_limit:20});expect(auth).toHaveBeenCalledWith(expect.any(NextRequest));
});
test("write gate can be held while historical reads remain available",async()=>{enabled();process.env.CREATOR_TEAM_BANK_REVIEW_READY="false";expect((await POST(write())).status).toBe(409);expect(rpc).not.toHaveBeenCalled();expect((await GET(read())).status).toBe(200);});
test.each([null,"https://unrelated.test"])("missing or foreign Origin %s rejects before auth",async source=>{enabled();expect((await POST(write(body,source))).status).toBe(403);expect(auth).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();});
test("unauthenticated requests cannot reach either review RPC",async()=>{enabled();auth.mockRejectedValue(new TeamSalesError("UNAUTHORIZED","Sign in",401));expect((await GET(read())).status).toBe(401);expect((await POST(write())).status).toBe(401);expect(rpc).not.toHaveBeenCalled();});
test("malformed JSON rejects without a review RPC",async()=>{enabled();const req=new NextRequest(`${origin}/api/sales-team/bank-review`,{method:"POST",headers:{origin,"content-type":"application/json"},body:"{"});expect((await POST(req)).status).toBe(400);expect(rpc).not.toHaveBeenCalled();});
test("oversized body rejects before parsing or a review RPC",async()=>{enabled();const req=new NextRequest(`${origin}/api/sales-team/bank-review`,{method:"POST",headers:{origin,"content-type":"application/json"},body:"x".repeat(4097)});expect((await POST(req)).status).toBe(400);expect(rpc).not.toHaveBeenCalled();});
test.each(["acknowledged","escalated"])("%s sends only frozen intent and verified actor without new-sales mutation admission",async action=>{
 enabled();expect((await POST(write({...body,action}))).status).toBe(200);expect(auth).toHaveBeenCalledWith(expect.any(NextRequest));
 expect(rpc).toHaveBeenCalledWith({fixture:true},"record_sales_team_bank_exception_review_v1",{p_creator_id:creator,p_actor_id:actor,p_request_id:request,p_review_id:review,p_action:action,p_state_sha256:body.state_sha256});
});
test.each([{...body,actor_id:creator},{...body,action:"confirmed"},{...body,action:"resolved"},{...body,state_sha256:"wrong"},{...body,request_id:"wrong"},[],null])("invalid or caller-spoofed intent is rejected before SQL",async value=>{enabled();expect((await POST(write(value))).status).toBe(400);expect(rpc).not.toHaveBeenCalled();});
test.each([["BANK_REVIEW_ACCESS_DENIED",403],["TEAM_STATEMENT_ACCESS_DENIED",403],["BANK_REVIEW_STATE_CHANGED",409],["ORIGINAL_BANK_REVIEW_REQUIRED",409],["BANK_REVIEW_AUTHORITY_REQUIRED",409]])("%s returns a minimized actionable response",async(code,status)=>{
 enabled();rpc.mockRejectedValue({message:code+" acct_private ba_private req_private"});const response=await POST(write());expect(response.status).toBe(status);expect(JSON.stringify(await response.json())).not.toMatch(/acct_|ba_|req_/);
});

test("action schema and presentation gates default off without changing F49's write gate",()=>{
 expect(teamBankReviewActionsSchemaReady({})).toBe(false);expect(teamBankReviewActionsReady({})).toBe(false);
 enabled();expect(teamBankReviewActionsReady()).toBe(false);expect(teamBankReviewReady()).toBe(true);
});
test("legacy history fallback adds a false capability and never calls the new wrapper",async()=>{
 enabled();rpc.mockResolvedValue({state:{bankConfirmed:false},canReview:true});const response=await GET(read());
 expect((await response.json()).canReview).toBe(false);expect(rpc.mock.calls[0][1]).toBe("read_sales_team_bank_exception_v1");
});
test("new scoped wrapper derives actor from auth; all three write/capability gates must agree",async()=>{
 enabled();process.env.CREATOR_TEAM_BANK_REVIEW_ACTIONS_SCHEMA_READY="true";process.env.CREATOR_TEAM_BANK_REVIEW_ACTIONS_READY="true";
 rpc.mockResolvedValue({state:{bankConfirmed:false},canReview:true});const response=await GET(read());
 expect((await response.json()).canReview).toBe(true);expect(rpc).toHaveBeenCalledWith({fixture:true},"read_sales_team_bank_review_view_v1",{p_creator_id:creator,p_actor_id:actor,p_request_id:request,p_cursor:null,p_limit:20});
 process.env.CREATOR_TEAM_BANK_REVIEW_READY="false";expect((await (await GET(read())).json()).canReview).toBe(false);
});
test.each([false,null,undefined,"true"])("SQL capability %s is never promoted by enabled UI gates",async canReview=>{
 enabled();process.env.CREATOR_TEAM_BANK_REVIEW_ACTIONS_SCHEMA_READY="true";process.env.CREATOR_TEAM_BANK_REVIEW_ACTIONS_READY="true";
 rpc.mockResolvedValue({canReview});expect((await (await GET(read())).json()).canReview).toBe(false);
});
test("new-schema submissions use the guarded wrapper, with no change to frozen intent or verified actor",async()=>{
 enabled();process.env.CREATOR_TEAM_BANK_REVIEW_ACTIONS_SCHEMA_READY="true";expect((await POST(write())).status).toBe(200);
 expect(rpc).toHaveBeenCalledWith({fixture:true},"record_sales_team_bank_review_action_v1",{p_creator_id:creator,p_actor_id:actor,p_request_id:request,p_review_id:review,p_action:"acknowledged",p_state_sha256:body.state_sha256});
});
test.each(["BANK_REVIEW_ACTION_STATE_CHANGED","BANK_REVIEW_ACTION_ISOLATION_REQUIRED"])("%s preserves a distinct minimized guarded error",async code=>{
 enabled();rpc.mockRejectedValue({message:code+" acct_private ba_private"});const result=await POST(write());expect(result.status).toBe(409);const data=await result.json();expect(data.code).toBe(code);expect(JSON.stringify(data)).not.toMatch(/acct_|ba_/);
});
