import "server-only";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {membershipAgreementFingerprint} from "@/lib/membershipAgreement";
import {validateTeamSurplusRequest,type TeamSurplusRequest} from "./surplusReservations";
import type {TeamOperationScope,TeamProviderRequest} from "./providerOperation";

export type TeamSurplusJournal=TeamOperationScope&{id:string;context:TeamSurplusRequest["context"];request:TeamProviderRequest;status:string;idempotency_key:string;
 first_dispatch_at:string;provider_id:string|null;provider_request_id:string|null};
export type TeamSurplusMoneySource=TeamSurplusRequest&{created_at:string;operation:TeamSurplusJournal};
export type TeamSurplusBalance={id:string;sourceId:string;kind:"debit"|"return";amountCents:number;feeCents:number;netCents:number;currency:"usd";created:number;availableOn:number;
 balanceType:"payments";type:string;reportingCategory:string;exchangeRate:null;
 status:"pending"|"available";providerRequestId:string;feeDetails:{amount:number;currency:"usd";application:null;type:string}[]};
const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Original bank payout evidence requires review");};
const objectId=(v:unknown)=>typeof v==="string"?v:(v as {id?:string}|null)?.id??"";
const requestId=(v:unknown)=>(v as {lastResponse?:{requestId?:string}}|null)?.lastResponse?.requestId??"";
const integer=(v:unknown)=>Number.isSafeInteger(v);
const empty=(v:unknown)=>v===null||v===undefined;

/** Eligibility is used only for a fresh payout. It must not be reapplied when
 * observing a debit/return that already happened to an older approved bank. */
export function inspectTeamSurplusDestination(q:TeamSurplusRequest,account:Stripe.Account,settings:Stripe.BalanceSettings,bank:Stripe.BankAccount){
 validateTeamSurplusRequest({context:q.context},q);
 const payouts=settings.payments?.payouts,rules=(payouts as unknown as {automatic_transfer_rules_by_currency?:unknown})?.automatic_transfer_rules_by_currency;
 check(account.object==="account"&&account.id===q.context.platformAccountId&&account.country==="US"&&account.default_currency==="usd"&&account.payouts_enabled===true&&
  settings.object==="balance_settings"&&payouts?.status==="enabled"&&payouts.schedule?.interval==="manual"&&
  (empty(rules)||typeof rules==="object"&&!Array.isArray(rules)&&Object.values(rules!).every(v=>Array.isArray(v)&&v.length===0))&&
  bank.object==="bank_account"&&bank.id===q.destination_id&&bank.country==="US"&&bank.currency==="usd"&&empty(bank.customer)&&
  (empty(bank.account)||objectId(bank.account)===q.context.platformAccountId)&&["new","validated","verified"].includes(bank.status)&&typeof bank.fingerprint==="string"&&bank.fingerprint.length>0&&bank.fingerprint.length<=256);
 return {platformAccountId:account.id,destinationId:bank.id,country:"US" as const,currency:"usd" as const,bankStatus:bank.status,
  bankHash:membershipAgreementFingerprint({fingerprint:bank.fingerprint,country:"US",currency:"usd"}),manualPayouts:true,payoutsEnabled:true,automaticRulesAbsent:true};
}

export function assertTeamSurplusJournal(source:TeamSurplusMoneySource,nowSeconds:number){
 validateTeamSurplusRequest({context:source.context},source);const op=source.operation;
 check(op&&integer(nowSeconds)&&op.id===source.operation_id&&op.scopeId===source.scope.scopeId&&op.scopeKey===source.scope.scopeKey&&op.kind==="withdrawal"&&
  op.saleId===null&&op.creatorId===null&&op.actorId===null&&op.workerRunId===source.original_worker_run_id&&isDeepStrictEqual(op.context,source.context)&&isDeepStrictEqual(op.request,source.request)&&
  op.idempotency_key===`cn-team-v1:${source.operation_id}`&&["dispatching","unknown","bound"].includes(op.status)&&
  Number.isFinite(Date.parse(source.created_at))&&Number.isFinite(Date.parse(op.first_dispatch_at))&&Date.parse(op.first_dispatch_at)>=Date.parse(source.created_at)-5000&&Date.parse(op.first_dispatch_at)<=nowSeconds*1000+5000&&
  (op.provider_id===null||/^po_[A-Za-z0-9]+$/.test(op.provider_id))&&(op.status!=="bound"||op.provider_id!==null));
}

/** Original payout inspection uses frozen authority. Mutable bank eligibility,
 * current new-money controls and SDK success cannot supply bank receipt proof. */
