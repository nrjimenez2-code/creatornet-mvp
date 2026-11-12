import "server-only";
import type Stripe from "stripe";
import {isDeepStrictEqual} from "node:util";
import {observeTeamFinancialState} from "./financialObservation";
import {readTeamCapture,type TeamReceiptComposition} from "./receipts";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {teamRpc} from "./server";
import type {RefundReasonCode,RefundResponsibility} from "@/lib/refundAllocation";
import {inspectTeamFinancialBalance,reconcileTeamFinancialBalances,type TeamBalanceOwners,type TeamFinancialBalance} from "./balancePolicy";

export type TeamEventSource={saleId:string;buyerId:string;obligationId:string;paymentIntentId:string;context:TeamReceiptComposition["context"]};
type Refund=Parameters<typeof observeTeamFinancialState>[0]["refunds"][number];
type Dispute=Parameters<typeof observeTeamFinancialState>[0]["disputes"][number];
type Review={id:string;refund_id:string;charge_id:string;amount_cents:number;responsibility:RefundResponsibility;reason_code:RefundReasonCode};
const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Team financial readback requires reconciliation");};
const id=(v:unknown)=>typeof v==="string"?v:(v as {id?:string}|null)?.id??"";
const requestId=(v:unknown)=>(v as {lastResponse?:{requestId?:string}}|null)?.lastResponse?.requestId??"";
const options={apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000};
const cents=(v:number)=>Number.isSafeInteger(v)&&v>=0;
/** Signed events only wake this independent, bounded GET-only inspection. All
 * ownership, amounts and decisions come from the original saved source and
 * current service reads. An incomplete list records a hold, never a release. */
