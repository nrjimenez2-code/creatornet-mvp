import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {validateExactPaymentContext} from "@/lib/installments/paymentContext";
import {teamId} from "./policy";
import {runTeamProviderOperation,TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {readTeamCashProof} from "./cashReadback";
import {validateTeamSurplusRequest,type TeamSurplusRequest} from "./surplusReservations";
import {inspectTeamSurplusPayout,type TeamSurplusMoneySource} from "./surplusPayoutPolicy";
import {readTeamSurplusDestination} from "./surplusPayoutReadback";
import {observeTeamDailySurplus} from "./surplusObservations";
import type {TeamReceiptComposition} from "./receipts";

/** One reserved original, at most one POST. No global client, scheduler, bank
 * configuration, unknown-create replay or bank-confirmation authority. */
export async function dispatchTeamDailySurplus(input:TeamReceiptComposition,args:{runId:string;leaseToken:string;requestId:string},admitNew=false){
 for(const value of [args.runId,args.leaseToken,args.requestId])teamId(value);
 const context=snapshotProviderJson(input.context),started=Date.now(),pending=new Set<Promise<unknown>>(),requestIds=new Set<string>();
 let gets=0,posts=0,original:TeamSurplusRequest,admitted:TeamSurplusMoneySource|undefined,providerLease:string|undefined;
 const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Original surplus execution requires review");};
 const bounded=()=>check(Date.now()>=started&&Date.now()-started<65000);
 const observe=async()=>{bounded();check(isDeepStrictEqual(snapshotProviderJson(await input.observeContext()),context));bounded();return context;};
 const c:TeamReceiptComposition={...input,context,observeContext:observe,stripe:{rawRequest:async(method,path,params,options)=>{
  bounded();
  if(method==="POST"){
   check(admitNew&&posts===0&&Date.now()-started<45000&&admitted&&path===original.request.path&&isDeepStrictEqual(snapshotProviderJson(params),original.request.params)&&
    options?.idempotencyKey===`cn-team-v1:${original.operation_id}`&&options.apiVersion===TEAM_STRIPE_API_VERSION&&options.maxNetworkRetries===0);posts++;
  }else{check(method==="GET"&&gets<24);gets++;}
  const request=input.stripe.rawRequest(method,path,params,{...options,apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:Math.max(1,Math.min(10000,65000-(Date.now()-started)))});pending.add(request);
  try{const value=await request;bounded();const id=(value as {lastResponse?:{requestId?:string}}).lastResponse?.requestId;check(typeof id==="string"&&/^req_[A-Za-z0-9]+$/.test(id)&&!requestIds.has(id));requestIds.add(id);return value;}finally{pending.delete(request);}
 }}};
 const rpc=async<T>(name:string,payload:Record<string,unknown>):Promise<T>=>{
  const request=input.admin.rpc(name,payload),result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);if(result.error)throw result.error;return result.data as T;
 };
 const port=async<T>(phase:string,payload:Record<string,unknown>={}):Promise<T>=>{
  if(!["unknown","bind"].includes(phase))await observe();
  return rpc<T>("run_sales_team_surplus_execution_v1",{p_run_id:args.runId,p_lease_token:args.leaseToken,p_context:context,p_request_id:args.requestId,p_phase:phase,p_payload:payload});
 };
 const read=async()=>{const q=await port<TeamSurplusRequest>("read");validateTeamSurplusRequest(c,q);check(q.id===args.requestId);return snapshotProviderJson(q);};
 const view=(status:string,extra:Record<string,unknown>={})=>({requestId:args.requestId,operationId:original.operation_id,status,bankConfirmed:false,...extra});
 const account=()=>observeTeamDailySurplus(c,args.requestId);
 const fresh=async()=>{
  check(Date.now()-started<45000);const readId=randomUUID(),scope={p_run_id:args.runId,p_lease_token:args.leaseToken,p_context:context,p_read_id:readId};
  await observe();await rpc("begin_sales_team_surplus_cash_v1",scope);
  const [cash,destination]=await Promise.all([
   readTeamCashProof(context,observe,async timeout=>await c.stripe.rawRequest("GET","/v1/balance",{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout}) as unknown as Stripe.Response<Stripe.Balance>),
   readTeamSurplusDestination(c,original),
  ]);
  await rpc("complete_sales_team_surplus_cash_v1",{...scope,p_proof:cash});
  await port("check",{checkId:randomUUID(),readId,proof:destination});
 };
 try{
  original=await read();
  if(original.operation){
   const op=original.operation as TeamSurplusMoneySource["operation"];
   if(op.status==="bound")return await account();
   return view("reconciliation_required");
  }
  if(original.resolved)return view("not_dispatched");
  if(!admitNew)return view("not_dispatched");
  validateExactPaymentContext(context,await input.observeEvidence());await fresh();
  const journal={rpc:async(name:string,p:Record<string,unknown>)=>{
   check(p.p_operation_id===original.operation_id);let data:unknown;
   if(name==="claim_sales_team_provider_operation_v1"){
    data=await port<{status:string;operation?:{lease_token?:string}}>("claim",{operationId:p.p_operation_id,scope:p.p_scope,request:p.p_request});providerLease=(data as {operation?:{lease_token?:string}}).operation?.lease_token;
   }else if(name==="assert_sales_team_provider_dispatch_v1")data=await port("assert",{operationId:p.p_operation_id,leaseToken:p.p_lease_token});
   else if(name==="mark_sales_team_provider_unknown_v1")data=await port("unknown",{operationId:p.p_operation_id,leaseToken:p.p_lease_token});
   else if(name==="bind_sales_team_provider_operation_v1")data=await port("bind",{operationId:p.p_operation_id,leaseToken:providerLease,providerId:p.p_provider_id,providerRequestId:p.p_provider_request_id});
   else throw Error("Unsupported surplus journal operation");return {data,error:null};
  }};
  const result=await runTeamProviderOperation({admin:journal,scope:original.scope,context,request:original.request,observeContext:observe,
   assertSource:async()=>{await fresh();const q=await read();check(q.operation&&isDeepStrictEqual(q.request,original.request)&&isDeepStrictEqual(q.scope,original.scope));admitted=q as TeamSurplusMoneySource;},
   create:async(frozen,options)=>{
    check(admitted&&isDeepStrictEqual(frozen,original.request));validateExactPaymentContext(context,await input.observeEvidence());
    await port("dispatch",{operationId:original.operation_id,leaseToken:providerLease});
    const payout=await c.stripe.rawRequest(frozen.method,frozen.path,frozen.params,options) as unknown as Stripe.Response<Stripe.Payout>;
    const proof=inspectTeamSurplusPayout(admitted,payout,payout.id,Math.floor(Date.now()/1000));return {id:proof.id,requestId:payout.lastResponse.requestId,payout};
   },
   retrieve:async id=>{check(admitted&&/^po_[A-Za-z0-9]+$/.test(id));const payout=await c.stripe.rawRequest("GET",`/v1/payouts/${id}`,{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000}) as unknown as Stripe.Response<Stripe.Payout>;
    const proof=inspectTeamSurplusPayout(admitted,payout,id,Math.floor(Date.now()/1000));return {id:proof.id,requestId:payout.lastResponse.requestId,payout};},
   reconcileUnknown:async()=>null,
   validate:value=>{check(admitted&&value.id===value.payout.id);inspectTeamSurplusPayout(admitted,value.payout,value.id,Math.floor(Date.now()/1000));},
  });
  if(result.status!=="bound")return view(result.status);return await account();
 }catch{
  if(providerLease){try{await port("unknown",{operationId:original!.operation_id,leaseToken:providerLease});}catch{/* The immutable original remains reserved for independent recovery. */}}
  if(!original!)throw Error("Original surplus task requires review");return view("reconciliation_required");
 }finally{await Promise.allSettled([...pending]);}
}
