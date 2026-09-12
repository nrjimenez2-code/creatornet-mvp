import "server-only";
import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import {assertAgreementId} from "./agreementStore";
import {HELD_INSTALLMENT_VERSION} from "./heldInvoice";
import {assertExactInstallmentEnvironment,assertExactInstallmentSandbox} from "./checkoutPreparation";
import {creditVerifiedFirstInstallmentSandbox} from "./receiptCredit";
import {activateExactInstallmentSandbox} from "./activation";
import {collectExactRenewalSandbox,type ExactRenewalResult} from "./renewal";
import type {ExactPurchaseLifecycleStore} from "./purchaseLifecycle";
import {reconcileExactRefundEventSandbox,type ExactRefundEventStore} from "./refundEvent";
import {observeExactDisputeSandbox,observeExactSubscriptionSandbox,type ExactLifecycleStore} from "./lifecycleEvents";
import {recoverExactRenewalSandbox,type ExactPaymentRecoveryStore} from "./paymentRecovery";
import {observeExpiredExactCheckoutSandbox} from "./checkoutExpiry";
import type {ExactPaymentRetryStore} from "./paymentRetryStore";
import {canCollectExactWebhookInvoice} from "./webhookCollection";
import {classifyExactInstallmentProtocol} from "./protocolBoundary";

type Binding=Readonly<{agreementId:string;purchaseId:string|null;sessionId:string|null;subscriptionId:string|null;
  customerId:string|null;status:string;previewOrigin:string}>;
export interface ExactEventBindingStore {
  bySession(id:string):Promise<Binding|null>;
  bySubscription(id:string):Promise<Binding|null>;
  byIntent(id:string):Promise<Binding|null>;
}

/** Resolve ONLY private, persisted identities. Event metadata may cause a
 * fail-closed retry, but can never select the buyer, fee, amount or purchase. */
export function createExactEventBindingStore(admin:SupabaseClient):ExactEventBindingStore {
  const fields="id,purchase_id,stripe_checkout_session_id,stripe_subscription_id,stripe_customer_id,status,terms";
  async function find(column:string,id:string):Promise<Binding|null> {
    const {data,error}=await admin.from("exact_installment_agreements").select(fields).eq(column,id).maybeSingle();
    if(error) throw new Error("Exact webhook binding lookup failed");
    if(!data) return null;
    assertAgreementId(data.id);
    if(data.purchase_id!==null) assertAgreementId(data.purchase_id);
    if(data.terms?.version!==HELD_INSTALLMENT_VERSION || typeof data.terms?.previewOrigin!=="string") {
      throw new Error("Invalid exact webhook binding");
    }
    return Object.freeze({agreementId:data.id,purchaseId:data.purchase_id,sessionId:data.stripe_checkout_session_id,
      subscriptionId:data.stripe_subscription_id,customerId:data.stripe_customer_id,status:data.status,previewOrigin:data.terms.previewOrigin});
  }
  return {
    bySession:id=>find("stripe_checkout_session_id",id),
    bySubscription:id=>find("stripe_subscription_id",id),
    async byIntent(id) {
      const {data,error}=await admin.from("exact_installment_receipts").select("agreement_id")
        .eq("stripe_payment_intent_id",id).maybeSingle();
      if(error) throw new Error("Exact webhook receipt lookup failed");
      if(data) return find("id",data.agreement_id);
      const {data:claim,error:claimError}=await admin.from("exact_installment_invoice_claims").select("agreement_id")
        .eq("stripe_payment_intent_id",id).maybeSingle();
      if(claimError) throw new Error("Exact webhook invoice lookup failed");
      return claim?find("id",claim.agreement_id):null;
    },
  };
}