export async function readTeamFinancialSnapshot(c:TeamReceiptComposition,source:TeamEventSource,observation:{eventId:string|null;balances:boolean}){
 const started=Date.now(),requestIds:string[]=[];
 const bounded=()=>check(Date.now()>=started&&Date.now()-started<45000);
 const originalStripe=c.stripe;
 c={...c,stripe:{rawRequest:async(...args:Parameters<Stripe["rawRequest"]>)=>{
  bounded();check(args[0]==="GET");
  const result=await originalStripe.rawRequest(args[0],args[1],args[2],{...args[3],timeout:Math.min(10000,45000-(Date.now()-started)),maxNetworkRetries:0});
  bounded();return result;
 }}};
 const get=async<T>(path:string,params:Record<string,unknown>={})=>{bounded();const v=await c.stripe.rawRequest("GET",path,params,options) as T;check(/^req_[A-Za-z0-9]+$/.test(requestId(v)));requestIds.push(requestId(v));bounded();return v;};
 const capture=await readTeamCapture(c,source.saleId,source.buyerId,source.obligationId);check(capture&&capture.proof.paymentIntentId===source.paymentIntentId&&isDeepStrictEqual(source.context,c.context));
 const chargeId=capture.proof.chargeId,amount=capture.proof.subtotalCents;
 async function list<T extends {id:string}>(path:string,prefix:string){
  const values:T[]=[],seen=new Set<string>();let after:string|undefined;
  for(let page=0;page<3;page++){
   const result=await get<Stripe.ApiList<T>>(path,{charge:chargeId,limit:100,...(after?{starting_after:after}:{})});
   check(result.object==="list"&&Array.isArray(result.data)&&result.data.length<=100&&typeof result.has_more==="boolean");
   for(const v of result.data){check(new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(v.id)&&!seen.has(v.id));seen.add(v.id);values.push(v);}
   if(!result.has_more)return {values,complete:true};check(result.data.length>0);after=result.data.at(-1)!.id;
  }
  return {values,complete:false};
 }
 const [refundList,disputeList,reviews]=await Promise.all([list<Stripe.Refund>("/v1/refunds","re"),list<Stripe.Dispute>("/v1/disputes","du"),
  teamRpc<Review[]>(c.admin,"read_sales_team_refund_reviews_v1",{p_sale_id:source.saleId,p_buyer_id:source.buyerId,p_obligation_id:source.obligationId})]);
 const now=Math.floor(Date.now()/1000),refunds:Refund[]=refundList.values.map(r=>{
  check(r.object==="refund"&&id(r.charge)===chargeId&&id(r.payment_intent)===source.paymentIntentId&&r.currency==="usd"&&cents(r.amount)&&r.amount>0&&r.amount<=amount&&
   Number.isSafeInteger(r.created)&&r.created>=capture.proof.paidAt-5&&r.created<=now+5&&r.transfer_reversal===null&&r.source_transfer_reversal===null&&
   ["succeeded","pending","requires_action","failed","canceled"].includes(r.status??""));
  return {id:r.id,chargeId,amountCents:r.amount,status:r.status as Refund["status"],created:r.created};
 });
 const disputes:Dispute[]=disputeList.values.map(d=>{
  check(d.object==="dispute"&&d.livemode===(c.context.mode==="live")&&id(d.charge)===chargeId&&id(d.payment_intent)===source.paymentIntentId&&d.currency==="usd"&&
   cents(d.amount)&&d.amount>0&&d.amount<=amount&&Number.isSafeInteger(d.created)&&d.created>=capture.proof.paidAt-5&&d.created<=now+5&&Array.isArray(d.balance_transactions)&&d.balance_transactions.length<=2);
  return {id:d.id,chargeId,amountCents:d.amount,status:d.status};
 });
 const decisions=reviews.map(r=>{check(refunds.some(f=>f.id===r.refund_id&&f.amountCents===Number(r.amount_cents))&&r.charge_id===chargeId);return {refundId:r.refund_id,chargeId,responsibility:r.responsibility,reasonCode:r.reason_code};});
 const stateArgs={chargeId,subtotalCents:amount,chargeRefundedCents:capture.proof.refundedCents,actualProcessingCostCents:capture.proof.processingCostCents,
  refunds,refundListComplete:refundList.complete,decisions,disputes};
 let state=observeTeamFinancialState(stateArgs);
 let balanceEvidence:ReturnType<typeof reconcileTeamFinancialBalances>&{owners:TeamBalanceOwners;entries:TeamFinancialBalance[];refundListComplete:boolean;disputeListComplete:boolean}|undefined;
 if(observation.balances){
  const owners:TeamBalanceOwners={refunds:refundList.values.map(r=>({id:r.id,status:r.status!,amountCents:r.amount,balanceId:id(r.balance_transaction)||null,failureBalanceId:id(r.failure_balance_transaction)||null})),
   disputes:disputeList.values.map(d=>({id:d.id,status:d.status,amountCents:d.amount,balanceIds:d.balance_transactions.map(id)}))};
  const refs=[...owners.refunds.flatMap(r=>[{id:r.balanceId,ownerId:r.id,kind:"refund" as const},{id:r.failureBalanceId,ownerId:r.id,kind:"refund_failure" as const}]),
   ...owners.disputes.flatMap(d=>d.balanceIds.map(key=>({id:key,ownerId:d.id,kind:null})))].filter(r=>r.id!==null);
  check(new Set(refs.map(r=>r.id)).size===refs.length&&refs.every(r=>/^txn_[A-Za-z0-9]+$/.test(r.id!)));
  const entries:TeamFinancialBalance[]=[];let cursor=0;
  // Each worker consumes one original reference at a time. All admitted reads
  // finish before a failure is propagated; no abandoned provider GET survives.
  const outcomes=await Promise.allSettled(Array.from({length:Math.min(4,refs.length,32)},async()=>{
   while(cursor<Math.min(refs.length,32)){const ref=refs[cursor++];const value=await get<Stripe.BalanceTransaction>(`/v1/balance_transactions/${ref.id}`);
    const kind=ref.kind??(value.reporting_category==="dispute_reversal"?"dispute_reversal":"dispute");
    entries.push(inspectTeamFinancialBalance(value,{expectedId:ref.id!,ownerId:ref.ownerId,chargeId,kind,paidAt:capture.proof.paidAt,now:Math.floor(Date.now()/1000)}));}
  }));
  const failed=outcomes.find(v=>v.status==="rejected");if(failed?.status==="rejected")throw failed.reason;
  entries.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const balance=reconcileTeamFinancialBalances({subtotalCents:amount,originalCostCents:capture.proof.processingCostCents,owners,entries,
   refundListComplete:refundList.complete,disputeListComplete:disputeList.complete,decisions,basePlatformCreditCents:state.platformProcessingCostCreditCents});
  if(balance.complete&&disputes.every(d=>["won","lost","prevented","warning_closed"].includes(d.status))&&entries.length){
   state=observeTeamFinancialState({...stateArgs,verifiedCombinedLoss:{subtotalCents:balance.principalLossCents,providerEvidenceIds:entries.map(e=>e.id)}});
  }
  state.platformProcessingCostCreditCents=balance.originalProcessingCreditCents;
  state.alerts.push(...balance.alerts);balanceEvidence={...balance,owners,entries,refundListComplete:refundList.complete,disputeListComplete:disputeList.complete};
 }
 if(!disputeList.complete)state.alerts.push("DISPUTE_LIST_INCOMPLETE");
 if(capture.proof.disputed&&!disputes.length)state.alerts.push("DISPUTE_IDENTITY_UNRECONCILED");
 // Dispute/refund balance adjustments and associated fees must be reconciled
 // separately from the original charge's processing fee before funds release.
 if(disputes.length&&!balanceEvidence)state.alerts.push("DISPUTE_BALANCE_COST_RECONCILIATION_REQUIRED");
 // Re-read complete bounded lists, including their membership. Another refund
 // or dispute must not hide behind an unchanged disputed=true charge flag.
 const [againRefunds,againDisputes]=await Promise.all([list<Stripe.Refund>("/v1/refunds","re"),list<Stripe.Dispute>("/v1/disputes","du")]);
 const refundFields=(r:Stripe.Refund)=>({id:r.id,object:r.object,charge:id(r.charge),pi:id(r.payment_intent),amount:r.amount,currency:r.currency,status:r.status,created:r.created,
  balance:id(r.balance_transaction),failureBalance:id(r.failure_balance_transaction),transfer:id(r.transfer_reversal),sourceTransfer:id(r.source_transfer_reversal)});
 const disputeFields=(d:Stripe.Dispute)=>({id:d.id,object:d.object,charge:id(d.charge),pi:id(d.payment_intent),amount:d.amount,currency:d.currency,status:d.status,created:d.created,livemode:d.livemode,balance:d.balance_transactions});
 check(refundList.complete===againRefunds.complete&&disputeList.complete===againDisputes.complete&&isDeepStrictEqual(refundList.values.map(refundFields),againRefunds.values.map(refundFields))&&
  isDeepStrictEqual(disputeList.values.map(disputeFields),againDisputes.values.map(disputeFields)));
 if(balanceEvidence){
  let cursor=0;
  const outcomes=await Promise.allSettled(Array.from({length:Math.min(4,balanceEvidence.entries.length)},async()=>{
   while(cursor<balanceEvidence!.entries.length){const previous=balanceEvidence!.entries[cursor++];
    const current=inspectTeamFinancialBalance(await get<Stripe.BalanceTransaction>(`/v1/balance_transactions/${previous.id}`),{expectedId:previous.id,ownerId:previous.ownerId,chargeId,kind:previous.kind,paidAt:capture.proof.paidAt,now:Math.floor(Date.now()/1000)});
    const economic=(v:TeamFinancialBalance)=>{const {providerRequestId,status,availableOn,...fields}=v;void providerRequestId;void status;void availableOn;return fields;};
    check(isDeepStrictEqual(economic(previous),economic(current)));
   }
  }));
  const failed=outcomes.find(v=>v.status==="rejected");if(failed?.status==="rejected")throw failed.reason;
 }
 const refreshed=await readTeamCapture(c,source.saleId,source.buyerId,source.obligationId);check(refreshed);
 const stable=(v:typeof capture.proof)=>{const {providerRequestId,...fields}=v;void providerRequestId;return fields;};
 check(isDeepStrictEqual(stable(capture.proof),stable(refreshed.proof))&&isDeepStrictEqual(capture.source.contract,refreshed.source.contract)&&
  isDeepStrictEqual(capture.source.confirmation,refreshed.source.confirmation)&&isDeepStrictEqual(capture.source.receipt,refreshed.source.receipt));
 const currentReviews=await teamRpc<Review[]>(c.admin,"read_sales_team_refund_reviews_v1",{p_sale_id:source.saleId,p_buyer_id:source.buyerId,p_obligation_id:source.obligationId});check(isDeepStrictEqual(reviews,currentReviews));
 check(isDeepStrictEqual(await c.observeContext(),c.context));bounded();state.reviewHold=state.alerts.length>0;
 const proof={context:c.context,chargeId,paymentIntentId:source.paymentIntentId,...state,refundIds:refunds.map(r=>r.id),decisionIds:reviews.map(r=>r.id),
  providerEvidenceIds:[...(capture.proof.balanceTransactionId?[capture.proof.balanceTransactionId]:[]),...(balanceEvidence?.entries.map(e=>e.id)??[])],sourceEventId:observation.eventId,providerRequestIds:requestIds};
 return {revision:capture.source.receipt?.observation_revision??null,snapshot:{capture:{receipt:refreshed.proof,readback:refreshed.readback},proof,refunds,disputes,readStartedAt:started,...(balanceEvidence?{balanceEvidence}:{})}};
}
export async function observeTeamPaymentEvent(c:TeamReceiptComposition,source:TeamEventSource,eventId:string,balances=false){
 const inspected=await readTeamFinancialSnapshot(c,source,{eventId,balances});
 return teamRpc<{receiptId:string;held:boolean}>(c.admin,"complete_sales_team_payment_event_v1",{p_event_id:eventId,p_expected_revision:inspected.revision,p_snapshot:inspected.snapshot});
}
