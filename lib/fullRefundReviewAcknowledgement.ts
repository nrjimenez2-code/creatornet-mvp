import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {fullRefundReviewAdminReady,validFullRefundReviewCursor} from "./fullRefundReviewAdmin";
import {validMembershipAdminCursor} from "./membershipAdmin";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext,type ExactPaymentContext} from "./installments/paymentContext";
type Env=Record<string,string|undefined>;
export const fullRefundReviewAcknowledgementReady=(env:Env=process.env)=>fullRefundReviewAdminReady(env)&&
  env.CREATOR_FULL_REFUND_REVIEW_ACK_SCHEMA_READY==="true"&&env.CREATOR_FULL_REFUND_REVIEW_ACK_READY==="true";
export type RefundReviewAcknowledgement={requestId:string;eventId:string;revision:number;confirmHoldRetained:true};
export function parseRefundReviewAcknowledgement(value:unknown):RefundReviewAcknowledgement|null{
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const r=value as Record<string,unknown>;
  if(Object.keys(r).sort().join(",")!=="confirmHoldRetained,eventId,requestId,revision"||!validMembershipAdminCursor(r.requestId)||
    !validFullRefundReviewCursor(r.eventId)||typeof r.revision!=="number"||!Number.isSafeInteger(r.revision)||r.revision<0||r.confirmHoldRetained!==true)return null;
  return {requestId:r.requestId,eventId:r.eventId,revision:r.revision,confirmHoldRetained:true};
}
export async function acknowledgeFullRefundReview(admin:SupabaseClient,actorId:string,input:RefundReviewAcknowledgement,env:Env=process.env,
  injected?:{context:ExactPaymentContext;observe:()=>Promise<unknown>}){
  const check=(v:unknown)=>{if(!v)throw Error("Refund review acknowledgement unavailable");};
  check(fullRefundReviewAcknowledgementReady(env)&&validMembershipAdminCursor(actorId)&&parseRefundReviewAcknowledgement(input));
  let deps=injected;
  if(!deps){const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config);
    deps={context:config.approvedContext,observe:async()=>validateExactPaymentContext(config.approvedContext,(await runtime.observeContext()).contextEvidence)};}
  await deps.observe();
  const {data:r,error}=await admin.rpc("acknowledge_full_refund_review_v1",{p_context:deps.context,p_actor_id:actorId,
    p_request_id:input.requestId,p_event_id:input.eventId,p_revision:input.revision});
  check(!error&&r?.status==="review_recorded_hold_retained"&&r.requestId===input.requestId&&r.eventId===input.eventId&&r.revision===input.revision&&
    typeof r.recordedAt==="string"&&Number.isFinite(Date.parse(r.recordedAt))&&typeof r.current==="boolean");
  await deps.observe();
  return {status:"review_recorded_hold_retained" as const,current:r.current as boolean};
}
