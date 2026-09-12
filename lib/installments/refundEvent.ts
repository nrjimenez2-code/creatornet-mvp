import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { confirmAdminRefundWebhookDelivery, type PaymentRefundState } from "../paymentRefunds";
import { calculateInstallmentPlan } from "../installmentPlan";
import { assertAgreementId, type ExactAgreementStore } from "./agreementStore";
import { assertExactInstallmentEnvironment } from "./checkoutPreparation";

export type ExactRefundReceipt = Readonly<{ paymentNumber:number; amountCents:number; applicationFeeCents:number;
  chargeId:string; balanceTransactionId:string; actualStripeFeeCents:number; invoiceId:string|null }>;
export interface ExactRefundEventStore {
  creditedReceipt(agreementId:string,paymentIntentId:string):Promise<ExactRefundReceipt|null>;
  hold(agreementId:string,eventId:string,state:PaymentRefundState):Promise<void>;
  apply(agreementId:string,eventId:string,state:PaymentRefundState):Promise<number>;
  confirmAdminDelivery(state:PaymentRefundState,stripe:Stripe):Promise<void>;
}
function requireThat(v:unknown,reason:string):asserts v {
  if(!v) throw new Error(`Exact refund stopped: ${reason}`);
}
const id=(v:string|{id:string}|null|undefined)=>typeof v==="string"?v:v?.id;
const cents=(v:unknown)=>typeof v==="string"&&/^\d+$/.test(v)?Number(v):v;
async function stripeRead<T>(read:()=>Promise<T>):Promise<T> {
  try { return await read(); }
  catch { throw new Error("Exact refund Stripe evidence unavailable"); }
}

export function createExactRefundEventStore(admin:SupabaseClient):ExactRefundEventStore {
  return {
    async creditedReceipt(agreementId,paymentIntentId) {
      assertAgreementId(agreementId);
      requireThat(/^pi_[a-zA-Z0-9]+$/.test(paymentIntentId),"invalid payment identity");
      const {data:r,error}=await admin.from("exact_installment_receipts")
        .select("payment_number,amount_cents,application_fee_cents,stripe_invoice_id,ledger_id,counted_at")
        .eq("agreement_id",agreementId).eq("stripe_payment_intent_id",paymentIntentId).maybeSingle();
      if(error) throw new Error("Exact refund receipt lookup failed");
      if(!r || !r.counted_at || !r.ledger_id) return null;
      const {data:l,error:ledgerError}=await admin.from("payment_fee_ledger")
        .select("stripe_payment_intent_id,stripe_charge_id,stripe_balance_transaction_id,actual_stripe_fee_cents,earnings_credited_at")
        .eq("id",r.ledger_id).maybeSingle();
      if(ledgerError || !l || !l.earnings_credited_at) throw new Error("Exact refund ledger unavailable");
      const gross=cents(r.amount_cents),fee=cents(r.application_fee_cents),actual=cents(l.actual_stripe_fee_cents);
      requireThat(Number.isInteger(r.payment_number)&&r.payment_number>=1&&r.payment_number<=24 &&
        Number.isSafeInteger(gross)&&Number(gross)>0 && Number.isSafeInteger(fee)&&Number(fee)>=0&&Number(fee)<=Number(gross) &&
        Number.isSafeInteger(actual)&&Number(actual)>=0&&Number(actual)<=99999999 &&
        l.stripe_payment_intent_id===paymentIntentId && /^ch_[a-zA-Z0-9]+$/.test(l.stripe_charge_id) &&
        /^txn_[a-zA-Z0-9]+$/.test(l.stripe_balance_transaction_id) &&
        (r.payment_number===1?r.stripe_invoice_id===null:/^in_[a-zA-Z0-9]+$/.test(r.stripe_invoice_id)),"invalid credited receipt");
      return {paymentNumber:r.payment_number,amountCents:Number(gross),applicationFeeCents:Number(fee),
        chargeId:l.stripe_charge_id,balanceTransactionId:l.stripe_balance_transaction_id,
        actualStripeFeeCents:Number(actual),invoiceId:r.stripe_invoice_id};
    },
    async apply(agreementId,eventId,state) {
      const {data,error}=await admin.rpc("apply_exact_installment_refund_event",{p_agreement_id:agreementId,
        p_event_id:eventId,p_payment_intent_id:state.paymentIntentId,p_charge_id:state.chargeId,
        p_gross_cents:state.chargeAmountCents,p_refunded_cents:state.refundedAmountCents});
      if(error) throw new Error("Exact refund accounting failed");
      const result=cents(data);
      requireThat(Number.isSafeInteger(result)&&Number(result)>=state.refundedAmountCents&&Number(result)<=state.chargeAmountCents,
        "invalid cumulative refund response");
      return Number(result);
    },
    async hold(agreementId,eventId,state) {
      const {data,error}=await admin.rpc("hold_exact_installment_refund_event",{p_agreement_id:agreementId,
        p_event_id:eventId,p_payment_intent_id:state.paymentIntentId,p_charge_id:state.chargeId,p_gross_cents:state.chargeAmountCents});
      if(error) throw new Error("Exact refund review hold failed");
      assertAgreementId(data);
    },
    async confirmAdminDelivery(state,stripe) {
      try { await confirmAdminRefundWebhookDelivery(admin,stripe,state); }
      catch { throw new Error("Exact admin refund delivery confirmation failed"); }
    },
  };
}

