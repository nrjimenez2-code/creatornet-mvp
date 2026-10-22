import type {SupabaseClient} from "@supabase/supabase-js";
import type Stripe from "stripe";
import {createMockClient} from "./__mocks__/supabaseQueryMock";
jest.mock("@/lib/supabaseClient",()=>({createServerSupabase:jest.fn()}));
import {readTeamRecipientStatus,refreshTeamRecipient,startTeamRecipientOnboarding} from "@/lib/salesTeams/recipients";
import {recipientCreationRequest,type TeamRecipientSetup} from "@/lib/salesTeams/recipientPolicy";
const user="00000000-0000-4000-8000-000000000002",setupId="00000000-0000-4000-8000-000000000003",requestId="00000000-0000-4000-8000-000000000004";
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
function fixture(api:"v1"|"v2"="v1"){
 let setup:TeamRecipientSetup={user_id:user,id:setupId,api,account_id:api==="v1"?"acct_original":null,legacy_creation_key:api==="v1"?setupId:null,context,
  request:api==="v2"?recipientCreationRequest(user,setupId,"member@example.test"):null};
 let recipient:Record<string,unknown>|null=null,operation:Record<string,unknown>|null=null,phase="dispatch",linkStatus="dispatch",fail=false,savedLink:Record<string,unknown>={};
 const object=api==="v1"?{id:"acct_original",object:"account",country:"US",default_currency:"usd",payouts_enabled:false,capabilities:{transfers:"active"},metadata:{creatornet_user_id:user,creatornet_creation_id:setupId},lastResponse:{requestId:"req_read"}}:
  {id:"acct_original",object:"v2.core.account",livemode:false,identity:{country:"US"},defaults:{currency:"usd",responsibilities:{fees_collector:"application",losses_collector:"application"}},
   dashboard:"express",applied_configurations:["recipient"],configuration:{recipient:{applied:true,capabilities:{stripe_balance:{stripe_transfers:{status:"active"},payouts:{status:"pending"}}}}},
   metadata:{creatornet_user_id:user,creatornet_team_recipient_setup_id:setupId},lastResponse:{requestId:"req_read"}};
 const db=createMockClient(op=>{
  if(op.table==="sales_team_recipients_v1"){
   if(op.kind==="update")recipient={...recipient,...op.payload as Record<string,unknown>};
   return {data:recipient,error:null};
  }
  if(op.table==="sales_team_provider_operations_v1")return {data:operation?{id:operation.id}:null,error:null};
  throw Error(op.table);
 });
 const rpc=jest.fn(async(name:string,args:Record<string,unknown>):Promise<{data:unknown;error:null}>=>{
  if(name==="sales_team_recipient_allowed_v1")return {data:true,error:null};
  if(name==="sales_team_recipient_context_current_v1")return {data:true,error:null};
  // RPC responses are parsed JSON in the caller's realm. Node structuredClone
  // returns host-realm prototypes under Jest and is not a PostgREST response.
  if(name==="reserve_sales_team_recipient_v1")return {data:JSON.parse(JSON.stringify(setup)),error:null};
  if(name==="record_sales_team_recipient_v1"){
   const proof=args.p_observation as Record<string,unknown>;setup={...setup,account_id:String(proof.accountId)};
   recipient={ownership_verified:true,transfers_active:proof.transfersActive,payouts_ready:proof.payoutsReady,verified_at:new Date().toISOString()};return {data:null,error:null};
  }
  if(name==="claim_sales_team_provider_operation_v1"){
   if(!operation)operation={...args.p_scope as object,id:args.p_operation_id,request:args.p_request,context:args.p_context,
    idempotency_key:`cn-team-v1:${args.p_operation_id}`,lease_token:requestId,lease_until:new Date(Date.now()+30000).toISOString(),first_dispatch_at:new Date().toISOString(),provider_id:null,provider_request_id:null};
   return {data:{status:phase,operation},error:null};
  }
  if(name==="assert_sales_team_provider_dispatch_v1")return {data:operation,error:null};
  if(name==="mark_sales_team_provider_unknown_v1"){phase="reconciliation_required";return {data:null,error:null};}
  if(name==="bind_sales_team_provider_operation_v1"){operation={...operation,provider_id:args.p_provider_id};phase="bound";return {data:operation,error:null};}
  if(name==="claim_sales_team_onboarding_link_v1")return {data:{status:linkStatus,link:{user_id:user,context,request:args.p_request,lease_token:requestId,...savedLink}},error:null};
  if(name==="mark_sales_team_onboarding_unknown_v1"){linkStatus="reconciliation_required";return {data:null,error:null};}
  if(name==="bind_sales_team_onboarding_link_v1"){linkStatus="bound";savedLink={url:args.p_url,expires_at:args.p_expires_at};return {data:null,error:null};}
  if(name==="assert_sales_team_onboarding_dispatch_v1")return {data:null,error:null};
  throw Error(name);
 });
 db.rpc=(name,args)=>rpc(name,args as Record<string,unknown>);
 const rawRequest=jest.fn(async(method:string,path:string):Promise<unknown>=>{
  if(fail)throw Error("provider unavailable");
  if(path==="/v2/core/accounts")return method==="GET"?{data:[object],next_page_url:null}:object;
  if(path.endsWith("account_links"))return {object:api==="v1"?"account_link":"v2.core.account_link",account:"acct_original",livemode:false,
   url:"https://connect.stripe.com/setup/synthetic",expires_at:api==="v1"?Math.floor(Date.now()/1000)+300:new Date(Date.now()+300000).toISOString(),lastResponse:{requestId:"req_link"}};
  return object;
 });
 const observeContext=jest.fn(async()=>context);
 const composition={admin:db as unknown as SupabaseClient,stripe:{rawRequest:rawRequest as unknown as Stripe["rawRequest"]},context,observeContext};
 return {composition,db,rpc,rawRequest,observeContext,object,fail:()=>{fail=true;},setRecipient:(r:Record<string,unknown>)=>{recipient=r;},getSetup:()=>setup};
}
test("legacy refresh makes a pinned original-account GET and records separate readiness",async()=>{
 const f=fixture();const result=await refreshTeamRecipient(f.composition,user);
 expect(result.status).toMatchObject({status:"setup_required",transfersActive:true,payoutsReady:false});
 expect(f.rawRequest).toHaveBeenCalledWith("GET","/v1/accounts/acct_original",{},{apiVersion:"2026-08-26.dahlia",maxNetworkRetries:0,timeout:10000});
 expect(f.rawRequest.mock.calls.some(([method])=>method==="POST")).toBe(false);
});
test("new v2 account uses one saved key and independently retrieves the created identity",async()=>{
 const f=fixture("v2");await refreshTeamRecipient(f.composition,user,true);await refreshTeamRecipient(f.composition,user,true);
 const writes=f.rawRequest.mock.calls.filter(([method])=>method==="POST");expect(writes).toHaveLength(1);
 expect(writes[0]).toEqual(["POST","/v2/core/accounts",recipientCreationRequest(user,setupId,"member@example.test").params,
  expect.objectContaining({apiVersion:"2026-08-26.dahlia",idempotencyKey:expect.stringMatching(/^cn-team-v1:/),maxNetworkRetries:0})]);
 expect(f.rawRequest.mock.calls.filter(([method,path])=>method==="GET"&&path==="/v2/core/accounts/acct_original")).toHaveLength(2);
});
test("refresh never starts an unadmitted recipient POST",async()=>{
 const f=fixture("v2");expect((await refreshTeamRecipient(f.composition,user)).setup?.account_id).toBeNull();expect(f.rawRequest).not.toHaveBeenCalled();
});
test("uncertain creation is independently reconciled on refresh without another POST",async()=>{
 const f=fixture("v2");f.rawRequest.mockRejectedValueOnce(Error("timeout"));
 await expect(refreshTeamRecipient(f.composition,user,true)).rejects.toMatchObject({code:"TEAM_RECIPIENT_RECOVERY_REQUIRED"});
 expect((await refreshTeamRecipient(f.composition,user)).setup?.account_id).toBe("acct_original");
 expect(f.rawRequest.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
 expect(f.rawRequest.mock.calls.some(([method,path])=>method==="GET"&&path==="/v2/core/accounts")).toBe(true);
});
test("failed verification invalidates cached capabilities while preserving account identity",async()=>{
 const f=fixture();f.setRecipient({ownership_verified:true,transfers_active:true,payouts_ready:true,verified_at:new Date().toISOString()});f.fail();
 await expect(refreshTeamRecipient(f.composition,user)).rejects.toThrow("provider unavailable");
 expect(await readTeamRecipientStatus(f.composition.admin,user)).toMatchObject({status:"verification_required",transfersActive:false,payoutsReady:false});
 expect(f.getSetup().account_id).toBe("acct_original");
});
test.each([undefined,"https://api.stripe.com/v2/core/accounts?page=2"])("incomplete reconciliation page %s never binds an uncertain creation",async next=>{
 const f=fixture("v2");f.rawRequest.mockRejectedValueOnce(Error("timeout"));
 await expect(refreshTeamRecipient(f.composition,user,true)).rejects.toMatchObject({code:"TEAM_RECIPIENT_RECOVERY_REQUIRED"});
 const original=f.rawRequest.getMockImplementation()!;
 f.rawRequest.mockImplementation(async(method,path)=>method==="GET"&&path==="/v2/core/accounts"?{data:[f.object],next_page_url:next}:original(method,path));
 await expect(refreshTeamRecipient(f.composition,user)).rejects.toMatchObject({code:"TEAM_RECIPIENT_RECOVERY_REQUIRED"});
 expect(f.rpc.mock.calls.some(([name])=>name==="bind_sales_team_provider_operation_v1")).toBe(false);
 expect(f.rawRequest.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});
test("foreign independent context evidence blocks reads and writes",async()=>{
 const f=fixture();f.observeContext.mockResolvedValueOnce({...context,platformAccountId:"acct_foreign"});
 await expect(refreshTeamRecipient(f.composition,user,true)).rejects.toThrow();expect(f.rawRequest).not.toHaveBeenCalled();expect(f.rpc).not.toHaveBeenCalled();
});
test("a setup-link timeout keeps its original identity and never repeats the link POST",async()=>{
 const f=fixture();const original=f.rawRequest.getMockImplementation()!;
 f.rawRequest.mockImplementation(async(method,path)=>{if(method==="POST")throw Error("timeout");return original(method,path);});
 await expect(startTeamRecipientOnboarding(f.composition,user,requestId)).rejects.toMatchObject({code:"TEAM_RECIPIENT_RECOVERY_REQUIRED"});
 await expect(startTeamRecipientOnboarding(f.composition,user,requestId)).rejects.toMatchObject({code:"TEAM_RECIPIENT_RECOVERY_REQUIRED"});
 expect(f.rawRequest.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});
test("successful hosted setup links are stored by request identity and reused without another POST",async()=>{
 const f=fixture();const first=await startTeamRecipientOnboarding(f.composition,user,requestId);
 expect(first.url).toBe("https://connect.stripe.com/setup/synthetic");
 expect((await startTeamRecipientOnboarding(f.composition,user,requestId)).url).toBe(first.url);
 expect(f.rawRequest.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
 const binding=f.rpc.mock.calls.find(([name])=>name==="bind_sales_team_onboarding_link_v1")![1];
 expect(binding).toMatchObject({p_request_id:requestId,p_provider_request_id:"req_link"});expect(binding).not.toHaveProperty("p_provider_id");
});
test("status holds a cached recipient after the approved account pin changes",async()=>{
 const f=fixture();f.setRecipient({ownership_verified:true,transfers_active:true,payouts_ready:true,verified_at:new Date().toISOString()});
 const original=f.rpc.getMockImplementation()!;
 f.rpc.mockImplementation((name,args)=>name==="sales_team_recipient_context_current_v1"?Promise.resolve({data:false,error:null}):original(name,args));
 expect(await readTeamRecipientStatus(f.composition.admin,user)).toMatchObject({status:"verification_required",transfersActive:false,payoutsReady:false});
});
test("expired or future cached verification never grants readiness",async()=>{
 const f=fixture();for(const time of [Date.now()-16*60000,Date.now()+60000]){
  f.setRecipient({ownership_verified:true,transfers_active:true,payouts_ready:true,verified_at:new Date(time).toISOString()});
  expect(await readTeamRecipientStatus(f.composition.admin,user)).toMatchObject({status:"verification_required",transfersActive:false,payoutsReady:false});
 }
});
