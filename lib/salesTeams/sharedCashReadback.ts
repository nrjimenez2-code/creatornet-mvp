import "server-only";
import type Stripe from "stripe";
import type {ExactPaymentContext} from "@/lib/installments/paymentContext";
import {isDeepStrictEqual} from "node:util";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";

type Base={id:string;creatorId:string;context:ExactPaymentContext;fingerprint:string;createdAt:number;closed:boolean;chargeId:string;paymentIntentId:string};
export type SharedCashOriginal=Base&({kind:"legacy_refund";grossCents:number;refundCents:number;refundId:string|null;applicationFeeId:string;feeRefundId:string|null;
 feeRefundCents:number;actualFeeRefundCents:number|null;responsibility:string;reasonCode:string}|
 {kind:"tip_restoration";tipId:string;disputeId:string;originalTransferId:string;restorationTransferId:string|null;destinationId:string;restorationCents:number});
type Read={path:string;requestId:string};
export type SharedCashBalanceEntry={id:string;sourceId:string;kind:string;amountCents:number;feeCents:number;netCents:number;currency:"usd";created:number;availableOn:number;
 status:"available";balanceType:"payments";feeDetails:{amount:number;currency:"usd";application:null;type:string}[];requestId:string};
export type SharedCashObservation={version:"creatornet-shared-cash-observation-v1";sourceKind:SharedCashOriginal["kind"];sourceId:string;fingerprint:string;context:ExactPaymentContext;
 readStartedAt:number;complete:boolean;holdReason:string|null;objects:Record<string,unknown>;balances:SharedCashBalanceEntry[];reads:Read[]};
type Reader={context:ExactPaymentContext;observeContext():Promise<ExactPaymentContext>;stripe:{rawRequest(method:string,path:string,params:object,options:object):Promise<unknown>}};
const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Original shared cash evidence requires review");};
const objectId=(value:unknown)=>typeof value==="string"?value:(value as {id?:string}|null)?.id??"";
const money=(value:unknown):value is number=>Number.isSafeInteger(value)&&Math.abs(Number(value))<=9007199254740991;
/** GET-only cash proof for a terminal, already-bound original. Missing identities
 * and incomplete legacy workflows remain held; metadata never adopts an object.
 * This reader changes no recipient earnings, entitlements or bank-payout state. */