/** Signature/event claim belongs to the canonical HTTP handler. This observes
 * an existing refund; Stripe calls are retrieves/listing only. Monetary writes
 * use the immutable receipt's ledger, never one-time purchase reconciliation.
 * Preparation may be paused while this separately gated accounting continues. */
export async function reconcileExactRefundEventSandbox(args:{
  agreementId:string;paymentIntentId:string;chargeId:string;eventId:string;
  store:ExactAgreementStore;refundStore:ExactRefundEventStore;stripe:Stripe;env:Record<string,string|undefined>;
}):Promise<{status:"refund_reconciled"|"reconciliation_required"}> {
  assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
  requireThat(args.env.CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY==="true" &&
    args.env.CREATOR_EXACT_INSTALLMENTS_REFUND_EVENTS_READY==="true","refund event schema not enabled");
  assertAgreementId(args.agreementId);
  requireThat(/^evt_[a-zA-Z0-9]+$/.test(args.eventId)&&/^ch_[a-zA-Z0-9]+$/.test(args.chargeId)&&
    /^pi_[a-zA-Z0-9]+$/.test(args.paymentIntentId),"invalid event identity");
  const a=await args.store.load(args.agreementId);
  assertExactInstallmentEnvironment(args.env,a.terms.previewOrigin);
  requireThat(a.id===args.agreementId&&a.customerId&&a.subscriptionId&&a.sessionId,"agreement binding missing");
  const r=await args.refundStore.creditedReceipt(a.id,args.paymentIntentId);
  if(!r) return {status:"reconciliation_required"};
  const expected=calculateInstallmentPlan(a.terms.totalCents,a.terms.paymentCount,a.terms.renewalFeeSchedule,
    a.terms.firstPaymentFeeSchedule).payments[r.paymentNumber-1];
  requireThat(expected&&expected.amountCents===r.amountCents&&expected.fees.totalCreatorDeductionCents===r.applicationFeeCents&&
    r.chargeId===args.chargeId,"receipt terms differ");
  const state=await inspectExactRefundCapture(args.stripe,{paymentIntentId:args.paymentIntentId,chargeId:args.chargeId,
    customerId:a.customerId,destinationId:a.terms.destinationId,expectedLiveMode:false,receipt:r});
  await args.refundStore.hold(a.id,args.eventId,state);
  const {confirmed,uncertain}=await inspectExactRefundTotals(args.stripe,state);
  if(uncertain || confirmed<=0 || confirmed!==state.refundedAmountCents) return {status:"reconciliation_required"};
  const cumulative=await args.refundStore.apply(a.id,args.eventId,state);
  // Existing reversals are monotonic; never restore earnings silently.
  if(cumulative!==state.refundedAmountCents) return {status:"reconciliation_required"};
  await args.refundStore.confirmAdminDelivery({...state,refundedAmountCents:cumulative},args.stripe);
  return {status:"refund_reconciled"};
}

