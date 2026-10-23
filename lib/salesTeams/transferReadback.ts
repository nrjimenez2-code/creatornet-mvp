import "server-only";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {snapshotProviderJson} from "@/lib/membershipOperation";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {validateTeamTransferRequest,type TeamTransferRequest} from "./transferReservations";
import type {TeamReceiptComposition} from "./receipts";

const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Original earned transfer readback requires reconciliation");};
const objectId=(v:unknown)=>typeof v==="string"?v:(v as {id?:string}|null)?.id??"";
const requestId=(v:unknown)=>(v as {lastResponse?:{requestId?:string}}|null)?.lastResponse?.requestId??"";
const integer=(v:number)=>Number.isSafeInteger(v)&&v>=0&&v<=99999999;
type ReaderComposition=Pick<TeamReceiptComposition,"context"|"observeContext"|"stripe">;
function original(c:Pick<ReaderComposition,"context">,q:TeamTransferRequest){
 validateTeamTransferRequest(c,q);const op=q.operation;check(op&&!q.canceled&&Number.isFinite(Date.parse(op.first_dispatch_at))&&Date.parse(op.first_dispatch_at)<=Date.now()+5000&&
  op.id===q.operation_id&&op.idempotency_key===`cn-team-v1:${q.operation_id}`&&isDeepStrictEqual(op.context,q.context)&&isDeepStrictEqual(op.request,q.request)&&
  isDeepStrictEqual({scopeId:op.scopeId,scopeKey:op.scopeKey,kind:op.kind,saleId:op.saleId,creatorId:op.creatorId,actorId:op.actorId,workerRunId:op.workerRunId},q.scope)&&
  ['dispatching','unknown','bound'].includes(op.status)&&(!op.provider_id||/^tr_[A-Za-z0-9]+$/.test(op.provider_id)));
 return op;
}
/** A direct POST/retrieve response can bind its exact original identity before
 * a balance debit is available. Accounting still requires the stricter repeated
 * transfer/balance readback below. A request ID alone cannot release money. */
