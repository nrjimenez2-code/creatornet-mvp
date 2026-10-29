import "server-only";
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import type {TeamReceiptComposition} from "./receipts";
import type {TeamTransferRequest} from "./transferReservations";
import {readTeamBoundTransfer} from "./transferReadback";

type Reader=Pick<TeamReceiptComposition,"context"|"observeContext"|"stripe">;
type TransferProof=Awaited<ReturnType<typeof readTeamBoundTransfer>>;
/** Loaded by a service owner from the original request and its immutable F27
 * completion. This type is not authority supplied by a client or webhook. */
export type TeamBeneficiaryPayoutSource={request:TeamTransferRequest;completion:{
 request_id:string;transfer_id:string;balance_id:string;proof:TransferProof;
}};
const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Beneficiary payout evidence requires review");};
const id=(value:unknown)=>typeof value==="string"?value:(value as {id?:string}|null)?.id??"";
const requestId=(value:unknown)=>(value as {lastResponse?:{requestId?:string}}|null)?.lastResponse?.requestId??"";
const cents=(value:number)=>Number.isSafeInteger(value)&&Math.abs(value)<=99999999;
const timestamp=(value:number,now:number)=>Number.isSafeInteger(value)&&value>0&&value<=now+5;

function payout(value:Stripe.Payout,payoutId:string,q:TeamTransferRequest,now:number){
 check(value.object==="payout"&&value.id===payoutId&&value.livemode===(q.context.mode==="live")&&
  value.currency==="usd"&&cents(value.amount)&&value.amount>0&&value.automatic===true&&value.method==="standard"&&
  value.type==="bank_account"&&/^ba_[A-Za-z0-9]+$/.test(id(value.destination))&&
  value.reconciliation_status==="completed"&&['pending','in_transit','paid','failed','canceled'].includes(value.status)&&
  timestamp(value.created,now)&&Number.isSafeInteger(value.arrival_date)&&value.arrival_date>0&&
  /^txn_[A-Za-z0-9]+$/.test(id(value.balance_transaction))&&!value.original_payout&&!value.reversed_by);
 const returned=id(value.failure_balance_transaction);
 check(!returned||/^txn_[A-Za-z0-9]+$/.test(returned));
 check(['failed','canceled'].includes(value.status)||!returned&&!value.failure_code);
 // Trace/descriptor text is deliberately omitted: neither is bank receipt.
 return {id:value.id,amountCents:value.amount,currency:value.currency,destinationId:id(value.destination),
  automatic:true as const,method:"standard" as const,status:value.status,created:value.created,arrivalDate:value.arrival_date,
  debitBalanceId:id(value.balance_transaction),returnBalanceId:returned||null,failureCode:value.failure_code??null};
}
function balance(value:Stripe.BalanceTransaction,now:number){
 check(value.object==="balance_transaction"&&/^txn_[A-Za-z0-9]+$/.test(value.id)&&cents(value.amount)&&cents(value.fee)&&value.fee>=0&&
  cents(value.net)&&value.net===value.amount-value.fee&&value.currency==="usd"&&value.exchange_rate===null&&value.balance_type==="payments"&&
  timestamp(value.created,now)&&Number.isSafeInteger(value.available_on)&&value.available_on>0&&
  ['pending','available'].includes(value.status)&&/^[a-z_]{1,64}$/.test(value.type)&&/^[a-z_]{1,64}$/.test(value.reporting_category)&&
  Array.isArray(value.fee_details)&&value.fee_details.length<=32);
 let fees=0;for(const fee of value.fee_details){check(cents(fee.amount)&&fee.amount>=0&&fee.currency==="usd");fees+=fee.amount;}check(fees===value.fee);
 return {id:value.id,sourceId:id(value.source),amountCents:value.amount,feeCents:value.fee,netCents:value.net,currency:value.currency,
  balanceType:value.balance_type,type:value.type,reportingCategory:value.reporting_category,created:value.created,availableOn:value.available_on,status:value.status};
}
function original(source:TeamBeneficiaryPayoutSource,fresh:TransferProof){
 const {request:q,completion:c}=source,p=c.proof;
 check(q.completed===true&&!q.canceled&&c.request_id===q.id&&c.transfer_id===fresh.transfer.id&&c.balance_id===fresh.balance.id&&
  p.requestId===q.id&&p.operationId===q.operation_id&&p.receiptId===q.receipt_id&&p.saleId===q.sale_id&&p.creatorId===q.creator_id&&p.beneficiary===q.beneficiary&&
  isDeepStrictEqual(p.context,q.context)&&p.originalRequestId===fresh.originalRequestId&&p.idempotencyKey===fresh.idempotencyKey&&
  isDeepStrictEqual(p.transfer,snapshotProviderJson(fresh.transfer))&&isDeepStrictEqual(p.balance,snapshotProviderJson(fresh.balance)));
}

/** Read-only candidate evidence, not an installed bank-confirmation owner. The
 * caller must resolve this immutable original server-side, admit a fresh check,
 * and atomically accept it under the exact context before exposing any status.
 * A webhook payout ID is a locator only. Manual/instant payouts cannot establish
 * automatic-payout membership through Stripe's payout filter. No financial POST,
 * bank-account mutation, accounting release or bank receipt is performed here. */
