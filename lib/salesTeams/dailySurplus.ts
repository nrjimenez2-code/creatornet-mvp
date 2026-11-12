import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {SupabaseClient} from "@supabase/supabase-js";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {reserveTeamDailySurplus,type TeamSurplusRequest} from "./surplusReservations";
import {dispatchTeamDailySurplus} from "./surplusExecution";
import {observeTeamDailySurplus} from "./surplusObservations";
import {recoverTeamDailySurplus} from "./surplusRecovery";
import type {TeamReceiptComposition} from "./receipts";

type Run={status:string;runId?:string;leaseToken?:string};
type StoredEvent={event_id:string;event_type:string;event_created:number;payout_id:string;request_id:string;context:TeamReceiptComposition["context"]};
type OwnedEvent={event:StoredEvent;token:string|null;recorded:boolean;finished:boolean};
/** One UTC slot and original request. Stored signed events retain their actual
 * shared claims; independent F41/F42 consumers alone supply money proof. */
export async function runTeamDailySurplus(base:TeamReceiptComposition,options:{admitNew?:boolean;now?:()=>number}={}){
 const now=options.now??Date.now,started=now(),context=snapshotProviderJson(base.context),pending=new Set<Promise<unknown>>();
 let gets=0,posts=0,rpcs=0,fresh=false,original:TeamSurplusRequest|undefined;
 const remaining=()=>{const elapsed=now()-started;if(elapsed<0||elapsed>=65000)throw Error("Daily surplus observation budget exhausted");return 65000-elapsed;};
 const current=async()=>{if(remaining()<30000)throw Error("Daily surplus context admission held");const result=await base.observeContext();remaining();if(!isDeepStrictEqual(result,context))throw Error("Daily surplus context changed");return context;};
 const admin={rpc:(name,payload,requestOptions)=>{
  if(++rpcs>60)throw Error("Daily surplus RPC limit reached");const timeout=Math.min(5000,remaining()),request=base.admin.rpc(name,payload,requestOptions);
  return typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(timeout)):request;
 },from:base.admin.from.bind(base.admin)} as SupabaseClient;
 const c:TeamReceiptComposition={...base,context,admin,observeContext:current,observeEvidence:async()=>{
  if(remaining()<30000)throw Error("Daily surplus evidence admission held");const evidence=await base.observeEvidence();remaining();return evidence;
 },stripe:{rawRequest:async(method,path,params,providerOptions)=>{
  const timeout=Math.min(10000,remaining());
  if(method==="GET"){if(++gets>32)throw Error("Daily surplus GET limit reached");}
  else if(method!=="POST"||!fresh||!original||posts!==0||remaining()<=40000||path!=="/v1/payouts"||
   !isDeepStrictEqual(params,original.request.params)||providerOptions?.idempotencyKey!==`cn-team-v1:${original.operation_id}`)throw Error("Daily surplus POST admission held");
  if(method==="POST")posts++;
  const request=base.stripe.rawRequest(method,path,params,{...providerOptions,apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout});
  pending.add(request);try{return await request;}finally{pending.delete(request);}
 }}};
 const rpc=async<T>(name:string,payload:Record<string,unknown>,cleanup=false):Promise<T>=>{
  const request=(cleanup?base.admin:admin).rpc(name,payload),result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);
  if(result.error)throw result.error;return result.data as T;
 };
 await current();const run=await rpc<Run>("claim_sales_team_surplus_run_v1",{p_run_id:randomUUID(),p_context:context,p_new:options.admitNew===true});
 if(run.status!=="claimed")return {status:run.status,bankConfirmed:false as const};
 const scope={p_run_id:run.runId!,p_lease_token:run.leaseToken!,p_context:context},events:OwnedEvent[]=[];
 let failed=false,status="review_required",moneyStatus="not_observed";
 try{
  const prepared=await reserveTeamDailySurplus(c,{runId:run.runId!,leaseToken:run.leaseToken!,requestId:randomUUID()});
  if("request" in prepared){
   original=snapshotProviderJson(prepared.request);
   fresh=prepared.status==="new"&&options.admitNew===true&&!original.operation;
   if(prepared.status==="new"){
    const outcome=await dispatchTeamDailySurplus(c,{runId:run.runId!,leaseToken:run.leaseToken!,requestId:original.id},fresh);moneyStatus=outcome.status;
   }else if(!original.operation){
    await rpc("run_sales_team_surplus_execution_v1",{...scope,p_request_id:original.id,p_phase:"cancel",p_payload:{}});moneyStatus="not_dispatched";
   }else{
    const rows=await rpc<StoredEvent[]>("read_sales_team_surplus_pending_events_v1",{...scope,p_request_id:original.id});
    if(!Array.isArray(rows)||rows.length>3)throw Error("Bounded original event list required");
    for(const event of rows){
     if(event.request_id!==original.id||!isDeepStrictEqual(event.context,context))throw Error("Original signed event changed");
     const token=randomUUID(),claim=await rpc<string>("claim_stripe_event",{p_event_id:`stripe:${event.event_id}`,p_event_type:event.event_type,p_lease_seconds:300,p_claim_token:token});
     if(claim==="busy")continue;if(!["new","duplicate"].includes(claim))throw Error("Durable original event claim required");
     const owned={event,token:claim==="new"?token:null,recorded:false,finished:false};events.push(owned);
     const admitted=await rpc<{recorded:boolean}>("begin_sales_team_surplus_event_v1",{p_event_id:event.event_id,p_event_type:event.event_type,p_event_created:event.event_created,p_payout_id:event.payout_id,p_request_id:original.id,p_context:context,p_claim_token:owned.token});owned.recorded=admitted.recorded;
    }
    const checkId=randomUUID(),operation=original.operation as {provider_id?:string|null};
    const outcome=operation.provider_id?await observeTeamDailySurplus(c,original.id,checkId):await recoverTeamDailySurplus(c,original.id,checkId);moneyStatus=outcome.status;
    if("complete" in outcome&&outcome.complete===true&&outcome.bankConfirmed===false){
     for(const owned of events){
      if(!owned.recorded)await rpc("complete_sales_team_surplus_event_v1",{p_event_id:owned.event.event_id,p_claim_token:owned.token,p_check_id:checkId,p_context:context});
      if(owned.token){const done=await rpc<boolean>("complete_stripe_event",{p_event_id:`stripe:${owned.event.event_id}`,p_claim_token:owned.token});if(done!==true)throw Error("Original event completion claim changed");}
      owned.finished=true;
     }
    }
   }
  }else moneyStatus=prepared.status;
 }catch{failed=true;}finally{
  fresh=false;await Promise.allSettled([...pending]);
  for(const owned of events)if(owned.token&&!owned.finished){try{await rpc("release_stripe_event",{p_event_id:`stripe:${owned.event.event_id}`,p_claim_token:owned.token},true);}catch{failed=true;}}
  status=(await rpc<{status:string}>("finish_sales_team_surplus_run_v1",{...scope,p_failed:failed},true)).status;
 }
 return {status,moneyStatus,requestId:original?.id??null,bankConfirmed:false as const};
}
