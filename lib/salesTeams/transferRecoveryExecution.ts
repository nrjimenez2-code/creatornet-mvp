import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {validateExactPaymentContext} from "@/lib/installments/paymentContext";
import {teamId} from "./policy";
import {runTeamProviderOperation,TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {validateTeamTransferRecoveryRequest,type TeamTransferRecoveryRequest} from "./transferRecoveryReservations";
import {readTeamOriginalTransferForRecovery} from "./transferReversalReadback";
import {observeTeamBoundTransferReversal} from "./transferReversalObservations";
import {readTeamCashProof} from "./cashReadback";
import {readTeamFinancialSnapshot,type TeamEventSource} from "./financialReadback";
import type {TeamReceiptComposition} from "./receipts";

type Original=TeamTransferRecoveryRequest&{held:boolean;source_ready:boolean;financial_check_id:string;new_allowed:boolean};
const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Original transfer recovery execution requires review");};
const objectId=(value:unknown)=>typeof value==="string"?value:(value as {id?:string}|null)?.id??"";
function inspect(p:Original,r:Stripe.TransferReversal){
 validateTeamTransferRecoveryRequest({context:p.context},p);const op=p.operation;
 check(op&&op.id===p.operation_id&&op.idempotency_key===`cn-team-v1:${p.operation_id}`&&isDeepStrictEqual(op.context,p.context)&&isDeepStrictEqual(op.request,p.request)&&
  isDeepStrictEqual({scopeId:op.scopeId,scopeKey:op.scopeKey,kind:op.kind,saleId:op.saleId,creatorId:op.creatorId,actorId:op.actorId,workerRunId:op.workerRunId},p.scope)&&
  ['dispatching','unknown','bound'].includes(op.status)&&Number.isFinite(Date.parse(op.first_dispatch_at))&&Date.parse(op.first_dispatch_at)<=Date.now()+5000);
 check(r.object==="transfer_reversal"&&/^trr_[A-Za-z0-9]+$/.test(r.id)&&objectId(r.transfer)===p.transfer.operation!.provider_id&&r.amount===Number(p.amount_cents)&&r.currency==="usd"&&
  Number.isSafeInteger(r.created)&&r.created>=Math.floor(Date.parse(op.first_dispatch_at)/1000)-5&&r.created>=Math.floor(Date.parse(p.transfer.operation!.first_dispatch_at)/1000)-5&&r.created<=Math.floor(Date.now()/1000)+5&&
  isDeepStrictEqual(snapshotProviderJson(r.metadata),p.request.params.metadata)&&r.source_refund===null&&(r.destination_payment_refund===null||/^pyr_[A-Za-z0-9]+$/.test(objectId(r.destination_payment_refund)))&&
  (r.balance_transaction===null||/^txn_[A-Za-z0-9]+$/.test(objectId(r.balance_transaction))));
 return {id:r.id,transferId:objectId(r.transfer),amount:r.amount,currency:r.currency,created:r.created,metadata:snapshotProviderJson(r.metadata)};
}

/** One frozen reservation, one actual execution worker. Observation is the
 * default. Unknown outcomes keep their original key for separate event proof.
 * At most 40 GETs, one POST, 65s total and a 45s POST cutoff; no transport retries. */
export async function dispatchTeamTransferRecovery(input:TeamReceiptComposition,args:{runId:string;leaseToken:string;taskId:string;requestId:string;checkId:string},admitNew=false){
 for(const value of [args.runId,args.leaseToken,args.taskId,args.requestId,args.checkId])teamId(value);
 const context=snapshotProviderJson(input.context),started=Date.now();let gets=0,posts=0,admitted:Original|undefined,providerLease:string|undefined;
 let postIdentity:ReturnType<typeof inspect>|undefined,postRequestId:string|undefined;
 const bounded=()=>check(Date.now()>=started&&Date.now()-started<65000);
 const observe=async()=>{bounded();check(isDeepStrictEqual(snapshotProviderJson(await input.observeContext()),context));bounded();return context;};
 const c:TeamReceiptComposition={...input,context,observeContext:observe,stripe:{rawRequest:async(method,path,params,options)=>{
  bounded();if(method==="POST"){
   check(admitNew&&posts===0&&Date.now()-started<45000&&original&&path===original.request.path&&isDeepStrictEqual(snapshotProviderJson(params),original.request.params)&&
    options?.apiVersion===TEAM_STRIPE_API_VERSION&&options.maxNetworkRetries===0&&options.idempotencyKey===`cn-team-v1:${original.operation_id}`);posts++;
  }else{check(method==="GET"&&gets<40);gets++;}
  const value=await input.stripe.rawRequest(method,path,params,{...options,apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:method==="POST"?10000:Math.min(10000,65000-(Date.now()-started))});bounded();return value;
 }}};
 const port=async<T>(phase:string,payload:Record<string,unknown>={}):Promise<T>=>{
  if(!['unknown','bind'].includes(phase))await observe();
  const request=input.admin.rpc("run_sales_team_transfer_recovery_execution_v1",{p_run_id:args.runId,p_lease_token:args.leaseToken,p_context:context,p_task_id:args.taskId,p_phase:phase,p_payload:payload});
  const result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);if(result.error)throw result.error;return result.data as T;
 };
 const read=async()=>{const p=await port<Original>("read");validateTeamTransferRecoveryRequest(c,p);check(p.id===args.requestId);return snapshotProviderJson(p);};
 const original=await read(),view=(status:string,completed=false,held=true)=>({requestId:original.id,operationId:original.operation_id,status,completed,held});
 if(original.completed)return view("accounted",true,original.held);
 if(original.canceled)return view("canceled",false,false);
 const account=async()=>{try{const observed=await observeTeamBoundTransferReversal(c,{...args,operationId:original.operation_id});return {...view(observed.completed?"accounted":"reconciliation_required",observed.completed,observed.held),recorded:observed.recorded};}catch{return view("reconciliation_required");}};
 if(original.operation){
  if(original.operation.provider_id)return account();
  return view(original.operation.status==="dispatching"&&Date.parse(original.operation.lease_until??"")>Date.now()?"busy":"reconciliation_required");
 }
 if(!admitNew)return view("not_dispatched");if(!original.new_allowed)return view("not_enabled");
 const cashRpc=async(name:string,readId:string,extra:Record<string,unknown>={})=>{
  await observe();const request=input.admin.rpc(name,{p_run_id:args.runId,p_lease_token:args.leaseToken,p_context:context,p_read_id:readId,...extra});
  const result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);if(result.error)throw result.error;
 };
 const refresh=async()=>{
  const checkId=randomUUID(),begun=await port<{readId:string;transfer:Original["transfer"]}>("begin_check",{checkId});check(begun.readId===checkId&&begun.transfer.id===original.transfer_request_id);
  const proof=await readTeamOriginalTransferForRecovery(c,begun.transfer);check((await port<{ready:boolean}>("complete_check",{checkId,proof})).ready);
  const readId=randomUUID();await cashRpc("begin_sales_team_settlement_cash_v1",readId);
  const cash=await readTeamCashProof(context,observe,async timeout=>await c.stripe.rawRequest("GET","/v1/balance",{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout}) as unknown as Stripe.Response<Stripe.Balance>);
  await cashRpc("complete_sales_team_settlement_cash_v1",readId,{p_proof:cash});check((await port<{ready:boolean}>("recheck",{checkId,readId})).ready);
 };
 const journal={rpc:async(name:string,p:Record<string,unknown>)=>{
  check(p.p_operation_id===original.operation_id);let data:unknown;
  if(name==="claim_sales_team_provider_operation_v1"){
   data=await port<{operation?:{lease_token?:string}}>("claim",{operationId:p.p_operation_id,scope:p.p_scope,request:p.p_request});providerLease=(data as {operation?:{lease_token?:string}}).operation?.lease_token;
  }else if(name==="assert_sales_team_provider_dispatch_v1")data=await port("assert",{operationId:p.p_operation_id,leaseToken:p.p_lease_token});
  else if(name==="mark_sales_team_provider_unknown_v1")data=await port("unknown",{operationId:p.p_operation_id,leaseToken:p.p_lease_token});
  else if(name==="bind_sales_team_provider_operation_v1")data=await port("bind",{operationId:p.p_operation_id,leaseToken:providerLease,providerId:p.p_provider_id,providerRequestId:p.p_provider_request_id,reconciled:p.p_reconciled});
  else throw Error("Unsupported original recovery journal operation");return {data,error:null};
 }};
 try{
  validateExactPaymentContext(context,await input.observeEvidence());await observe();
  if(!original.source_ready){
   const begun=await port<{checkId:string;completed:boolean;held:boolean;source:TeamEventSource}>("begin_financial");check(begun.checkId===original.financial_check_id);
   const checked=begun.completed?begun:await(async()=>{const fresh=await readTeamFinancialSnapshot(c,begun.source,{eventId:null,balances:true});return port<{held:boolean}>("complete_financial",{revision:fresh.revision,snapshot:fresh.snapshot});})();check(!checked.held);
  }
  if((await port<{canceled:boolean}>("unsent")).canceled)return view("canceled",false,false);
  await refresh();
  const result=await runTeamProviderOperation({admin:journal,scope:original.scope,context,request:original.request,observeContext:observe,
   assertSource:async()=>{await refresh();admitted=await read();check(admitted.operation&&!admitted.operation.provider_id&&isDeepStrictEqual(admitted.request,original.request)&&isDeepStrictEqual(admitted.scope,original.scope));},
   create:async(frozen,options)=>{
    check(admitted&&isDeepStrictEqual(frozen,original.request));const reversal=await c.stripe.rawRequest(frozen.method,frozen.path,frozen.params,options) as unknown as Stripe.Response<Stripe.TransferReversal>;
    postIdentity=inspect(admitted,reversal);postRequestId=reversal.lastResponse?.requestId;check(/^req_[A-Za-z0-9]+$/.test(postRequestId??""));return {id:reversal.id,requestId:postRequestId,reversal};
   },
   retrieve:async id=>{
    check(admitted&&/^trr_[A-Za-z0-9]+$/.test(id));const reversal=await c.stripe.rawRequest("GET",`${original.request.path}/${id}`,{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000}) as unknown as Stripe.Response<Stripe.TransferReversal>;
    check(reversal.id===id&&/^req_[A-Za-z0-9]+$/.test(reversal.lastResponse?.requestId??"")&&reversal.lastResponse.requestId!==postRequestId&&(!postIdentity||isDeepStrictEqual(postIdentity,inspect(admitted,reversal))));return {id,requestId:reversal.lastResponse.requestId,reversal};
   },reconcileUnknown:async()=>null,validate:value=>{check(admitted&&value.id===value.reversal.id);inspect(admitted,value.reversal);}
  });
  if(result.status==="busy"||result.status==="not_enabled")return view(result.status);return account();
 }catch{
  if(providerLease){try{await port("unknown",{operationId:original.operation_id,leaseToken:providerLease});}catch{/* Preserve this exact journal for independent original recovery. */}}
  return view("reconciliation_required");
 }
}