export function inspectTeamTransferDispatch(q:TeamTransferRequest,t:Stripe.Transfer){
 original({context:q.context},q);
 const first=Math.floor(Date.parse(q.operation!.first_dispatch_at)/1000),now=Math.floor(Date.now()/1000);
 check(t.object==="transfer"&&/^tr_[A-Za-z0-9]+$/.test(t.id)&&t.livemode===(q.context.mode==="live")&&t.amount===Number(q.amount_cents)&&t.currency==="usd"&&
  objectId(t.destination)===q.destination_id&&objectId(t.source_transaction)===q.chargeId&&t.source_type==="card"&&t.transfer_group===`cn_team_${q.sale_id}`&&
  isDeepStrictEqual(snapshotProviderJson(t.metadata),q.request.params.metadata)&&Number.isSafeInteger(t.created)&&t.created>=first-5&&t.created<=now+5&&
  t.amount_reversed===0&&t.reversed===false&&/^req_[A-Za-z0-9]+$/.test(requestId(t)));
 return {id:t.id,requestId:requestId(t)};
}
function inspectTransfer(q:TeamTransferRequest,t:Stripe.Transfer,expectedId:string){
 const now=Math.floor(Date.now()/1000),first=Math.floor(Date.parse(q.operation!.first_dispatch_at)/1000),reversalCount=(t.reversals as Stripe.ApiList<Stripe.TransferReversal>&{total_count?:number})?.total_count;
 check(t.object==="transfer"&&t.id===expectedId&&/^tr_[A-Za-z0-9]+$/.test(t.id)&&t.livemode===(q.context.mode==="live")&&
  t.amount===Number(q.amount_cents)&&t.currency==="usd"&&objectId(t.destination)===q.destination_id&&objectId(t.source_transaction)===q.chargeId&&
  t.source_type==="card"&&t.transfer_group===`cn_team_${q.sale_id}`&&isDeepStrictEqual(snapshotProviderJson(t.metadata),q.request.params.metadata)&&
  Number.isSafeInteger(t.created)&&t.created>=first-5&&t.created<=now+5&&/^txn_[A-Za-z0-9]+$/.test(objectId(t.balance_transaction))&&
  /^(py|ch)_[A-Za-z0-9]+$/.test(objectId(t.destination_payment))&&t.reversed===false&&t.amount_reversed===0&&t.reversals?.object==="list"&&
  Array.isArray(t.reversals.data)&&t.reversals.data.length===0&&t.reversals.has_more===false&&(reversalCount===undefined||reversalCount===0)&&t.reversals.url===`/v1/transfers/${t.id}/reversals`);
 return {id:t.id,amountCents:t.amount,currency:t.currency,destinationId:objectId(t.destination),destinationPaymentId:objectId(t.destination_payment),
  sourceChargeId:objectId(t.source_transaction),sourceType:t.source_type,transferGroup:t.transfer_group,created:t.created,livemode:t.livemode,
  balanceId:objectId(t.balance_transaction),amountReversedCents:0,reversed:false,metadata:snapshotProviderJson(t.metadata)};
}
function inspectBalance(q:TeamTransferRequest,t:ReturnType<typeof inspectTransfer>,v:Stripe.BalanceTransaction){
 const now=Math.floor(Date.now()/1000);check(v.object==="balance_transaction"&&v.id===t.balanceId&&/^txn_[A-Za-z0-9]+$/.test(v.id)&&
  objectId(v.source)===t.id&&v.type==="transfer"&&v.reporting_category==="transfer"&&v.balance_type==="payments"&&v.currency==="usd"&&v.exchange_rate===null&&
  v.amount===-Number(q.amount_cents)&&integer(v.fee)&&v.net===v.amount-v.fee&&Number.isSafeInteger(v.net)&&
  Number.isSafeInteger(v.created)&&v.created>=t.created-5&&v.created<=now+5&&Number.isSafeInteger(v.available_on)&&v.available_on>0&&v.available_on<=now&&v.status==="available"&&
  Array.isArray(v.fee_details)&&v.fee_details.length<=32);
 let total=0;const feeDetails=v.fee_details.map(f=>{check(integer(f.amount)&&f.currency==="usd"&&f.application===null&&['stripe_fee','tax','payment_method_passthrough_fee'].includes(f.type));
  total+=f.amount;return {amount:f.amount,currency:f.currency,application:null,type:f.type};});check(total===v.fee);
 return {id:v.id,sourceId:objectId(v.source),amountCents:v.amount,feeCents:v.fee,netCents:v.net,currency:v.currency,balanceType:v.balance_type,
  type:v.type,reportingCategory:v.reporting_category,created:v.created,availableOn:v.available_on,status:v.status,feeDetails};
}
function transport(c:ReaderComposition,milliseconds:number){
 const started=Date.now(),expected=snapshotProviderJson(c.context),seen=new Set<string>();const bounded=()=>check(Date.now()>=started&&Date.now()-started<milliseconds);
 const context=async()=>{bounded();check(isDeepStrictEqual(snapshotProviderJson(await c.observeContext()),expected));bounded();};
 const get=async<T>(path:string,params:Record<string,unknown>={})=>{await context();
  const value=await c.stripe.rawRequest("GET",path,params,{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:Math.min(10000,milliseconds-(Date.now()-started))}) as T;
  bounded();const req=requestId(value);check(/^req_[A-Za-z0-9]+$/.test(req)&&!seen.has(req));seen.add(req);await context();return value;
 };
 return {get,context,started};
}
type Reader=ReturnType<typeof transport>;
async function readTransfer(q:TeamTransferRequest,transferId:string,reader:Reader){
 const started=Date.now(),one=await reader.get<Stripe.Transfer>(`/v1/transfers/${transferId}`),transfer=inspectTransfer(q,one,transferId);
 const firstBalance=await reader.get<Stripe.BalanceTransaction>(`/v1/balance_transactions/${transfer.balanceId}`),balance=inspectBalance(q,transfer,firstBalance);
 const two=await reader.get<Stripe.Transfer>(`/v1/transfers/${transferId}`);check(isDeepStrictEqual(transfer,inspectTransfer(q,two,transferId)));
 const secondBalance=await reader.get<Stripe.BalanceTransaction>(`/v1/balance_transactions/${transfer.balanceId}`);check(isDeepStrictEqual(balance,inspectBalance(q,transfer,secondBalance)));
 await reader.context();check(Date.now()>=started&&Date.now()-started<25000);
 return {requestId:q.id,operationId:q.operation_id,receiptId:q.receipt_id,saleId:q.sale_id,creatorId:q.creator_id,beneficiary:q.beneficiary,
  context:snapshotProviderJson(q.context),transfer,balance,readStartedAt:started,observedAt:Math.floor(Date.now()/1000),
  transferReadRequestIds:[requestId(one),requestId(two)],balanceReadRequestIds:[requestId(firstBalance),requestId(secondBalance)]};
}
/** Independent GET-only evidence. The consumer must validate its current worker,
 * immutable original, reserved fees and atomic accounting before any release.
 * This reader never writes a journal, releases accounting or proves bank payout. */
