import "server-only";
import type Stripe from "stripe";
import {isDeepStrictEqual} from "node:util";
import {assertMembershipUsBilling} from "@/lib/membershipBillingEligibility";
import {membershipAgreementFingerprint} from "@/lib/membershipAgreement";
import type {ExactPaymentContextEvidence} from "@/lib/installments/paymentContext";
import {teamId} from "@/lib/salesTeams/policy";
import {TEAM_STRIPE_API_VERSION,type TeamProviderRequest} from "@/lib/salesTeams/providerOperation";
import {inspectTeamSuccessfulCharge,type TeamPaymentContract,type TeamTokenProof} from "@/lib/salesTeams/paymentProtocol";
const check:(v:unknown)=>asserts v=v=>{if(!v)throw Error("Original team capture needs reconciliation");};
const id=(v:string|{id:string}|null|undefined)=>typeof v==="string"?v:v?.id??null;
export type TeamCaptureConfirmation={operationId:string;paymentIntentId:string;firstDispatchAt:number;lastDispatchAt:number;request:TeamProviderRequest;tokenProof:TeamTokenProof};
/** The caller must load the owned immutable contract and bound original
 * confirmation from service-only storage, then independently retrieve these
 * objects. Event metadata or browser SDK results cannot supply this authority.
 * This inspector cannot create operations, publish access or credit balances. */
export function inspectTeamReceipt(args:{contract:TeamPaymentContract;evidence:ExactPaymentContextEvidence;confirmation:TeamCaptureConfirmation;
 paymentIntent:Stripe.PaymentIntent;charge:Stripe.Charge;balance:Stripe.BalanceTransaction|null;nowSeconds:number;financialInspection?:boolean}){
 const {contract:c,confirmation:op,paymentIntent:pi,charge:ch,balance}=args;
 teamId(op.operationId);check(Number.isSafeInteger(args.nowSeconds)&&args.nowSeconds>=c.acceptedAt&&
  Number.isSafeInteger(op.firstDispatchAt)&&op.firstDispatchAt>=c.acceptedAt&&op.firstDispatchAt<c.expiresAt&&op.firstDispatchAt<=args.nowSeconds&&
  Number.isSafeInteger(op.lastDispatchAt)&&op.lastDispatchAt>=op.firstDispatchAt&&op.lastDispatchAt<c.expiresAt&&op.lastDispatchAt<=args.nowSeconds&&
  op.paymentIntentId===pi.id&&op.request.method==="POST"&&op.request.apiVersion===TEAM_STRIPE_API_VERSION&&
  op.request.path===`/v1/payment_intents/${pi.id}/confirm`&&op.request.params.use_stripe_sdk===true&&
  op.request.params.return_url===new URL(`/purchase/team/${c.saleId}`,c.context.siteOrigin).toString()&&
  /^ctoken_[A-Za-z0-9]+$/.test(op.tokenProof.tokenId)&&op.tokenProof.country==="US"&&/^[a-f0-9]{64}$/.test(op.tokenProof.previewHash)&&
  Number.isSafeInteger(op.tokenProof.createdAt)&&op.tokenProof.createdAt>=c.acceptedAt&&op.tokenProof.createdAt<=op.lastDispatchAt&&
  isDeepStrictEqual(op.request.params,{...(op.request.params.confirmation_token===undefined?{}:{confirmation_token:op.tokenProof.tokenId}),use_stripe_sdk:true,return_url:new URL(`/purchase/team/${c.saleId}`,c.context.siteOrigin).toString()}));
 check(/^req_[A-Za-z0-9]+$/.test((ch as Stripe.Response<Stripe.Charge>).lastResponse?.requestId||""));
 const capture=inspectTeamSuccessfulCharge(c,args.evidence,pi,ch,op.paymentIntentId);
 check(Number.isSafeInteger(ch.created)&&ch.created>=op.firstDispatchAt-5&&ch.created<=args.nowSeconds+5&&
  /^pm_[A-Za-z0-9]+$/.test(id(pi.payment_method)||"")&&id(ch.payment_method)===id(pi.payment_method)&&
  ch.payment_method_details?.type==="card"&&ch.payment_method_details.card?.country==="US"&&
  typeof ch.disputed==="boolean"&&typeof ch.refunded==="boolean"&&ch.refunded===(ch.amount_refunded===ch.amount));
 // Captured billing is immutable charge evidence. Reading mutable current
 // PaymentMethod billing here would incorrectly strand historical receipts.
 assertMembershipUsBilling({type:"card",billing_details:ch.billing_details});
 if(!args.financialInspection)check(ch.amount_refunded===0&&!ch.disputed);
 let processingCostCents:number|null=null,availableOn:number|null=null;
 if(balance){
  check(balance.object==="balance_transaction"&&/^txn_[A-Za-z0-9]+$/.test(balance.id)&&balance.id===capture.balanceTransactionId&&
   id(balance.source)===ch.id&&balance.type==="charge"&&balance.currency==="usd"&&balance.amount===c.amountCents&&
   Number.isSafeInteger(balance.fee)&&balance.fee>=0&&balance.fee<=99999999&&balance.net===balance.amount-balance.fee&&
   Number.isSafeInteger(balance.created)&&balance.created>=ch.created-5&&balance.created<=args.nowSeconds+5&&
   Number.isSafeInteger(balance.available_on)&&balance.available_on>=balance.created&&["pending","available"].includes(balance.status)&&Array.isArray(balance.fee_details));
  let total=0;
  for(const fee of balance.fee_details){check(Number.isSafeInteger(fee.amount)&&fee.amount>=0&&fee.currency==="usd"&&fee.application===null&&fee.type!=="application_fee");total+=fee.amount;check(Number.isSafeInteger(total));}
  check(total===balance.fee);processingCostCents=balance.fee;availableOn=balance.available_on;
 }else check(capture.balanceTransactionId===null||/^txn_[A-Za-z0-9]+$/.test(capture.balanceTransactionId));
 return Object.freeze({protocol:c.protocol,context:c.context,saleId:c.saleId,obligationId:c.obligationId,
  currency:"usd" as const,paid:true as const,captured:true as const,...capture,processingCostCents,availableOn,
  metadataHash:membershipAgreementFingerprint(pi.metadata),providerRequestId:(ch as Stripe.Response<Stripe.Charge>).lastResponse?.requestId});
}
