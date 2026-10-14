import "server-only";
import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {SERVER_PAYMENT_PROTOCOL} from "./serverPaymentConfirmation";
import {accountFullServerPayment,reconcileFullServerPaymentRefund,reconcileFullServerPaymentDispute,reconcileFullServerRefundObject} from "./fullServerPaymentReadback";
import {confirmAdminRefundWebhookDelivery} from "./paymentRefunds";
import {reconcileFullServerPaymentLifecycle} from "./fullServerPaymentLifecycle";

const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Full payment event requires review");};
const id=(value:unknown)=>typeof value==="string"?value:value&&typeof value==="object"?(value as {id?:unknown}).id:null;

/** Only after signature verification and the shared durable event claim.
 * Event identifiers locate a bound original; metadata never supplies ownership,
 * prices or accepted terms. Bound manual events never use generic accounting. */
export async function handoffFullServerPaymentWebhook(args:{event:Stripe.Event;admin:SupabaseClient;
  stripe:Pick<Stripe,"charges"|"refunds">;env:Record<string,string|undefined>}):Promise<boolean>{
  const {event,admin,env}=args,object=event.data.object as unknown as Record<string,any>;
  if(event.type==="account.updated")return false;
  const related=[object,object.payment_intent,object.charge];
  let marked=related.some(v=>v&&typeof v==="object"&&v.metadata?.server_payment_protocol!=null);
  if(env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY!=="true"){check(!marked);return false;}
  let intentId:unknown,chargeId:unknown;
  if(object.object==="payment_intent")intentId=object.id;
  else if(object.object==="charge"){intentId=id(object.payment_intent);chargeId=object.id;}
  else if(object.object==="dispute"||object.object==="refund"){
    intentId=id(object.payment_intent);chargeId=id(object.charge);
    if(!intentId){
      check(typeof chargeId==="string"&&/^ch_[A-Za-z0-9]+$/.test(chargeId)&&event.account==null);
      const charge=await args.stripe.charges.retrieve(chargeId,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
      check(charge.object==="charge"&&charge.id===chargeId&&charge.livemode===event.livemode);
      intentId=id(charge.payment_intent);
      marked ||= charge.metadata?.server_payment_protocol!=null||
        (typeof charge.payment_intent==="object"&&charge.payment_intent?.metadata?.server_payment_protocol!=null);
    }
  }else{check(!marked);return false;}
  if(typeof intentId!=="string"||!/^pi_[A-Za-z0-9]+$/.test(intentId)){check(!marked);return false;}
  const original=await admin.from("server_payment_intent_operations_v1").select("attempt_id,payment_intent_id,bound_at")
    .eq("payment_intent_id",intentId).maybeSingle();check(!original.error);
  if(!original.data){check(!marked);return false;}
  check(original.data.bound_at&&original.data.payment_intent_id===intentId);assertAgreementId(original.data.attempt_id);
  const pin=await admin.from("server_payment_protocols_v1").select("attempt_id,buyer_id,kind,protocol,context,source")
    .eq("attempt_id",original.data.attempt_id).maybeSingle();
  check(!pin.error&&pin.data&&pin.data.attempt_id===original.data.attempt_id&&pin.data.protocol===SERVER_PAYMENT_PROTOCOL);
  // An installment that reaches this boundary was not handled by its earlier
  // dedicated adapter. It must not enter generic accounting either.
  // Refund objects do not carry livemode. The admitted event and original
  // protocol context establish mode; charge fallback independently checks it.
  check(pin.data.kind==="full"&&event.account==null&&(object.object==="refund"||object.livemode===event.livemode)&&
    pin.data.context?.mode===(event.livemode?"live":"test"));
  assertAgreementId(pin.data.buyer_id);assertAgreementId(pin.data.source?.attempt_key);
  if(object.object==="refund"&&["refund.created","refund.updated","refund.failed"].includes(event.type)){
    check(env.CREATOR_FULL_SERVER_PAYMENT_WEBHOOK_READY==="true"&&typeof chargeId==="string"&&/^ch_[A-Za-z0-9]+$/.test(chargeId));
    const result=await reconcileFullServerRefundObject({buyerId:pin.data.buyer_id,attemptId:pin.data.attempt_id,
      attemptKey:pin.data.source.attempt_key,eventId:event.id,refundId:object.id,eventCreated:event.created,env,
      expectedEvent:{paymentIntentId:intentId,chargeId,livemode:event.livemode}});
    check(result.status==="refund_observed"||result.status==="refund_review_recorded");
    if(result.refundApplied){
      await confirmAdminRefundWebhookDelivery(admin,args.stripe,{paymentIntentId:intentId,chargeId,
        chargeAmountCents:result.amountCents!,refundedAmountCents:result.refundedCents!},
        {apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    }
    return true;
  }
  if(object.object==="dispute"&&["charge.dispute.created","charge.dispute.updated","charge.dispute.closed",
    "charge.dispute.funds_withdrawn","charge.dispute.funds_reinstated"].includes(event.type)){
    check(env.CREATOR_FULL_SERVER_PAYMENT_WEBHOOK_READY==="true"&&typeof chargeId==="string"&&/^ch_[A-Za-z0-9]+$/.test(chargeId));
    const result=await reconcileFullServerPaymentDispute({buyerId:pin.data.buyer_id,attemptId:pin.data.attempt_id,
      attemptKey:pin.data.source.attempt_key,eventId:event.id,disputeId:object.id,eventCreated:event.created,env,
      expectedEvent:{paymentIntentId:intentId,chargeId,livemode:event.livemode}});
    check(result.status==="dispute_observed");return true;
  }
  if(event.type==="charge.refunded"&&object.object==="charge"){
    check(env.CREATOR_FULL_SERVER_PAYMENT_WEBHOOK_READY==="true"&&typeof chargeId==="string"&&/^ch_[A-Za-z0-9]+$/.test(chargeId));
    const result=await reconcileFullServerPaymentRefund({buyerId:pin.data.buyer_id,attemptId:pin.data.attempt_id,
      attemptKey:pin.data.source.attempt_key,eventId:event.id,env,
      expectedEvent:{paymentIntentId:intentId,chargeId,livemode:event.livemode}});
    check(result.status==="original_refund_applied");
    // Confirmation markers are written only after the original cumulative
    // financial transaction committed; a marker failure keeps delivery retryable.
    await confirmAdminRefundWebhookDelivery(admin,args.stripe,{paymentIntentId:intentId,chargeId,
      chargeAmountCents:result.amountCents,refundedAmountCents:result.refundedCents},
      {apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    return true;
  }
  if(object.object==="payment_intent"&&["payment_intent.processing","payment_intent.payment_failed","payment_intent.canceled",
    "payment_intent.requires_action"].includes(event.type)){
    check(env.CREATOR_FULL_SERVER_PAYMENT_WEBHOOK_READY==="true");
    const result=await reconcileFullServerPaymentLifecycle({buyerId:pin.data.buyer_id,attemptId:pin.data.attempt_id,
      attemptKey:pin.data.source.attempt_key,eventId:event.id,eventCreated:event.created,env,
      expectedEvent:{paymentIntentId:intentId,livemode:event.livemode}});
    check(result.status==="original_lifecycle_observed"||result.status==="original_capture_accounted");return true;
  }
  if(object.object==="charge")check(object.refunded!==true&&object.disputed!==true&&!(object.amount_refunded>0));
  // Unsupported owned events never fall through into generic accounting.
  check(env.CREATOR_FULL_SERVER_PAYMENT_WEBHOOK_READY==="true"&&
    ((event.type==="payment_intent.succeeded"&&object.object==="payment_intent")||
     (["charge.succeeded","charge.updated"].includes(event.type)&&object.object==="charge")));
  if(chargeId!=null)check(typeof chargeId==="string"&&/^ch_[A-Za-z0-9]+$/.test(chargeId));
  const result=await accountFullServerPayment({buyerId:pin.data.buyer_id,attemptId:pin.data.attempt_id,
    attemptKey:pin.data.source.attempt_key,env,expectedEvent:{paymentIntentId:intentId,
      ...(chargeId?{chargeId:chargeId as string}:{}),livemode:event.livemode}});
  check(result.status==="original_capture_accounted");return true;
}
