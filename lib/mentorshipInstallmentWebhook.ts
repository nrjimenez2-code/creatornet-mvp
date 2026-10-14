import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MENTORSHIP_INSTALLMENT_QUOTE_VERSION } from "./mentorshipInstallmentQuote";
import {assertAgreementId} from "./installments/agreementStore";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Shared post-signature owner lookup. Event metadata never supplies the buyer
 * or accepted agreement. Reused by first, later and financial event handlers. */
export async function readBuyerMentorshipWebhookOwner(event:Pick<Stripe.Event,"account"|"livemode"|"data">,admin:SupabaseClient,objectType:string) {
  const object=event.data.object as unknown as {object?:string;id?:string;customer?:string|{id?:string};livemode?:boolean};
  const customerId=typeof object.customer==="string"?object.customer:object.customer?.id;
  if(typeof customerId!=="string" || !/^cus_[A-Za-z0-9]+$/.test(customerId))return null;
  const owner=await admin.from("buyer_mentorship_customer_operations_v1").select("reservation_id,bound_at").eq("customer_id",customerId).maybeSingle();
  if(owner.error)throw Error("Buyer event ownership requires review");if(!owner.data)return null;
  if(!owner.data.bound_at || event.account!=null || object.object!==objectType || object.livemode!==event.livemode || typeof object.id!=="string")
    throw Error("Buyer event identity differs");
  assertAgreementId(owner.data.reservation_id);
  const reservation=await admin.from("buyer_mentorship_installment_reservations_v1").select("id,buyer_id,request_id,context,status")
    .eq("id",owner.data.reservation_id).maybeSingle();
  if(reservation.error || !reservation.data || reservation.data.id!==owner.data.reservation_id || reservation.data.status!=="reserved" ||
    reservation.data.context?.mode!==(event.livemode?"live":"test"))throw Error("Buyer event reservation requires review");
  assertAgreementId(reservation.data.buyer_id);assertAgreementId(reservation.data.request_id);
  return {reservationId:reservation.data.id as string,buyerId:reservation.data.buyer_id as string,requestId:reservation.data.request_id as string,
    customerId,objectId:object.id};
}

export async function handoffBuyerMentorshipRefundWebhook(args:{event:Stripe.Event;admin:SupabaseClient;env:Record<string,string|undefined>}) {
  const {event,admin,env}=args;
  if(env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY!=="true" ||
    env.CREATOR_MENTORSHIP_INSTALLMENT_REFUND_SCHEMA_READY!=="true" || env.CREATOR_MENTORSHIP_INSTALLMENT_REFUND_EVENTS_READY!=="true")return false;
  const object=event.data.object as unknown as {amount_refunded?:number;payment_intent?:string|{id?:string}};
  if(event.type!=="charge.refunded" && !(event.type==="charge.updated" && Number.isSafeInteger(object.amount_refunded) && object.amount_refunded!>0))return false;
  const owner=await readBuyerMentorshipWebhookOwner(event,admin,"charge");if(!owner)return false;
  const paymentIntentId=typeof object.payment_intent==="string"?object.payment_intent:object.payment_intent?.id;
  if(!paymentIntentId)throw Error("Buyer refund payment identity unavailable");
  const {reconcileBuyerMentorshipRefund}=await import("./mentorshipInstallmentRefund");
  const result=await reconcileBuyerMentorshipRefund({buyerId:owner.buyerId,requestId:owner.requestId,eventId:event.id,
    paymentIntentId,chargeId:owner.objectId,customerId:owner.customerId,livemode:event.livemode,env});
  if(result.status!=="refund_reconciled")throw Error("Buyer refund requires retry or review");return true;
}

export async function handoffBuyerMentorshipDisputeWebhook(args:{event:Stripe.Event;admin:SupabaseClient;
  stripe:Pick<Stripe,"charges">;env:Record<string,string|undefined>}):Promise<boolean> {
  const {event,admin,stripe,env}=args;
  if(env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY!=="true" ||
    env.CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_SCHEMA_READY!=="true" || env.CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_EVENTS_READY!=="true" ||
    !["charge.dispute.created","charge.dispute.updated","charge.dispute.closed"].includes(event.type))return false;
  const {charge}=await readBuyerDisputeCharge(event,stripe);
  const owner=await readBuyerMentorshipWebhookOwner({...event,data:{object:charge}},admin,"charge");if(!owner)return false;
  const object=event.data.object as Stripe.Dispute;
  const paymentIntentId=typeof charge.payment_intent==="string"?charge.payment_intent:charge.payment_intent?.id;
  if(object.object!=="dispute" || object.livemode!==event.livemode || !paymentIntentId)throw Error("Buyer dispute signed identity differs");
  const {observeBuyerMentorshipDispute}=await import("./mentorshipInstallmentDispute");
  const result=await observeBuyerMentorshipDispute({buyerId:owner.buyerId,requestId:owner.requestId,eventId:event.id,eventCreated:event.created,
    disputeId:object.id,paymentIntentId,chargeId:charge.id,customerId:owner.customerId,livemode:event.livemode,env});
  if(result.status!=="dispute_observed" && result.status!=="dispute_review_recorded")throw Error("Buyer dispute requires retry or review");
  return true;
}

