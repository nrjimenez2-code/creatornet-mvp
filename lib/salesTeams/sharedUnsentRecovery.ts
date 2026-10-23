import "server-only";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {teamId} from "./policy";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import type {TeamReceiptComposition} from "./receipts";

type Source={kind:"legacy_refund"|"tip_restoration";id:string;context:TeamReceiptComposition["context"];fingerprint:string;chargeId:string;paymentIntentId:string;disputeId?:string;terminalStatus?:string;originalTransferId?:string};
const objectId=(value:unknown)=>typeof value==="string"?value:(value as {id?:string}|null)?.id??null;
/** No absent-list inference. SQL must first prove guarded birth and no outgoing
 * admission/attempt. Historical and uncertain originals use the existing held
 * path. Provider reads only verify the original parents and current condition. */
export async function inspectSharedUnsentRecovery(c:TeamReceiptComposition,scope:{runId:string;leaseToken:string;taskId:string}):Promise<{held:boolean}|null>{
 for(const value of [scope.runId,scope.leaseToken,scope.taskId])teamId(value);
 const current=async()=>{if(!isDeepStrictEqual(await c.observeContext(),c.context))throw Error("Unsent shared context changed");};
 const rpc=async<T>(name:string,extra:Record<string,unknown>={}):Promise<T>=>{
  await current();const request=c.admin.rpc(name,{p_run_id:scope.runId,p_lease_token:scope.leaseToken,p_task_id:scope.taskId,p_context:c.context,...extra});
  const result=await (typeof request.abortSignal==="function"?request.abortSignal(AbortSignal.timeout(5000)):request);if(result.error)throw result.error;return result.data as T;
 };
 const begun=await rpc<{eligible:boolean;completed?:boolean;held?:boolean;source?:Source}>("begin_sales_team_shared_unsent_v1");
 if(!begun.eligible)return null;if(begun.completed)return {held:begun.held!==false};
 const s=begun.source;if(!s||!isDeepStrictEqual(s.context,c.context)||!/^ch_[A-Za-z0-9]+$/.test(s.chargeId)||!/^pi_[A-Za-z0-9]+$/.test(s.paymentIntentId)||!['legacy_refund','tip_restoration'].includes(s.kind))throw Error("Original unsent shared source required");
 const started=Date.now(),reads:{path:string;requestId:string}[]=[];
 const get=async<T>(path:string):Promise<T>=>{
  if(Date.now()<started||Date.now()-started>=25000)throw Error("Unsent shared read budget exhausted");
  const value=await c.stripe.rawRequest("GET",path,{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000}) as unknown as T&{lastResponse?:{requestId?:string}};
  const requestId=value.lastResponse?.requestId??"";if(!/^req_[A-Za-z0-9]{1,100}$/.test(requestId)||reads.some(r=>r.requestId===requestId))throw Error("Independent unsent original reads required");reads.push({path,requestId});return value;
 };
 const charge=async()=>{const v=await get<Stripe.Charge>(`/v1/charges/${s.chargeId}`);if(v.object!=="charge")throw Error("Original charge required");return {id:v.id,paymentIntentId:objectId(v.payment_intent),currency:v.currency,livemode:v.livemode,paid:v.paid,captured:v.captured,status:v.status,amountCents:v.amount,refundedCents:v.amount_refunded,applicationFeeId:objectId(v.application_fee),transferId:objectId(v.transfer),destinationId:objectId(v.transfer_data?.destination)};};
 const charges={first:await charge(),second:await charge()};let disputes:unknown=null,originalTransfer:unknown=null;
 if(s.kind==="tip_restoration"){
  if(!s.disputeId||!/^dp_[A-Za-z0-9]+$/.test(s.disputeId))throw Error("Original dispute required");
  const dispute=async()=>{const v=await get<Stripe.Dispute>(`/v1/disputes/${s.disputeId}`);if(v.object!=="dispute")throw Error("Original dispute required");return {id:v.id,chargeId:objectId(v.charge),paymentIntentId:objectId(v.payment_intent),currency:v.currency,livemode:v.livemode,amountCents:v.amount,status:v.status};};
  disputes={first:await dispute(),second:await dispute()};
  if(s.terminalStatus==="won"){
   if(!s.originalTransferId||!/^tr_[A-Za-z0-9]+$/.test(s.originalTransferId))throw Error("Original transfer required");
   const transfer=async()=>{const v=await get<Stripe.Transfer>(`/v1/transfers/${s.originalTransferId}`);if(v.object!=="transfer")throw Error("Original transfer required");return {id:v.id,sourceTransaction:objectId(v.source_transaction),destinationId:objectId(v.destination),currency:v.currency,livemode:v.livemode,amountCents:v.amount,reversedCents:v.amount_reversed};};
   originalTransfer={first:await transfer(),second:await transfer()};
  }
 }
 if(Date.now()<started||Date.now()-started>=25000)throw Error("Unsent shared read budget exhausted");
 return rpc<{held:boolean}>("complete_sales_team_shared_unsent_v1",{p_proof:{fingerprint:s.fingerprint,context:c.context,readStartedAt:started,charge:charges,dispute:disputes,originalTransfer,reads}});
}
