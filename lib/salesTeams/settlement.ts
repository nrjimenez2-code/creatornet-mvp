import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {reserveTeamEarnedTransfer} from "./transferReservations";
import {dispatchTeamEarnedTransfer} from "./transferExecution";
import {readTeamFinancialSnapshot,type TeamEventSource} from "./financialReadback";
import {observeTeamRecipient,type TeamRecipientSetup} from "./recipientPolicy";
import type {TeamReceiptComposition} from "./receipts";

type Plan={id:string;kind:"original"|"earned";receipt_id:string;beneficiary:"creator"|"closer";request_id:string;task_id:string;
 financial_check_id:string;transfer_check_id:string;recipient_source:TeamRecipientSetup|null;source_ready:boolean};
type Claim={status:"claimed"|"held"|"idle"|"busy"|"slot_consumed";runId?:string;leaseToken?:string};
/** At most three durable plans in one 15-minute slot. Existing originals retain
 * priority; every new share uses current financial/recipient evidence. A run's
 * observation-only authority cannot become fresh transfer authority. */
export async function runTeamAutomaticSettlement(c:TeamReceiptComposition,options:{admitNew?:boolean;now?:()=>number}={}){
 const now=options.now??Date.now,started=now(),context=snapshotProviderJson(c.context),pending=new Set<Promise<unknown>>();let gets=0,posts=0;
 const bounded=()=>{if(now()<started||now()-started>=65000)throw Error("Settlement observation budget exhausted");};
 const current=async()=>{bounded();if(!isDeepStrictEqual(snapshotProviderJson(await c.observeContext()),context))throw Error("Settlement context changed");bounded();};
 const rpc=async<T>(name:string,args:Record<string,unknown>):Promise<T>=>{const request=c.admin.rpc(name,args);const result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);if(result.error)throw result.error;return result.data as T;};
 await current();const claim=await rpc<Claim>("claim_sales_team_automatic_settlement_v1",{p_run_id:randomUUID(),p_context:context,p_new:options.admitNew===true});
 if(claim.status!=="claimed")return {status:claim.status,settled:0,held:0};
 const scope={p_run_id:claim.runId!,p_lease_token:claim.leaseToken!,p_context:context};let settled=0,held=0,canceled=0,failed=false;
 const reader:TeamReceiptComposition={...c,context,observeContext:async()=>{await current();return context;},observeEvidence:async()=>{bounded();const evidence=await c.observeEvidence();bounded();return evidence;},stripe:{rawRequest:async(method,path,params,providerOptions)=>{
  bounded();if(method==="GET"){if(++gets>40)throw Error("Settlement GET limit reached");}
  else if(method!=="POST"||path!=="/v1/transfers"||!options.admitNew||++posts>3||now()-started>=45000)throw Error("Settlement write admission held");
  const request=c.stripe.rawRequest(method,path,params,{...providerOptions,apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:method==="POST"?10000:Math.min(10000,65000-(now()-started))});
  pending.add(request);try{return await request;}finally{pending.delete(request);}
 }}};
 const drain=async()=>{await Promise.allSettled([...pending]);};
 try{
  for(let n=0;n<3&&now()>=started&&now()-started<50000;n++){
   await current();const allowNew=options.admitNew===true&&gets<=28&&now()-started<25000;
   const plan=await rpc<Plan|null>("next_sales_team_settlement_plan_v1",{...scope,p_new:allowNew,p_refresh:gets<=10&&now()-started<15000});if(!plan)break;
   let taskHeld=true,recipientAttempted=false,canceledPlan=false;
   const phase=<T>(p_phase:string,p_payload:Record<string,unknown>={})=>rpc<T>("run_sales_team_settlement_plan_v1",{...scope,p_plan_id:plan.id,p_phase,p_payload});
   try{
    if(plan.kind==="earned"){
     if(!allowNew)throw Error("New settlement admission held");
     const unsent=await phase<{canceled:boolean}>("unsent");
     if(unsent.canceled){taskHeld=false;canceledPlan=true;}
     else{
     if(!plan.source_ready){
      const begun=await phase<{checkId:string;completed:boolean;held:boolean;source:TeamEventSource}>("begin_financial");
      if(begun.checkId!==plan.financial_check_id)throw Error("Original settlement financial check changed");
      const checked=begun.completed?begun:await(async()=>{const fresh=await readTeamFinancialSnapshot(reader,begun.source,{eventId:null,balances:true});await current();return phase<{held:boolean}>("complete_financial",{revision:fresh.revision,snapshot:fresh.snapshot});})();
      if(checked.held)throw Error("Current financial evidence remains held");
      const saved=plan.recipient_source;if(!saved?.account_id||!isDeepStrictEqual(saved.context,context))throw Error("Original settlement recipient required");
      recipientAttempted=true;const path=`${saved.api==="v1"?"/v1/accounts/":"/v2/core/accounts/"}${saved.account_id}`,params=saved.api==="v2"?{include:["configuration.recipient","defaults","identity","requirements"]}:{};
      const get=async()=>{const value=await reader.stripe.rawRequest("GET",path,params,{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000}) as unknown as {lastResponse?:{requestId?:string}};return observeTeamRecipient(saved,value,value.lastResponse?.requestId??"");};
      const first=await get(),second=await get();await current();const ready=await phase<{ready:boolean}>("recipient",{first,second});recipientAttempted=false;if(!ready.ready)throw Error("Recipient capabilities remain held");
     }
     await reserveTeamEarnedTransfer(reader,{runId:claim.runId!,leaseToken:claim.leaseToken!,taskId:plan.task_id,requestId:plan.request_id,receiptId:plan.receipt_id,beneficiary:plan.beneficiary});
     }
    }
    if(!canceledPlan){
    const result=await dispatchTeamEarnedTransfer(reader,{runId:claim.runId!,leaseToken:claim.leaseToken!,taskId:plan.task_id,requestId:plan.request_id,checkId:plan.transfer_check_id},plan.kind==="earned"&&allowNew);
    taskHeld=!result.completed||result.held;
    }
   }catch{
    await drain();if(recipientAttempted){try{await phase("recipient",{first:null,second:null});}catch{/* No original account is replaced after a failed observation. */}}
   }
   await drain();const result=await rpc<{held:boolean;settled:boolean;canceled?:boolean}>("finish_sales_team_settlement_plan_v1",{...scope,p_plan_id:plan.id,p_held:taskHeld});if(result.held)held++;else if(result.canceled)canceled++;else if(result.settled)settled++;
  }
 }catch(error){failed=true;throw error;}finally{await drain();await rpc("finish_sales_team_automatic_settlement_v1",{...scope,p_failed:failed});}
 return {status:held?"review_required":"complete",settled,held,...(canceled?{canceled}:{})};
}
