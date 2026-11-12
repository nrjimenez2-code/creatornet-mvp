import "server-only";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import {membershipAgreementFingerprint} from "@/lib/membershipAgreement";
import {assertMembershipUsBilling} from "@/lib/membershipBillingEligibility";
import type {ExactPaymentContextEvidence} from "@/lib/installments/paymentContext";
import {inspectTeamConfirmationToken,inspectTeamPaymentIntent,type TeamPaymentContract,type TeamTokenProof} from "./paymentProtocol";
import {TEAM_STRIPE_API_VERSION} from "./providerOperation";
import {teamId,TeamSalesError,teamSavedMethodSchemaReady,teamSavedMethodReady} from "./policy";
import {teamRpc} from "./server";
import type {TeamReceiptComposition} from "./receipts";

export type TeamSavedMethodQuote={version:"creatornet-team-saved-method-v1";saleId:string;obligationId:string;fingerprint:string;authorization:string;
 currentPeriod:number;currentAmountCents:number;payments:{number:number;amountCents:number}[];
 automaticAuthorized:boolean;acceptedBilling:string;acceptedPolicy:unknown}&({paymentKind:"installments";monthlyAmountCents:null;minimumMonths:null;autoRenew:false}|{paymentKind:"monthly";monthlyAmountCents:number;minimumMonths:number;autoRenew:boolean});
export type TeamSavedMethodAcceptance={accepted:true;fingerprint:string};
export type TeamSavedMethodSource={consent:{id:string;token_id:string;token_proof:TeamTokenProof};contract:TeamPaymentContract;receiptId:string;paymentIntentId:string;confirmationOperationId:string};
const check:(v:unknown)=>asserts v=v=>{if(!v)throw new TeamSalesError("TEAM_SAVED_METHOD_REVIEW_REQUIRED","The payment is separate from permission to reuse its saved card. Refresh the original payment for review.");};
const id=(value:unknown)=>typeof value==="string"?value:(value as {id?:string}|null)?.id??"";
const requestId=(value:unknown)=>(value as {lastResponse?:{requestId?:string}}|null)?.lastResponse?.requestId??"";
export async function readTeamSavedMethodQuote(c:{admin:SupabaseClient},saleId:string,buyerId:string,obligationId:string|null=null){
 return teamRpc<TeamSavedMethodQuote|null>(c.admin,"read_sales_team_saved_method_quote_v1",{p_sale_id:teamId(saleId),p_buyer_id:teamId(buyerId),p_obligation_id:obligationId?teamId(obligationId):null});
}
export async function savedMethodPaymentResponse(admin:SupabaseClient,saleId:string,buyerId:string,payment:{phase:string;saveForFuture?:boolean;obligationId?:string}){
 if(!teamSavedMethodSchemaReady()||!payment.saveForFuture)return {};
 return {savedMethodConsentRequired:true,savedMethodConsentEnabled:teamSavedMethodReady(),...(!teamSavedMethodReady()?{collectionEnabled:false}:{}),
  ...(payment.phase==="needs_method"?{savedMethodConsent:await readTeamSavedMethodQuote({admin},saleId,buyerId,payment.obligationId??null)}:{})};
}
export async function acceptTeamSavedMethod(c:{admin:SupabaseClient},contract:TeamPaymentContract,request:string,acceptance:TeamSavedMethodAcceptance,proof:TeamTokenProof){
 check(acceptance?.accepted===true&&/^[a-f0-9]{64}$/.test(acceptance.fingerprint));
 return teamRpc(c.admin,"accept_sales_team_saved_method_v1",{p_sale_id:contract.saleId,p_buyer_id:contract.terms.buyerId,p_obligation_id:contract.obligationId,p_request_id:teamId(request),p_context:contract.context,p_fingerprint:acceptance.fingerprint,p_accepted:true,p_token_proof:proof});
}
/** This proof is sale/customer/token-specific. A method attached to some other
 * customer, or an updated card with different checked attributes, is not adopted. */