export async function readSharedCashOriginal(c:Reader,s:SharedCashOriginal,now:()=>number=Date.now):Promise<SharedCashObservation>{
 check(isDeepStrictEqual(c.context,s.context)&&isDeepStrictEqual(await c.observeContext(),s.context)&&/^[a-f0-9]{64}$/.test(s.fingerprint)&&Number.isSafeInteger(s.createdAt)&&s.createdAt>0);
 const started=now(),reads:Read[]=[],requestIds=new Set<string>(),balances:SharedCashBalanceEntry[]=[],objects:Record<string,unknown>={};let requests=0;
 const result=(reason:string|null):SharedCashObservation=>({version:"creatornet-shared-cash-observation-v1",sourceKind:s.kind,sourceId:s.id,fingerprint:s.fingerprint,context:s.context,
  readStartedAt:started,complete:reason===null,holdReason:reason,objects,balances,reads});
 if(!s.closed)return result("original_workflow_unfinished");
 if(s.kind==="legacy_refund"&&(!s.refundId||s.feeRefundCents>0&&!s.feeRefundId)||s.kind==="tip_restoration"&&!s.restorationTransferId)return result("original_provider_identity_required");
 const get=async<T>(path:string):Promise<T>=>{
  check(++requests<=16&&now()>=started&&now()-started<45000);
  const value=await c.stripe.rawRequest("GET",path,{},{apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:Math.min(10000,45000-(now()-started))}) as T&{lastResponse?:{requestId?:string}};
  const requestId=value?.lastResponse?.requestId??"";check(/^req_[A-Za-z0-9]+$/.test(requestId)&&!requestIds.has(requestId)&&now()>=started&&now()-started<45000);requestIds.add(requestId);reads.push({path,requestId});return value;
 };
 const refs:{id:string;sourceId:string;kind:string;amount:number}[]=[];
 const ref=(id:unknown,sourceId:string,kind:string,amount:number)=>{check(typeof id==="string"&&/^txn_[A-Za-z0-9]+$/.test(id)&&!refs.some(existing=>existing.id===id)&&money(amount));refs.push({id,sourceId,kind,amount});};
 const chargeIdentity=(v:Stripe.Charge)=>{
  check(v.object==="charge"&&v.id===s.chargeId&&v.livemode===(s.context.mode==="live")&&objectId(v.payment_intent)===s.paymentIntentId&&v.currency==="usd"&&v.paid===true&&v.captured===true&&v.status==="succeeded"&&money(v.amount)&&v.amount>0);
  return {id:v.id,paymentIntentId:objectId(v.payment_intent),currency:v.currency,amountCents:v.amount,livemode:v.livemode,paid:v.paid,captured:v.captured,status:v.status,applicationFeeId:objectId(v.application_fee),transferId:objectId(v.transfer),destinationId:objectId(v.transfer_data?.destination)};
 };
 check(/^ch_[A-Za-z0-9]+$/.test(s.chargeId)&&/^pi_[A-Za-z0-9]+$/.test(s.paymentIntentId));
 const charge=chargeIdentity(await get<Stripe.Charge>(`/v1/charges/${s.chargeId}`));objects.charge=charge;
 let verifyRoots:()=>Promise<void>;
 if(s.kind==="legacy_refund"){
  check(money(s.refundCents)&&s.refundCents>0&&money(s.grossCents)&&s.refundCents<=s.grossCents&&charge.amountCents===s.grossCents&&charge.applicationFeeId===s.applicationFeeId&&charge.transferId!==""&&charge.destinationId!==""&&/^re_[A-Za-z0-9]+$/.test(s.refundId!)&&/^fee_[A-Za-z0-9]+$/.test(s.applicationFeeId));
  const normalize=(v:Stripe.Refund)=>{
   check(v.object==="refund"&&v.id===s.refundId&&objectId(v.charge)===s.chargeId&&objectId(v.payment_intent)===s.paymentIntentId&&v.amount===s.refundCents&&v.currency==="usd"&&
    v.metadata?.creatornet_refund_operation_id===s.id&&v.metadata.responsibility===s.responsibility&&v.metadata.reason_code===s.reasonCode&&Number.isSafeInteger(v.created)&&v.created>=s.createdAt-5&&v.created<=Math.floor(now()/1000)+5);
   return {id:v.id,status:v.status??null,chargeId:s.chargeId,paymentIntentId:s.paymentIntentId,amountCents:v.amount,currency:v.currency,created:v.created,balanceId:objectId(v.balance_transaction)||null,failureBalanceId:objectId(v.failure_balance_transaction)||null,
    operationId:v.metadata.creatornet_refund_operation_id,responsibility:v.metadata.responsibility,reasonCode:v.metadata.reason_code};
  };
  const refund=normalize(await get<Stripe.Refund>(`/v1/refunds/${s.refundId}`));objects.refund=refund;
  if(!["succeeded","failed","canceled"].includes(refund.status??""))return result("original_refund_pending");
  if(refund.status==="succeeded"){
   check(refund.failureBalanceId===null);ref(refund.balanceId,refund.id,"refund",-s.refundCents);
  }else if(refund.balanceId||refund.failureBalanceId){ref(refund.balanceId,refund.id,"refund",-s.refundCents);ref(refund.failureBalanceId,refund.id,"refund_failure",s.refundCents);}
  let fee:Record<string,unknown>|null=null;
  const feePath=`/v1/application_fees/${s.applicationFeeId}/refunds/${s.feeRefundId}`;
  const feeIdentity=(v:Stripe.FeeRefund)=>{
   check(v.object==="fee_refund"&&v.id===s.feeRefundId&&objectId(v.fee)===s.applicationFeeId&&v.currency==="usd"&&money(v.amount)&&v.amount>0&&
    v.amount===s.actualFeeRefundCents&&v.amount<=s.feeRefundCents&&v.metadata?.creatornet_refund_operation_id===s.id&&v.metadata.responsibility===s.responsibility&&Number.isSafeInteger(v.created)&&v.created>=s.createdAt-5&&v.created<=Math.floor(now()/1000)+5);
   return {id:v.id,feeId:objectId(v.fee),amountCents:v.amount,currency:v.currency,created:v.created,balanceId:objectId(v.balance_transaction),operationId:v.metadata.creatornet_refund_operation_id,responsibility:v.metadata.responsibility};
  };
  if(s.feeRefundId){
   check(/^fr_[A-Za-z0-9]+$/.test(s.feeRefundId));const parent=await get<Stripe.ApplicationFee>(`/v1/application_fees/${s.applicationFeeId}`);
   check(parent.object==="application_fee"&&parent.id===s.applicationFeeId&&objectId(parent.charge)===s.chargeId&&objectId(parent.account)===charge.destinationId&&parent.currency==="usd"&&parent.livemode===(s.context.mode==="live")&&
    money(parent.amount)&&money(parent.amount_refunded)&&parent.amount>0&&parent.amount_refunded>=Number(s.actualFeeRefundCents)&&parent.amount_refunded<=parent.amount);
   objects.applicationFee={id:parent.id,chargeId:objectId(parent.charge),accountId:objectId(parent.account),currency:parent.currency,livemode:parent.livemode,amountCents:parent.amount,refundedCents:parent.amount_refunded};
   const observed=feeIdentity(await get<Stripe.FeeRefund>(feePath));fee=observed;objects.feeRefund=observed;ref(observed.balanceId,observed.id,"application_fee_refund",-observed.amountCents);
  }
  verifyRoots=async()=>{check(isDeepStrictEqual(normalize(await get<Stripe.Refund>(`/v1/refunds/${s.refundId}`)),refund));if(fee)check(isDeepStrictEqual(feeIdentity(await get<Stripe.FeeRefund>(feePath)),fee));};
 }else{
  check(/^tr_[A-Za-z0-9]+$/.test(s.restorationTransferId!)&&/^dp_[A-Za-z0-9]+$/.test(s.disputeId)&&s.id===s.disputeId&&money(s.restorationCents)&&s.restorationCents>0);
  const normalizeDispute=(v:Stripe.Dispute)=>{
   check(v.object==="dispute"&&v.id===s.disputeId&&objectId(v.charge)===s.chargeId&&objectId(v.payment_intent)===s.paymentIntentId&&v.currency==="usd"&&v.livemode===(s.context.mode==="live"));
   return {id:v.id,status:v.status,chargeId:objectId(v.charge),paymentIntentId:objectId(v.payment_intent),currency:v.currency,livemode:v.livemode};
  };
  const dispute=normalizeDispute(await get<Stripe.Dispute>(`/v1/disputes/${s.disputeId}`));
  if(dispute.status!=="won")return result("original_tip_dispute_unfinished");
  check(charge.transferId===s.originalTransferId&&charge.destinationId===s.destinationId);
  const normalize=(v:Stripe.Transfer)=>{
   check(v.object==="transfer"&&v.id===s.restorationTransferId&&v.amount===s.restorationCents&&v.currency==="usd"&&v.livemode===(s.context.mode==="live")&&objectId(v.destination)===s.destinationId&&v.source_transaction===null&&v.source_type==="card"&&
    v.transfer_group===`creatornet-tip-dispute-restore:${s.disputeId}`&&v.metadata.payment_kind==="video_tip_dispute_restoration"&&v.metadata.tip_id===s.tipId&&v.metadata.dispute_id===s.disputeId&&Number.isSafeInteger(v.created)&&v.created>=s.createdAt-5&&v.created<=Math.floor(now()/1000)+5);
   return {id:v.id,amountCents:v.amount,currency:v.currency,destinationId:objectId(v.destination),created:v.created,balanceId:objectId(v.balance_transaction),livemode:v.livemode,sourceTransaction:v.source_transaction,sourceType:v.source_type,
    transferGroup:v.transfer_group,tipId:v.metadata.tip_id,disputeId:v.metadata.dispute_id};
  };
  const transfer=normalize(await get<Stripe.Transfer>(`/v1/transfers/${s.restorationTransferId}`));objects.transfer=transfer;objects.dispute=dispute;
  ref(transfer.balanceId,transfer.id,"transfer",-s.restorationCents);
  verifyRoots=async()=>{check(isDeepStrictEqual(normalize(await get<Stripe.Transfer>(`/v1/transfers/${s.restorationTransferId}`)),transfer));check(isDeepStrictEqual(normalizeDispute(await get<Stripe.Dispute>(`/v1/disputes/${s.disputeId}`)),dispute));};
 }
 check(refs.length<=4);
 const traced=await Promise.allSettled(refs.map(async owned=>{
  const v=await get<Stripe.BalanceTransaction>(`/v1/balance_transactions/${owned.id}`);
  check(v.object==="balance_transaction"&&v.id===owned.id&&objectId(v.source)===owned.sourceId&&v.type===owned.kind&&v.amount===owned.amount&&v.currency==="usd"&&v.exchange_rate===null&&v.balance_type==="payments"&&
   money(v.amount)&&money(v.fee)&&money(v.net)&&BigInt(v.net)===BigInt(v.amount)-BigInt(v.fee)&&v.status==="available"&&Number.isSafeInteger(v.created)&&v.created>=s.createdAt-5&&v.created<=Math.floor(now()/1000)+5&&Number.isSafeInteger(v.available_on)&&v.available_on>0&&v.available_on<=Math.floor(now()/1000)&&Array.isArray(v.fee_details));
  let total=0n;const feeDetails=v.fee_details.map(part=>{check(money(part.amount)&&part.currency==="usd"&&part.application===null&&["stripe_fee","tax","payment_method_passthrough_fee"].includes(part.type));total+=BigInt(part.amount);return {amount:part.amount,currency:"usd" as const,application:null,type:part.type};});check(total===BigInt(v.fee));
  balances.push({id:v.id,sourceId:owned.sourceId,kind:owned.kind,amountCents:v.amount,feeCents:v.fee,netCents:v.net,currency:"usd",created:v.created,availableOn:v.available_on,status:"available",balanceType:"payments",feeDetails,requestId:reads.findLast(read=>read.path===`/v1/balance_transactions/${owned.id}`)!.requestId});
 }));
 const failure=traced.find(item=>item.status==="rejected");if(failure?.status==="rejected")throw failure.reason;
 await verifyRoots();check(isDeepStrictEqual(chargeIdentity(await get<Stripe.Charge>(`/v1/charges/${s.chargeId}`)),charge));
 check(isDeepStrictEqual(await c.observeContext(),s.context)&&now()>=started&&now()-started<45000);
 balances.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);return result(null);
}
