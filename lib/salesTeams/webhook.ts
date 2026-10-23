import "server-only";
import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {createTeamPaymentContext} from "./context";
import {teamEventReconciliationReady,teamFinancialReconciliationReady,teamFulfillmentReady,teamPaymentSchemaReady} from "./policy";
import {teamRpc} from "./server";
import {refreshTeamBoundCollection} from "./collection";
import {observeTeamPaymentEvent,type TeamEventSource} from "./financialReadback";
type Args={event:Stripe.Event;admin:SupabaseClient;stripe:Pick<Stripe,"rawRequest">;env:Record<string,string|undefined>};
const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Original team payment event requires review");};
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"?v as Record<string,unknown>:{};
const id=(v:unknown):string|null=>typeof v==="string"?v:typeof record(v).id==="string"?record(v).id as string:null;
const marked=(v:unknown)=>record(record(v).metadata).team_protocol!=null;
/** Read-only classification also runs on completed duplicates, before any
 * legacy refund-confirmation repair. Installed original bindings remain a
 * fence even if all new-activity/source application flags are disabled. */
export async function locateTeamPaymentEvent({event,admin,stripe}:Omit<Args,"env">):Promise<TeamEventSource|null>{
 const object=record(event.data.object);let marker=[object,object.payment_intent,object.charge].some(marked);
 if(event.type==="account.updated"){check(!marker);return null;}
 let paymentIntentId:string|null=null,chargeId:string|null=null;
 if(object.object==="payment_intent")paymentIntentId=id(object);
 else if(object.object==="charge"){paymentIntentId=id(object.payment_intent);chargeId=id(object);}
 else if(object.object==="refund"||object.object==="dispute"){paymentIntentId=id(object.payment_intent);chargeId=id(object.charge);}
 else{check(!marker);return null;}
 check(!paymentIntentId||/^pi_[A-Za-z0-9]+$/.test(paymentIntentId));check(!chargeId||/^ch_[A-Za-z0-9]+$/.test(chargeId));
 // Refund/dispute objects can omit the PaymentIntent. A charge read closes the
 // pre-receipt window where the owned charge has no receipt mapping yet.
 if(!paymentIntentId&&chargeId&&(object.object==="refund"||object.object==="dispute")){
  check(event.account==null);const charge=await stripe.rawRequest("GET",`/v1/charges/${chargeId}`,{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000}) as unknown as Stripe.Response<Stripe.Charge>;
  check(charge.object==="charge"&&charge.id===chargeId&&charge.livemode===event.livemode&&/^req_[A-Za-z0-9]+$/.test(charge.lastResponse?.requestId??""));
  paymentIntentId=id(charge.payment_intent);marker||=marked(charge)||marked(charge.payment_intent);check(!paymentIntentId||/^pi_[A-Za-z0-9]+$/.test(paymentIntentId));
 }
 if(!paymentIntentId&&!chargeId){check(!marker);return null;}
 const response=await admin.rpc("locate_sales_team_payment_event_v1",{p_payment_intent_id:paymentIntentId,p_charge_id:chargeId});
 if(response.error){
  // Check the durable journal as well: a missing/stale locator must not erase
  // installed ownership when the new-activity flags have been turned off.
  const code=String(response.error.code??"");if(["PGRST202","42883"].includes(code)){
   check(!marker);const original=await admin.from("sales_team_provider_operations_v1").select("id").eq("kind","intent").eq("provider_id",paymentIntentId).maybeSingle();
   if(original.error){check(!teamPaymentSchemaReady()&&["42P01","PGRST205"].includes(String(original.error.code??"")));return null;}
   check(!original.data&&!teamPaymentSchemaReady());return null;
  }
  throw response.error;
 }
 const source=response.data as TeamEventSource|null;if(!source){check(!marker);return null;}
 check(source.context&&source.paymentIntentId===paymentIntentId&&event.account==null&&source.context.mode===(event.livemode?"live":"test")&&
  (object.object==="refund"||object.livemode===event.livemode));return source;
}
/** Called only after real signature/mode/source checks and a new durable event
 * claim. The immutable signed locator is persisted before provider inspection.
 * No provider POST or legacy destination-charge side effect is available here. */
export async function handoffTeamPaymentWebhook(args:Args){
 const source=await locateTeamPaymentEvent(args);if(!source)return false;
 const object=record(args.event.data.object),chargeId=object.object==="charge"?id(object):id(object.charge);
 const expectedObject=args.event.type.startsWith("payment_intent.")?"payment_intent":args.event.type.startsWith("charge.dispute.")?"dispute":args.event.type.startsWith("refund.")?"refund":args.event.type.startsWith("charge.")?"charge":null;
 check(expectedObject&&object.object===expectedObject);
 const event=await teamRpc<{recorded:boolean;receiptId?:string|null}>(args.admin,"begin_sales_team_payment_event_v1",{p_event_id:args.event.id,p_event_type:args.event.type,p_event_created:args.event.created,
  p_object_id:object.id,p_payment_intent_id:source.paymentIntentId,p_charge_id:chargeId,p_context:source.context});
 if(event.recorded){
  if(event.receiptId&&teamFulfillmentReady(args.env)){
   const c=createTeamPaymentContext(args.env);check(isDeepStrictEqual(c.context,source.context)&&isDeepStrictEqual(await c.observeContext(),source.context));
   await teamRpc(c.admin,"fulfill_sales_team_receipt_v1",{p_sale_id:source.saleId,p_buyer_id:source.buyerId,p_receipt_id:event.receiptId});
  }
  return true;
 }
 check(teamEventReconciliationReady(args.env));const c=createTeamPaymentContext(args.env);
 check(isDeepStrictEqual(c.context,source.context)&&isDeepStrictEqual(await c.observeContext(),source.context));
 const saved=await refreshTeamBoundCollection(c,source.saleId,source.buyerId,source.obligationId);
 if(saved.saved.receipt||saved.saved.state?.status==="succeeded"){
  const result=await observeTeamPaymentEvent(c,source,args.event.id,teamFinancialReconciliationReady(args.env));
  if(teamFulfillmentReady(args.env))await teamRpc(c.admin,"fulfill_sales_team_receipt_v1",{p_sale_id:source.saleId,p_buyer_id:source.buyerId,p_receipt_id:result.receiptId});
 }else await teamRpc(c.admin,"complete_sales_team_lifecycle_event_v1",{p_event_id:args.event.id,p_state_id:saved.saved.state?.id??null});
 return true;
}
