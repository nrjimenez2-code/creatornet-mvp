import "server-only";
import { isSupportedStripeSnapshotVersion } from "../stripeSnapshotVersion";
import type Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import { assertAgreementId } from "./agreementStore";
import { calculateInstallmentPlan } from "../installmentPlan";
import type { ExactContextReservation } from "./contextReservation";
import { contextStripeId } from "./contextCheckout";
import { parseExactLifecycleRead } from "./lifecycleEvents";
import type { ExactRefundReceipt } from "./refundEvent";

function check(v:unknown):asserts v { if(!v) throw new Error("Context financial event requires review"); }
function fields(v:unknown,keys:string[]):Record<string,unknown> {
  check(v&&typeof v==="object"&&Object.getPrototypeOf(v)===Object.prototype);
  const ds=Object.getOwnPropertyDescriptors(v); check(Reflect.ownKeys(ds).length===keys.length);
  for(const k of keys) check(ds[k]&&"value" in ds[k]&&ds[k].enumerable);
  return v as Record<string,unknown>;
}
const refundTypes=["charge.refunded","refund.created","refund.updated","refund.failed"];
const disputeTypes=["charge.dispute.created","charge.dispute.updated","charge.dispute.closed",
  "charge.dispute.funds_withdrawn","charge.dispute.funds_reinstated"];
export type ContextFinancialEvent=Readonly<{id:string;type:string;kind:"refund"|"dispute";objectId:string;
  paymentIntentId:string;chargeId:string;created:number}>;

/** Event must be retrieved by the private account-checked SDK. Payload money
 * is never accepted as proof. Canonical HTTP signature/claim is still required. */
export function inspectContextFinancialEvent(event:Stripe.Event,eventId:string,r:ExactContextReservation,apiVersion:string) {
  check(event.id===eventId&&event.object==="event"&&isSupportedStripeSnapshotVersion(event.api_version,apiVersion)&&event.livemode===(r.context.mode==="live")&&
    event.account==null&&(event as unknown as {context?:unknown}).context==null&&Number.isSafeInteger(event.created)&&
    event.created>=r.createdAt&&event.created<=Math.floor(Date.now()/1000));
  contextStripeId(event.id,"evt");
  check(refundTypes.includes(event.type)||disputeTypes.includes(event.type));
  const kind=disputeTypes.includes(event.type)?"dispute" as const:"refund" as const;
  const object=event.data.object as Stripe.Charge|Stripe.Refund|Stripe.Dispute;
  const objectId=contextStripeId(object.id,kind==="dispute"?"du":event.type==="charge.refunded"?"ch":"re");
  check(object.object===(kind==="dispute"?"dispute":event.type==="charge.refunded"?"charge":"refund"));
  // Refund objects have no livemode; the retrieved charge/PI establish it.
  if(object.object!=="refund") check(object.livemode===(r.context.mode==="live"));
  const chargeId=object.object==="charge"?objectId:contextStripeId(object.charge,"ch");
  const paymentIntentId=object.payment_intent==null?null:contextStripeId(object.payment_intent,"pi");
  return Object.freeze({id:event.id,type:event.type,kind,objectId,chargeId,paymentIntentId,created:event.created});
}

export function readContextFinancialState(value:unknown,r:ExactContextReservation,event:ContextFinancialEvent) {
  const v=fields(value,["agreement_id","booking_payment_id","customer_id","subscription_id","session_id","receipt","lifecycle","event"]);
  check(v.agreement_id===r.id&&typeof v.booking_payment_id==="string"&&isDeepStrictEqual(v.event,event));
  assertAgreementId(v.booking_payment_id);
  const customerId=contextStripeId(v.customer_id,"cus"),subscriptionId=contextStripeId(v.subscription_id,"sub"),sessionId=contextStripeId(v.session_id,"cs");
  let receipt:ExactRefundReceipt|null=null;
  if(v.receipt!==null) {
    const p=fields(v.receipt,["paymentNumber","amountCents","applicationFeeCents","chargeId","balanceTransactionId","actualStripeFeeCents","invoiceId"]);
    check(Number.isSafeInteger(p.paymentNumber)&&Number(p.paymentNumber)>=1&&Number(p.paymentNumber)<=r.terms.paymentCount);
    const expected=calculateInstallmentPlan(r.terms.totalCents,r.terms.paymentCount,r.terms.renewalFeeSchedule,r.terms.firstPaymentFeeSchedule).payments[Number(p.paymentNumber)-1];
    check(p.amountCents===expected.amountCents&&p.applicationFeeCents===expected.fees.totalCreatorDeductionCents&&p.chargeId===event.chargeId&&
      Number.isSafeInteger(p.actualStripeFeeCents)&&Number(p.actualStripeFeeCents)>=0&&Number(p.actualStripeFeeCents)<=99999999);
    contextStripeId(p.chargeId,"ch"); contextStripeId(p.balanceTransactionId,"txn");
    if(p.paymentNumber===1) check(p.invoiceId===null); else contextStripeId(p.invoiceId,"in");
    receipt=Object.freeze(p) as ExactRefundReceipt;
  }
  const lifecycle=event.kind==="dispute"?parseExactLifecycleRead(v.lifecycle,r.id):null;
  check(event.kind!=="refund"||v.lifecycle===null);
  return Object.freeze({customerId,subscriptionId,sessionId,receipt,lifecycle});
}
