import "server-only";
import { isDeepStrictEqual } from "node:util";
import type Stripe from "stripe";
import { validateExactPaymentContext,type ExactPaymentContext,type ExactPaymentContextEvidence } from "@/lib/installments/paymentContext";
import { membershipAgreementFingerprint } from "@/lib/membershipAgreement";
import { assertMembershipUsBilling } from "@/lib/membershipBillingEligibility";
import { TEAM_SALES_PROTOCOL,teamId } from "./policy";
import { TEAM_STRIPE_API_VERSION,type TeamProviderRequest } from "./providerOperation";
import type { TeamSaleTerms } from "./agreement";

export type TeamPaymentContract={protocol:typeof TEAM_SALES_PROTOCOL;saleId:string;obligationId:string;operationId:string;
 terms:TeamSaleTerms;fingerprint:string;context:ExactPaymentContext;customerId:string;periodNumber:number;
 amountCents:number;acceptedAt:number;expiresAt:number;kind:"payment"|"monthly_payoff"};
const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Team payment needs reconciliation");};
const sid=(value:unknown,prefix:string)=>check(typeof value==="string"&&new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value));
const id=(value:string|{id:string}|null|undefined)=>typeof value==="string"?value:value?.id??null;
export function assertTeamPaymentContract(c:TeamPaymentContract,evidence:ExactPaymentContextEvidence){
 validateExactPaymentContext(c.context,evidence);
 for(const value of [c.saleId,c.obligationId,c.operationId,c.terms.buyerId,c.terms.creatorId,c.terms.productId])teamId(value);
 check(c.protocol===TEAM_SALES_PROTOCOL&&c.terms.protocol===c.protocol&&c.terms.saleId===c.saleId&&
  membershipAgreementFingerprint(c.terms)===c.fingerprint&&c.terms.currency==="usd"&&c.terms.distribution.chargeType==="separate_charges_and_transfers"&&
  c.terms.distribution.platformFeeBps===1200&&Number.isSafeInteger(c.periodNumber)&&c.periodNumber>=1&&
  Number.isSafeInteger(c.amountCents)&&c.amountCents>=50&&c.amountCents<=99999999&&
  Number.isSafeInteger(c.acceptedAt)&&c.acceptedAt>0&&Number.isSafeInteger(c.expiresAt)&&c.expiresAt>c.acceptedAt);
 sid(c.customerId,"cus");
 if(c.kind==="monthly_payoff")check(c.terms.paymentKind==="monthly"&&c.terms.initialCommitmentMonths&&c.periodNumber<=c.terms.initialCommitmentMonths&&
  c.amountCents===c.terms.amountCents*(c.terms.initialCommitmentMonths-c.periodNumber+1));
 else if(c.terms.paymentKind==="monthly")check(c.amountCents===c.terms.amountCents&&
  (c.terms.monthlyTerms?.autoRenew||c.periodNumber<=(c.terms.initialCommitmentMonths??1)));
 else check(c.terms.payments.find(p=>p.number===c.periodNumber)?.amountCents===c.amountCents);
 return c;
}
export function teamPaymentMetadata(c:TeamPaymentContract){
 return {team_protocol:c.protocol,team_sale_id:c.saleId,team_obligation_id:c.obligationId,team_operation_id:c.operationId,
  team_terms_fingerprint:c.fingerprint,buyer_id:c.terms.buyerId,creator_id:c.terms.creatorId,product_id:c.terms.productId,
  post_id:c.terms.postId,period_number:String(c.periodNumber),payment_kind:c.kind};
}
export function teamIntentRequest(c:TeamPaymentContract,evidence:ExactPaymentContextEvidence):TeamProviderRequest{
 assertTeamPaymentContract(c,evidence);
 return {method:"POST",apiVersion:TEAM_STRIPE_API_VERSION,path:"/v1/payment_intents",params:{amount:c.amountCents,currency:"usd",customer:c.customerId,
  confirm:false,confirmation_method:"manual",capture_method:"automatic_async",allowed_payment_method_types:["card"],
  ...(c.terms.paymentKind!=="full"&&c.kind!=="monthly_payoff"?{setup_future_usage:"off_session"}:{}),
  transfer_group:`cn_team_${c.saleId}`,metadata:teamPaymentMetadata(c)}};
}
/** A separate charge must retain its gross funds on the platform. Legacy
 * destination/application-fee validators remain unchanged for other protocols. */
