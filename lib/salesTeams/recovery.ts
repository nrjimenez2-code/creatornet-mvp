import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import type {TeamReceiptComposition} from "./receipts";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {readTeamFinancialSnapshot,observeTeamPaymentEvent,type TeamEventSource} from "./financialReadback";
import {refreshTeamBoundCollection} from "./collection";
import {inspectSharedCashOriginal} from "./sharedCashChecks";
import type {SharedCashOriginal} from "./sharedCashReadback";
import {observeTeamRecipient,type TeamRecipientSetup} from "./recipientPolicy";
import {recoverTeamWorkerRefund} from "./workerRefunds";
import {inspectSharedUnsentRecovery} from "./sharedUnsentRecovery";

type Task={id:string;kind:"financial"|"event"|"shared_cash"|"recipient"|"fulfillment"|"refund";source_id:string;source:Record<string,unknown>};
type Claim={status:"held"|"busy"|"slot_consumed"|"claimed";runId?:string;leaseToken?:string};
/** Three durable tasks, at most forty object GETs, no retries or provider writes.
 * Context observations have their existing independent timeouts. Leases and
 * immutable results preserve uncertain invocations if a process disappears. */
export async function runTeamAutomaticRecovery(c:TeamReceiptComposition,options:{now?:()=>number;fulfill?:boolean;recoverRefunds?:boolean;recoverSharedUnsent?:boolean}={}){
 const now=options.now??Date.now,started=now();
 const bounded=()=>{if(now()<started||now()-started>=45000)throw Error("Recovery observation budget exhausted");};
 const current=async()=>{bounded();if(!isDeepStrictEqual(await c.observeContext(),c.context))throw Error("Recovery context changed");bounded();};
 const rpc=async<T>(name:string,args:Record<string,unknown>):Promise<T>=>{const request=c.admin.rpc(name,args);const result=await (typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);if(result.error)throw result.error;return result.data as T;};
 await current();const claimed=await rpc<Claim>("claim_sales_team_recovery_run_v1",{p_run_id:randomUUID(),p_context:c.context});
 if(claimed.status!=="claimed")return {status:claimed.status,observed:0,held:0};
 const runId=claimed.runId!,leaseToken=claimed.leaseToken!,scope={p_run_id:runId,p_lease_token:leaseToken,p_context:c.context};
 let count=0,observed=0,held=0,failed=false;
 const pending=new Set<Promise<unknown>>();
 const raw=(async(method:string,path:string,params:Record<string,unknown>={},providerOptions:Record<string,unknown>={})=>{
  bounded();if(method!=="GET"||++count>40||!/^\/v[12]\/[A-Za-z0-9_./-]+$/.test(path))throw Error("Recovery permits bounded original GETs only");
  const request=c.stripe.rawRequest("GET",path,params,{...providerOptions,apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:Math.min(10000,45000-(now()-started))});
  pending.add(request);try{return await request;}finally{pending.delete(request);}
 }) as Stripe["rawRequest"];
 const reader:TeamReceiptComposition={...c,stripe:{rawRequest:raw},observeContext:async()=>{await current();return c.context;},observeEvidence:async()=>{bounded();const evidence=await c.observeEvidence();bounded();return evidence;}};
 const drain=async()=>{await Promise.allSettled([...pending]);};
 try{
  for(let n=0;n<3&&now()>=started&&now()-started<35000;n++){
   await current();const task=await rpc<Task|null>("next_sales_team_recovery_task_v1",{...scope,p_fulfill:options.fulfill===true,...(options.recoverRefunds===true?{p_refunds:true}:{})});if(!task)break;
   let taskHeld=true;
   try{
    if(task.kind==="refund"){
     if(!options.recoverRefunds)throw Error("Original refund recovery held");
     const result=await recoverTeamWorkerRefund(reader,{runId,leaseToken,taskId:task.id,requestId:task.source_id});taskHeld=result.held;
    }else if(task.kind==="financial"){
     const begun=await rpc<{checkId:string;completed:boolean;held:boolean;source:TeamEventSource}>("begin_sales_team_recovery_financial_v1",{...scope,p_task_id:task.id});
     if(begun.completed)taskHeld=begun.held;
     else{const inspected=await readTeamFinancialSnapshot(reader,begun.source,{eventId:null,balances:true});await current();const result=await rpc<{held:boolean}>("complete_sales_team_recovery_financial_v1",{...scope,p_check_id:begun.checkId,p_expected_revision:inspected.revision,p_snapshot:inspected.snapshot});taskHeld=result.held;}
    }else if(task.kind==="event"){
     const source=task.source as unknown as TeamEventSource;
     const refreshed=await refreshTeamBoundCollection(reader,source.saleId,source.buyerId,source.obligationId);
     if(refreshed.saved.receipt||refreshed.saved.state?.status==="succeeded"){
      const result=await observeTeamPaymentEvent(reader,source,task.source_id,true);taskHeld=result.held;
      if(options.fulfill)await rpc("fulfill_sales_team_receipt_v1",{p_sale_id:source.saleId,p_buyer_id:source.buyerId,p_receipt_id:result.receiptId});
     }else{await rpc("complete_sales_team_lifecycle_event_v1",{p_event_id:task.source_id,p_state_id:refreshed.saved.state?.id??null});taskHeld=false;}
    }else if(task.kind==="shared_cash"){
     const unsent=options.recoverSharedUnsent?await inspectSharedUnsentRecovery(reader,{runId,leaseToken,taskId:task.id}):null;
     const result=unsent??await inspectSharedCashOriginal(reader,{workerRunId:runId,kind:task.source.kind as SharedCashOriginal["kind"],id:String(task.source.id),checkId:task.id});taskHeld=result.held;
    }else if(task.kind==="fulfillment"){
     if(!options.fulfill)throw Error("Shared fulfillment recovery held");
     await rpc("fulfill_sales_team_receipt_v1",{p_sale_id:task.source.saleId,p_buyer_id:task.source.buyerId,p_receipt_id:task.source.receiptId});taskHeld=false;
    }else{
     const saved=task.source as unknown as TeamRecipientSetup;if(!saved.account_id||saved.user_id!==task.source_id||!isDeepStrictEqual(saved.context,c.context))throw Error("Original recovery recipient changed");
     const path=`${saved.api==="v1"?"/v1/accounts/":"/v2/core/accounts/"}${saved.account_id}`,params=saved.api==="v2"?{include:["configuration.recipient","defaults","identity","requirements"]}:{};
     const get=async()=>{const value=await raw("GET",path,params,{apiVersion:TEAM_STRIPE_API_VERSION}) as unknown as {lastResponse?:{requestId?:string}};return observeTeamRecipient(saved,value,value.lastResponse?.requestId??"");};
     const first=await get(),second=await get(),economic=(v:typeof first)=>{const {requestId,...fields}=v;void requestId;return fields;};
     if(first.requestId===second.requestId||!isDeepStrictEqual(economic(first),economic(second)))throw Error("Current recipient observation changed");
     await current();await rpc("observe_sales_team_recovery_recipient_v1",{...scope,p_task_id:task.id,p_observation:second});taskHeld=!second.transfersActive||!second.payoutsReady;
    }
   }catch{
    taskHeld=true;await drain();if(task.kind==="recipient")await rpc("observe_sales_team_recovery_recipient_v1",{...scope,p_task_id:task.id,p_observation:null});
   }
   await drain();await rpc("finish_sales_team_recovery_task_v1",{...scope,p_task_id:task.id,p_held:taskHeld});if(taskHeld)held++;else observed++;
  }
 }catch(error){failed=true;throw error;}finally{await drain();await rpc("finish_sales_team_recovery_run_v1",{...scope,p_failed:failed});}
 return {status:held?"review_required":"complete",observed,held};
}
