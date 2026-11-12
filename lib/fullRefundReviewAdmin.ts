import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext,type ExactPaymentContext} from "./installments/paymentContext";
import {validMembershipAdminCursor} from "./membershipAdmin";

type Env=Record<string,string|undefined>;
function check(v:unknown):asserts v {if(!v)throw Error("Full refund review unavailable");}
const record=(v:unknown):Record<string,unknown>=>{check(v!==null&&typeof v==="object"&&!Array.isArray(v));return v as Record<string,unknown>;};
const count=(v:unknown)=>{check(typeof v==="number"&&Number.isSafeInteger(v)&&v>=0);return v;};
const time=(v:unknown)=>{check(typeof v==="string"&&Number.isFinite(Date.parse(v)));return v;};
const id=(v:unknown,prefix:string)=>{check(typeof v==="string"&&v.length<=255&&new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(v));return v;};
export const validFullRefundReviewCursor=(v:unknown):v is string=>typeof v==="string"&&v.length<=255&&/^evt_[A-Za-z0-9]+$/.test(v);
export const fullRefundReviewAdminReady=(env:Env=process.env)=>["CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY",
  "CREATOR_FULL_REFUND_REVIEW_SCHEMA_READY","CREATOR_FULL_REFUND_REVIEW_ADMIN_SCHEMA_READY","CREATOR_FULL_REFUND_REVIEW_ADMIN_READY"].every(key=>env[key]==="true");

export function parseFullRefundReviewAdmin(value:unknown,context:ExactPaymentContext,cursor:string|null){
  check(cursor===null||validFullRefundReviewCursor(cursor));
  const root=record(value),b=record(root.backlog);
  check(isDeepStrictEqual(root.context,context)&&isDeepStrictEqual(b.context,context)&&Array.isArray(root.rows)&&root.rows.length<=26);
  const observedAt=time(b.observedAt),events=count(b.events),needsReview=count(b.needsReview),unapplied=count(b.unapplied),reviewRecorded=count(b.reviewRecorded);
  check(needsReview<=events&&unapplied<=events&&reviewRecorded<=events&&(events===0)===(needsReview===0));
  const oldestObservedAt=b.oldestObservedAt===null?null:time(b.oldestObservedAt);
  check(events===0?oldestObservedAt===null:oldestObservedAt!==null&&Date.parse(oldestObservedAt)<=Date.parse(observedAt));
  let previous=cursor??"";
  const rows=root.rows.map(value=>{
    const r=record(value),eventId=id(r.event_id,"evt");check(eventId>previous);previous=eventId;
    check(validMembershipAdminCursor(r.attempt_id));
    check(r.disposition===null||["refund_observed","refund_review_recorded"].includes(r.disposition as string));
    check(r.refund_status===null||["pending","requires_action","succeeded","failed","canceled"].includes(r.refund_status as string));
    const appliedAt=r.applied_at===null?null:time(r.applied_at),eventObservedAt=time(r.observed_at),holdAt=time(r.financial_hold_at);
    const observations=count(r.observations),amountCents=r.amount_cents===null?null:count(r.amount_cents);
    check(Date.parse(eventObservedAt)<=Date.parse(observedAt)&&Date.parse(holdAt)<=Date.parse(observedAt));
    check(appliedAt===null?r.disposition===null&&r.refund_status===null&&amountCents===null&&observations===0:
      r.disposition!==null&&r.refund_status!==null&&amountCents!==null&&amountCents>0&&observations>0&&
      Date.parse(appliedAt)>=Date.parse(eventObservedAt)&&Date.parse(appliedAt)<=Date.parse(observedAt));
    const ack=r.last_review==null?null:record(r.last_review);
    const lastReview=ack?{revision:count(ack.revision),recordedAt:time(ack.recordedAt)}:null;
    check(!lastReview||lastReview.revision<=count(r.revision));
    return {eventId,attemptId:r.attempt_id,lastReview,refundId:id(r.refund_id,"re"),chargeId:id(r.charge_id,"ch"),
      paymentIntentId:id(r.payment_intent_id,"pi"),holdAt,revision:count(r.revision),observedAt:eventObservedAt,
      appliedAt,disposition:r.disposition as string|null,refundStatus:r.refund_status as string|null,amountCents,observations};
  });
  check(rows.length<=events&&(cursor!==null||rows.length===Math.min(events,26)));
  return {mode:context.mode,observedAt,events,needsReview,unapplied,reviewRecorded,oldestObservedAt,
    rows:rows.slice(0,25),nextCursor:rows.length>25?rows[24].eventId:null};
}

/** requireAdmin must run first. No provider writes, accounting, acknowledgements or hold release. */
export async function readFullRefundReviewAdmin(admin:SupabaseClient,cursor:string|null,env:Env=process.env,
  injected?:{context:ExactPaymentContext;observe:()=>Promise<unknown>}){
  check(fullRefundReviewAdminReady(env)&&(cursor===null||validFullRefundReviewCursor(cursor)));
  let deps=injected;
  if(!deps){const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config);
    deps={context:config.approvedContext,observe:async()=>validateExactPaymentContext(config.approvedContext,(await runtime.observeContext()).contextEvidence)};}
  await deps.observe();
  const withAcknowledgements=env.CREATOR_FULL_REFUND_REVIEW_ACK_SCHEMA_READY==="true";
  const {data,error}=await admin.rpc(withAcknowledgements?"read_full_refund_review_admin_ack_v1":"read_full_refund_review_admin_v1",{p_context:deps.context,p_after:cursor});check(!error);
  if(withAcknowledgements)check(Array.isArray(data?.rows)&&data.rows.every((r:Record<string,unknown>)=>Object.hasOwn(r,"last_review")));
  const page=parseFullRefundReviewAdmin(data,deps.context,cursor);
  await deps.observe();return page;
}
