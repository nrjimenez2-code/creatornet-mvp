import "server-only";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {teamId} from "./policy";
import {TEAM_STRIPE_API_VERSION,teamOperationId,type TeamOperationScope,type TeamProviderRequest} from "./providerOperation";
import {validateTeamTransferRequest,type TeamTransferRequest,type TeamTransferJournal} from "./transferReservations";
import type {TeamReceiptComposition} from "./receipts";

/** Supplied immutable journal projection. This reader does not reserve, adopt,
 * bind, dispatch, reduce debt or attest a bank payout. Its future SQL consumer
 * must independently enforce current worker authority and once-only accounting. */
export type TeamTransferReversalOriginal={id:string;amountCents:number;originalWorkerRunId:string;transfer:TeamTransferRequest;operation:TeamTransferJournal};
type Reader=Pick<TeamReceiptComposition,"context"|"observeContext"|"stripe">;
const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Original transfer reversal requires reconciliation");};
const objectId=(value:unknown)=>typeof value==="string"?value:(value as {id?:string}|null)?.id??"";
const requestId=(value:unknown)=>(value as {lastResponse?:{requestId?:string}}|null)?.lastResponse?.requestId??"";
const cents=(value:number)=>Number.isSafeInteger(value)&&value>=0&&value<=99999999;

function completedTransfer(context:Reader["context"],t:TeamTransferRequest){
 const op=t.operation;validateTeamTransferRequest({context},t);
 check(t.completed&&!t.canceled&&op?.status==="bound"&&/^tr_[A-Za-z0-9]+$/.test(op.provider_id??"")&&/^req_[A-Za-z0-9]+$/.test(op.provider_request_id??"")&&
  op.id===t.operation_id&&op.idempotency_key===`cn-team-v1:${t.operation_id}`&&isDeepStrictEqual(op.context,context)&&isDeepStrictEqual(op.request,t.request)&&
  isDeepStrictEqual({scopeId:op.scopeId,scopeKey:op.scopeKey,kind:op.kind,saleId:op.saleId,creatorId:op.creatorId,actorId:op.actorId,workerRunId:op.workerRunId},t.scope)&&
  Number.isFinite(Date.parse(op.first_dispatch_at))&&Date.parse(op.first_dispatch_at)<=Date.now()+5000);
 return op;
}
function original(context:Reader["context"],q:TeamTransferReversalOriginal){
 const t=q.transfer,op=completedTransfer(context,t);teamId(q.id);teamId(q.originalWorkerRunId);
 check(cents(q.amountCents)&&q.amountCents>0&&q.amountCents<=Number(t.amount_cents));
 const scope:TeamOperationScope={scopeId:q.id,scopeKey:"recovery:v1",kind:"reversal",saleId:t.sale_id,creatorId:t.creator_id,actorId:null,workerRunId:q.originalWorkerRunId};
 const operationId=teamOperationId(scope),expected:TeamProviderRequest={apiVersion:TEAM_STRIPE_API_VERSION,method:"POST",path:`/v1/transfers/${op.provider_id}/reversals`,params:{amount:q.amountCents,
  metadata:{team_protocol:"creatornet-team-recovery-v1",team_sale_id:t.sale_id,team_receipt_id:t.receipt_id,team_transfer_request_id:t.id,team_recovery_request_id:q.id,team_provider_operation_id:operationId,team_beneficiary:t.beneficiary}}};
 const saved=q.operation;check(saved.id===operationId&&saved.idempotency_key===`cn-team-v1:${operationId}`&&isDeepStrictEqual(saved.context,context)&&isDeepStrictEqual(saved.request,expected)&&
  isDeepStrictEqual({scopeId:saved.scopeId,scopeKey:saved.scopeKey,kind:saved.kind,saleId:saved.saleId,creatorId:saved.creatorId,actorId:saved.actorId,workerRunId:saved.workerRunId},scope)&&
  saved.status==="bound"&&/^trr_[A-Za-z0-9]+$/.test(saved.provider_id??"")&&/^req_[A-Za-z0-9]+$/.test(saved.provider_request_id??"")&&
  Number.isFinite(Date.parse(saved.first_dispatch_at))&&Date.parse(saved.first_dispatch_at)>=Date.parse(op.first_dispatch_at)-5000&&Date.parse(saved.first_dispatch_at)<=Date.now()+5000);
 return {transferId:op.provider_id!,reversalId:saved.provider_id!,operationId,expected};
}

