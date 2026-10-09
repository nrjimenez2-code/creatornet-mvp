import "server-only";
import type Stripe from "stripe";
import {isDeepStrictEqual} from "node:util";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import type {inspectFullServerPaymentCapture} from "./fullServerPaymentReceipt";

type CaptureProof=ReturnType<typeof inspectFullServerPaymentCapture>;
const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Original full refund observation requires review");};
const object=(value:unknown):Record<string,unknown>=>{
  check(value!==null&&typeof value==="object"&&!Array.isArray(value));return value as Record<string,unknown>;
};
function providerId(value:unknown,prefix:string):string{
  const id=typeof value==="string"?value:object(value).id;
  check(typeof id==="string"&&new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(id));return id;
}
function nullableId(value:unknown,prefix:string){return value===null||value===undefined?null:providerId(value,prefix);}
function nullableReason(value:unknown){
  if(value===null||value===undefined)return null;
  check(typeof value==="string"&&/^[a-z_]{1,100}$/.test(value));return value;
}

/** Normalize an independently retrieved Refund against an already verified
 * original capture and signed event locator. Refund objects have no livemode:
 * the platform context and original charge establish mode. Provider references
 * below are references only, not evidence of refund settlement or a reversal.
 * This function cannot account money, release a hold or authorize a retry. */
export function inspectOriginalFullRefund(args:{proof:CaptureProof;refund:unknown;refundId:string;
  eventId:string;eventCreated:number;eventLivemode:boolean;nowSeconds:number}){
  const {proof:p}=args,r=object(args.refund);
  check(p.version==="full-server-payment-capture-v1"&&["test","live"].includes(p.context.mode)&&
    args.eventLivemode===(p.context.mode==="live"));
  providerId(args.eventId,"evt");providerId(args.refundId,"re");
  check(r.object==="refund"&&r.id===args.refundId&&providerId(r.charge,"ch")===p.chargeId&&
    (r.payment_intent===null||providerId(r.payment_intent,"pi")===p.paymentIntentId)&&r.currency==="usd");
  check(Number.isSafeInteger(p.amountCents)&&p.amountCents>0&&Number.isSafeInteger(p.paidAt)&&p.paidAt>0&&
    Number.isSafeInteger(r.amount)&&(r.amount as number)>0&&(r.amount as number)<=p.amountCents&&
    Number.isSafeInteger(args.nowSeconds)&&Number.isSafeInteger(args.eventCreated)&&args.eventCreated<=args.nowSeconds&&
    Number.isSafeInteger(r.created)&&(r.created as number)>=p.paidAt&&(r.created as number)<=args.eventCreated);
  check(typeof r.status==="string"&&["pending","requires_action","succeeded","failed","canceled"].includes(r.status));
  return Object.freeze({version:"full-server-refund-observation-v1" as const,eventId:args.eventId,eventCreated:args.eventCreated,
    attemptId:p.attemptId,paymentIntentId:p.paymentIntentId,chargeId:p.chargeId,refundId:args.refundId,
    amountCents:r.amount as number,currency:"usd" as const,created:r.created as number,
    status:r.status as "pending"|"requires_action"|"succeeded"|"failed"|"canceled",
    balanceTransactionId:nullableId(r.balance_transaction,"txn"),failureBalanceTransactionId:nullableId(r.failure_balance_transaction,"txn"),
    failureReason:nullableReason(r.failure_reason),pendingReason:nullableReason(r.pending_reason)});
}

/** Retrieve the exact original twice, with independently checked platform
 * context around the reads. A changing status/reversal requires a fresh
 * reconciliation; no write or replacement refund can occur here. The caller
 * must durably hold the owned original before invoking provider readback. */
export async function readOriginalFullRefund(args:Omit<Parameters<typeof inspectOriginalFullRefund>[0],"refund">&{
  stripe:Pick<Stripe,"refunds">;observeContext:()=>Promise<void>;
}){
  providerId(args.refundId,"re");providerId(args.eventId,"evt");
  const options={apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000};
  await args.observeContext();
  const first=inspectOriginalFullRefund({...args,refund:await args.stripe.refunds.retrieve(args.refundId,options)});
  await args.observeContext();
  const second=inspectOriginalFullRefund({...args,refund:await args.stripe.refunds.retrieve(args.refundId,options)});
  check(isDeepStrictEqual(first,second));
  await args.observeContext();return second;
}

/** A charge total or successful individual Refund does not prove that every
 * refunded cent succeeded. Require two stable complete lists and count only
 * succeeded Refunds before using the cumulative accounting engine. A supplied
 * individual observation must also match its entry in the complete list. */
export async function readOriginalFullRefundTotal(args:{proof:CaptureProof;stripe:Pick<Stripe,"refunds">;
  observeContext:()=>Promise<void>;nowSeconds:number}&(
    {observation:ReturnType<typeof inspectOriginalFullRefund>;eventId?:never}|{eventId:string;observation?:never})){
  const eventId=providerId(args.observation?.eventId??args.eventId,"evt");
  const options={apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000};
  const comparable=(o:ReturnType<typeof inspectOriginalFullRefund>)=>{
    const {eventId:unusedId,eventCreated:unusedCreated,...evidence}=o;
    void unusedId;void unusedCreated;return evidence;
  };
  const read=async()=>{
    const seen=new Set<string>(),rows:ReturnType<typeof comparable>[]=[];let cursor:string|undefined;
    for(let pageNumber=0;pageNumber<100;pageNumber++){
      const page=await args.stripe.refunds.list({charge:args.proof.chargeId,limit:100,...(cursor?{starting_after:cursor}:{})},options);
      check(page.object==="list"&&Array.isArray(page.data)&&typeof page.has_more==="boolean");
      for(const refund of page.data){
        check(!seen.has(refund.id));seen.add(refund.id);
        rows.push(comparable(inspectOriginalFullRefund({proof:args.proof,refund,refundId:refund.id,eventId,
          eventCreated:args.nowSeconds,eventLivemode:args.proof.context.mode==="live",nowSeconds:args.nowSeconds})));
      }
      if(!page.has_more)return rows.sort((a,b)=>a.refundId.localeCompare(b.refundId));
      check(page.data.length>0);cursor=page.data[page.data.length-1].id;
    }
    throw Error("Original full refund list requires review");
  };
  await args.observeContext();const first=await read();await args.observeContext();const second=await read();
  check(isDeepStrictEqual(first,second));
  if(args.observation){const original=args.observation;
    check(isDeepStrictEqual(second.find(r=>r.refundId===original.refundId),comparable(original)));}
  const total=second.filter(r=>r.status==="succeeded").reduce((n,r)=>n+r.amountCents,0);
  check(Number.isSafeInteger(total)&&total>=0&&total<=args.proof.amountCents);
  await args.observeContext();return total;
}
