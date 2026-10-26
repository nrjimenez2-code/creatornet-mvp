import "server-only";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {ExactPaymentContext,ExactPaymentContextEvidence} from "@/lib/installments/paymentContext";
import {confirmTeamCollection} from "./collection";
import {teamId,TeamSalesError} from "./policy";
import {teamRpc} from "./server";
import {TEAM_STRIPE_API_VERSION,type TeamProviderRequest} from "./providerOperation";
import {teamIntentRequest,type TeamPaymentContract,type TeamTokenProof} from "./paymentProtocol";
import {inspectTeamReceipt,type TeamCaptureConfirmation} from "./receiptPolicy";
export type TeamReceiptComposition={admin:SupabaseClient;stripe:Pick<Stripe,"rawRequest">;context:ExactPaymentContext;observeContext:()=>Promise<ExactPaymentContext>;observeEvidence:()=>Promise<ExactPaymentContextEvidence>};
type Operation={id:string;kind:string;status:string;provider_id:string|null;request:TeamProviderRequest;context:ExactPaymentContext;sale_id:string;creator_id:string;actor_id:string;first_dispatch_at:string};
export type TeamCaptureSource={contract:TeamPaymentContract;intent:Operation;firstConfirmationDispatchAt:string;
 confirmation:{operation_id:string;request_id:string;kind:"token"|"reconfirm";token_id:string;token_proof:TeamTokenProof;request:TeamProviderRequest;operation:Operation|null}|null;
 receipt:{id:string;observation_revision:number;payment_intent_id:string;charge_id:string;refunded_subtotal_cents:number;processing_cost_cents:number|null;balance_transaction_id:string|null;available_on:string|null}|null};
const check:(v:unknown)=>asserts v=v=>{if(!v)throw new TeamSalesError("TEAM_CAPTURE_REVIEW_REQUIRED","The original captured payment needs receipt reconciliation.");};
const id=(v:unknown)=>typeof v==="string"?v:(v as {id?:string}|null)?.id??"";
const req=(v:unknown)=>(v as {lastResponse?:{requestId?:string}}|null)?.lastResponse?.requestId??"";
const options={apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000};
/** Provider transport is GET-only here. This can recover existing confirmation
 * evidence and record captured money, but cannot issue a charge or replacement. */
