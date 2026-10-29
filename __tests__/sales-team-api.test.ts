import { NextRequest } from "next/server";
const mockAuth=jest.fn(),mockCookieAuth=jest.fn(),mockRpc=jest.fn(),mockFrom=jest.fn();
const admin={auth:{getUser:mockAuth},rpc:mockRpc,from:mockFrom};
jest.mock("@supabase/supabase-js",()=>({createClient:()=>admin}));
jest.mock("@/lib/supabaseClient",()=>({createServerSupabase:async()=>({auth:{getUser:mockCookieAuth}})}));
jest.mock("@/lib/rateLimit",()=>({allowRequest:()=>true}));
import { POST } from "@/app/api/sales-team/route";
import { POST as assign } from "@/app/api/sales-team/assignments/route";
import { teamRequest } from "@/lib/salesTeams/server";
import {GET as statement} from "@/app/api/sales-team/statements/route";
const creator="00000000-0000-4000-8000-000000000001",actor="00000000-0000-4000-8000-000000000002",target="00000000-0000-4000-8000-000000000003";
const env={...process.env};
const request=(body:Record<string,unknown>,headers:Record<string,string>={})=>new NextRequest("https://creatornet.example/api/sales-team",{
 method:"POST",headers:{origin:"https://creatornet.example","content-type":"application/json",...headers},body:JSON.stringify({creator_id:creator,...body})});
beforeEach(()=>{
 jest.clearAllMocks();process.env.CREATOR_SALES_TEAM_SCHEMA_READY="true";process.env.CREATOR_SALES_TEAM_READY="true";
 mockAuth.mockResolvedValue({data:{user:{id:actor,email:"member@example.test"}},error:null});mockCookieAuth.mockResolvedValue({data:{user:{id:actor}},error:null});
 mockRpc.mockImplementation(async(name:string)=>({data:name==="sales_team_actor_role_v1"?"manager":{id:target},error:null}));
 mockFrom.mockReturnValue({select:()=>({eq:()=>({eq:()=>({eq:()=>({maybeSingle:async()=>({data:{id:target,user_id:actor,creator_id:creator,role:"manager",status:"active"},error:null})})})})})});
});
afterEach(()=>{process.env={...env};});
test("default-off and cross-origin mutations never reach team SQL",async()=>{
 delete process.env.CREATOR_SALES_TEAM_READY;expect((await POST(request({action:"remove_member",membership_id:target}))).status).toBe(409);
 process.env.CREATOR_SALES_TEAM_READY="true";expect((await POST(request({}, {origin:"https://attacker.example"}))).status).toBe(403);expect(mockRpc).not.toHaveBeenCalled();
});
test("invalid bearer identity does not fall back to a different cookie identity",async()=>{
 mockAuth.mockResolvedValueOnce({data:{user:null},error:Error("invalid")});
 await expect(teamRequest(request({}, {authorization:"Bearer forged"}),true)).rejects.toMatchObject({status:401});expect(mockCookieAuth).not.toHaveBeenCalled();
});
test("mutations bind the verified actor and discard forged pricing, recipient and actor fields",async()=>{
 const response=await POST(request({action:"remove_member",membership_id:target,actor_id:creator,commission_bps:9000,account_id:"acct_attacker"}));
 expect(response.status).toBe(200);expect(mockRpc).toHaveBeenLastCalledWith("manage_sales_team_v1",{
  p_creator_id:creator,p_actor_id:actor,p_action:"remove_member",p_input:{membership_id:target}});
});
test("invitation acceptance passes the token hash and authenticated identity only",async()=>{
 const response=await POST(request({action:"accept_invitation",token:"a".repeat(64),email:"forged@example.test",user_id:creator}));
 expect(response.status).toBe(200);const params=mockRpc.mock.calls[0][1];expect(params.p_actor_id).toBe(actor);expect(Object.keys(params.p_input)).toEqual(["token_hash"]);expect(params.p_input.token_hash).not.toBe("a".repeat(64));
});
test("a closer cannot invoke management and cross-creator denial is explicit",async()=>{
 mockRpc.mockResolvedValueOnce({data:null,error:null});expect((await POST(request({action:"remove_member",membership_id:target}))).status).toBe(403);
 expect(mockRpc.mock.calls).toHaveLength(1);
});
test("assignment uses no caller-supplied creator, destination or commission identity",async()=>{
 expect((await assign(request({booking_id:target,actor_id:creator,target_id:creator,commission_bps:9000})) ).status).toBe(200);
 expect(mockRpc).toHaveBeenCalledWith("assign_sales_team_booking_v1",{p_booking_id:target,p_actor_id:actor,p_membership_id:null});
});
test("unknown commands and absent commission terms fail before any mutation",async()=>{
 expect((await POST(request({action:"make_admin"}))).status).toBe(400);
 expect((await POST(request({action:"invite",role:"closer",is_closer:true,email:"member@example.test",token:"a".repeat(64),request_id:target}))).status).toBe(400);
 expect(mockRpc.mock.calls.every(([name])=>name==="sales_team_actor_role_v1")).toBe(true);
});

