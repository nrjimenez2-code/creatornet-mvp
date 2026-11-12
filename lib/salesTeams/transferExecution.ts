import "server-only";
import type Stripe from "stripe";
import {isDeepStrictEqual} from "node:util";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {validateExactPaymentContext} from "@/lib/installments/paymentContext";
import {teamId} from "./policy";
import {runTeamProviderOperation,TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {reserveTeamEarnedTransfer,validateTeamTransferRequest,type TeamTransferRequest} from "./transferReservations";
import {inspectTeamTransferDispatch} from "./transferReadback";
import {observeTeamAdmittedTransfer} from "./transferObservations";
import type {TeamReceiptComposition} from "./receipts";

/** One supplied, bounded original task. Default execution is observation only.
 * At most one exact POST can reach the transport; unknown originals use F25's
 * independent event/debit consumer and never enter a replacement create path. */
export async function dispatchTeamEarnedTransfer(input:TeamReceiptComposition,args:{runId:string;leaseToken:string;taskId:string;requestId:string;checkId:string},admitNew=false){
 for(const value of [args.runId,args.leaseToken,args.taskId,args.requestId,args.checkId])teamId(value);
 const context=snapshotProviderJson(input.context),started=Date.now();let gets=0,posts=0,admitted:TeamTransferRequest|undefined,providerLease:string|undefined;
 const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Original transfer execution requires review");};
 const bounded=()=>check(Date.now()>=started&&Date.now()-started<65000);
 const observe=async()=>{bounded();check(isDeepStrictEqual(snapshotProviderJson(await input.observeContext()),context));bounded();return context;};
 const c:TeamReceiptComposition={...input,context,observeContext:observe,stripe:{rawRequest:async(method,path,params,options)=>{
  bounded();if(method==="POST"){
   check(admitNew&&posts===0&&Date.now()-started<45000&&original&&path===original.request.path&&isDeepStrictEqual(snapshotProviderJson(params),original.request.params)&&
    options?.apiVersion===TEAM_STRIPE_API_VERSION&&options.maxNetworkRetries===0&&options.idempotencyKey===`cn-team-v1:${original.operation_id}`);posts++;
  }else{check(method==="GET"&&gets<20);gets++;}
  const value=await input.stripe.rawRequest(method,path,params,{...options,apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:method==="POST"?10000:Math.min(10000,65000-(Date.now()-started))});
  bounded();return value;
 }}};
 const port=async<T>(phase:string,payload:Record<string,unknown>={}):Promise<T>=>{
  // An admitted outcome may drain after its worker lease/time budget. This
  // outcome-only port has no authority to issue another provider request.
  if(!['unknown','bind'].includes(phase))await observe();
  const request=input.admin.rpc("run_sales_team_transfer_execution_v1",{p_run_id:args.runId,p_lease_token:args.leaseToken,p_context:context,p_task_id:args.taskId,p_phase:phase,p_payload:payload});
  const result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);if(result.error)throw result.error;return result.data as T;
 };
 const read=async()=>{const q=await port<TeamTransferRequest>("read");validateTeamTransferRequest(c,q);check(q.id===args.requestId);return snapshotProviderJson(q);};
 const original=await read();
 const view=(status:string,completed=false,held=true)=>({requestId:args.requestId,operationId:original!.operation_id,status,completed,held});
 if(original.completed)return view("accounted",true,original.held??true);
 const account=async()=>{try{const value=await observeTeamAdmittedTransfer(c,args);return {...view(value.completed?"accounted":"reconciliation_required",value.completed,value.held??true),recorded:value.recorded};}
  catch{return view("reconciliation_required");}};
 if(original.operation){
  if(original.operation.status==="dispatching"&&Date.parse(original.operation.lease_until??"")>Date.now())return view("busy");
  return account();
 }
 if(!admitNew)return view("not_dispatched");
 const journal={rpc:async(name:string,p:Record<string,unknown>)=>{
  check(p.p_operation_id===original!.operation_id);
  let data:unknown;
  if(name==="claim_sales_team_provider_operation_v1"){
   data=await port<{status:string;operation?:{lease_token?:string}}>("claim",{operationId:p.p_operation_id,scope:p.p_scope,request:p.p_request});
   providerLease=(data as {operation?:{lease_token?:string}}).operation?.lease_token;
  }else if(name==="assert_sales_team_provider_dispatch_v1")data=await port("assert",{operationId:p.p_operation_id,leaseToken:p.p_lease_token});
  else if(name==="mark_sales_team_provider_unknown_v1")data=await port("unknown",{operationId:p.p_operation_id,leaseToken:p.p_lease_token});
  else if(name==="bind_sales_team_provider_operation_v1")data=await port("bind",{operationId:p.p_operation_id,leaseToken:providerLease,providerId:p.p_provider_id,providerRequestId:p.p_provider_request_id,reconciled:p.p_reconciled});
  else throw Error("Unsupported transfer journal operation");
  return {data,error:null};
 }};
 try{
  validateExactPaymentContext(context,await input.observeEvidence());
  await reserveTeamEarnedTransfer(c,{...args,receiptId:original.receipt_id,beneficiary:original.beneficiary});
  const result=await runTeamProviderOperation({admin:journal,scope:original.scope,context,request:original.request,observeContext:observe,
   assertSource:async()=>{
    await reserveTeamEarnedTransfer(c,{...args,receiptId:original!.receipt_id,beneficiary:original!.beneficiary});admitted=await read();
    check(admitted.operation&&!admitted.operation.provider_id&&isDeepStrictEqual(admitted.request,original!.request)&&isDeepStrictEqual(admitted.scope,original!.scope));
   },
   create:async(frozen,options)=>{check(admitted&&isDeepStrictEqual(frozen,original!.request));const value=await c.stripe.rawRequest(frozen.method,frozen.path,frozen.params,options) as unknown as Stripe.Transfer;
    return {...inspectTeamTransferDispatch(admitted,value),transfer:value};},
   retrieve:async id=>{check(admitted&&/^tr_[A-Za-z0-9]+$/.test(id));const value=await c.stripe.rawRequest("GET",`/v1/transfers/${id}`,{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000}) as unknown as Stripe.Transfer;
    check(value.id===id);return {...inspectTeamTransferDispatch(admitted,value),transfer:value};},
   reconcileUnknown:async()=>null,
   validate:value=>{check(admitted&&value.id===value.transfer.id);inspectTeamTransferDispatch(admitted,value.transfer);}
  });
  if(result.status==="busy"||result.status==="not_enabled")return view(result.status);
  return account();
 }catch{
  if(providerLease){try{await port("unknown",{operationId:original.operation_id,leaseToken:providerLease});}catch{/* Original admission remains held for its independent observer. */}}
  return view("reconciliation_required");
 }
}