/** Shared read-only captured-payment proof. No refund or accounting mutation. */
export async function inspectExactRefundCapture(stripe:{
  paymentIntents:{retrieve(id:string):Promise<Stripe.PaymentIntent>}; charges:{retrieve(id:string):Promise<Stripe.Charge>};
  balanceTransactions:{retrieve(id:string):Promise<Stripe.BalanceTransaction>};
},args:{paymentIntentId:string;chargeId:string;customerId:string;destinationId:string;expectedLiveMode:boolean;receipt:ExactRefundReceipt}):Promise<PaymentRefundState> {
  const r=args.receipt;
  const pi=await stripeRead(()=>stripe.paymentIntents.retrieve(args.paymentIntentId));
  requireThat(pi.id===args.paymentIntentId&&pi.livemode===args.expectedLiveMode&&pi.status==="succeeded"&&id(pi.customer)===args.customerId&&
    id(pi.latest_charge)===r.chargeId&&pi.currency==="usd"&&pi.amount===r.amountCents&&pi.amount_received===r.amountCents&&
    pi.application_fee_amount===r.applicationFeeCents&&id(pi.transfer_data?.destination)===args.destinationId&&
    pi.transfer_data?.amount==null,"captured PaymentIntent differs");
  const charge=await stripeRead(()=>stripe.charges.retrieve(args.chargeId));
  requireThat(charge.id===r.chargeId&&charge.id===args.chargeId&&charge.livemode===args.expectedLiveMode&&id(charge.payment_intent)===pi.id&&id(charge.customer)===args.customerId&&
    charge.paid===true&&charge.captured===true&&charge.status==="succeeded"&&charge.currency==="usd"&&
    charge.amount===r.amountCents&&charge.amount_captured===r.amountCents&&charge.payment_method_details?.type==="card"&&
    id(charge.balance_transaction)===r.balanceTransactionId&&Number.isSafeInteger(charge.amount_refunded)&&
    charge.amount_refunded>=0&&charge.amount_refunded<=r.amountCents&&charge.refunded===(charge.amount_refunded===r.amountCents),
    "captured refund evidence differs");
  const balance=await stripeRead(()=>stripe.balanceTransactions.retrieve(r.balanceTransactionId));
  requireThat(balance.id===r.balanceTransactionId&&id(balance.source)===r.chargeId&&balance.type==="charge"&&
    balance.currency==="usd"&&balance.amount===r.amountCents&&balance.fee===r.actualStripeFeeCents&&
    balance.net===balance.amount-balance.fee,"balance audit differs");
  return Object.freeze({paymentIntentId:pi.id,chargeId:charge.id,chargeAmountCents:r.amountCents,refundedAmountCents:charge.amount_refunded});
}

/** Shared bounded listing, including uncertain/pending outcomes. Callers must
 * persist the review hold first; only matching succeeded sums may be applied. */
export async function inspectExactRefundTotals(stripe:{refunds:{list(params:Stripe.RefundListParams):Promise<Stripe.ApiList<Stripe.Refund>>}},state:PaymentRefundState) {
  let confirmed=0,uncertain=false,cursor:string|undefined;
  const succeeded:Array<Readonly<{id:string;amount:number;operationId:string|null}>>=[];
  const seen=new Set<string>();
  for(let pageNumber=0;;pageNumber++) {
    requireThat(pageNumber<100,"refund pagination needs review");
    const page:Stripe.ApiList<Stripe.Refund>=await stripeRead(()=>stripe.refunds.list({charge:state.chargeId,limit:100,
      ...(cursor?{starting_after:cursor}:{})}));
    for(const refund of page.data) {
      requireThat(/^re_[a-zA-Z0-9]+$/.test(refund.id)&&!seen.has(refund.id)&&id(refund.charge)===state.chargeId&&
        id(refund.payment_intent)===state.paymentIntentId&&refund.currency==="usd"&&Number.isSafeInteger(refund.amount)&&
        refund.amount>0&&refund.amount<=state.chargeAmountCents,"refund object identity differs");
      seen.add(refund.id);
      if(refund.status==="succeeded") {
        confirmed+=refund.amount;
        succeeded.push(Object.freeze({id:refund.id,amount:refund.amount,operationId:refund.metadata?.creatornet_refund_operation_id??null}));
      }
      else if(refund.status!=="failed"&&refund.status!=="canceled") uncertain=true;
      requireThat(Number.isSafeInteger(confirmed)&&confirmed<=state.chargeAmountCents,"refund sum exceeds charge");
    }
    if(!page.has_more) break;
    const next=page.data.at(-1)?.id;
    requireThat(next&&next!==cursor,"refund pagination did not advance");cursor=next;
  }
  return Object.freeze({confirmed,uncertain,succeeded:Object.freeze(succeeded)});
}
