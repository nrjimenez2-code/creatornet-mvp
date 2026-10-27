import "server-only";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import {membershipAgreementFingerprint} from "@/lib/membershipAgreement";
import {assertMembershipUsBilling} from "@/lib/membershipBillingEligibility";
import type {ExactPaymentContext,ExactPaymentContextEvidence} from "@/lib/installments/paymentContext";
import {assertTeamPaymentContract,type TeamPaymentContract,type TeamTokenProof} from "./paymentProtocol";
import {TEAM_STRIPE_API_VERSION,type TeamProviderRequest} from "./providerOperation";
import {teamId,TeamSalesError} from "./policy";
export type TeamSavedAuthority={consentId:string;saleId:string;buyerId:string;context:ExactPaymentContext;termsFingerprint:string;customerId:string;paymentMethodId:string;cardHash:string;
 tokenId:string;tokenProof:TeamTokenProof;receiptId:string;confirmationOperationId:string;automaticAuthorized:boolean};
const check:(v:unknown)=>asserts v=v=>{if(!v)throw new TeamSalesError("TEAM_AUTOMATIC_COLLECTION_REVIEW_REQUIRED","The original accepted automatic payment needs review. No replacement payment was requested.");};
const id=(value:unknown)=>typeof value==="string"?value:(value as {id?:string}|null)?.id??"";
export function assertTeamSavedAuthority(c:TeamPaymentContract,a:TeamSavedAuthority){
 for(const value of [a.consentId,a.saleId,a.buyerId,a.receiptId,a.confirmationOperationId])teamId(value);
 check(c.kind==="payment"&&c.terms.paymentKind!=="full"&&a.automaticAuthorized===true&&a.saleId===c.saleId&&a.buyerId===c.terms.buyerId&&a.termsFingerprint===c.fingerprint&&isDeepStrictEqual(a.context,c.context)&&a.customerId===c.customerId&&
  /^pm_[A-Za-z0-9]+$/.test(a.paymentMethodId)&&/^[a-f0-9]{64}$/.test(a.cardHash)&&a.tokenId===a.tokenProof.tokenId&&/^ctoken_[A-Za-z0-9]+$/.test(a.tokenId)&&a.tokenProof.country==="US"&&/^[a-f0-9]{64}$/.test(a.tokenProof.previewHash));
}
export function inspectTeamReusableMethod(c:TeamPaymentContract,a:TeamSavedAuthority,evidence:ExactPaymentContextEvidence,method:Stripe.PaymentMethod,now:number){
 assertTeamPaymentContract(c,evidence);assertTeamSavedAuthority(c,a);
 check(Number.isSafeInteger(now)&&method.object==="payment_method"&&method.id===a.paymentMethodId&&id(method.customer)===a.customerId&&method.livemode===(c.context.mode==="live")&&method.type==="card"&&method.card?.country==="US"&&typeof method.card.fingerprint==="string"&&method.card.fingerprint.length>0);
 assertMembershipUsBilling(method);const date=new Date(now*1000);check(method.card.exp_year>date.getUTCFullYear()||method.card.exp_year===date.getUTCFullYear()&&method.card.exp_month>=date.getUTCMonth()+1);
 const cardHash=membershipAgreementFingerprint({fingerprint:method.card.fingerprint,expMonth:method.card.exp_month,expYear:method.card.exp_year,country:"US"});check(cardHash===a.cardHash);
 return {consentId:a.consentId,customerId:a.customerId,paymentMethodId:a.paymentMethodId,cardHash,country:"US" as const};
}
export function isTeamSavedAuthenticationRequired(pi:Stripe.PaymentIntent,a:TeamSavedAuthority){
 return pi.status==="requires_payment_method"&&(pi.last_payment_error?.code==="authentication_required"||pi.last_payment_error?.decline_code==="authentication_required")&&(id(pi.payment_method)||id(pi.last_payment_error?.payment_method))===a.paymentMethodId;
}
export function teamSavedConfirmationRequest(c:TeamPaymentContract,a:TeamSavedAuthority,intentId:string,onSession:boolean,authenticate=false):TeamProviderRequest{
 assertTeamSavedAuthority(c,a);check(/^pi_[A-Za-z0-9]+$/.test(intentId));return {method:"POST",apiVersion:TEAM_STRIPE_API_VERSION,path:`/v1/payment_intents/${intentId}/confirm`,params:onSession?
  {...(authenticate?{payment_method:a.paymentMethodId}:{}),use_stripe_sdk:true,return_url:new URL(`/purchase/team/${c.saleId}`,c.context.siteOrigin).toString()}:{payment_method:a.paymentMethodId,off_session:true}};
}
