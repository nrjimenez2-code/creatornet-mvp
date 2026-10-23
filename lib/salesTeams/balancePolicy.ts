import "server-only";
import type Stripe from "stripe";
import type {observeTeamFinancialState} from "./financialObservation";
import {reasonMatchesResponsibility} from "@/lib/refundAllocation";

type Input=Parameters<typeof observeTeamFinancialState>[0];
export type TeamFinancialBalance={id:string;ownerId:string;kind:"refund"|"refund_failure"|"dispute"|"dispute_reversal";sourceId:string;
 amountCents:number;feeCents:number;netCents:number;currency:"usd";created:number;availableOn:number;status:"pending"|"available";
 providerRequestId:string;feeDetails:{amount:number;currency:string;application:null;type:string}[]};
export type TeamBalanceOwners={refunds:{id:string;status:string;amountCents:number;balanceId:string|null;failureBalanceId:string|null}[];
 disputes:{id:string;status:string;amountCents:number;balanceIds:string[]}[]};
const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Original financial balance evidence requires review");};
const id=(v:unknown)=>typeof v==="string"?v:(v as {id?:string}|null)?.id??"";
/** A retrieved transaction is admitted only through a current refund/dispute
 * reference bound to the owned original charge. Raw descriptions and evidence
 * documents are intentionally absent from the stored accounting proof. */
export function inspectTeamFinancialBalance(v:Stripe.BalanceTransaction,args:{expectedId:string;ownerId:string;chargeId:string;kind:TeamFinancialBalance["kind"];paidAt:number;now:number}):TeamFinancialBalance{
 const {kind}=args,refund=kind==="refund"||kind==="refund_failure",category=kind==="refund_failure"?"refund_failure":kind;
 const request=(v as Stripe.Response<Stripe.BalanceTransaction>).lastResponse?.requestId??"";
 check(v.object==="balance_transaction"&&v.id===args.expectedId&&/^txn_[A-Za-z0-9]+$/.test(v.id)&&/^req_[A-Za-z0-9]+$/.test(request)&&
  id(v.source)===args.ownerId&&v.currency==="usd"&&v.exchange_rate===null&&
  (refund?["refund","refund_failure","adjustment"].includes(v.type):v.type==="adjustment")&&v.reporting_category===category&&
  Number.isSafeInteger(v.amount)&&v.amount!==0&&Math.abs(v.amount)<=99999999&&
  (["refund","dispute"].includes(kind)?v.amount<0:v.amount>0)&&Number.isSafeInteger(v.fee)&&Math.abs(v.fee)<=99999999&&v.net===v.amount-v.fee&&
  Number.isSafeInteger(v.created)&&v.created>=args.paidAt-5&&v.created<=args.now+5&&Number.isSafeInteger(v.available_on)&&v.available_on>0&&
  ["pending","available"].includes(v.status)&&Array.isArray(v.fee_details));
 let total=0;const feeDetails=v.fee_details.map(f=>{check(Number.isSafeInteger(f.amount)&&Math.abs(f.amount)<=99999999&&f.currency==="usd"&&f.application===null&&
  typeof f.type==="string"&&["stripe_fee","tax","payment_method_passthrough_fee"].includes(f.type));total+=f.amount;return {amount:f.amount,currency:f.currency,application:null,type:f.type};});
 check(total===v.fee);
 return {id:v.id,ownerId:args.ownerId,kind,sourceId:id(v.source),amountCents:v.amount,feeCents:v.fee,netCents:v.net,currency:"usd",created:v.created,
  availableOn:v.available_on,status:v.status as "pending"|"available",providerRequestId:request,feeDetails};
}
/** Sum independently linked principal movements once, rather than adding an
 * event's refund/dispute amount twice. Unknown/overlapping traces remain held.
 * A refund decision covers its own fees plus the original processing share. */
