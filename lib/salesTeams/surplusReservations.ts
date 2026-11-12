import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {teamId} from "./policy";
import {readTeamCashProof} from "./cashReadback";
import {TEAM_STRIPE_API_VERSION,teamOperationId,type TeamOperationScope,type TeamProviderRequest} from "./providerOperation";
import type {TeamReceiptComposition} from "./receipts";

export type TeamSurplusRequest={id:string;operation_id:string;original_worker_run_id:string;read_id:string;amount_cents:number;cost_reserve_cents:number;destination_id:string;
 context:TeamReceiptComposition["context"];policy:{context:TeamReceiptComposition["context"];destination_id:string;minimum_cents:number;maximum_cents:number;cost_reserve_cents:number;prerequisites_verified:boolean;contract_sha256:string;revision:number};
 protection:unknown;request:TeamProviderRequest;scope:TeamOperationScope;operation:unknown;resolved:boolean};
export type TeamSurplusPreparation={status:"new"|"original";request:TeamSurplusRequest}|{status:"held"|"insufficient_surplus"|"cash_required"};

export function validateTeamSurplusRequest(c:Pick<TeamReceiptComposition,"context">,q:TeamSurplusRequest){
 const check=(v:unknown)=>{if(!v)throw Error("Original protected surplus requires review");};
 for(const value of [q.id,q.operation_id,q.original_worker_run_id,q.read_id])teamId(value);
 const amount=Number(q.amount_cents),cost=Number(q.cost_reserve_cents),policy=q.policy;
 check(isDeepStrictEqual(q.context,c.context)&&isDeepStrictEqual(policy.context,c.context)&&Number.isSafeInteger(amount)&&amount>=1&&amount<=99999999&&
  Number.isSafeInteger(cost)&&cost>=0&&/^ba_[A-Za-z0-9]+$/.test(q.destination_id)&&q.destination_id===policy.destination_id&&policy.prerequisites_verified===true&&
  Number.isSafeInteger(Number(policy.minimum_cents))&&Number.isSafeInteger(Number(policy.maximum_cents))&&Number(policy.minimum_cents)>=1&&Number(policy.maximum_cents)<=99999999&&
  amount>=Number(policy.minimum_cents)&&amount<=Number(policy.maximum_cents)&&cost===Number(policy.cost_reserve_cents)&&/^[a-f0-9]{64}$/.test(policy.contract_sha256)&&Number.isSafeInteger(Number(policy.revision))&&Number(policy.revision)>0&&
  isDeepStrictEqual(q.scope,{scopeId:q.id,scopeKey:"surplus:v1",kind:"withdrawal",saleId:null,creatorId:null,actorId:null,workerRunId:q.original_worker_run_id})&&teamOperationId(q.scope)===q.operation_id);
 const expected:TeamProviderRequest={apiVersion:TEAM_STRIPE_API_VERSION,method:"POST",path:"/v1/payouts",params:{amount,currency:"usd",destination:q.destination_id,method:"standard",source_type:"card",
  metadata:{team_protocol:"creatornet-team-surplus-v1",team_surplus_request_id:q.id,team_provider_operation_id:q.operation_id}}};
 check(isDeepStrictEqual(q.request,expected));
}

/** Reserves an exact server-derived daily surplus. Only the existing independent
 * balance reader performs provider GETs. This adapter never dispatches a payout,
 * resolves an unknown journal, releases a reservation or confirms bank receipt. */
export async function reserveTeamDailySurplus(c:TeamReceiptComposition,args:{runId:string;leaseToken:string;requestId:string}){
 for(const value of [args.runId,args.leaseToken,args.requestId])teamId(value);
 const scope={p_run_id:args.runId,p_lease_token:args.leaseToken,p_context:c.context};
 const rpc=async<T>(name:string,extra:Record<string,unknown>={}):Promise<T>=>{
  if(!isDeepStrictEqual(await c.observeContext(),c.context))throw Error("Surplus context changed");
  const request=c.admin.rpc(name,{...scope,...extra}),result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);
  if(result.error)throw result.error;return result.data as T;
 };
 const prepare=(readId:string|null)=>rpc<TeamSurplusPreparation>("prepare_sales_team_surplus_v1",{p_request_id:args.requestId,p_read_id:readId});
 let prepared=await prepare(null);
 if(prepared.status==="cash_required"){
  const readId=randomUUID();await rpc("begin_sales_team_surplus_cash_v1",{p_read_id:readId});
  const proof=await readTeamCashProof(c.context,c.observeContext,async timeout=>await c.stripe.rawRequest("GET","/v1/balance",{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout}) as unknown as Stripe.Response<Stripe.Balance>);
  await rpc("complete_sales_team_surplus_cash_v1",{p_read_id:readId,p_proof:proof});prepared=await prepare(readId);
 }
 if("request" in prepared){validateTeamSurplusRequest(c,prepared.request);if(prepared.status==="new"&&prepared.request.id!==args.requestId)throw Error("Original surplus request changed");}
 return prepared;
}
