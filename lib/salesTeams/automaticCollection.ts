import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import type {SupabaseClient} from "@supabase/supabase-js";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {teamRpc} from "./server";
import {advanceTeamAutomaticCollection,type TeamCollectionTask} from "./savedCollection";
import {recordTeamCapture,type TeamReceiptComposition} from "./receipts";
import {readTeamCollection,teamCollectionView} from "./collection";
import {recordTeamSavedMethod} from "./savedMethod";
/** One authenticated 15-minute slot, three durable tasks, 40 GETs, at most
 * three POSTs and a 90-second lease. GET limits cover payment-object transport;
 * independently timed current-context probes retain their existing authority. */
export async function runTeamAutomaticCollection(c:TeamReceiptComposition,options:{admitNew?:boolean;now?:()=>number}={}){
 const now=options.now??Date.now,started=now(),context=snapshotProviderJson(c.context),pending=new Set<Promise<unknown>>();let gets=0,posts=0,allowFresh=false;
 const rpc:typeof c.admin.rpc=(name,args,requestOptions)=>{const request=c.admin.rpc(name,args,requestOptions);return typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request;};
 const admin={rpc,from:c.admin.from.bind(c.admin)} as unknown as SupabaseClient;
 const bounded=()=>{if(now()<started||now()-started>=65000)throw Error("Automatic collection observation budget exhausted");};
 const current=async()=>{bounded();if(!isDeepStrictEqual(await c.observeContext(),context))throw Error("Automatic collection context changed");bounded();};
 await current();const run=await teamRpc<{status:string;runId?:string;leaseToken?:string}>(admin,"claim_sales_team_collection_run_v1",{p_run_id:randomUUID(),p_context:context,p_new:options.admitNew===true});if(run.status!=="claimed")return {status:run.status,collected:0,held:0};
 const runId=run.runId!,leaseToken=run.leaseToken!,scope={p_run_id:runId,p_lease_token:leaseToken,p_context:context};let collected=0,held=0,failed=false,finalStatus="review_required";
 const reader:TeamReceiptComposition={...c,admin,context,observeContext:async()=>{await current();return context;},observeEvidence:async()=>{bounded();const result=await c.observeEvidence();bounded();return result;},stripe:{rawRequest:async(method,path,params,providerOptions)=>{
  bounded();if(method==="GET"){if(++gets>40)throw Error("Automatic collection GET limit reached");}
  else if(method!=="POST"||!allowFresh||!(path==="/v1/payment_intents"||/^\/v1\/payment_intents\/pi_[A-Za-z0-9]+\/confirm$/.test(path))||++posts>3||now()-started>=45000)throw Error("Automatic collection POST admission held");
  const request=c.stripe.rawRequest(method,path,params,{...providerOptions,apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:method==="POST"?10000:Math.max(1,Math.min(10000,65000-(now()-started)))});pending.add(request);try{return await request;}finally{pending.delete(request);}
 }}};
 const drain=async()=>{await Promise.allSettled([...pending]);};
 try{
  for(let n=0;n<3&&now()>=started&&now()-started<50000;n++){
   await current();allowFresh=options.admitNew===true&&posts<=1&&gets<=20&&now()-started<25000;
   const task=await teamRpc<TeamCollectionTask|null>(admin,"next_sales_team_collection_task_v1",{...scope,p_new:allowFresh});if(!task)break;let taskHeld=true;
   try{
    const saved=await c.admin.from("sales_team_automatic_collections_v1").select("sale_id,buyer_id").eq("obligation_id",task.obligation_id).maybeSingle();if(saved.error)throw saved.error;if(!saved.data)throw Error("Original automatic payment required");const {sale_id:saleId,buyer_id:buyerId}=saved.data;
    const payment=await advanceTeamAutomaticCollection(reader,{runId,leaseToken,task,canDispatch:()=>allowFresh&&now()>=started&&now()-started<25000&&posts<=1&&gets<=28},saleId,buyerId,allowFresh);
    if(["captured_pending_receipt","receipt_verified","payment_review","paid"].includes(payment.phase)){
     const receipt=await recordTeamCapture(reader,saleId,buyerId,task.obligation_id);
     if(receipt.status==="verified"||receipt.status==="verified_held")await teamRpc(admin,"fulfill_sales_team_receipt_v1",{p_sale_id:saleId,p_buyer_id:buyerId,p_receipt_id:receipt.receiptId});
     if(receipt.status==="verified")await recordTeamSavedMethod(reader,saleId,buyerId,task.obligation_id);
     taskHeld=teamCollectionView(await readTeamCollection(c,saleId,buyerId,task.obligation_id)).phase!=="paid";
    }
   }catch{/* Preserve the exact original and its uncertainty for another read. */}
   await drain();const result=await teamRpc<{held:boolean}>(admin,"finish_sales_team_collection_task_v1",{...scope,p_task_id:task.id,p_held:taskHeld});if(result.held)held++;else collected++;
  }
 }catch(error){failed=true;throw error;}finally{allowFresh=false;await drain();finalStatus=(await teamRpc<{status:string}>(admin,"finish_sales_team_collection_run_v1",{...scope,p_failed:failed})).status;}
 return {status:finalStatus,collected,held};
}
