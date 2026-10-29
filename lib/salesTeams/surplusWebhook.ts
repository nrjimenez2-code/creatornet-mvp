import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createTeamPaymentContext} from "./context";
import {teamId,teamSurplusEventsSchemaReady,teamSurplusReservationsSchemaReady} from "./policy";
import {observeTeamDailySurplus} from "./surplusObservations";
import {recoverTeamDailySurplus} from "./surplusRecovery";
import type {TeamReceiptComposition} from "./receipts";

type Args={event:Stripe.Event;admin:SupabaseClient;env:Record<string,string|undefined>;claimToken:string|null};
type Source={requestId:string;operationId:string;context:TeamReceiptComposition["context"];providerId:string|null;operationStatus:string};
const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Original signed surplus payout requires review");};
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const metadataId=(v:unknown)=>{if(v==null)return null;check(typeof v==="string");teamId(v);return v;};

/** Classification precedes payment/legacy classifiers, including duplicates.
 * Metadata is only a locator/fence; durable ownership remains authoritative. */
export async function locateTeamSurplusEvent({event,admin,env}:Omit<Args,"claimToken">):Promise<Source|null>{
 const object=record(event.data.object),metadata=record(object.metadata),marker=metadata.team_protocol;
 if(object.object!=="payout"){check(marker!=="creatornet-team-surplus-v1");return null;}
 check(event.type.startsWith("payout.")&&(marker==null||marker==="creatornet-team-surplus-v1")&&typeof object.id==="string"&&/^po_[A-Za-z0-9]+$/.test(object.id));
 const requestId=metadataId(metadata.team_surplus_request_id),operationId=metadataId(metadata.team_provider_operation_id);
 const key=event.type==="payout.created"&&typeof event.request?.idempotency_key==="string"&&event.request.idempotency_key.startsWith("cn-team-v1:")?event.request.idempotency_key:null;
 const marked=marker!=null||requestId!==null||operationId!==null||key!==null;
 const lookup=admin.rpc("locate_sales_team_surplus_event_v1",{p_payout_id:object.id,p_request_id:requestId,p_operation_id:operationId,p_idempotency_key:key});
 const response=await(typeof lookup.abortSignal==="function"?lookup.abortSignal(AbortSignal.timeout(5000)):lookup);
 if(response.error){
  if(["PGRST202","42883"].includes(String(response.error.code??""))){
   check(!marked);const ownership=admin.from("sales_team_provider_operations_v1").select("id").eq("kind","withdrawal").eq("provider_id",object.id);
   const original=await(typeof ownership.abortSignal==="function"?ownership.abortSignal(AbortSignal.timeout(5000)):ownership).maybeSingle();
   if(original.error){check(!teamSurplusReservationsSchemaReady(env)&&["42P01","PGRST205"].includes(String(original.error.code??"")));return null;}
   check(!original.data&&!teamSurplusReservationsSchemaReady(env));return null;
  }
  throw response.error;
 }
 const source=response.data as Source|null;if(!source){check(!marked);return null;}
 teamId(source.requestId);teamId(source.operationId);
 check(event.account==null&&event.context==null&&object.livemode===event.livemode&&source.context.mode===(event.livemode?"live":"test")&&
  (!source.providerId||source.providerId===object.id));return source;
}

/** Signature/source checks happen in the canonical route. Both live claims and
 * completed shared duplicates must prove their durable claim in SQL. Only the
 * F41/F42 GET-only original consumers supply money truth. */
export async function handoffTeamSurplusWebhook(args:Args){
 const started=Date.now(),remaining=()=>{const elapsed=Date.now()-started;check(elapsed>=0&&elapsed<45000);return 45000-elapsed;};
 const source=await locateTeamSurplusEvent(args);if(!source)return false;
 const rpc=async<T>(name:string,payload:Record<string,unknown>):Promise<T>=>{const timeout=Math.min(5000,remaining()),request=args.admin.rpc(name,payload),result=await(typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(timeout)):request);if(result.error)throw result.error;return result.data as T;};
 const admitted=await rpc<{recorded:boolean;source:Source}>("begin_sales_team_surplus_event_v1",{p_event_id:args.event.id,p_event_type:args.event.type,p_event_created:args.event.created,
  p_payout_id:record(args.event.data.object).id,p_request_id:source.requestId,p_context:source.context,p_claim_token:args.claimToken});
 if(admitted.recorded)return true;
 check(teamSurplusEventsSchemaReady(args.env)&&admitted.source.requestId===source.requestId&&isDeepStrictEqual(admitted.source.context,source.context));
 const base=createTeamPaymentContext(args.env);let gets=0;
 // Fit this added owner inside the canonical 60-second route. Each context
 // probe retains its existing 30-second elapsed ceiling; reserve that room
 // before admitting it. Await every admitted operation normally.
 const current=async()=>{check(remaining()>=30000);const context=await base.observeContext();remaining();check(isDeepStrictEqual(context,source.context));return context;};
 const c:TeamReceiptComposition={...base,observeContext:current,admin:{rpc:(name,payload,options)=>{
  const timeout=Math.min(5000,remaining()),request=base.admin.rpc(name,payload,options);return typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(timeout)):request;
 },from:base.admin.from.bind(base.admin)} as SupabaseClient,stripe:{rawRequest:async(method,path,params,options)=>{
  const timeout=Math.max(1,Math.min(10000,remaining()));check(method==="GET"&&++gets<=9);
  return await base.stripe.rawRequest(method,path,params,{...options,maxNetworkRetries:0,timeout});
 }}};
 check(isDeepStrictEqual(c.context,source.context));await current();
 const checkId=randomUUID();
 const observed=admitted.source.providerId?await observeTeamDailySurplus(c,source.requestId,checkId):await recoverTeamDailySurplus(c,source.requestId,checkId);
 check("complete" in observed&&observed.complete===true&&observed.bankConfirmed===false);
 await rpc("complete_sales_team_surplus_event_v1",{p_event_id:args.event.id,p_claim_token:args.claimToken,p_check_id:checkId,p_context:source.context});
 return true;
}