export function inspectTeamSurplusPayout(source:TeamSurplusMoneySource,payout:Stripe.Payout,expectedId:string,nowSeconds:number){
 assertTeamSurplusJournal(source,nowSeconds);
 check(/^po_[A-Za-z0-9]+$/.test(expectedId)&&payout.object==="payout"&&payout.id===expectedId&&(!source.operation.provider_id||source.operation.provider_id===expectedId)&&
  payout.livemode===(source.context.mode==="live")&&payout.amount===Number(source.amount_cents)&&payout.currency==="usd"&&payout.source_type==="card"&&payout.method==="standard"&&payout.type==="bank_account"&&payout.automatic===false&&
  objectId(payout.destination)===source.destination_id&&isDeepStrictEqual(payout.metadata,source.request.params.metadata)&&empty(payout.original_payout)&&empty(payout.reversed_by)&&empty(payout.application_fee)&&empty(payout.application_fee_amount)&&
  ["pending","in_transit","paid","failed","canceled"].includes(payout.status)&&integer(payout.created)&&payout.created>=Math.floor(Date.parse(source.operation.first_dispatch_at)/1000)-5&&payout.created<=nowSeconds+5&&
  integer(payout.arrival_date)&&payout.arrival_date>0&&/^txn_[A-Za-z0-9]+$/.test(objectId(payout.balance_transaction))&&
  (empty(payout.failure_balance_transaction)||["failed","canceled"].includes(payout.status)&&/^txn_[A-Za-z0-9]+$/.test(objectId(payout.failure_balance_transaction)))&&
  (empty(payout.failure_code)||typeof payout.failure_code==="string"&&/^[a-z_]{1,100}$/.test(payout.failure_code))&&/^req_[A-Za-z0-9]+$/.test(requestId(payout)));
 const trace=payout.trace_id?.status==="supported"?payout.trace_id.value:null;
 return {id:payout.id,status:payout.status,created:payout.created,arrivalDate:payout.arrival_date,amountCents:payout.amount,currency:"usd" as const,destinationId:source.destination_id,
  automatic:false as const,method:"standard" as const,sourceType:"card" as const,livemode:payout.livemode,metadata:payout.metadata,
  debitBalanceId:objectId(payout.balance_transaction),returnBalanceId:objectId(payout.failure_balance_transaction)||null,failureCode:payout.failure_code??null,
  traceReferenceHash:typeof trace==="string"&&trace.length>0&&trace.length<=256?membershipAgreementFingerprint({trace}):null,providerRequestId:requestId(payout)};
}

export function inspectTeamSurplusBalance(source:TeamSurplusMoneySource,payout:ReturnType<typeof inspectTeamSurplusPayout>,balance:Stripe.BalanceTransaction,kind:TeamSurplusBalance["kind"],nowSeconds:number):TeamSurplusBalance{
 const expectedId=kind==="debit"?payout.debitBalanceId:payout.returnBalanceId;
 check(expectedId&&balance.object==="balance_transaction"&&balance.id===expectedId&&objectId(balance.source)===payout.id&&balance.currency==="usd"&&balance.balance_type==="payments"&&balance.exchange_rate===null&&
  balance.amount===(kind==="debit"?-Number(source.amount_cents):Number(source.amount_cents))&&integer(balance.fee)&&(kind!=="debit"||balance.fee>=0)&&integer(balance.net)&&balance.net===balance.amount-balance.fee&&
  (kind==="debit"?balance.type==="payout"&&balance.reporting_category==="payout":balance.type===(payout.status==="failed"?"payout_failure":payout.status==="canceled"?"payout_cancel":"invalid")&&balance.reporting_category==="payout_reversal")&&
  integer(balance.created)&&balance.created>=payout.created-5&&balance.created<=nowSeconds+5&&integer(balance.available_on)&&balance.available_on>0&&
  ["pending","available"].includes(balance.status)&&Array.isArray(balance.fee_details)&&/^req_[A-Za-z0-9]+$/.test(requestId(balance)));
 let total=0;const feeDetails=balance.fee_details.map(detail=>{
  check(integer(detail.amount)&&detail.currency==="usd"&&detail.application===null&&["stripe_fee","tax","payment_method_passthrough_fee"].includes(detail.type));total+=detail.amount;check(integer(total));
  return {amount:detail.amount,currency:"usd" as const,application:null,type:detail.type};
 });check(total===balance.fee);
 return {id:balance.id,sourceId:payout.id,kind,amountCents:balance.amount,feeCents:balance.fee,netCents:balance.net,currency:"usd",balanceType:"payments",type:balance.type,reportingCategory:balance.reporting_category,exchangeRate:null,created:balance.created,availableOn:balance.available_on,
  status:balance.status as "pending"|"available",providerRequestId:requestId(balance),feeDetails};
}

export function reconcileTeamSurplusPayout(source:TeamSurplusMoneySource,payout:ReturnType<typeof inspectTeamSurplusPayout>,debit:TeamSurplusBalance,returned:TeamSurplusBalance|null,nowSeconds:number){
 check(debit.kind==="debit"&&debit.id===payout.debitBalanceId&&debit.sourceId===payout.id&&debit.amountCents===-Number(source.amount_cents)&&
  (returned===null?payout.returnBalanceId===null:returned.kind==="return"&&returned.id===payout.returnBalanceId&&returned.id!==debit.id&&returned.sourceId===payout.id&&returned.amountCents===Number(source.amount_cents)));
 const fees=debit.feeCents+(returned?.feeCents??0);check(integer(fees));
 const returnRequired=["failed","canceled"].includes(payout.status),complete=debit.status==="available"&&debit.availableOn<=nowSeconds&&(!returnRequired||returned?.status==="available"&&returned.availableOn<=nowSeconds)&&fees>=0;
 return {payout,debit,returned,costCents:fees,complete,costReserveExceeded:fees>Number(source.cost_reserve_cents),costCreditNeedsReview:fees<0,
  disposition:complete?(returnRequired?"returned":"debit_observed"):null,bankConfirmed:false as const};
}
