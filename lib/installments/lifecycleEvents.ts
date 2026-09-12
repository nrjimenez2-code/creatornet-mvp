import "server-only";
import {hasExpectedFutureEnd} from "./scheduledEnd";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateInstallmentPlan } from "../installmentPlan";
import { assertAgreementId, type ExactAgreementStore } from "./agreementStore";
import type { ExactActivation } from "./activation";
import type { ExactRefundEventStore } from "./refundEvent";
import { assertExactInstallmentEnvironment, installmentMonthBoundary } from "./checkoutPreparation";

export type LifecycleBasis=Readonly<{agreementStatus:string;activationStatus:string|null;activation:ExactActivation|null;
  stopStatus:string|null;stopCanceledAt:number|null}>;
export type LifecycleRead=Readonly<{revision:number;basis:LifecycleBasis}>;
type Observation=Readonly<{agreementId:string;eventId:string;objectId:string;read:LifecycleRead}>;
export type LifecycleDisposition="expected_held_schedule"|"billing_stop_observed"|"scheduled_end_observed"|"review_required";
export type LifecycleResult={status:"lifecycle_observed"|"lifecycle_review_recorded"|"reconciliation_required"};
/** Audit classification only. Current subscription ownership must be established
 * by the caller; expectedSchedule validates that protocol's unchanged terms.
 * No canceled/ended marker, even an expected one, grants a credit or debt waiver. */
export function classifyExactSubscriptionLifecycle(sub:Pick<Stripe.Subscription,"status"|"canceled_at"|"ended_at">,
  basis:LifecycleBasis,createdAt:number,now:number,expectedSchedule:()=>boolean):LifecycleDisposition {
  if(sub.status==="canceled") {
    const terminal=Number.isSafeInteger(sub.canceled_at)&&Number.isSafeInteger(sub.ended_at)&&
      !!sub.canceled_at&&!!sub.ended_at&&sub.canceled_at<=now&&sub.ended_at<=now&&sub.ended_at>=createdAt;
    if(terminal&&basis.stopStatus==="complete"&&basis.stopCanceledAt===sub.canceled_at) return "billing_stop_observed";
    if(terminal&&basis.agreementStatus==="complete"&&basis.activationStatus==="complete"&&basis.activation&&
      sub.ended_at!>=basis.activation.cancelAt) return "scheduled_end_observed";
  } else if(expectedSchedule()&&basis.stopStatus!=="complete"&&["awaiting_first","active","complete"].includes(basis.agreementStatus))
    return "expected_held_schedule";
  return "review_required";
}
type DisputeProof=Readonly<{paymentIntentId:string;chargeId:string;grossCents:number;disputedCents:number;status:string;eventCreated:number}>;
export interface ExactLifecycleStore {
  read(agreementId:string,objectId:string):Promise<LifecycleRead>;
  hold(agreementId:string,eventId:string,objectId:string,paymentIntentId:string|null):Promise<void>;
  observe(o:Observation,disposition:LifecycleDisposition,details:Record<string,unknown>):Promise<boolean>;
  dispute(o:Observation,proof:DisputeProof):Promise<LifecycleResult["status"]>;
}
const id=(v:string|{id:string}|null|undefined)=>typeof v==="string"?v:v?.id;
function requireThat(v:unknown,why:string):asserts v {if(!v) throw new Error(`Exact lifecycle: ${why}`);}
async function readStripe<T>(fn:()=>Promise<T>):Promise<T> {
  try{return await fn();}catch{throw new Error("Exact lifecycle Stripe evidence unavailable");}
}
const params=(o:Observation)=>({p_agreement_id:o.agreementId,p_event_id:o.eventId,p_object_id:o.objectId,
  p_revision:o.read.revision,p_basis:o.read.basis});