type FirstInput=Parameters<typeof creditVerifiedFirstInstallmentSandbox>[0];
type ActivationInput=Parameters<typeof activateExactInstallmentSandbox>[0];
type RenewalInput=Parameters<typeof collectExactRenewalSandbox>[0];
type Input={
  // Caller MUST supply the event returned by the existing signature verifier
  // after acquiring its durable event claim. This is NOT a public HTTP handler.
  verifiedEvent:Stripe.Event;bindings:ExactEventBindingStore;
  store:FirstInput["store"];creditStore:FirstInput["creditStore"];
  activationStore:ActivationInput["activationStore"];invoiceStore:RenewalInput["invoiceStore"];
  lifecycleStore:ExactPurchaseLifecycleStore;
  refundStore:ExactRefundEventStore;
  lifecycleEventStore:ExactLifecycleStore;
  recoveryStore:ExactPaymentRecoveryStore;
  retryStore?:ExactPaymentRetryStore;
  stripe:Stripe;env:Record<string,string|undefined>;
};
export type ExactEventResult=Readonly<{handled:false}>|Readonly<{handled:true;
  disposition:"first_credited_held"|"first_already_activated"|"bootstrap_zero"|"separate_receipt_handler"|"refund_reconciled"|
  "lifecycle_observed"|"lifecycle_review_recorded"|"payment_recovery_recorded"|ExactRenewalResult["status"]}>;
const objectId=(v:string|{id:string}|null|undefined)=>typeof v==="string"?v:v?.id;

/** Both event types converge on the same idempotent receipt/accounting and
 * held activation. Neither path can create or collect a renewal invoice. */
async function fulfillFirstPayment(args:Input,binding:Binding,
  expectedPayment?:FirstInput["expectedPayment"]):Promise<ExactEventResult> {
  assertExactInstallmentSandbox(args.env,binding.previewOrigin);
  if(!binding.purchaseId || !binding.sessionId) throw new Error("Exact pending purchase not ready; retry required");
  await creditVerifiedFirstInstallmentSandbox({...args,agreementId:binding.agreementId,
    purchaseId:binding.purchaseId,sessionId:binding.sessionId,expectedPayment});
  await args.lifecycleStore.fulfillFirst(binding.agreementId);
  if(binding.status==="active" || binding.status==="complete") {
    return {handled:true,disposition:"first_already_activated"};
  }
  await activateExactInstallmentSandbox({...args,agreementId:binding.agreementId,sessionId:binding.sessionId});
  return {handled:true,disposition:"first_credited_held"};
}

/** Async capture can publish its balance transaction only after Checkout's
 * original delivery. The event snapshot is a locator, not payment evidence. */