function transfer(saved:TeamTransferRequest,t:Stripe.Transfer,transferId:string,minimumReversed=0){
 const now=Math.floor(Date.now()/1000),first=Math.floor(Date.parse(saved.operation!.first_dispatch_at)/1000),reversals=t.reversals as Stripe.ApiList<Stripe.TransferReversal>&{total_count?:number};
 check(t.object==="transfer"&&t.id===transferId&&t.livemode===(saved.context.mode==="live")&&t.amount===Number(saved.amount_cents)&&t.currency==="usd"&&
  objectId(t.destination)===saved.destination_id&&objectId(t.source_transaction)===saved.chargeId&&t.source_type==="card"&&t.transfer_group===`cn_team_${saved.sale_id}`&&
  isDeepStrictEqual(snapshotProviderJson(t.metadata),saved.request.params.metadata)&&Number.isSafeInteger(t.created)&&t.created>=first-5&&t.created<=now+5&&
  /^txn_[A-Za-z0-9]+$/.test(objectId(t.balance_transaction))&&/^(py|ch)_[A-Za-z0-9]+$/.test(objectId(t.destination_payment))&&
  cents(t.amount_reversed)&&t.amount_reversed>=minimumReversed&&t.amount_reversed<=t.amount&&t.reversed===(t.amount_reversed===t.amount)&&
  reversals?.object==="list"&&Array.isArray(reversals.data)&&reversals.data.length<=100&&typeof reversals.has_more==="boolean"&&reversals.url===`/v1/transfers/${transferId}/reversals`&&
  (reversals.total_count===undefined||(Number.isSafeInteger(reversals.total_count)&&reversals.total_count>=reversals.data.length)));
 // A known reversal is retrieved directly. An inline paginated reversal list is
 // never treated as complete provenance or authority to adopt another original.
 return {id:t.id,amountCents:t.amount,amountReversedCents:t.amount_reversed,reversed:t.reversed,currency:t.currency,destinationId:objectId(t.destination),sourceChargeId:objectId(t.source_transaction),
  destinationPaymentId:objectId(t.destination_payment),balanceId:objectId(t.balance_transaction),transferGroup:t.transfer_group,sourceType:t.source_type,created:t.created,livemode:t.livemode,metadata:snapshotProviderJson(t.metadata)};
}

function reversal(q:TeamTransferReversalOriginal,r:Stripe.TransferReversal,ids:ReturnType<typeof original>){
 const now=Math.floor(Date.now()/1000),first=Math.floor(Date.parse(q.operation.first_dispatch_at)/1000);
 check(r.object==="transfer_reversal"&&r.id===ids.reversalId&&objectId(r.transfer)===ids.transferId&&r.amount===q.amountCents&&r.currency==="usd"&&
  Number.isSafeInteger(r.created)&&r.created>=first-5&&r.created<=now+5&&isDeepStrictEqual(snapshotProviderJson(r.metadata),ids.expected.params.metadata)&&
  /^txn_[A-Za-z0-9]+$/.test(objectId(r.balance_transaction))&&r.source_refund===null&&
  (r.destination_payment_refund===null||/^pyr_[A-Za-z0-9]+$/.test(objectId(r.destination_payment_refund))));
 return {id:r.id,transferId:objectId(r.transfer),amountCents:r.amount,currency:r.currency,balanceId:objectId(r.balance_transaction),created:r.created,
  destinationPaymentRefundId:r.destination_payment_refund===null?null:objectId(r.destination_payment_refund),sourceRefundId:null,metadata:snapshotProviderJson(r.metadata)};
}

function balance(q:TeamTransferReversalOriginal,r:ReturnType<typeof reversal>,b:Stripe.BalanceTransaction){
 const now=Math.floor(Date.now()/1000);check(b.object==="balance_transaction"&&b.id===r.balanceId&&/^txn_[A-Za-z0-9]+$/.test(b.id)&&objectId(b.source)===r.id&&
  b.type==="transfer_refund"&&typeof b.reporting_category==="string"&&/^[a-z_]{1,80}$/.test(b.reporting_category)&&b.balance_type==="payments"&&b.currency==="usd"&&b.exchange_rate===null&&
  b.amount===q.amountCents&&cents(b.fee)&&Number.isSafeInteger(b.net)&&b.net===b.amount-b.fee&&Number.isSafeInteger(b.created)&&b.created>=r.created-5&&b.created<=now+5&&
  b.status==="available"&&Number.isSafeInteger(b.available_on)&&b.available_on>0&&b.available_on<=now&&Array.isArray(b.fee_details)&&b.fee_details.length<=32);
 let total=0;const feeDetails=b.fee_details.map(f=>{check(cents(f.amount)&&f.currency==="usd"&&f.application===null&&["stripe_fee","tax","payment_method_passthrough_fee"].includes(f.type));total+=f.amount;
  return {amount:f.amount,currency:f.currency,application:null,type:f.type};});check(total===b.fee);
 // Retain actual reporting classification and net, including a cost exceeding
 // returned principal. No category default, fee estimate or debt credit is made.
 return {id:b.id,sourceId:objectId(b.source),type:b.type,reportingCategory:b.reporting_category,balanceType:b.balance_type,currency:b.currency,amountCents:b.amount,feeCents:b.fee,netCents:b.net,
  created:b.created,availableOn:b.available_on,status:b.status,feeDetails};
}