export function reconcileTeamFinancialBalances(args:{subtotalCents:number;originalCostCents:number|null;owners:TeamBalanceOwners;entries:TeamFinancialBalance[];
 refundListComplete:boolean;disputeListComplete:boolean;decisions:Input["decisions"];basePlatformCreditCents:number}){
 check(Number.isSafeInteger(args.subtotalCents)&&args.subtotalCents>=50&&Number.isSafeInteger(args.basePlatformCreditCents)&&args.basePlatformCreditCents>=0&&
  (args.originalCostCents===null||Number.isSafeInteger(args.originalCostCents)&&args.originalCostCents>=0));
 const seen=new Set<string>(),ownerIds=new Set<string>(),decisionIds=new Set<string>(),alerts:string[]=[];let feeCents=0,principal=0,refundFeesForPlatform=0;
 check(args.owners.refunds.length<=300&&args.owners.disputes.length<=300&&args.entries.length<=32);
 for(const d of args.decisions){check(!decisionIds.has(d.refundId)&&reasonMatchesResponsibility(d.reasonCode,d.responsibility)&&args.owners.refunds.some(r=>r.id===d.refundId));decisionIds.add(d.refundId);}
 const refs=new Map<string,{ownerId:string;kind:TeamFinancialBalance["kind"]}>();
 const admit=(key:string|null,ownerId:string,kind:TeamFinancialBalance["kind"])=>{if(!key)return;check(/^txn_[A-Za-z0-9]+$/.test(key)&&!refs.has(key));refs.set(key,{ownerId,kind});};
 for(const r of args.owners.refunds){check(/^re_[A-Za-z0-9]+$/.test(r.id)&&!ownerIds.has(r.id)&&Number.isSafeInteger(r.amountCents)&&r.amountCents>0&&r.amountCents<=args.subtotalCents&&["succeeded","pending","requires_action","failed","canceled"].includes(r.status));ownerIds.add(r.id);admit(r.balanceId,r.id,"refund");admit(r.failureBalanceId,r.id,"refund_failure");
  if(r.status==="succeeded"&&(!r.balanceId||r.failureBalanceId))alerts.push("REFUND_BALANCE_TRACE_INCOMPLETE");
  if(r.status==="succeeded"&&!decisionIds.has(r.id))alerts.push("REFUND_RESPONSIBILITY_UNREVIEWED");
  if(["pending","requires_action"].includes(r.status))alerts.push("REFUND_PENDING");
  if(["failed","canceled"].includes(r.status)&&Boolean(r.balanceId)!==Boolean(r.failureBalanceId))alerts.push("REFUND_FAILURE_BALANCE_TRACE_INCOMPLETE");}
 for(const d of args.owners.disputes){check(/^du_[A-Za-z0-9]+$/.test(d.id)&&!ownerIds.has(d.id)&&Number.isSafeInteger(d.amountCents)&&d.amountCents>0&&d.amountCents<=args.subtotalCents&&["warning_needs_response","warning_under_review","warning_closed","needs_response","under_review","won","lost","prevented"].includes(d.status)&&d.balanceIds.length<=2);ownerIds.add(d.id);for(const key of d.balanceIds){const entry=args.entries.find(v=>v.id===key);admit(key,d.id,entry?.kind==="dispute_reversal"?"dispute_reversal":"dispute");}
  if(["needs_response","under_review","lost","won"].includes(d.status)&&!d.balanceIds.length)alerts.push("DISPUTE_BALANCE_TRACE_INCOMPLETE");}
 for(const e of args.entries){const reference=refs.get(e.id);check(reference&&reference.ownerId===e.ownerId&&reference.kind===e.kind&&!seen.has(e.id)&&e.sourceId===e.ownerId&&e.currency==="usd"&&Number.isSafeInteger(e.amountCents)&&Math.abs(e.amountCents)>0&&Math.abs(e.amountCents)<=99999999&&Number.isSafeInteger(e.feeCents)&&Math.abs(e.feeCents)<=99999999&&e.netCents===e.amountCents-e.feeCents&&(["refund","dispute"].includes(e.kind)?e.amountCents<0:e.amountCents>0));seen.add(e.id);feeCents+=e.feeCents;principal-=e.amountCents;
  const decision=args.decisions.find(d=>d.refundId===e.ownerId);if(decision?.responsibility==="platform")refundFeesForPlatform+=e.feeCents;}
 if(seen.size!==refs.size)alerts.push("FINANCIAL_BALANCE_READ_INCOMPLETE");
 for(const r of args.owners.refunds){const own=args.entries.filter(e=>e.ownerId===r.id),net=own.reduce((s,e)=>s+e.amountCents,0);
  if(r.status==="succeeded"&&net!==-r.amountCents||["failed","canceled"].includes(r.status)&&net!==0)alerts.push("REFUND_PRINCIPAL_TRACE_UNRECONCILED");}
 for(const d of args.owners.disputes){const own=args.entries.filter(e=>e.ownerId===d.id),net=own.reduce((s,e)=>s+e.amountCents,0);
  if(d.status==="lost"&&net!==-d.amountCents||["won","prevented","warning_closed"].includes(d.status)&&net!==0)alerts.push("DISPUTE_PRINCIPAL_TRACE_UNRECONCILED");}
 if(!args.refundListComplete||!args.disputeListComplete)alerts.push("FINANCIAL_LIST_INCOMPLETE");
 if(refs.size>32)alerts.push("FINANCIAL_BALANCE_REFERENCE_LIMIT");
 if(principal<0||principal>args.subtotalCents)alerts.push("COMBINED_PRINCIPAL_TRACE_UNRECONCILED");
 const totalCredit=args.basePlatformCreditCents+refundFeesForPlatform,totalCost=args.originalCostCents===null?null:args.originalCostCents+feeCents;
 if(totalCost===null||totalCost<0||totalCredit<0||totalCredit>totalCost)alerts.push("FINANCIAL_COST_ALLOCATION_UNRECONCILED");
 const originalCredit=Math.max(0,Math.min(args.basePlatformCreditCents,totalCredit)),adjustmentCredit=Math.max(0,totalCredit-originalCredit);
 return {complete:alerts.length===0,principalLossCents:Math.max(0,Math.min(args.subtotalCents,principal)),feeAdjustmentCents:feeCents,
  originalProcessingCreditCents:originalCredit,financialProcessingCreditCents:adjustmentCredit,alerts:[...new Set(alerts)]};
}