/** A delayed success event may describe a capture with an observed refund or
 * dispute. Reconcile current financial evidence instead of clean-crediting or
 * activating access. Receipt identity binds the event; earlier financial
 * markers alone never establish its completion. */
export async function handoffBuyerMentorshipRecordedFinancialEvent(args:{event:Stripe.Event;admin:SupabaseClient;
  env:Record<string,string|undefined>;owner:NonNullable<Awaited<ReturnType<typeof readBuyerMentorshipWebhookOwner>>>;
  objectType:"checkout.session"|"payment_intent"|"charge"|"invoice";invoiceId?:string}):Promise<boolean> {
  const {event,admin,env,owner,objectType,invoiceId}=args;
  const refundsReady=env.CREATOR_MENTORSHIP_INSTALLMENT_REFUND_SCHEMA_READY==="true" &&
    env.CREATOR_MENTORSHIP_INSTALLMENT_REFUND_EVENTS_READY==="true";
  const disputesReady=env.CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_SCHEMA_READY==="true" &&
    env.CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_EVENTS_READY==="true";
  if(!refundsReady && !disputesReady)return false;
  let query=admin.from(invoiceId?"buyer_mentorship_later_receipts_v1":"buyer_mentorship_first_receipts_v1")
    .select("reservation_id,proof").eq("reservation_id",owner.reservationId);
  if(invoiceId)query=query.eq("invoice_id",invoiceId);
  const receipt=await query.maybeSingle();
  if(receipt.error)throw Error("Buyer delayed event receipt unavailable");
  if(!receipt.data)return false;
  const proof=receipt.data.proof;
  const expectedId=objectType==="checkout.session"?proof?.checkoutSessionId:objectType==="payment_intent"?proof?.paymentIntentId:
    objectType==="invoice"?proof?.invoiceId:proof?.chargeId;
  if(receipt.data.reservation_id!==owner.reservationId || proof?.reservationId!==owner.reservationId ||
    proof.customerId!==owner.customerId || expectedId!==owner.objectId || (invoiceId && proof.invoiceId!==invoiceId))
    throw Error("Buyer delayed event receipt differs");
  let disputeObserved=false;
  if(disputesReady) {
    const disputes=await admin.from("buyer_mentorship_dispute_events_v1").select("event_id,reservation_id,payment_intent_id,charge_id,dispute_id,details")
      .eq("reservation_id",owner.reservationId).eq("payment_intent_id",proof.paymentIntentId)
      .order("applied_at",{ascending:false,nullsFirst:false}).limit(101);
    if(disputes.error || !Array.isArray(disputes.data) || disputes.data.length>100)throw Error("Buyer delayed event dispute evidence unavailable");
    const {observeBuyerMentorshipDispute}=await import("./mentorshipInstallmentDispute");
    const seen=new Set<string>();
    for(const d of disputes.data) {
      if(d.reservation_id!==owner.reservationId || d.payment_intent_id!==proof.paymentIntentId || d.charge_id!==proof.chargeId ||
        typeof d.dispute_id!=="string")throw Error("Buyer delayed event dispute identity differs");
      if(seen.has(d.dispute_id))continue;
      seen.add(d.dispute_id);
      // Replay its original event identity: one success event can reference more
      // than one dispute and must not be rebound to several financial objects.
      if(!Number.isSafeInteger(d.details?.eventCreated) || d.details.eventCreated<=0)throw Error("Buyer dispute observation still pending");
      const result=await observeBuyerMentorshipDispute({buyerId:owner.buyerId,requestId:owner.requestId,eventId:d.event_id,
        eventCreated:d.details.eventCreated,disputeId:d.dispute_id,paymentIntentId:proof.paymentIntentId,chargeId:proof.chargeId,
        customerId:owner.customerId,livemode:event.livemode,env});
      if(result.status!=="dispute_observed" && result.status!=="dispute_review_recorded")throw Error("Buyer delayed event dispute requires retry or review");
      disputeObserved=true;
    }
  }
  if(!refundsReady)return disputeObserved;
  const observation=await admin.from("buyer_mentorship_refund_events_v1").select("reservation_id,payment_intent_id,charge_id,gross_cents")
    .eq("reservation_id",owner.reservationId).eq("payment_intent_id",proof.paymentIntentId).limit(1).maybeSingle();
  if(observation.error)throw Error("Buyer delayed event financial observation unavailable");
  if(!observation.data)return disputeObserved;
  if(observation.data.reservation_id!==owner.reservationId || observation.data.payment_intent_id!==proof.paymentIntentId ||
    observation.data.charge_id!==proof.chargeId || observation.data.gross_cents!==proof.amountCents)
    throw Error("Buyer delayed event financial identity differs");
  const {reconcileBuyerMentorshipRefund}=await import("./mentorshipInstallmentRefund");
  const result=await reconcileBuyerMentorshipRefund({buyerId:owner.buyerId,requestId:owner.requestId,eventId:event.id,
    paymentIntentId:proof.paymentIntentId,chargeId:proof.chargeId,customerId:owner.customerId,livemode:event.livemode,env});
  if(result.status!=="refund_reconciled")throw Error("Buyer delayed event refund requires retry or review");
  return true;
}