export function parseExactLifecycleRead(value:unknown,agreementId:string):LifecycleRead {
  requireThat(value&&typeof value==="object"&&!Array.isArray(value),"invalid lifecycle read");
  const result=value as LifecycleRead;
  requireThat(Number.isSafeInteger(result.revision)&&result.revision>=0&&result.basis&&
    typeof result.basis.agreementStatus==="string"&&
    [null,"running","complete"].includes(result.basis.activationStatus)&&[null,"running","complete"].includes(result.basis.stopStatus)&&
    (result.basis.stopCanceledAt===null||(Number.isSafeInteger(result.basis.stopCanceledAt)&&result.basis.stopCanceledAt>0)),"invalid lifecycle read");
  const a=result.basis.activation;
  requireThat(a===null||(a&&a.agreementId===agreementId&&/^pi_[a-zA-Z0-9]+$/.test(a.firstPaymentIntentId)&&
    /^pm_[a-zA-Z0-9]+$/.test(a.paymentMethodId)&&/^si_[a-zA-Z0-9]+$/.test(a.subscriptionItemId)&&
    [a.firstPaidAt,a.firstRenewalAt,a.cancelAt].every(v=>Number.isSafeInteger(v)&&v>0)&&
    a.firstPaidAt<a.firstRenewalAt&&a.firstRenewalAt<a.cancelAt),"invalid saved activation");
  requireThat((a===null)===(result.basis.activationStatus===null),"activation basis differs");
  return result;
}
export function createExactLifecycleStore(admin:SupabaseClient):ExactLifecycleStore {
  const rpc=async(name:string,p:Record<string,unknown>)=>{
    const {data,error}=await admin.rpc(name,p);
    if(error) throw new Error(`Exact lifecycle database operation failed: ${name}`);
    return data;
  };
  return {
    async read(agreementId,objectId) {
      assertAgreementId(agreementId);
      requireThat(/^(du|sub)_[a-zA-Z0-9]+$/.test(objectId),"invalid resource identity");
      const result=await rpc("read_exact_installment_lifecycle",{p_agreement_id:agreementId,p_object_id:objectId});
      return parseExactLifecycleRead(result,agreementId);
    },
    async hold(agreementId,eventId,objectId,paymentIntentId) {
      await rpc("hold_exact_installment_lifecycle_event",{p_agreement_id:agreementId,p_event_id:eventId,
        p_object_id:objectId,p_payment_intent_id:paymentIntentId});
    },
    async observe(o,disposition,details) {
      const result=await rpc("finish_exact_installment_lifecycle",{...params(o),p_disposition:disposition,p_details:details});
      requireThat(typeof result==="boolean","invalid observation result");return result;
    },
    async dispute(o,p) {
      const result=await rpc("apply_exact_installment_dispute_event",{p_agreement_id:o.agreementId,p_event_id:o.eventId,
        p_dispute_id:o.objectId,p_revision:o.read.revision,p_basis:o.read.basis,p_payment_intent_id:p.paymentIntentId,
        p_charge_id:p.chargeId,p_gross_cents:p.grossCents,p_disputed_cents:p.disputedCents,p_status:p.status,p_event_created:p.eventCreated});
      requireThat(["lifecycle_observed","lifecycle_review_recorded","reconciliation_required"].includes(result),"invalid dispute result");
      return result as LifecycleResult["status"];
    },
  };
}
type Common={agreementId:string;eventId:string;store:ExactAgreementStore;lifecycleEventStore:ExactLifecycleStore;
  env:Record<string,string|undefined>};
function gate(args:Common) {
  assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
  requireThat(args.env.CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY==="true"&&
    args.env.CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY==="true","lifecycle schema not enabled");
  assertAgreementId(args.agreementId);requireThat(/^evt_[a-zA-Z0-9]+$/.test(args.eventId),"invalid event identity");
}

/** After canonical signature/event claim. Audit-only, including first-charge
 * disputes with no invoice ID. Retrieved payment/receipt identities select the
 * ledger. This never decides dispute-cost responsibility or releases a hold. */