export function inspectTeamSavedMethod(source:TeamSavedMethodSource,evidence:ExactPaymentContextEvidence,pi:Stripe.PaymentIntent,token:Stripe.ConfirmationToken,method:Stripe.PaymentMethod,now:number){
 const c=source.contract;inspectTeamPaymentIntent(c,evidence,pi,source.paymentIntentId);
 check(c.kind==="payment"&&c.terms.paymentKind!=="full"&&pi.status==="succeeded"&&/^pm_[A-Za-z0-9]+$/.test(id(pi.payment_method)));
 const proof=inspectTeamConfirmationToken(c,evidence,token,source.consent.token_id,now,pi.id),preview=token.payment_method_preview?.card;
 check(proof.previewHash===source.consent.token_proof.previewHash&&proof.createdAt===source.consent.token_proof.createdAt&&
  method.object==="payment_method"&&method.id===id(pi.payment_method)&&method.livemode===pi.livemode&&id(method.customer)===c.customerId&&method.type==="card"&&method.card?.country==="US"&&
  typeof preview?.fingerprint==="string"&&preview.fingerprint.length>0&&method.card.fingerprint===preview.fingerprint&&method.card.exp_month===preview.exp_month&&method.card.exp_year===preview.exp_year);
 assertMembershipUsBilling(method);const date=new Date(now*1000);
 check(method.card.exp_year>date.getUTCFullYear()||method.card.exp_year===date.getUTCFullYear()&&method.card.exp_month>=date.getUTCMonth()+1);
 return {paymentMethodId:method.id,customerId:c.customerId,country:"US" as const,tokenId:token.id,previewHash:proof.previewHash,
  cardHash:membershipAgreementFingerprint({fingerprint:method.card.fingerprint,expMonth:method.card.exp_month,expYear:method.card.exp_year,country:"US"})};
}
/** GET-only proof collection after shared fulfillment. Failure cannot erase a
 * captured receipt. No card is attached, updated, confirmed or charged here. */
export async function recordTeamSavedMethod(c:TeamReceiptComposition,saleId:string,buyerId:string,obligationId:string|null=null){
 const read=()=>teamRpc<TeamSavedMethodSource|null>(c.admin,"read_sales_team_saved_method_source_v1",{p_sale_id:teamId(saleId),p_buyer_id:teamId(buyerId),p_obligation_id:obligationId?teamId(obligationId):null});
 const source=await read();if(!source)return {status:"not_eligible" as const};
 const started=Date.now(),options={apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000};
 check(isDeepStrictEqual(source.contract.context,c.context)&&isDeepStrictEqual(await c.observeContext(),c.context)&&/^pi_[A-Za-z0-9]+$/.test(source.paymentIntentId));
 const get=async<T>(path:string)=>{const value=await c.stripe.rawRequest("GET",path,{},options) as T;check(/^req_[A-Za-z0-9]+$/.test(requestId(value)));return value;};
 const pi=await get<Stripe.PaymentIntent>(`/v1/payment_intents/${source.paymentIntentId}`);check(/^pm_[A-Za-z0-9]+$/.test(id(pi.payment_method))&&/^ctoken_[A-Za-z0-9]+$/.test(source.consent.token_id));
 const [token,method]=await Promise.all([get<Stripe.ConfirmationToken>(`/v1/confirmation_tokens/${source.consent.token_id}`),get<Stripe.PaymentMethod>(`/v1/payment_methods/${id(pi.payment_method)}`)]);
 const proof=inspectTeamSavedMethod(source,await c.observeEvidence(),pi,token,method,Math.floor(Date.now()/1000));
 check(isDeepStrictEqual(await read(),source)&&isDeepStrictEqual(await c.observeContext(),c.context)&&Date.now()>=started&&Date.now()-started<30000);
 await teamRpc(c.admin,"record_sales_team_saved_method_v1",{p_sale_id:saleId,p_buyer_id:buyerId,p_obligation_id:source.contract.obligationId,p_proof:{...proof,context:c.context,consentId:source.consent.id,receiptId:source.receiptId,confirmationOperationId:source.confirmationOperationId,paymentIntentId:pi.id,
  intentRequestId:requestId(pi),tokenRequestId:requestId(token),methodRequestId:requestId(method),readStartedAt:started,observedAt:Math.floor(Date.now()/1000)}});
 return {status:"verified" as const};
}
