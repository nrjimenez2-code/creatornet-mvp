import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {fullRefundReviewAdminReady,validFullRefundReviewCursor} from "./fullRefundReviewAdmin";
import {validMembershipAdminCursor} from "./membershipAdmin";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext,type ExactPaymentContext} from "./installments/paymentContext";
import {SERVER_PAYMENT_PROTOCOL} from "./serverPaymentConfirmation";
import {reconcileFullServerRefundObject} from "./fullServerPaymentReadback";
type Env=Record<string,string|undefined>;
export const fullRefundReviewReconciliationReady=(env:Env=process.env)=>fullRefundReviewAdminReady(env)&&
  env.CREATOR_FULL_REFUND_EVENT_SCHEMA_READY==="true"&&env.CREATOR_FULL_REFUND_RECONCILE_READY==="true";
export type RefundReviewReconciliation={eventId:string;revision:number;confirmOriginalOnly:true};
export function parseRefundReviewReconciliation(value:unknown):RefundReviewReconciliation|null{
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const r=value as Record<string,unknown>;
  if(Object.keys(r).sort().join(",")!=="confirmOriginalOnly,eventId,revision"||!validFullRefundReviewCursor(r.eventId)||
    typeof r.revision!=="number"||!Number.isSafeInteger(r.revision)||r.revision<0||r.confirmOriginalOnly!==true)return null;
  return {eventId:r.eventId,revision:r.revision,confirmOriginalOnly:true};
}
/** Only after requireAdmin. The browser supplies a locator and reviewed revision,
 * never payment ownership, provider IDs, event time, keys or economic parameters.
 * The existing engine reads the original provider state and accounts it under
 * its own gates/locks. It cannot create a refund/charge or release a hold. */
export async function reconcileFullRefundReview(admin:SupabaseClient,input:RefundReviewReconciliation,env:Env=process.env,
  injected?:{context:ExactPaymentContext;observe:()=>Promise<unknown>;reconcile:typeof reconcileFullServerRefundObject}){
  const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Original refund reconciliation requires review");};
  check(fullRefundReviewReconciliationReady(env)&&parseRefundReviewReconciliation(input));
  let deps=injected;
  if(!deps){const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config);
    deps={context:config.approvedContext,observe:async()=>validateExactPaymentContext(config.approvedContext,(await runtime.observeContext()).contextEvidence),reconcile:reconcileFullServerRefundObject};}
  await deps.observe();
  const event=await admin.from("full_server_payment_refund_object_events_v1")
    .select("event_id,attempt_id,refund_id,charge_id,event_created").eq("event_id",input.eventId).maybeSingle();
  check(!event.error&&event.data?.event_id===input.eventId&&validMembershipAdminCursor(event.data.attempt_id));
  const e=event.data;
  check(typeof e.refund_id==="string"&&/^re_[A-Za-z0-9]+$/.test(e.refund_id)&&typeof e.charge_id==="string"&&/^ch_[A-Za-z0-9]+$/.test(e.charge_id)&&
    Number.isSafeInteger(e.event_created)&&e.event_created>0&&e.event_created<=Math.floor(Date.now()/1000));
  const [hold,source]=await Promise.all([
    admin.from("full_server_payment_financial_holds_v1").select("attempt_id,payment_intent_id,revision").eq("attempt_id",e.attempt_id).maybeSingle(),
    admin.from("server_payment_protocols_v1").select("attempt_id,buyer_id,kind,protocol,context,source").eq("attempt_id",e.attempt_id).maybeSingle(),
  ]);
  check(!hold.error&&hold.data&&hold.data.attempt_id===e.attempt_id&&hold.data.revision===input.revision&&
    typeof hold.data.payment_intent_id==="string"&&/^pi_[A-Za-z0-9]+$/.test(hold.data.payment_intent_id));
  check(!source.error&&source.data&&source.data.attempt_id===e.attempt_id&&source.data.kind==="full"&&source.data.protocol===SERVER_PAYMENT_PROTOCOL&&
    isDeepStrictEqual(source.data.context,deps.context)&&validMembershipAdminCursor(source.data.buyer_id)&&validMembershipAdminCursor(source.data.source?.attempt_key));
  await deps.observe();
  const result=await deps.reconcile({buyerId:source.data.buyer_id,attemptId:e.attempt_id,attemptKey:source.data.source.attempt_key,
    eventId:e.event_id,refundId:e.refund_id,eventCreated:e.event_created,expectedEvent:{paymentIntentId:hold.data.payment_intent_id,
      chargeId:e.charge_id,livemode:deps.context.mode==="live"},env});
  await deps.observe();
  if(result.status==="reconciliation_required")return {status:"reconciliation_required" as const,holdRetained:true as const};
  check(result.attemptId===e.attempt_id&&result.paymentIntentId===hold.data.payment_intent_id&&
    ["refund_observed","refund_review_recorded","refund_recorded_accounting_review"].includes(result.status));
  if(result.status==="refund_recorded_accounting_review")return {status:"reconciliation_required" as const,holdRetained:true as const};
  return {status:"original_reconciled_hold_retained" as const,holdRetained:true as const,observation:result.status};
}
