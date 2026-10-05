import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {readBuyerMentorshipWebhookOwner,handoffBuyerMentorshipRecordedFinancialEvent} from "./mentorshipInstallmentWebhook";
import { recordBuyerMentorshipFirstPayment } from "./mentorshipInstallmentAccounting";

/** Called only after signature verification and a durable event claim. The
 * event selects a persisted dedicated customer; its metadata supplies neither
 * ownership nor money. The accounting adapter rereads the original payment
 * capture and compares its identities with this event before recording it.
 * Unhandled events continue to the buyer lifecycle rejection boundary. */
export async function handoffBuyerMentorshipFirstWebhook(args: {
  event: Stripe.Event; admin: SupabaseClient; env: Record<string,string|undefined>;
}): Promise<boolean> {
  const {event,admin,env}=args;
  if(env.CREATOR_MENTORSHIP_INSTALLMENT_FIRST_WEBHOOK_READY!=="true" ||
    env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY!=="true") return false;
  const expectedType: Record<string,"checkout.session"|"payment_intent"|"charge">={
    "checkout.session.completed":"checkout.session", "payment_intent.succeeded":"payment_intent",
    "charge.succeeded":"charge", "charge.updated":"charge",
  };
  const objectType=expectedType[event.type]; if(!objectType)return false;
  const owner=await readBuyerMentorshipWebhookOwner(event,admin,objectType);if(!owner)return false;
  await reconcileBuyerMentorshipFirstCapture({event,admin,env,owner,objectType});
  return true;
}

/** Re-read and account the original capture, including a late lifecycle event
 * whose current provider readback has independently established success. */
export async function reconcileBuyerMentorshipFirstCapture(args:{event:Stripe.Event;admin:SupabaseClient;
  env:Record<string,string|undefined>;owner:NonNullable<Awaited<ReturnType<typeof readBuyerMentorshipWebhookOwner>>>;
  objectType:"checkout.session"|"payment_intent"|"charge"}){
  const {event,admin,env,owner,objectType}=args;
  if(await handoffBuyerMentorshipRecordedFinancialEvent({event,admin,env,owner,objectType}))return;
  await recordBuyerMentorshipFirstPayment({buyerId:owner.buyerId,requestId:owner.requestId,env,
    expectedEvent:{reservationId:owner.reservationId,customerId:owner.customerId,livemode:event.livemode,object:objectType,id:owner.objectId}});
  if(env.CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_READY==="true") {
    const {activateBuyerMentorship}=await import("./mentorshipInstallmentActivationRuntime");
    const activation=await activateBuyerMentorship({buyerId:owner.buyerId,requestId:owner.requestId,env});
    if(activation.status!=="activated_held" && activation.status!=="collection_enabled")throw Error("Buyer first-payment activation requires retry or review");
  }
}