export async function readTeamBeneficiaryPayout(c:Reader,input:TeamBeneficiaryPayoutSource,payoutId:string){
 const source=snapshotProviderJson(input),q=source.request,context=snapshotProviderJson(c.context),started=Date.now();
 check(/^po_[A-Za-z0-9]+$/.test(payoutId)&&q.completed===true&&!q.canceled&&source.completion?.request_id===q.id&&isDeepStrictEqual(context,q.context));
 const bounded=()=>check(Date.now()>=started&&Date.now()-started<65000);
 const current=async()=>{bounded();check(Date.now()-started<35000);check(isDeepStrictEqual(snapshotProviderJson(await c.observeContext()),context));bounded();};
 // Never let replacing the mutable composition redirect an admitted read.
 const reader={context,observeContext:c.observeContext.bind(c),stripe:c.stripe};
 const fresh=await readTeamBoundTransfer(reader,q);bounded();original(source,fresh);
 const retainedRequests=[...source.completion.proof.transferReadRequestIds,...source.completion.proof.balanceReadRequestIds];
 check([...fresh.transferReadRequestIds,...fresh.balanceReadRequestIds].every(req=>!retainedRequests.includes(req)));
 const seen=new Set([...retainedRequests,...fresh.transferReadRequestIds,...fresh.balanceReadRequestIds,fresh.originalRequestId]);
 const requests:string[]=[];
 const get=async<T>(path:string,params:Record<string,unknown>={}):Promise<T>=>{
  bounded();const value=await reader.stripe.rawRequest("GET",path,params,{apiVersion:TEAM_STRIPE_API_VERSION,
   stripeAccount:q.destination_id,maxNetworkRetries:0,timeout:Math.max(1,Math.min(10000,65000-(Date.now()-started)))});
  bounded();const req=requestId(value);check(/^req_[A-Za-z0-9]+$/.test(req)&&!seen.has(req));seen.add(req);requests.push(req);return value as T;
 };
 await current();
 const first=payout(await get<Stripe.Payout>(`/v1/payouts/${payoutId}`),payoutId,q,Math.floor(Date.now()/1000));
 check(first.created>=fresh.transfer.created-5);
 const readMembers=async()=>{
  const values:ReturnType<typeof balance>[]=[],ids=new Set<string>();let after:string|undefined,complete=false;
  for(let page=0;page<3;page++){
   const list=await get<Stripe.ApiList<Stripe.BalanceTransaction>>("/v1/balance_transactions",{payout:payoutId,limit:100,...(after?{starting_after:after}:{})});
   check(list.object==="list"&&list.url==="/v1/balance_transactions"&&Array.isArray(list.data)&&list.data.length<=100&&typeof list.has_more==="boolean");
   for(const item of list.data){const v=balance(item,Math.floor(Date.now()/1000));check(!ids.has(v.id)&&v.id!==first.debitBalanceId&&v.id!==first.returnBalanceId&&
     v.status==="available"&&v.availableOn<=Math.floor(Date.now()/1000));ids.add(v.id);values.push(v);}
   if(!list.has_more){complete=true;break;}check(list.data.length>0);after=list.data.at(-1)!.id;
  }
  check(complete);values.sort((a,b)=>a.id.localeCompare(b.id));
  const matches=values.filter(v=>v.sourceId===fresh.transfer.destinationPaymentId);
  check(matches.length===1);const credit=matches[0];
  check(credit.amountCents===fresh.transfer.amountCents&&credit.netCents>0&&credit.created>=fresh.transfer.created-5&&
   values.reduce((sum,v)=>sum+v.netCents,0)===first.amountCents);
  return {values,credit};
 };
 const members=await readMembers();
 const independent=balance(await get<Stripe.BalanceTransaction>(`/v1/balance_transactions/${members.credit.id}`),Math.floor(Date.now()/1000));
 check(isDeepStrictEqual(independent,members.credit));
 const debit=balance(await get<Stripe.BalanceTransaction>(`/v1/balance_transactions/${first.debitBalanceId}`),Math.floor(Date.now()/1000));
 check(debit.id===first.debitBalanceId&&debit.sourceId===payoutId&&debit.type==="payout"&&debit.reportingCategory==="payout"&&debit.amountCents===-first.amountCents);
 let returned:ReturnType<typeof balance>|null=null;
 if(first.returnBalanceId){returned=balance(await get<Stripe.BalanceTransaction>(`/v1/balance_transactions/${first.returnBalanceId}`),Math.floor(Date.now()/1000));
  check(returned.id===first.returnBalanceId&&returned.sourceId===payoutId&&['payout_failure','payout_cancel'].includes(returned.type)&&returned.amountCents===first.amountCents);}
 const repeated=await readMembers();check(isDeepStrictEqual(members,repeated));
 const second=payout(await get<Stripe.Payout>(`/v1/payouts/${payoutId}`),payoutId,q,Math.floor(Date.now()/1000));check(isDeepStrictEqual(first,second));
 await current();bounded();
 return {version:"creatornet-beneficiary-payout-observation-v1" as const,context,requestId:q.id,operationId:q.operation_id,
  receiptId:q.receipt_id,saleId:q.sale_id,creatorId:q.creator_id,beneficiary:q.beneficiary,beneficiaryUserId:q.beneficiary_user_id,
  connectedAccountId:q.destination_id,transferId:fresh.transfer.id,destinationPaymentId:fresh.transfer.destinationPaymentId,
  transferAmountCents:fresh.transfer.amountCents,payout:second,credit:members.credit,debit,returned,
  memberCount:members.values.length,membersSha256:createHash("sha256").update(JSON.stringify(members.values)).digest("hex"),
  transferReadRequestIds:fresh.transferReadRequestIds,transferBalanceReadRequestIds:fresh.balanceReadRequestIds,
  connectedReadRequestIds:requests,readStartedAt:started,observedAt:Math.floor(Date.now()/1000),bankConfirmed:false as const};
}