/** Temporary routing boundary for the new buyer-owned protocol. Call after
 * signature verification and the durable event claim, before other payment
 * handlers. It deliberately releases the claim through the route's error path:
 * an unsupported first payment must not be credited as a fully paid purchase.
 * This is not receipt processing and cannot enable Checkout publication. */
export async function rejectUnimplementedBuyerInstallmentEvent(args: {
  event: Stripe.Event; admin: SupabaseClient; env: Record<string, string | undefined>;
  stripe: Pick<Stripe, "charges">;
}): Promise<void> {
  const object = record(args.event.data.object);
  if (!object) return;
  const parent = record(object.parent);
  const related = [object, record(object.customer), record(object.charge), record(object.payment_intent),
    record(object.subscription), record(object.subscription_details), record(parent?.subscription_details)];
  if (related.some(item => record(item?.metadata)?.creatornet_installment_version === MENTORSHIP_INSTALLMENT_QUOTE_VERSION)) {
    throw Error("Buyer installment receipt processing is not ready; review required");
  }
  // Metadata is not reliably inherited by later invoices. The dedicated,
  // persisted Customer is an additional ownership signal, never a receipt.
  if (args.env.CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY !== "true") return;
  // Disputes normally carry only a charge ID, not a Customer or inherited
  // Checkout metadata. Resolve the signed relationship before choosing another
  // accounting handler. A failed read is uncertainty, never proof of nonownership.
  if (args.event.type.startsWith("charge.dispute.")) {
    const {charge,intent}=await readBuyerDisputeCharge(args.event,args.stripe);
    related.push(record(charge), intent);
    if (related.some(item => record(item?.metadata)?.creatornet_installment_version === MENTORSHIP_INSTALLMENT_QUOTE_VERSION)) {
      throw Error("Buyer installment receipt processing is not ready; review required");
    }
  }
  const customers = new Set<string>();
  for (const item of related) {
    const customer = item?.object === "customer" ? item.id :
      typeof item?.customer === "string" ? item.customer : record(item?.customer)?.id;
    if (typeof customer === "string" && /^cus_[A-Za-z0-9]+$/.test(customer)) customers.add(customer);
  }
  for (const customer of customers) {
    const found = await args.admin.from("buyer_mentorship_customer_operations_v1")
      .select("reservation_id").eq("customer_id", customer).maybeSingle();
    if (found.error) throw Error("Buyer installment event ownership could not be verified");
    if (found.data) throw Error("Buyer installment receipt processing is not ready; review required");
  }
}

async function readBuyerDisputeCharge(event:Stripe.Event,stripe:Pick<Stripe,"charges">) {
  const object=record(event.data.object);if(!object)throw Error("Buyer dispute object missing");
    const chargeId = typeof object.charge === "string" ? object.charge : record(object.charge)?.id;
    if (typeof chargeId !== "string" || !/^ch_[A-Za-z0-9]+$/.test(chargeId) || event.account != null) {
      throw Error("Buyer installment dispute relationship requires review");
    }
    const charge = await stripe.charges.retrieve(chargeId, { expand: ["payment_intent"] });
    const intent = record(charge.payment_intent);
    const eventIntentId = typeof object.payment_intent === "string" ? object.payment_intent : record(object.payment_intent)?.id;
    const intentId = typeof charge.payment_intent === "string" ? charge.payment_intent : intent?.id;
    if (charge.object !== "charge" || charge.id !== chargeId || charge.livemode !== event.livemode ||
        (eventIntentId != null && eventIntentId !== intentId) ||
        (intent && (intent.object !== "payment_intent" || intent.livemode !== event.livemode))) {
      throw Error("Buyer installment dispute relationship requires review");
    }

  return {charge,intent};
}
