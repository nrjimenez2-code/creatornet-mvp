import {validateTeamSurplusRequest,type TeamSurplusRequest} from "@/lib/salesTeams/surplusReservations";
import {teamOperationId} from "@/lib/salesTeams/providerOperation";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1" as const,mode:"test" as const,platformAccountId:"acct_platform",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
function fixture():TeamSurplusRequest{
 const scope={scopeId:id(1),scopeKey:"surplus:v1",kind:"withdrawal" as const,saleId:null,creatorId:null,actorId:null,workerRunId:id(2)},operationId=teamOperationId(scope);
 return {id:id(1),operation_id:operationId,original_worker_run_id:id(2),read_id:id(3),amount_cents:5000,cost_reserve_cents:20,destination_id:"ba_approved",context,
  policy:{context,destination_id:"ba_approved",minimum_cents:50,maximum_cents:5000,cost_reserve_cents:20,prerequisites_verified:true,contract_sha256:"a".repeat(64),revision:1},
  protection:{scope:"synthetic protocol fixture only"},scope,operation:null,resolved:false,
  request:{method:"POST",apiVersion:"2026-08-26.dahlia",path:"/v1/payouts",params:{amount:5000,currency:"usd",destination:"ba_approved",method:"standard",source_type:"card",metadata:{team_protocol:"creatornet-team-surplus-v1",team_surplus_request_id:id(1),team_provider_operation_id:operationId}}}};
}
test("an exact frozen protected-surplus request can be inspected without a provider client",()=>{expect(()=>validateTeamSurplusRequest({context},fixture())).not.toThrow();});
test.each(["amount","destination","cost","context","worker","actor","method","path","metadata","approval"])("changed %s cannot redirect an original surplus request",fault=>{
 const q=fixture();
 if(fault==="amount")q.amount_cents++;
 if(fault==="destination")q.destination_id="ba_foreign";
 if(fault==="cost")q.cost_reserve_cents=0;
 if(fault==="context")q.context={...context,platformAccountId:"acct_foreign"};
 if(fault==="worker")q.scope={...q.scope,workerRunId:id(4)};
 if(fault==="actor")q.scope={...q.scope,actorId:id(4)};
 if(fault==="method")q.request.params={...q.request.params,method:"instant"};
 if(fault==="path")q.request.path="/v1/transfers";
 if(fault==="metadata")q.request.params={...q.request.params,metadata:{team_protocol:"foreign"}};
 if(fault==="approval")q.policy={...q.policy,prerequisites_verified:false};
 expect(()=>validateTeamSurplusRequest({context},q)).toThrow(/surplus requires review/);
});