export async function observeExactDisputeSandbox(args:Common&{disputeId:string;paymentIntentId:string;eventCreated:number;
  refundStore:ExactRefundEventStore;stripe:Pick<Stripe,"disputes"|"paymentIntents"|"charges"|"balanceTransactions">}):Promise<LifecycleResult> {
  gate(args);requireThat(/^du_[a-zA-Z0-9]+$/.test(args.disputeId)&&/^pi_[a-zA-Z0-9]+$/.test(args.paymentIntentId)&&
    Number.isSafeInteger(args.eventCreated)&&args.eventCreated>0,"invalid dispute identity");
  const a=await args.store.load(args.agreementId);assertExactInstallmentEnvironment(args.env,a.terms.previewOrigin);
  requireThat(a.id===args.agreementId&&a.customerId&&a.subscriptionId&&a.sessionId,"agreement binding missing");
  const snapshot=await args.lifecycleEventStore.read(a.id,args.disputeId);
  // The signed event's persisted PI binding can stop NEW collections before
  // slow Stripe reads. The hold also survives uncredited receipts or outages.
  await args.lifecycleEventStore.hold(a.id,args.eventId,args.disputeId,args.paymentIntentId);
  const d=await readStripe(()=>args.stripe.disputes.retrieve(args.disputeId));
  requireThat(d.id===args.disputeId&&d.livemode===false&&d.currency==="usd"&&
    (d.payment_intent==null||id(d.payment_intent)===args.paymentIntentId)&&Number.isSafeInteger(d.amount)&&d.amount>0&&d.amount<=99999999,
  "dispute evidence differs");
  requireThat(["warning_needs_response","warning_under_review","warning_closed","needs_response","under_review","won","lost","prevented"]
    .includes(d.status),"unknown dispute status");
  const r=await args.refundStore.creditedReceipt(a.id,args.paymentIntentId);
  if(!r) return {status:"reconciliation_required"};
  const expected=calculateInstallmentPlan(a.terms.totalCents,a.terms.paymentCount,a.terms.renewalFeeSchedule,
    a.terms.firstPaymentFeeSchedule).payments[r.paymentNumber-1];
  requireThat(expected&&r.amountCents===expected.amountCents&&r.applicationFeeCents===expected.fees.totalCreatorDeductionCents&&
    id(d.charge)===r.chargeId,"credited dispute terms differ");
  const pi=await readStripe(()=>args.stripe.paymentIntents.retrieve(args.paymentIntentId));
  requireThat(pi.id===args.paymentIntentId&&pi.livemode===false&&pi.status==="succeeded"&&id(pi.customer)===a.customerId&&
    id(pi.latest_charge)===r.chargeId&&pi.currency==="usd"&&pi.amount===r.amountCents&&pi.amount_received===r.amountCents&&
    pi.application_fee_amount===r.applicationFeeCents&&id(pi.transfer_data?.destination)===a.terms.destinationId&&
    pi.transfer_data?.amount==null,"captured dispute payment differs");
  const charge=await readStripe(()=>args.stripe.charges.retrieve(r.chargeId));
  requireThat(charge.id===r.chargeId&&charge.livemode===false&&id(charge.payment_intent)===pi.id&&id(charge.customer)===a.customerId&&
    charge.paid===true&&charge.captured===true&&charge.status==="succeeded"&&charge.currency==="usd"&&
    charge.amount===r.amountCents&&charge.amount_captured===r.amountCents&&charge.payment_method_details?.type==="card"&&
    id(charge.balance_transaction)===r.balanceTransactionId,"captured dispute charge differs");
  const balance=await readStripe(()=>args.stripe.balanceTransactions.retrieve(r.balanceTransactionId));
  requireThat(balance.id===r.balanceTransactionId&&id(balance.source)===r.chargeId&&balance.currency==="usd"&&
    balance.type==="charge"&&balance.amount===r.amountCents&&balance.fee===r.actualStripeFeeCents&&balance.net===balance.amount-balance.fee,
  "original balance audit differs");
  return {status:await args.lifecycleEventStore.dispute({agreementId:a.id,eventId:args.eventId,objectId:d.id,read:snapshot},
    {paymentIntentId:pi.id,chargeId:charge.id,grossCents:r.amountCents,disputedCents:d.amount,status:d.status,eventCreated:args.eventCreated})};
}

/** Observe, never mutate a subscription. A changed/canceled schedule fences new
 * collections and records review; it does not mark an installment paid or revoke
 * access. Expected bootstrap/activation and already-approved stops can be ACKed
 * without sending every ordinary subscription update into an endless retry. */
