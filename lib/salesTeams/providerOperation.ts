import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { snapshotProviderJson } from "@/lib/membershipOperation";
import type { ExactPaymentContext } from "@/lib/installments/paymentContext";
import { teamId,TeamSalesError } from "./policy";

export const TEAM_STRIPE_API_VERSION="2026-08-26.dahlia";
export type TeamProviderRequest={apiVersion:string;method:"POST";path:string;params:Record<string,unknown>};
export type TeamOperationKind="recipient"|"customer"|"intent"|"confirmation"|"cancellation"|"transfer"|"reversal"|"withdrawal"|"setup"|"refund";
export type TeamOperationScope={scopeId:string;scopeKey:string;kind:TeamOperationKind;saleId:string|null;creatorId:string|null;actorId:string|null;workerRunId?:string|null};
type TeamOperation=TeamOperationScope&{id:string;request:TeamProviderRequest;context:ExactPaymentContext;status:string;
 idempotency_key:string;lease_token:string|null;lease_until:string|null;first_dispatch_at:string|null;provider_id:string|null;provider_request_id:string|null};
type Database={rpc(name:string,args:Record<string,unknown>):PromiseLike<{data:unknown;error:unknown}>};
type ProviderResult={id:string;requestId?:string};
export function teamOperationId(scope:Pick<TeamOperationScope,"scopeId"|"scopeKey"|"kind">){
 teamId(scope.scopeId);if(!scope.scopeKey||scope.scopeKey.length>200)throw Error("Invalid operation scope");
 const hex=createHash("sha256").update(`creatornet-team-v1:${scope.scopeId}:${scope.kind}:${scope.scopeKey}`).digest("hex").slice(0,32).split("");
 hex[12]="4";hex[16]="8";const s=hex.join("");return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
/** Service-only execution seam. Unknown writes receive independent original
 * provider reconciliation; this adapter never repeats an uncertain POST. */
export async function runTeamProviderOperation<T extends ProviderResult>(args:{
 admin:Database;scope:TeamOperationScope;context:ExactPaymentContext;request:TeamProviderRequest;
 observeContext:()=>Promise<ExactPaymentContext>;assertSource:()=>Promise<void>;
 create:(request:TeamProviderRequest,options:{idempotencyKey:string;apiVersion:string;maxNetworkRetries:0;timeout:10000})=>Promise<T>;
 retrieve:(id:string)=>Promise<T>;reconcileUnknown:(operationId:string)=>Promise<T|null>;
 validate:(object:T)=>void;now?:()=>number;
}):Promise<{status:"bound";object:T;operationId:string}|{status:"busy"|"not_enabled"|"reconciliation_required";operationId:string}>{
 const scope=snapshotProviderJson({...args.scope,workerRunId:args.scope.workerRunId??null}),context=snapshotProviderJson(args.context),request=snapshotProviderJson(args.request);
 const operationId=teamOperationId(scope),now=args.now??Date.now;
 const check=(value:unknown)=>{if(!value)throw new TeamSalesError("PROVIDER_OPERATION_REVIEW_REQUIRED","This original provider operation needs reconciliation.");};
 const observe=async()=>{const started=now();check(isDeepStrictEqual(await args.observeContext(),context)&&now()>=started&&now()-started<30000);};
 const rpc=async(name:string,extra:Record<string,unknown>={})=>{const result=await args.admin.rpc(name,{p_operation_id:operationId,...extra});if(result.error)throw result.error;return result.data;};
 const parse=(raw:unknown)=>{
  const op=raw as TeamOperation;check(op&&op.id===operationId&&isDeepStrictEqual(op.context,context)&&isDeepStrictEqual(op.request,request)&&
   op.scopeId===scope.scopeId&&op.scopeKey===scope.scopeKey&&op.kind===scope.kind&&op.saleId===scope.saleId&&op.creatorId===scope.creatorId&&
   op.actorId===scope.actorId&&op.idempotency_key===`cn-team-v1:${operationId}`);return op;
 };
 const validate=async(object:T)=>{args.validate(object);check(typeof object.id==="string"&&object.id.length>0);await observe();return object;};
 await observe();
 const claim=await rpc("claim_sales_team_provider_operation_v1",{p_scope:scope,p_context:context,p_request:request}) as {status:string;operation?:unknown};
 if(claim.status==="not_enabled")return {status:"not_enabled",operationId};
 let op=parse(claim.operation);
 if(op.provider_id){const object=await validate(await args.retrieve(op.provider_id));check(object.id===op.provider_id);return {status:"bound",object,operationId};}
 if(claim.status==="busy")return {status:"busy",operationId};
 if(claim.status==="reconciliation_required"){
  const original=await args.reconcileUnknown(operationId);if(!original)return {status:"reconciliation_required",operationId};
  const object=await validate(original);check(/^req_[A-Za-z0-9]+$/.test(object.requestId||""));
  await rpc("bind_sales_team_provider_operation_v1",{p_provider_id:object.id,p_provider_request_id:object.requestId,p_reconciled:true});
  return {status:"bound",object,operationId};
 }
 check(claim.status==="dispatch"&&op.lease_token&&op.lease_until&&op.first_dispatch_at);
 const admitted=()=>check(Date.parse(op.lease_until!)>now()&&Date.parse(op.first_dispatch_at!)<=now()&&now()-Date.parse(op.first_dispatch_at!)<23*3600000);
 admitted();await args.assertSource();await observe();
 op=parse(await rpc("assert_sales_team_provider_dispatch_v1",{p_lease_token:op.lease_token}));admitted();
 let created:T;
 try{created=await args.create(snapshotProviderJson(request),{idempotencyKey:op.idempotency_key,apiVersion:request.apiVersion,maxNetworkRetries:0,timeout:10000});}
 catch{
  await rpc("mark_sales_team_provider_unknown_v1",{p_lease_token:op.lease_token});
  return {status:"reconciliation_required",operationId};
 }
 const object=await validate(created);check(/^req_[A-Za-z0-9]+$/.test(object.requestId||""));
 const independent=await validate(await args.retrieve(object.id));check(independent.id===object.id);
 await rpc("bind_sales_team_provider_operation_v1",{p_provider_id:object.id,p_provider_request_id:object.requestId,p_reconciled:false});
 return {status:"bound",object:independent,operationId};
}