export async function readTeamBoundTransfer(c:ReaderComposition,input:TeamTransferRequest){
 const q=snapshotProviderJson(input),op=original(c,q);check(op.status==="bound"&&op.provider_id&&/^req_[A-Za-z0-9]+$/.test(op.provider_request_id??""));
 const proof=await readTransfer(q,op.provider_id,transport(c,25000));
 return {...proof,originalRequestId:op.provider_request_id!,idempotencyKey:op.idempotency_key};
}
/** Unknown POSTs are never retried or identified by metadata search. A complete
 * bounded original event list must contain exactly one original idempotency key,
 * followed by repeat reads of the exact original object and debit. */
export async function recoverTeamUnknownTransfer(c:ReaderComposition,input:TeamTransferRequest){
 const q=snapshotProviderJson(input),op=original(c,q);check(!op.provider_id&&(op.status==="unknown"||op.status==="dispatching"&&Number.isFinite(Date.parse(op.lease_until??""))&&Date.parse(op.lease_until!)<=Date.now()));
 const reader=transport(c,45000),events:Stripe.Event[]=[],ids=new Set<string>(),eventRequests=new Map<string,string>();let after:string|undefined,complete=false;
 for(let page=0;page<3;page++){
  const list=await reader.get<Stripe.ApiList<Stripe.Event>>("/v1/events",{type:"transfer.created",created:{gte:Math.floor(Date.parse(op.first_dispatch_at)/1000)-5},limit:100,...(after?{starting_after:after}:{})});
  check(list.object==="list"&&Array.isArray(list.data)&&list.data.length<=100&&typeof list.has_more==="boolean");
  for(const e of list.data){check(e.object==="event"&&/^evt_[A-Za-z0-9]+$/.test(e.id)&&!ids.has(e.id));ids.add(e.id);events.push(e);eventRequests.set(e.id,requestId(list));}
  if(!list.has_more){complete=true;break;}check(list.data.length>0);after=list.data.at(-1)!.id;
 }
 if(!complete)return null;
 const matches=events.filter(e=>e.type==="transfer.created"&&e.request?.idempotency_key===op.idempotency_key);if(matches.length!==1)return null;
 const event=matches[0],originalRequestId=event.request?.id??"";check(event.account==null&&event.livemode===(q.context.mode==="live")&&/^req_[A-Za-z0-9]+$/.test(originalRequestId)&&
  Number.isSafeInteger(event.created)&&event.created>=Math.floor(Date.parse(op.first_dispatch_at)/1000)-5&&event.created<=Math.floor(Date.now()/1000)+5);
 const snapshot=event.data.object as Stripe.Transfer,identity=inspectTransfer(q,snapshot,snapshot.id),proof=await readTransfer(q,snapshot.id,reader);
 check(isDeepStrictEqual(identity,proof.transfer));
 return {...proof,originalRequestId,idempotencyKey:op.idempotency_key,recovery:{eventId:event.id,eventType:event.type,eventCreated:event.created,livemode:event.livemode,
  account:null,eventReadRequestId:eventRequests.get(event.id)!,readStartedAt:reader.started}};
}
