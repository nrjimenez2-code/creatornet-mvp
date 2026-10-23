import "server-only";
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {teamId} from "./policy";
import {teamRpc} from "./server";
import {readTeamFinancialSnapshot,type TeamEventSource} from "./financialReadback";
import type {TeamReceiptComposition} from "./receipts";
import type Stripe from "stripe";
import {reasonMatchesResponsibility,type RefundReasonCode,type RefundResponsibility} from "@/lib/refundAllocation";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";

/** Internal inspections have their own durable UUIDs. Repeating an HTTP request
 * reuses the actor's pending inspection; it never fabricates a Stripe event. */
export async function inspectTeamReceiptFinancials(c:TeamReceiptComposition,receiptId:string,actorId:string,checkId:string=randomUUID()){
 teamId(receiptId);teamId(actorId);teamId(checkId);
 if(!isDeepStrictEqual(await c.observeContext(),c.context))throw Error("Financial context changed");
 const begun=await teamRpc<{checkId:string;completed:boolean;held:boolean;source:TeamEventSource}>(c.admin,"begin_sales_team_financial_check_v1",{
  p_check_id:checkId,p_receipt_id:receiptId,p_actor_id:actorId,p_event_id:null,p_worker_run_id:null,p_context:c.context});
 if(begun.completed)return {checkId:begun.checkId,receiptId,held:begun.held,completed:true};
 const inspected=await readTeamFinancialSnapshot(c,begun.source,{eventId:null,balances:true});
 const result=await teamRpc<{receiptId:string;held:boolean}>(c.admin,"complete_sales_team_financial_check_v1",{
  p_check_id:begun.checkId,p_expected_revision:inspected.revision,p_snapshot:inspected.snapshot});
 return {...result,checkId:begun.checkId,completed:true};
}

/** Responsibility review records an existing successful refund. This does not
 * create a refund or release its financial hold. A fresh inspection follows. */
export async function reviewTeamRefundResponsibility(c:TeamReceiptComposition,args:{actorId:string;receiptId:string;requestId:string;expectedRevision:number;refundId:string;responsibility:RefundResponsibility;reasonCode:RefundReasonCode}){
 for(const v of [args.actorId,args.receiptId,args.requestId])teamId(v);
 if(!/^re_[A-Za-z0-9]+$/.test(args.refundId)||!Number.isSafeInteger(args.expectedRevision)||args.expectedRevision<0||!reasonMatchesResponsibility(args.reasonCode,args.responsibility))throw Error("Invalid refund responsibility review");
 const source=await teamRpc<{revision:number;source:TeamEventSource}>(c.admin,"read_sales_team_financial_admin_source_v1",{p_actor_id:args.actorId,p_receipt_id:args.receiptId,p_context:c.context});
 if(!isDeepStrictEqual(await c.observeContext(),source.source.context))throw Error("Financial context changed");
 const started=Date.now();
 const get=()=>c.stripe.rawRequest("GET",`/v1/refunds/${args.refundId}`,{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000}) as unknown as Promise<Stripe.Response<Stripe.Refund>>;
 const original=await get(),current=await get();
 const identity=(r:Stripe.Refund)=>({id:r.id,object:r.object,charge:typeof r.charge==="string"?r.charge:r.charge?.id,pi:typeof r.payment_intent==="string"?r.payment_intent:r.payment_intent?.id,amount:r.amount,currency:r.currency,status:r.status,created:r.created,transfer:r.transfer_reversal,sourceTransfer:r.source_transfer_reversal});
 if(!isDeepStrictEqual(identity(original),identity(current))||current.id!==args.refundId||current.object!=="refund"||current.status!=="succeeded"||current.currency!=="usd"||current.payment_intent!==source.source.paymentIntentId||typeof current.charge!=="string"||current.transfer_reversal!==null||current.source_transfer_reversal!==null||!Number.isSafeInteger(current.amount)||current.amount<=0||!/^req_[A-Za-z0-9]+$/.test(current.lastResponse?.requestId??"")||Date.now()<started||Date.now()-started>25000||!isDeepStrictEqual(await c.observeContext(),c.context))throw Error("Original refund review evidence changed");
 return teamRpc<{reviewId:string;holdRetained:true}>(c.admin,"review_sales_team_refund_v1",{p_actor_id:args.actorId,p_request_id:args.requestId,p_receipt_id:args.receiptId,p_expected_revision:args.expectedRevision,
  p_responsibility:args.responsibility,p_reason_code:args.reasonCode,p_proof:{context:c.context,chargeId:current.charge,paymentIntentId:current.payment_intent,refundId:current.id,status:current.status,amountCents:current.amount,providerRequestId:current.lastResponse.requestId,readStartedAt:started}});
}
