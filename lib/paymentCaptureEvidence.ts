import "server-only";
import type Stripe from "stripe";

const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Payment capture requires review");};
const id=(value:string|{id:string}|null|undefined)=>typeof value==="string"?value:value?.id??null;
function sid(value:string|{id:string}|null|undefined,prefix:string){
  const result=id(value);check(typeof result==="string"&&new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(result));return result;
}

/** Shared independently read charge/card/balance evidence. The caller must
 * validate the original intent and accepted source first. This does not write
 * a receipt, grant access, credit earnings or authorize a new payment. */
export function inspectPaymentCaptureEvidence(args:{
  paymentIntent:Stripe.PaymentIntent;charge:Stripe.Charge;balance:Stripe.BalanceTransaction;paymentMethod:Stripe.PaymentMethod;
  customerId:string|null;live:boolean;amountCents:number;applicationFeeCents:number;
  createdAt:number;expiresAt:number;nowSeconds:number;financialInspection?:"refund"|"dispute"|"refund_and_dispute";
}){
  const {paymentIntent:pi,charge,balance,paymentMethod:pm}=args;
  check(charge.object==="charge"&&charge.id===sid(pi.latest_charge,"ch")&&charge.livemode===args.live&&
    sid(charge.payment_intent,"pi")===pi.id&&id(charge.customer)===args.customerId&&
    charge.paid===true&&charge.captured===true&&charge.status==="succeeded"&&charge.currency==="usd"&&
    charge.amount===args.amountCents&&charge.amount_captured===args.amountCents&&
    charge.application_fee_amount===args.applicationFeeCents&&charge.payment_method_details?.type==="card"&&
    sid(charge.payment_method,"pm")===sid(pi.payment_method,"pm")&&
    (args.financialInspection==="refund"||args.financialInspection==="refund_and_dispute"?Number.isSafeInteger(charge.amount_refunded)&&charge.amount_refunded>=0&&
      charge.amount_refunded<=args.amountCents&&charge.refunded===(charge.amount_refunded===args.amountCents):
      charge.amount_refunded===0&&charge.refunded===false)&&
    (args.financialInspection==="dispute"||args.financialInspection==="refund_and_dispute"?typeof charge.disputed==="boolean":charge.disputed===false)&&
    Number.isSafeInteger(charge.created)&&charge.created>=args.createdAt&&charge.created<=args.nowSeconds&&charge.created<=args.expiresAt);
  check(pm.object==="payment_method"&&pm.id===sid(pi.payment_method,"pm")&&pm.livemode===args.live&&
    pm.type==="card"&&pm.card&&id(pm.customer)===args.customerId&&
    charge.billing_details?.address?.country==="US"&&pm.billing_details?.address?.country==="US");
  check(balance.object==="balance_transaction"&&balance.id===sid(charge.balance_transaction,"txn")&&
    sid(balance.source,"ch")===charge.id&&balance.type==="charge"&&balance.currency==="usd"&&
    balance.amount===args.amountCents&&Number.isSafeInteger(balance.fee)&&balance.fee>=0&&balance.fee<=99999999&&
    balance.net===balance.amount-balance.fee);
  return {chargeId:charge.id,balanceTransactionId:balance.id,transferId:sid(charge.transfer,"tr"),
    paymentMethodId:pm.id,actualStripeFeeCents:balance.fee,paidAt:charge.created,buyerCountry:"US" as const};
}