export function inspectTeamPaymentIntent(c:TeamPaymentContract,evidence:ExactPaymentContextEvidence,pi:Stripe.PaymentIntent,intentId:string){
 assertTeamPaymentContract(c,evidence);sid(intentId,"pi");const expected=teamIntentRequest(c,evidence).params;
 check(pi.object==="payment_intent"&&pi.id===intentId&&pi.livemode===(c.context.mode==="live")&&id(pi.customer)===c.customerId&&
  pi.amount===c.amountCents&&pi.currency==="usd"&&pi.confirmation_method==="manual"&&pi.capture_method==="automatic_async"&&
  pi.application_fee_amount===null&&pi.transfer_data===null&&pi.on_behalf_of===null&&pi.shipping===null&&
  pi.transfer_group===expected.transfer_group&&pi.setup_future_usage===(expected.setup_future_usage??null)&&
  isDeepStrictEqual(pi.payment_method_types,["card"])&&pi.automatic_payment_methods?.enabled!==true&&isDeepStrictEqual(pi.metadata,expected.metadata)&&
  Number.isSafeInteger(pi.created)&&pi.created>=c.acceptedAt-5&&pi.created<c.expiresAt&&pi.amount_capturable===0&&
  Number.isSafeInteger(pi.amount_received)&&(pi.status==="succeeded"?pi.amount_received===c.amountCents:pi.amount_received===0));
 return pi;
}
export type TeamTokenProof={tokenId:string;createdAt:number;expiresAt:number;previewHash:string;country:"US"};
export function inspectTeamConfirmationToken(c:TeamPaymentContract,evidence:ExactPaymentContextEvidence,token:Stripe.ConfirmationToken,tokenId:string,now:number,usedByIntent?:string){
 assertTeamPaymentContract(c,evidence);sid(tokenId,"ctoken");if(usedByIntent)sid(usedByIntent,"pi");
 check(Number.isSafeInteger(now)&&now>=c.acceptedAt&&token.object==="confirmation_token"&&token.id===tokenId&&token.livemode===(c.context.mode==="live")&&
  token.payment_intent===(usedByIntent??null)&&token.setup_intent===null&&token.shipping===null&&token.use_stripe_sdk===true&&
  token.setup_future_usage===(c.terms.paymentKind!=="full"&&c.kind!=="monthly_payoff"?"off_session":null)&&
  Number.isSafeInteger(token.created)&&token.created>=c.acceptedAt&&token.created<=now&&
  (usedByIntent||Number.isSafeInteger(token.expires_at)&&token.expires_at!>now+30&&now<c.expiresAt)&&
  (token.return_url===null||token.return_url===new URL(`/purchase/team/${c.saleId}`,c.context.siteOrigin).toString())&&
  token.payment_method_options==null&&token.mandate_data==null);
 const preview=token.payment_method_preview;
 check(preview?.type==="card"&&preview.card?.country==="US"&&(id(preview.customer)===null||id(preview.customer)===c.customerId));
 assertMembershipUsBilling(preview);
 const month=new Date((usedByIntent?token.created:now)*1000);
 check(Number.isInteger(preview.card.exp_month)&&preview.card.exp_month>=1&&preview.card.exp_month<=12&&Number.isInteger(preview.card.exp_year)&&
  (preview.card.exp_year>month.getUTCFullYear()||preview.card.exp_year===month.getUTCFullYear()&&preview.card.exp_month>=month.getUTCMonth()+1));
 return {tokenId:token.id,createdAt:token.created,expiresAt:token.expires_at??token.created,previewHash:membershipAgreementFingerprint(preview),country:"US" as const};
}
export function teamConfirmationRequest(c:TeamPaymentContract,evidence:ExactPaymentContextEvidence,intentId:string,proof:TeamTokenProof,now:number):TeamProviderRequest{
 assertTeamPaymentContract(c,evidence);sid(intentId,"pi");sid(proof.tokenId,"ctoken");
 check(proof.country==="US"&&proof.createdAt>=c.acceptedAt&&proof.createdAt<=now&&proof.expiresAt>now+30&&now<c.expiresAt);
 return {method:"POST",apiVersion:TEAM_STRIPE_API_VERSION,path:`/v1/payment_intents/${intentId}/confirm`,params:{confirmation_token:proof.tokenId,
  use_stripe_sdk:true,return_url:new URL(`/purchase/team/${c.saleId}`,c.context.siteOrigin).toString()}};
}
/** Captured receipts deliberately do not reread mutable card billing or current
 * membership eligibility. Captured money must remain accountable after either changes. */
export function inspectTeamSuccessfulCharge(c:TeamPaymentContract,evidence:ExactPaymentContextEvidence,pi:Stripe.PaymentIntent,charge:Stripe.Charge,intentId:string){
 inspectTeamPaymentIntent(c,evidence,pi,intentId);sid(charge.id,"ch");
 check(pi.status==="succeeded"&&id(pi.latest_charge)===charge.id&&charge.object==="charge"&&charge.livemode===(c.context.mode==="live")&&
  charge.paid&&charge.captured&&charge.status==="succeeded"&&id(charge.payment_intent)===pi.id&&id(charge.customer)===c.customerId&&
  charge.amount===c.amountCents&&charge.amount_captured===c.amountCents&&charge.currency==="usd"&&charge.application_fee===null&&
  charge.application_fee_amount===null&&charge.transfer_data===null&&charge.transfer===null&&charge.on_behalf_of===null&&
  isDeepStrictEqual(charge.metadata,teamPaymentMetadata(c))&&Number.isSafeInteger(charge.created)&&charge.created>=pi.created&&
  Number.isSafeInteger(charge.amount_refunded)&&charge.amount_refunded>=0&&charge.amount_refunded<=charge.amount);
 return {paymentIntentId:pi.id,chargeId:charge.id,subtotalCents:c.amountCents,taxCents:0,paidAt:charge.created,
  balanceTransactionId:id(charge.balance_transaction),refundedCents:charge.amount_refunded,disputed:charge.disputed};
}
