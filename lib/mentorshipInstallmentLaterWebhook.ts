import "server-only";
import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readBuyerMentorshipWebhookOwner,handoffBuyerMentorshipRecordedFinancialEvent} from "./mentorshipInstallmentWebhook";
import {reconcileBuyerMentorshipInvoice} from "./mentorshipInstallmentReconciliation";

/** Signature and durable event claim must precede this handoff. Resolve the
 * dedicated customer and original admission from storage, never from metadata.
 * Each event converges on the same invoice receipt; no payment retry is possible. */
export async function handoffBuyerMentorshipLaterWebhook(args:{event:Stripe.Event;admin:SupabaseClient;env:Record<string,string|undefined>}):Promise<boolean> {
  const {event,admin,env}=args;
  if(env.CREATOR_MENTORSHIP_INSTALLMENT_LATER_WEBHOOK_READY!=="true" ||
    env.CREATOR_MENTORSHIP_INSTALLMENT_LATER_RECEIPT_SCHEMA_READY!=="true" ||
    env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY!=="true")return false;
  const types:Record<string,"invoice"|"payment_intent"|"charge">={"invoice.paid":"invoice","invoice.payment_succeeded":"invoice",
    "payment_intent.succeeded":"payment_intent","charge.succeeded":"charge","charge.updated":"charge",
    "invoice.payment_failed":"invoice","invoice.payment_action_required":"invoice",
    "payment_intent.payment_failed":"payment_intent","payment_intent.requires_action":"payment_intent"};
  const type=types[event.type];if(!type)return false;
  const object=event.data.object as unknown as {object?:string;id?:string;customer?:string|{id?:string};livemode?:boolean;payment_intent?:string|{id?:string}};
  const owner=await readBuyerMentorshipWebhookOwner(event,admin,type);if(!owner)return false;
  const paymentIntentId=type==="payment_intent"?object.id:typeof object.payment_intent==="string"?object.payment_intent:object.payment_intent?.id;
  const lookup=type==="invoice"?object.id:paymentIntentId;
  if(typeof lookup!=="string" || !(type==="invoice"?/^in_[A-Za-z0-9]+$/:/^pi_[A-Za-z0-9]+$/).test(lookup))
    throw Error("Buyer later event payment identity unavailable");
  const admission=await admin.from("buyer_mentorship_payment_admissions_v1").select("reservation_id,invoice_id,payment_intent_id,payment_number")
    .eq("reservation_id",owner.reservationId).eq(type==="invoice"?"invoice_id":"payment_intent_id",lookup).maybeSingle();
  if(admission.error)throw Error("Buyer later event admission unavailable");
  if(!admission.data)return false; // First capture or an unimplemented lifecycle stays with the protective boundary.
  if(admission.data.reservation_id!==owner.reservationId)throw Error("Buyer later event admission differs");
  if(await handoffBuyerMentorshipRecordedFinancialEvent({event,admin,env,owner,objectType:type,invoiceId:admission.data.invoice_id}))return true;
  if(["invoice.payment_failed","invoice.payment_action_required","payment_intent.payment_failed","payment_intent.requires_action"].includes(event.type)) {
    if(env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_SCHEMA_READY!=="true" || env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_READY!=="true")return false;
    if(type==="charge")throw Error("Buyer recovery event type differs");
    const {recoverBuyerMentorshipPayment}=await import("./mentorshipInstallmentPaymentRecovery");
    const recovered=await recoverBuyerMentorshipPayment({buyerId:owner.buyerId,requestId:owner.requestId,invoiceId:admission.data.invoice_id,
      eventId:event.id,env,expectedEvent:{object:type,id:owner.objectId,customerId:owner.customerId,livemode:event.livemode}});
    if(recovered.status!=="payment_recovery_recorded" || ("futureCollection" in recovered && recovered.futureCollection==="review_required"))throw Error("Buyer payment recovery requires retry or review");
    return true;
  }
  const result=await reconcileBuyerMentorshipInvoice({buyerId:owner.buyerId,requestId:owner.requestId,
    invoiceId:admission.data.invoice_id,env,expectedEvent:{object:type,id:owner.objectId,customerId:owner.customerId,livemode:event.livemode}});
  if(result.status!=="credited" && result.status!=="already_credited")throw Error("Buyer later receipt requires retry or review");
  if(env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_RESUME_HANDOFF_READY==="true" || env.CREATOR_MENTORSHIP_INSTALLMENT_SAME_CARD_RECOVERY_READY==="true") {
    const {handoffBuyerMentorshipPaidFutureCollection}=await import("./mentorshipInstallmentPaymentRecovery");
    const future=await handoffBuyerMentorshipPaidFutureCollection({buyerId:owner.buyerId,requestId:owner.requestId,invoiceId:admission.data.invoice_id,env});
    // Receipt is already durable. Retrying this event can only reconcile it and
    // recover the original release; it cannot issue another payment.
    if(future==="review_required")throw Error("Buyer future collection requires retry or review");
  }
  return true;
}