async function recoverFirstCharge(args:Input,tagged:boolean):Promise<ExactEventResult> {
  assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
  if(args.verifiedEvent.livemode!==false) throw new Error("Live installment event is not enabled");
  const chargeId=(args.verifiedEvent.data.object as Stripe.Charge).id;
  if(!/^ch_[A-Za-z0-9]+$/.test(chargeId)) throw new Error("Invalid updated charge identity");
  const charge=await args.stripe.charges.retrieve(chargeId);
  const chargeTagged=classifyExactInstallmentProtocol(charge)==="exact-v1";
  if(charge.id!==chargeId || charge.livemode!==false) throw new Error("Updated charge identity differs");
  const paymentIntentId=objectId(charge.payment_intent);
  if(!paymentIntentId) {
    if(tagged || chargeTagged) {
      throw new Error("Exact updated charge payment identity missing");
    }
    return {handled:false};
  }
  if(!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) throw new Error("Invalid updated charge payment identity");
  const intent=await args.stripe.paymentIntents.retrieve(paymentIntentId);
  const exact=classifyExactInstallmentProtocol(intent)==="exact-v1";
  if(intent.id!==paymentIntentId || intent.livemode!==false) throw new Error("Updated charge payment identity differs");
  const known=await args.bindings.byIntent(paymentIntentId);
  const metadata=intent.metadata;
  if(!known && !exact) {
    if(tagged || chargeTagged) {
      throw new Error("Exact updated charge metadata conflict");
    }
    return {handled:false};
  }
  // Current PI metadata selects only a candidate. Persisted agreement/session
  // identities plus full fresh receipt verification authorize the first credit.
  const agreementId=exact?metadata.installment_plan_id:known!.agreementId;
  assertAgreementId(agreementId);
  if(known && known.agreementId!==agreementId) throw new Error("Exact updated charge agreement conflict");
  if(args.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE!=="true") {
    return {handled:true,disposition:"reconciliation_required"};
  }
  const agreement=await args.store.load(agreementId);
  assertExactInstallmentSandbox(args.env,agreement.terms.previewOrigin);
  if(agreement.id!==agreementId || !agreement.sessionId) throw new Error("Exact updated charge agreement not ready");
  const binding=await args.bindings.bySession(agreement.sessionId);
  if(!binding || binding.agreementId!==agreement.id || binding.sessionId!==agreement.sessionId ||
      binding.customerId!==agreement.customerId || binding.subscriptionId!==agreement.subscriptionId ||
      binding.previewOrigin!==agreement.terms.previewOrigin ||
      objectId(intent.customer)!==agreement.customerId || objectId(charge.customer)!==agreement.customerId ||
      objectId(intent.latest_charge)!==chargeId) throw new Error("Exact updated charge binding mismatch");
  const session=await args.stripe.checkout.sessions.retrieve(agreement.sessionId);
  classifyExactInstallmentProtocol(session);
  if(session.id!==agreement.sessionId || session.livemode!==false ||
      objectId(session.customer)!==agreement.customerId) throw new Error("Exact updated charge Checkout mismatch");
  const firstIntent=objectId(session.payment_intent);
  if(!firstIntent || !/^pi_[A-Za-z0-9]+$/.test(firstIntent)) throw new Error("Exact updated charge Checkout payment missing");
  if(firstIntent!==paymentIntentId) {
    // A persisted receipt/invoice claim, not a metadata number alone, proves a
    // non-first payment belongs to this agreement. Its own invoice handler owns it.
    if(!known || exact && (!/^[1-9]\d*$/.test(metadata.installment_number || "") ||
        Number(metadata.installment_number)<2 ||
        Number(metadata.installment_number)>agreement.terms.paymentCount)) {
      throw new Error("Exact updated charge is not the saved first payment");
    }
    return {handled:true,disposition:"separate_receipt_handler"};
  }
  if(!exact || metadata.installment_number!=="1") throw new Error("Exact updated first-charge metadata conflict");
  return fulfillFirstPayment(args,binding,{paymentIntentId,chargeId});
}

/** Candidate handoff imported after the canonical route's signature/event claim.
 * `handled:true` MUST bypass the legacy one-time/subscription switch entirely.
 * Reconciliation/unknown events MUST NOT be marked complete by that route.
 * Requires a separately seeded new purchase. First delivery is retryable and
 * only follows verified receipt credit; no URL is published by this handler.
 * Cancellation fencing and recovery remain collection prerequisites.
 */