test("routing and future-term updates use curated inputs and require a reviewed commission revision",async()=>{
 expect((await POST(request({action:"configure_destination",target_id:target,weight:0,enabled:false,booking_url:"https://attacker.example"}))).status).toBe(200);
 expect(mockRpc).toHaveBeenLastCalledWith("manage_sales_team_v1",{p_creator_id:creator,p_actor_id:actor,p_action:"configure_destination",p_input:{target_id:target,weight:0,enabled:false}});
 const body={action:"configure_member",membership_id:target,role:"closer",is_closer:true,commission_bps:1200,hold_days:14,renewal_rule:"initial_commitment"};
 expect((await POST(request(body))).status).toBe(409);
 expect((await POST(request({...body,expected_revision:7}))).status).toBe(200);
 expect(mockRpc).toHaveBeenLastCalledWith("manage_sales_team_v1",expect.objectContaining({p_input:expect.objectContaining({expected_revision:7,commission_bps:1200})}));
});

test("financial statements bind the current user and remain readable with new activity disabled",async()=>{
 const req=new NextRequest(`https://creatornet.example/api/sales-team/statements?creator_id=${creator}&actor_id=${creator}`,{headers:{authorization:"Bearer verified"}});
 expect((await statement(req)).status).toBe(404);expect(mockRpc).not.toHaveBeenCalled();
 process.env.CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY="true";process.env.CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY="true";delete process.env.CREATOR_SALES_TEAM_READY;
 expect((await statement(req)).status).toBe(200);
 expect(mockRpc).toHaveBeenCalledWith("read_sales_team_statement_v1",{p_creator_id:creator,p_actor_id:actor,p_cursor:null,p_limit:20});
});
test("payout statements require the complete schema chain and bind the verified actor",async()=>{
 process.env.CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY="true";process.env.CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY="true";
 process.env.CREATOR_TEAM_PAYOUT_STATEMENTS_SCHEMA_READY="true";
 const req=new NextRequest(`https://creatornet.example/api/sales-team/statements?creator_id=${creator}&actor_id=${creator}&cursor=${target}`,{headers:{authorization:"Bearer verified"}});
 expect((await statement(req)).status).toBe(200);expect(mockRpc).toHaveBeenLastCalledWith("read_sales_team_statement_v1",expect.anything());
 for(const key of ["PAYMENT","LATER_COLLECTION","PAYMENT_LIFECYCLE","COLLECTION_RETRY","SAVED_METHOD","AUTOMATIC_COLLECTION","RECEIPT","EVENT","FINANCIAL","REFUND_DISPATCH","CASH","COMBINED_SETTLEMENT","SURPLUS_RESERVATIONS","SURPLUS_EXECUTION","SURPLUS_RECOVERY","SURPLUS_EVENTS","SURPLUS_DAILY","BENEFICIARY_PAYOUT"])process.env[`CREATOR_TEAM_${key}_SCHEMA_READY`]="true";
 delete process.env.CREATOR_SALES_TEAM_READY;expect((await statement(req)).status).toBe(200);
 expect(mockRpc).toHaveBeenLastCalledWith("read_sales_team_payout_statement_v1",{p_creator_id:creator,p_actor_id:actor,p_cursor:target,p_limit:20});
});