/** Six bounded GETs prove repeated original transfer, reversal and actual
 * Payments-balance return. Unknown/unbound reversals require separate original
 * event/key recovery; matching metadata alone never selects one here. */
export async function readTeamBoundTransferReversal(c:Reader,input:TeamTransferReversalOriginal){
 const q=snapshotProviderJson(input),context=snapshotProviderJson(c.context),ids=original(context,q),started=Date.now(),seen=new Set<string>();let reads=0;
 const bounded=()=>check(Date.now()>=started&&Date.now()-started<25000);
 const current=async()=>{bounded();check(isDeepStrictEqual(snapshotProviderJson(await c.observeContext()),context));bounded();};
 const get=async<T>(path:string)=>{await current();check(++reads<=6);const value=await c.stripe.rawRequest("GET",path,{},
  {apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:Math.min(10000,25000-(Date.now()-started))}) as T;
  bounded();const req=requestId(value);check(/^req_[A-Za-z0-9]+$/.test(req)&&!seen.has(req));seen.add(req);await current();return value;};
 const one=await get<Stripe.Transfer>(`/v1/transfers/${ids.transferId}`),root=transfer(q.transfer,one,ids.transferId,q.amountCents);
 const first=await get<Stripe.TransferReversal>(`/v1/transfers/${ids.transferId}/reversals/${ids.reversalId}`),returned=reversal(q,first,ids);
 check(returned.created>=root.created&&Math.floor(Date.parse(q.operation.first_dispatch_at)/1000)>=root.created-5);
 const debit=await get<Stripe.BalanceTransaction>(`/v1/balance_transactions/${returned.balanceId}`),movement=balance(q,returned,debit);
 const two=await get<Stripe.Transfer>(`/v1/transfers/${ids.transferId}`);check(isDeepStrictEqual(root,transfer(q.transfer,two,ids.transferId,q.amountCents)));
 const second=await get<Stripe.TransferReversal>(`/v1/transfers/${ids.transferId}/reversals/${ids.reversalId}`);check(isDeepStrictEqual(returned,reversal(q,second,ids)));
 const repeated=await get<Stripe.BalanceTransaction>(`/v1/balance_transactions/${returned.balanceId}`);check(isDeepStrictEqual(movement,balance(q,returned,repeated)));await current();
 return {requestId:q.id,operationId:ids.operationId,transferRequestId:q.transfer.id,receiptId:q.transfer.receipt_id,saleId:q.transfer.sale_id,creatorId:q.transfer.creator_id,beneficiary:q.transfer.beneficiary,
  context,transfer:root,reversal:returned,balance:movement,originalRequestId:q.operation.provider_request_id!,idempotencyKey:q.operation.idempotency_key,
  transferReadRequestIds:[requestId(one),requestId(two)],reversalReadRequestIds:[requestId(first),requestId(second)],balanceReadRequestIds:[requestId(debit),requestId(repeated)],readStartedAt:started,observedAt:Math.floor(Date.now()/1000)};
}

/** Repeated root reads for a supplied completed original. This proves neither
 * an individual return nor authority to adopt or dispatch a reversal. */
export async function readTeamOriginalTransferForRecovery(c:Reader,input:TeamTransferRequest){
 const q=snapshotProviderJson(input),context=snapshotProviderJson(c.context),op=completedTransfer(context,q),started=Date.now(),seen=new Set<string>();
 const bounded=()=>check(Date.now()>=started&&Date.now()-started<25000);
 const current=async()=>{bounded();check(isDeepStrictEqual(snapshotProviderJson(await c.observeContext()),context));bounded();};
 const get=async()=>{await current();const value=await c.stripe.rawRequest("GET",`/v1/transfers/${op.provider_id}`,{},
  {apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:Math.min(10000,25000-(Date.now()-started))}) as unknown as Stripe.Transfer;
  bounded();const req=requestId(value);check(/^req_[A-Za-z0-9]+$/.test(req)&&!seen.has(req));seen.add(req);await current();return value;};
 const first=await get(),root=transfer(q,first,op.provider_id!),second=await get();check(isDeepStrictEqual(root,transfer(q,second,op.provider_id!)));await current();
 return {transferRequestId:q.id,receiptId:q.receipt_id,context,transfer:root,transferReadRequestIds:[requestId(first),requestId(second)],readStartedAt:started,observedAt:Math.floor(Date.now()/1000)};
}
