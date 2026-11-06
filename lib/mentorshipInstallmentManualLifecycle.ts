import "server-only";
import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import {assertAgreementId} from "./installments/agreementStore";
import {readBuyerMentorshipWebhookOwner} from "./mentorshipInstallmentWebhook";
import {confirmBuyerMentorshipServerPayment} from "./mentorshipServerPayment";
import {reconcileBuyerMentorshipFirstCapture} from "./mentorshipInstallmentFirstWebhook";

const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Original installment lifecycle requires review");};

/** After canonical signature verification and durable event claim. Observes
 * only the bound first-payment phase. Missing phases and uncertain declines
 * remain retryable; cancellation never establishes selection-release proof. */
export async function handoffBuyerMentorshipManualLifecycle(args:{event:Stripe.Event;admin:SupabaseClient;env:Record<string,string|undefined>}):Promise<boolean>{
  const {event,admin,env}=args;
  if(env.CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_LIFECYCLE_READY!=="true"||
    env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY!=="true"||
    env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY!=="true")return false;
  if(!["payment_intent.processing","payment_intent.payment_failed","payment_intent.canceled","payment_intent.requires_action"].includes(event.type))return false;
  check(/^evt_[A-Za-z0-9]+$/.test(event.id)&&Number.isSafeInteger(event.created)&&event.created>0&&event.created<=Math.floor(Date.now()/1000));
  const owner=await readBuyerMentorshipWebhookOwner(event,admin,"payment_intent");if(!owner)return false;
  check(/^pi_[A-Za-z0-9]+$/.test(owner.objectId));
  const original=await admin.from("server_payment_intent_operations_v1").select("attempt_id,payment_intent_id,bound_at")
    .eq("payment_intent_id",owner.objectId).maybeSingle();
  check(!original.error);
  if(!original.data)return false; // Legacy/later owned events retain their protective boundary.
  check(original.data.bound_at&&original.data.payment_intent_id===owner.objectId);assertAgreementId(original.data.attempt_id);
  const result=await confirmBuyerMentorshipServerPayment({buyerId:owner.buyerId,requestId:owner.requestId,env,
    action:{kind:"observe"},expectedEvent:{paymentIntentId:owner.objectId,customerId:owner.customerId,livemode:event.livemode}});
  check(result.status==="observed"&&!("dispatched" in result&&result.dispatched));assertAgreementId(result.operationId);
  const observation=result.observation;
  check(observation.paymentIntentId===owner.objectId&&Number.isSafeInteger(observation.observedAt)&&
    observation.observedAt>0&&observation.observedAt<=Math.floor(Date.now()/1000));
  if(observation.status==="succeeded"){
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_FIRST_WEBHOOK_READY==="true");
    await reconcileBuyerMentorshipFirstCapture({event,admin,env,owner,objectType:"payment_intent"});
  }else if(observation.status==="requires_payment_method"){
    check(observation.failure&&observation.failure.chargeId===observation.chargeId&&
      observation.failure.paymentMethodId===observation.paymentMethodId);
  }else check(["processing","requires_action","requires_confirmation","canceled"].includes(observation.status));
  return true;
}