export async function readTeamCapture(c:TeamReceiptComposition,saleId:string,buyerId:string,obligationId:string|null=null){
 teamId(saleId);teamId(buyerId);if(obligationId)teamId(obligationId);
 const read=()=>teamRpc<TeamCaptureSource|null>(c.admin,"read_sales_team_capture_source_v1",{p_sale_id:saleId,p_buyer_id:buyerId,p_obligation_id:obligationId});
 let source=await read();if(!source)return null;
 const context=async()=>{const before=Date.now();check(isDeepStrictEqual(c.context,source!.contract.context)&&isDeepStrictEqual(await c.observeContext(),c.context)&&Date.now()>=before&&Date.now()-before<30000);};
 await context();const started=Date.now();
 const get=async<T>(path:string)=>{const value=await c.stripe.rawRequest("GET",path,{},options) as T;check(/^req_[A-Za-z0-9]+$/.test(req(value)));return value;};
 check(source.contract.saleId===saleId&&source.contract.terms.buyerId===buyerId&&source.intent?.status==="bound"&&source.intent.kind==="intent"&&
  source.intent.id===source.contract.operationId&&source.intent.sale_id===saleId&&source.intent.actor_id===buyerId&&source.intent.creator_id===source.contract.terms.creatorId&&
  isDeepStrictEqual(source.intent.context,c.context)&&isDeepStrictEqual(source.intent.request,teamIntentRequest(source.contract,await c.observeEvidence()))&&/^pi_[A-Za-z0-9]+$/.test(source.intent.provider_id??""));
 let pi=await get<Stripe.PaymentIntent>(`/v1/payment_intents/${source.intent.provider_id}`);
 if(pi.status!=="succeeded")return null;
 check(source.confirmation);
 if(source.confirmation.operation?.status!=="bound"){
  await confirmTeamCollection(c,saleId,buyerId,{requestId:source.confirmation.request_id,kind:source.confirmation.kind,tokenId:source.confirmation.token_id,recoveryOnly:true,...(source.contract.periodNumber>1?{obligationId:source.contract.obligationId}:{})});
  source=await read();check(source?.confirmation);
 }
 const saved=source,confirmation=saved.confirmation!,operation=confirmation.operation;
 check(operation&&operation.id===confirmation.operation_id&&operation.kind==="confirmation"&&operation.status==="bound"&&operation.provider_id===pi.id&&
  operation.sale_id===saleId&&operation.actor_id===buyerId&&operation.creator_id===saved.contract.terms.creatorId&&isDeepStrictEqual(operation.context,c.context)&&
  isDeepStrictEqual(operation.request,confirmation.request));
 const binding:TeamCaptureConfirmation={operationId:operation.id,paymentIntentId:pi.id,firstDispatchAt:Math.floor(Date.parse(saved.firstConfirmationDispatchAt)/1000),
  lastDispatchAt:Math.floor(Date.parse(operation.first_dispatch_at)/1000),request:confirmation.request,tokenProof:confirmation.token_proof};
 const chargeId=id(pi.latest_charge);check(/^ch_[A-Za-z0-9]+$/.test(chargeId));let charge=await get<Stripe.Charge>(`/v1/charges/${chargeId}`);
 const balanceId=id(charge.balance_transaction);check(!balanceId||/^txn_[A-Za-z0-9]+$/.test(balanceId));
 const balance=balanceId?await get<Stripe.BalanceTransaction>(`/v1/balance_transactions/${balanceId}`):null;
 const inspect=(intent:Stripe.PaymentIntent,captured:Stripe.Charge,evidence:ExactPaymentContextEvidence)=>inspectTeamReceipt({contract:saved.contract,evidence,confirmation:binding,
  paymentIntent:intent,charge:captured,balance,nowSeconds:Math.floor(Date.now()/1000),financialInspection:true});
 const initial=inspect(pi,charge,await c.observeEvidence());
 [pi,charge]=await Promise.all([get<Stripe.PaymentIntent>(`/v1/payment_intents/${pi.id}`),get<Stripe.Charge>(`/v1/charges/${chargeId}`)]);
 const proof=inspect(pi,charge,await c.observeEvidence()),stable=(value:typeof proof)=>{const {providerRequestId,...fields}=value;void providerRequestId;return fields;};
 check(isDeepStrictEqual(stable(initial),stable(proof)));await context();check(Date.now()>=started&&Date.now()-started<60000);
 const fresh=await read();check(fresh&&isDeepStrictEqual(fresh.contract,saved.contract)&&isDeepStrictEqual(fresh.intent,saved.intent)&&isDeepStrictEqual(fresh.confirmation,saved.confirmation));
 return {source:saved,binding,proof,readback:{intentRequestId:req(pi),chargeRequestId:req(charge),balanceRequestId:balance?req(balance):null,readStartedAt:started,observedAt:Math.floor(Date.now()/1000)}};
}
export async function recordTeamCapture(c:TeamReceiptComposition,saleId:string,buyerId:string,obligationId:string|null=null){
 const inspected=await readTeamCapture(c,saleId,buyerId,obligationId);if(!inspected)return {status:"awaiting_capture" as const};
 const {source:saved,binding,proof,readback}=inspected;
 const receipt=await teamRpc<{id:string;review_hold:boolean;dispute_hold:boolean;processing_cost_cents:number|null}>(c.admin,"record_verified_sales_team_capture_v1",{
  p_sale_id:saleId,p_buyer_id:buyerId,p_obligation_id:saved.contract.obligationId,p_confirmation_id:binding.operationId,
  p_capture:{receipt:proof,readback}});
 return {status:receipt.review_hold||receipt.dispute_hold?"verified_held" as const:"verified" as const,receiptId:receipt.id,processingCostPending:receipt.processing_cost_cents===null};
}