export async function dispatchExactInstallmentEventSandbox(args:Input):Promise<ExactEventResult> {
  const event=args.verifiedEvent;
  const tagged=classifyExactInstallmentProtocol(event.data.object)==="exact-v1";
  if(event.type==="charge.updated" && [args.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY,
    args.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE].includes("true")) {
    return recoverFirstCharge(args,tagged);
  }
  if(event.type==="checkout.session.expired" && [args.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY,
    args.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE,args.env.CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY].includes("true")) {
    assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
    if(event.livemode!==false) throw new Error("Live installment event is not enabled");
    const binding=await args.bindings.bySession(event.data.object.id);
    if(binding) {
      if(args.env.CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY!=="true") return {handled:true,disposition:"reconciliation_required"};
      const result=await observeExpiredExactCheckoutSandbox({...args,agreementId:binding.agreementId,
        sessionId:event.data.object.id,eventId:event.id});
      return {handled:true,disposition:result.status};
    }
    if(tagged) throw new Error("Exact expired Checkout binding not ready; retry required");
    return {handled:false};
  }
  const failedInvoice=event.type==="invoice.payment_failed"||event.type==="invoice.payment_action_required"||
    event.type==="invoice.voided"||event.type==="invoice.marked_uncollectible";
  const paidInvoice=event.type==="invoice.paid"||event.type==="invoice.payment_succeeded";
  if((failedInvoice||paidInvoice&&args.env.CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY==="true")&&
    [args.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY,args.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE,
      args.env.CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY].includes("true")) {
    assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
    if(event.livemode!==false) throw new Error("Live installment event is not enabled");
    const invoice=event.data.object as Stripe.Invoice;
    const sub=objectId(invoice.parent?.subscription_details?.subscription);
    const binding=sub?await args.bindings.bySubscription(sub):null;
    if(binding) {
      assertExactInstallmentEnvironment(args.env,binding.previewOrigin);
      if(args.env.CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY!=="true") return {handled:true,disposition:"reconciliation_required"};
      if(failedInvoice||await args.recoveryStore.has(binding.agreementId,invoice.id)) {
        const result=await recoverExactRenewalSandbox({...args,agreementId:binding.agreementId,invoiceId:invoice.id,eventId:event.id});
        return {handled:true,disposition:result.status};
      }
      // A normal paid invoice without a recovery record uses existing receipt
      // handling below; it does not acquire a needless failure/review hold.
    } else if(tagged) throw new Error("Exact recovery binding not ready; retry required");
    else if(failedInvoice) return {handled:false};
  }
  const isDispute=event.type==="charge.dispute.created"||event.type==="charge.dispute.updated"||event.type==="charge.dispute.closed"||
    event.type==="charge.dispute.funds_withdrawn"||event.type==="charge.dispute.funds_reinstated";
  const isSubscription=event.type==="customer.subscription.created"||event.type==="customer.subscription.updated"||
    event.type==="customer.subscription.deleted"||event.type==="customer.subscription.paused"||event.type==="customer.subscription.resumed";
  if((isDispute||isSubscription)&&[args.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY,
    args.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE,args.env.CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY].includes("true")) {
    assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
    if(event.livemode!==false) throw new Error("Live installment event is not enabled");
    if(isSubscription) {
      const subscription=event.data.object as Stripe.Subscription;
      const binding=await args.bindings.bySubscription(subscription.id);
      if(binding) {
        assertExactInstallmentEnvironment(args.env,binding.previewOrigin);
        if(args.env.CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY!=="true") return {handled:true,disposition:"reconciliation_required"};
        const result=await observeExactSubscriptionSandbox({...args,agreementId:binding.agreementId,
          subscriptionId:subscription.id,eventId:event.id});
        return {handled:true,disposition:result.status};
      }
    } else {
      const dispute=event.data.object as Stripe.Dispute;
      let pi=objectId(dispute.payment_intent);
      // Dispute.payment_intent is nullable. The actual charge provides linkage;
      // missing metadata must not send a first exact charge into legacy logic.
      if(!pi) {
        const cid=objectId(dispute.charge);
        if(!cid||!/^ch_[a-zA-Z0-9]+$/.test(cid)) throw new Error("Dispute charge binding missing");
        let charge:Stripe.Charge;
        try {charge=await args.stripe.charges.retrieve(cid);}catch{throw new Error("Dispute charge evidence unavailable");}
        classifyExactInstallmentProtocol(charge);
        if(charge.id!==cid||charge.livemode!==false) throw new Error("Dispute charge identity differs");
        pi=objectId(charge.payment_intent);
      }
      const binding=pi?await args.bindings.byIntent(pi):null;
      if(binding&&pi) {
        assertExactInstallmentEnvironment(args.env,binding.previewOrigin);
        if(args.env.CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY!=="true") return {handled:true,disposition:"reconciliation_required"};
        const result=await observeExactDisputeSandbox({...args,agreementId:binding.agreementId,
          disputeId:dispute.id,paymentIntentId:pi,eventId:event.id,eventCreated:event.created});
        return {handled:true,disposition:result.status};
      }
      if(pi) {
        let intent:Stripe.PaymentIntent;
        try {intent=await args.stripe.paymentIntents.retrieve(pi);}catch{throw new Error("Dispute payment evidence unavailable");}
        const exact=classifyExactInstallmentProtocol(intent)==="exact-v1";
        if(intent.id!==pi||intent.livemode!==false) throw new Error("Dispute payment identity differs");
        if(exact) throw new Error("Exact dispute receipt not ready; retry required");
      }
    }
    if(tagged) throw new Error("Exact lifecycle binding not ready; retry required");
    return {handled:false};
  }
  // Refund accounting has its own schema acknowledgement, so pausing creation
  // does not silently abandon refunds on agreements already created. Unknown
  // legacy charges remain with the existing handler; no new table is queried
  // when every relevant candidate flag is off.
  if((event.type==="charge.refunded" || event.type==="refund.created" || event.type==="refund.updated" || event.type==="refund.failed") &&
    [args.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY,
    args.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE,args.env.CREATOR_EXACT_INSTALLMENTS_REFUND_EVENTS_READY].includes("true")) {
    assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
    if(event.livemode!==false) throw new Error("Live installment event is not enabled");
    const pi=objectId(event.data.object.payment_intent);
    const binding=pi?await args.bindings.byIntent(pi):null;
    if(binding && pi) {
      assertExactInstallmentEnvironment(args.env,binding.previewOrigin);
      if(args.env.CREATOR_EXACT_INSTALLMENTS_REFUND_EVENTS_READY!=="true") {
        return {handled:true,disposition:"reconciliation_required"};
      }
      const chargeId=event.type==="charge.refunded"?event.data.object.id:objectId(event.data.object.charge);
      if(!chargeId) throw new Error("Exact refund charge identity missing");
      const result=await reconcileExactRefundEventSandbox({...args,agreementId:binding.agreementId,
        paymentIntentId:pi,chargeId,eventId:event.id});
      return {handled:true,disposition:result.status};
    }
    if(tagged) throw new Error("Exact refund binding not ready; retry required");
    return {handled:false};
  }
  if(args.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE!=="true") {
    if(tagged) throw new Error("Exact installment event cannot fall back to legacy processing");
    // Once the schema/route is installed this flag must remain on even while
    // preparation/collection is paused. Untagged invoice PIs can still arrive;
    // quarantine known identities instead of running old one-time accounting.
    if(args.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY==="true") {
      assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
      if(event.livemode!==false) throw new Error("Live installment event is not enabled");
      let known:Binding|null=null;
      if(event.type==="checkout.session.completed" || event.type==="checkout.session.expired") {
        known=await args.bindings.bySession(event.data.object.id);
      } else if(event.type==="payment_intent.succeeded" || event.type==="payment_intent.payment_failed") {
        known=await args.bindings.byIntent(event.data.object.id);
      } else if(event.type==="invoice.created" || event.type==="invoice.paid" || event.type==="invoice.payment_succeeded") {
        const sid=objectId(event.data.object.parent?.subscription_details?.subscription);
        if(sid) known=await args.bindings.bySubscription(sid);
      } else if(event.type==="charge.refunded" || event.type==="charge.dispute.created" ||
        event.type==="charge.dispute.updated" || event.type==="charge.dispute.closed") {
        const pi=objectId(event.data.object.payment_intent);
        if(pi) known=await args.bindings.byIntent(pi);
      } else if(event.type==="customer.subscription.updated" || event.type==="customer.subscription.deleted") {
        known=await args.bindings.bySubscription(event.data.object.id);
      }
      if(known) return {handled:true,disposition:"reconciliation_required"};
    }
    return {handled:false};
  }
  // Reject production configuration and live events before even a binding read.
  assertExactInstallmentSandbox(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
  if(event.livemode!==false) throw new Error("Live installment event is not enabled");
  if(event.type==="checkout.session.completed") {
    const session=event.data.object;
    const binding=await args.bindings.bySession(session.id);
    if(!binding) {
      if(tagged) throw new Error("Exact Checkout binding not ready; retry required");
      return {handled:false};
    }
    assertExactInstallmentSandbox(args.env,binding.previewOrigin);
    if(!binding.purchaseId || !binding.sessionId || binding.sessionId!==session.id) {
      throw new Error("Exact pending purchase not ready; retry required");
    }
    // The actual Stripe objects, not this event's amounts or metadata, are
    // verified again by the first-receipt handler. Its accounting RPC is not
    // the legacy one-time creditPurchaseEarnings path.
    return fulfillFirstPayment(args,binding);
  }
  if(event.type==="invoice.created" || event.type==="invoice.payment_succeeded" || event.type==="invoice.paid") {
    const incoming=event.data.object;
    const sid=objectId(incoming.parent?.subscription_details?.subscription);
    const binding=sid?await args.bindings.bySubscription(sid):null;
    if(!binding) {
      const parentTag=incoming.parent?.subscription_details?.metadata?.installment_collection_version;
      if(tagged || parentTag===HELD_INSTALLMENT_VERSION) throw new Error("Exact invoice binding not ready; retry required");
      return {handled:false};
    }
    assertExactInstallmentSandbox(args.env,binding.previewOrigin);
    const invoice=await args.stripe.invoices.retrieve(incoming.id);
    classifyExactInstallmentProtocol(invoice);
    if(invoice.id!==incoming.id || invoice.livemode!==false ||
      objectId(invoice.parent?.subscription_details?.subscription)!==binding.subscriptionId ||
      objectId(invoice.customer)!==binding.customerId) throw new Error("Exact invoice binding mismatch");
    if(invoice.billing_reason==="subscription_create" && invoice.total===0 && invoice.subtotal===0 &&
      invoice.amount_due===0 && invoice.amount_paid===0 && invoice.currency==="usd" &&
      invoice.starting_balance===0 && !invoice.discounts?.length && !invoice.total_discount_amounts?.length &&
      !invoice.total_taxes?.length && !invoice.pre_payment_credit_notes_amount && !invoice.post_payment_credit_notes_amount) {
      return {handled:true,disposition:"bootstrap_zero"}; // NOT an installment or access grant.
    }
    const collectionAllowed=canCollectExactWebhookInvoice({env:args.env,eventType:event.type,
      agreementId:binding.agreementId,previewOrigin:binding.previewOrigin});
    const result=await collectExactRenewalSandbox({...args,agreementId:binding.agreementId,invoiceId:invoice.id,
      reconcileOnly:event.type!=="invoice.created",
      env:{...args.env,CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT:collectionAllowed?"true":"false"}});
    return {handled:true,disposition:result.status};
  }
  if(event.type==="payment_intent.succeeded" || event.type==="payment_intent.payment_failed") {
    const binding=await args.bindings.byIntent(event.data.object.id);
    if(binding) {
      assertExactInstallmentSandbox(args.env,binding.previewOrigin);
      return {handled:true,disposition:"separate_receipt_handler"};
    }
    // First PI success can precede its Checkout event/receipt. Do not let that
    // race become a one-time credit; require retry until its binding exists.
    if(tagged) throw new Error("Exact payment receipt not ready; retry required");
    return {handled:false};
  }
  // Remaining lifecycle events need dedicated handlers, not the legacy inference that
  // only invoice-backed charges are installments. The first exact charge has
  // no invoice ID. Quarantine even if incoming metadata was removed.
  if(event.type==="charge.refunded" || event.type==="charge.dispute.created" ||
    event.type==="charge.dispute.updated" || event.type==="charge.dispute.closed") {
    const pi=objectId(event.data.object.payment_intent);
    if(pi && await args.bindings.byIntent(pi)) return {handled:true,disposition:"reconciliation_required"};
  }
  if(event.type==="customer.subscription.updated" || event.type==="customer.subscription.deleted") {
    if(await args.bindings.bySubscription(event.data.object.id)) return {handled:true,disposition:"reconciliation_required"};
  }
  if(tagged) throw new Error("Exact installment lifecycle event needs a dedicated handler");
  return {handled:false};
}