export async function observeExactSubscriptionSandbox(args:Common&{subscriptionId:string;
  stripe:Pick<Stripe,"subscriptions">;now?:()=>number}):Promise<LifecycleResult> {
  gate(args);requireThat(/^sub_[a-zA-Z0-9]+$/.test(args.subscriptionId),"invalid subscription identity");
  const a=await args.store.load(args.agreementId);assertExactInstallmentEnvironment(args.env,a.terms.previewOrigin);
  requireThat(a.id===args.agreementId&&a.subscriptionId===args.subscriptionId&&a.customerId,"subscription binding missing");
  const snapshot=await args.lifecycleEventStore.read(a.id,args.subscriptionId),b=snapshot.basis;
  if(b.agreementStatus!==a.status) return {status:"reconciliation_required"};
  const sub=await readStripe(()=>args.stripe.subscriptions.retrieve(args.subscriptionId));
  requireThat(sub.id===a.subscriptionId&&sub.livemode===false&&id(sub.customer)===a.customerId,"subscription owner differs");
  const now=(args.now??(()=>Math.floor(Date.now()/1000)))();
  const disposition=classifyExactSubscriptionLifecycle(sub,b,a.createdAt,now,()=>{
    const plan=calculateInstallmentPlan(a.terms.totalCents,a.terms.paymentCount,a.terms.renewalFeeSchedule,a.terms.firstPaymentFeeSchedule);
    const item=sub.items.data[0];
    const common=["trialing","active"].includes(sub.status)&&sub.billing_mode?.type==="classic"&&
      sub.pause_collection?.behavior==="keep_as_draft"&&sub.pause_collection.resumes_at==null&&
      sub.collection_method==="charge_automatically"&&sub.cancel_at!=null&&hasExpectedFutureEnd(sub,sub.cancel_at,a.createdAt,now)&&
      sub.schedule==null&&sub.pending_update==null&&sub.default_source==null&&sub.application_fee_percent==null&&
      id(sub.transfer_data?.destination)===a.terms.destinationId&&sub.transfer_data?.amount_percent==null&&
      sub.metadata.installment_plan_id===a.id&&sub.metadata.installment_collection_version===a.terms.version&&
      sub.metadata.booking_payment_id===a.terms.bookingPaymentId&&!sub.automatic_tax.enabled&&!sub.discounts?.length&&
      !sub.default_tax_rates?.length&&sub.billing_thresholds==null&&sub.pending_invoice_item_interval==null&&
      !sub.items.has_more&&sub.items.data.length===1&&item.quantity===1&&item.subscription===sub.id&&
      item.price.unit_amount===plan.regularAmountCents&&item.price.currency==="usd"&&item.price.billing_scheme==="per_unit"&&
      item.price.recurring?.interval==="month"&&item.price.recurring.interval_count===1&&item.price.recurring.usage_type==="licensed"&&
      !item.tax_rates?.length&&!item.discounts?.length&&item.billing_thresholds==null&&item.price.transform_quantity==null;
    const end=a.createdAt+48*3600;
    const bootstrap=b.agreementStatus==="awaiting_first"&&sub.status==="trialing"&&sub.trial_end===end&&
      sub.cancel_at===installmentMonthBoundary(end,a.terms.paymentCount-1)&&sub.default_payment_method==null&&
      !sub.metadata.installment_activation_version&&b.activationStatus!=="complete";
    const act=b.activation;
    const activated=act&&(b.activationStatus==="running"||b.activationStatus==="complete")&&
      sub.trial_end===act.firstRenewalAt&&sub.billing_cycle_anchor===act.firstRenewalAt&&sub.cancel_at===act.cancelAt&&
      item?.id===act.subscriptionItemId&&id(sub.default_payment_method)===act.paymentMethodId&&
      sub.metadata.installment_activation_version==="first-paid-v1"&&sub.payment_settings?.payment_method_types?.length===1&&
      sub.payment_settings.payment_method_types[0]==="card"&&sub.payment_settings.save_default_payment_method==="off";
    return Boolean(common&&(bootstrap||activated));
  });
  if(disposition!=="expected_held_schedule") await args.lifecycleEventStore.hold(a.id,args.eventId,sub.id,null);
  const saved=await args.lifecycleEventStore.observe({agreementId:a.id,eventId:args.eventId,objectId:sub.id,read:snapshot},disposition,
    {status:sub.status,cancelAt:sub.cancel_at,canceledAt:sub.canceled_at,endedAt:sub.ended_at,
      pauseBehavior:sub.pause_collection?.behavior??null});
  return {status:!saved?"reconciliation_required":disposition==="review_required"?"lifecycle_review_recorded":"lifecycle_observed"};
}
