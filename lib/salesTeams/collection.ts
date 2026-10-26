import "server-only";
import {isDeepStrictEqual} from "node:util";
import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {ExactPaymentContext,ExactPaymentContextEvidence} from "@/lib/installments/paymentContext";
import {assertMembershipUsBilling} from "@/lib/membershipBillingEligibility";
import {teamId,TeamSalesError} from "./policy";
import {teamRpc} from "./server";
import {runTeamProviderOperation,teamOperationId,TEAM_STRIPE_API_VERSION,type TeamOperationScope,type TeamProviderRequest} from "./providerOperation";
import {inspectTeamConfirmationToken,inspectTeamPaymentIntent,teamConfirmationRequest,teamIntentRequest,type TeamPaymentContract,type TeamTokenProof} from "./paymentProtocol";

type Composition={admin:SupabaseClient;stripe:Pick<Stripe,"rawRequest">;context:ExactPaymentContext;observeContext:()=>Promise<ExactPaymentContext>;observeEvidence:()=>Promise<ExactPaymentContextEvidence>};
type Json=Record<string,unknown>;
type SavedConfirmation={operation_id:string;operation_status?:string|null;request_id:string;step_number:number;kind:"token"|"reconfirm";token_id:string;token_proof:TeamTokenProof;request:TeamProviderRequest;state_id:string};
type State={id:string;status:string;payment_intent_id:string;payment_method_id:string|null;proof:Json;observed_at:string};
export type TeamCollection={collection_expires_at?:string;sale:{id:string;buyer_id:string;creator_id:string;context:ExactPaymentContext;terms:TeamPaymentContract["terms"];fingerprint:string;accepted_at:string};
 setup:{customer_operation_id:string;customer_request:TeamProviderRequest;context:ExactPaymentContext;expires_at:string;created_at:string}|null;
 runtime:{customer_id:string|null;stop_requested_at:string|null;canceled_at:string|null;financial_hold:boolean}|null;
 obligation:{id:string;amount_cents:number;period_number:number}|null;attempt:{contract:TeamPaymentContract;intent_operation_id:string;request:TeamProviderRequest}|null;
 confirmation:SavedConfirmation|null;state:State|null;receipt:{id:string;fulfilled?:boolean;held?:boolean}|null;closed:boolean};
const rec=(v:unknown):Json=>v&&typeof v==="object"&&!Array.isArray(v)?v as Json:{};
const requestId=(v:unknown)=>String(rec(rec(v).lastResponse).requestId||"");
const now=()=>Math.floor(Date.now()/1000);
const review=()=>new TeamSalesError("TEAM_PAYMENT_RECONCILIATION_REQUIRED","Your original payment needs reconciliation. Refresh its status before continuing.");
const check:(v:unknown)=>asserts v=v=>{if(!v)throw review();};
const objectId=(v:unknown)=>typeof v==="string"?v:String(rec(v).id||"");
const options={apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0,timeout:10000};
const intentReadStarted=new WeakMap<Stripe.PaymentIntent,number>();
export async function readTeamCollection(c:Pick<Composition,"admin">,saleId:string,buyerId:string,obligationId:string|null=null){
 return teamRpc<TeamCollection>(c.admin,obligationId?"read_sales_team_period_payment_v1":"read_sales_team_payment_v1",{p_sale_id:teamId(saleId),p_buyer_id:teamId(buyerId),...(obligationId?{p_obligation_id:teamId(obligationId)}:{})});
}
export type TeamNextPayment={status:"due"|"not_due"|"complete";periodNumber?:number;amountCents?:number;dueAt?:string};
export async function readTeamCollectionOverview(c:Pick<Composition,"admin">,saleId:string,buyerId:string){
 return teamRpc<{payment:TeamCollection;nextPayment?:TeamNextPayment}>(c.admin,"read_sales_team_collection_overview_v1",{p_sale_id:teamId(saleId),p_buyer_id:teamId(buyerId)});
}
const scope=(s:TeamCollection,kind:TeamOperationScope["kind"],scopeKey:string):TeamOperationScope=>({scopeId:s.sale.id,saleId:s.sale.id,creatorId:s.sale.creator_id,actorId:s.sale.buyer_id,kind,scopeKey});
async function get<T>(c:Composition,path:string,params:Json={}):Promise<T>{return await c.stripe.rawRequest("GET",path,params,options) as T;}
async function prior(c:Composition,id:string){const r=await c.admin.from("sales_team_provider_operations_v1").select("id,status,provider_id").eq("id",id).maybeSingle();if(r.error)throw r.error;return r.data;}
async function assertContext(c:Composition,s:TeamCollection){check(isDeepStrictEqual(s.sale.context,c.context)&&isDeepStrictEqual(await c.observeContext(),c.context));}
function originalCustomer(s:TeamCollection,value:unknown){
 const v=rec(value);check(s.setup&&v.object==="customer"&&/^cus_[A-Za-z0-9]+$/.test(String(v.id))&&v.deleted!==true&&v.livemode===(s.sale.context.mode==="live")&&
  isDeepStrictEqual(v.metadata,s.setup.customer_request.params.metadata)&&Number.isSafeInteger(v.created)&&Number(v.created)>=Math.floor(Date.parse(s.setup.created_at)/1000)-5);
}
async function originalIntent(c:Composition,s:TeamCollection,intentId:string){
 check(s.attempt&&/^pi_[A-Za-z0-9]+$/.test(intentId));const started=Date.now(),pi=await get<Stripe.PaymentIntent>(c,`/v1/payment_intents/${intentId}`);
 inspectTeamPaymentIntent(s.attempt.contract,await c.observeEvidence(),pi,intentId);check(Date.now()>=started&&Date.now()-started<30000&&/^req_[A-Za-z0-9]+$/.test(requestId(pi)));intentReadStarted.set(pi,started);return pi;
}
/** Independently read state can describe captured money without reapplying
 * mutable card/admission checks. Only fresh debit/reconfirmation uses those. */
async function observeState(c:Composition,s:TeamCollection,pi:Stripe.PaymentIntent){
 check(s.attempt);let unpaidMethod=pi.latest_charge===null;
 if(pi.latest_charge&&(pi.status==="requires_payment_method"||pi.status==="canceled")){
  const ch=await get<Stripe.Charge>(c,`/v1/charges/${objectId(pi.latest_charge)}`);
  check(ch.object==="charge"&&ch.id===objectId(pi.latest_charge)&&ch.livemode===pi.livemode&&objectId(ch.payment_intent)===pi.id&&objectId(ch.customer)===s.attempt.contract.customerId&&ch.amount===pi.amount&&ch.currency===pi.currency);
  unpaidMethod=ch.status==="failed"&&!ch.paid&&!ch.captured&&ch.amount_captured===0;
 }
 let authorizedTokenId:string|null=null,authorizedPaymentMethodId:string|null=null;
 if(pi.status==="requires_confirmation"&&s.confirmation){
  const token=await get<Stripe.ConfirmationToken>(c,`/v1/confirmation_tokens/${s.confirmation.token_id}`);
  const proof=inspectTeamConfirmationToken(s.attempt.contract,await c.observeEvidence(),token,s.confirmation.token_id,now(),pi.id);
  check(proof.previewHash===s.confirmation.token_proof.previewHash&&proof.createdAt===s.confirmation.token_proof.createdAt&&/^pm_[A-Za-z0-9]+$/.test(objectId(pi.payment_method)));
  authorizedTokenId=token.id;authorizedPaymentMethodId=objectId(pi.payment_method);
 }
 const proof={context:c.context,obligationId:s.attempt.contract.obligationId,paymentIntentId:pi.id,status:pi.status,paymentMethodId:objectId(pi.payment_method)||null,
  amountReceived:pi.amount_received,amountCapturable:pi.amount_capturable,unpaidMethod,authorizedTokenId,authorizedPaymentMethodId,
  latestChargeId:objectId(pi.latest_charge)||null,providerRequestId:requestId(pi),observedAt:now(),readStartedAt:intentReadStarted.get(pi)};
 await assertContext(c,s);await teamRpc(c.admin,"record_sales_team_payment_state_v1",{p_obligation_id:s.attempt.contract.obligationId,p_proof:proof});return proof;
}
export function teamCollectionView(s:TeamCollection,pi?:Stripe.PaymentIntent){
 const phase=s.receipt?s.receipt.held?"payment_review":s.receipt.fulfilled?"paid":"receipt_verified":s.closed?"stopped":s.state?.status==="succeeded"?"captured_pending_receipt":s.obligation&&s.obligation.period_number>1&&s.runtime?.stop_requested_at&&s.state?.status==="canceled"?"later_stopped":s.runtime?.stop_requested_at?"stop_pending":!s.attempt?"not_started":
  s.state?.status==="requires_payment_method"?"needs_method":s.state?.status??"review_required";
 return {phase,amountCents:s.obligation?.amount_cents??s.sale.terms.payments[0].amountCents,currency:"usd",saveForFuture:s.sale.terms.paymentKind!=="full",
  ...(s.obligation&&s.obligation.period_number>1?{obligationId:s.obligation.id,periodNumber:s.obligation.period_number}:{}),
  automaticDebitsStopped:Boolean(s.runtime?.stop_requested_at),
  ...(phase==="requires_action"&&pi?.status==="requires_action"&&pi.client_secret?{clientSecret:pi.client_secret}:{}),
  pendingRequest:s.confirmation&&s.confirmation.operation_status!=="bound"?{id:s.confirmation.request_id,kind:s.confirmation.kind}:null};
}
/** Event recovery reads one already bound original and its current state. It
 * cannot reserve a customer/intent, confirm a payment or repeat a provider POST. */
export async function refreshTeamBoundCollection(c:Composition,saleId:string,buyerId:string,obligationId:string){
 let s=await readTeamCollection(c,saleId,buyerId);if(s.obligation?.id!==obligationId)s=await readTeamCollection(c,saleId,buyerId,obligationId);await assertContext(c,s);check(s.attempt?.contract.obligationId===obligationId);
 const op=await prior(c,s.attempt.intent_operation_id);check(op?.status==="bound"&&op.provider_id);
 const pi=await originalIntent(c,s,op.provider_id);await observeState(c,s,pi);s=await readTeamCollection(c,saleId,buyerId,s.obligation!.period_number>1?obligationId:null);
 return {saved:s,pi,view:teamCollectionView(s,pi)};
}
export async function prepareTeamCollection(c:Composition,saleId:string,buyerId:string,admitNew:boolean,obligationId:string|null=null){
 const read=()=>readTeamCollection(c,saleId,buyerId,obligationId);
 let s=await read();await assertContext(c,s);if(s.closed||s.receipt)return {saved:s,view:teamCollectionView(s)};
 const customerScope=scope(s,"customer","customer:v1"),customerId=teamOperationId(customerScope);
 if(!s.setup){if(!admitNew)return {saved:s,view:teamCollectionView(s)};
  await teamRpc(c.admin,"reserve_sales_team_customer_v1",{p_sale_id:saleId,p_buyer_id:buyerId,p_operation_id:customerId,p_context:c.context});s=await read();}
 check(s.setup&&s.setup.customer_operation_id===customerId&&isDeepStrictEqual(s.setup.context,c.context));
 if(!admitNew&&!await prior(c,customerId))return {saved:s,view:teamCollectionView(s)};
 const saved=s;
 const customer=await runTeamProviderOperation({admin:c.admin,scope:customerScope,context:c.context,observeContext:c.observeContext,request:s.setup.customer_request,
  assertSource:async()=>{check(admitNew);await assertContext(c,saved);},
  create:async(r,o)=>{check(admitNew);const value=await c.stripe.rawRequest(r.method,r.path,r.params,o);return {id:String(rec(value).id||""),requestId:requestId(value),value};},
  retrieve:async id=>{const value=await get(c,`/v1/customers/${id}`);return {id:String(rec(value).id||""),requestId:requestId(value),value};},
  reconcileUnknown:async()=>{
   const page=await get<Stripe.ApiList<Stripe.Customer>>(c,"/v1/customers",{limit:100});if(page.has_more!==false||!Array.isArray(page.data)||page.data.length>100)return null;
   const matches=page.data.filter(v=>isDeepStrictEqual(v.metadata,saved.setup!.customer_request.params.metadata));if(matches.length!==1)return null;
   const value=await get(c,`/v1/customers/${matches[0].id}`);return {id:String(rec(value).id||""),requestId:requestId(value),value};
  },validate:o=>{check(o.id===rec(o.value).id);originalCustomer(saved,o.value);}});
 if(customer.status!=="bound")throw review();
 await teamRpc(c.admin,"bind_sales_team_customer_v1",{p_sale_id:saleId,p_buyer_id:buyerId,p_customer_id:customer.object.id});s=await read();
 check(s.obligation&&s.runtime?.customer_id===customer.object.id);
 const intentScope=scope(s,"intent",`intent:${s.obligation.id}`),intentId=teamOperationId(intentScope);
 if(!s.attempt){if(!admitNew)return {saved:s,view:teamCollectionView(s)};
  const contract:TeamPaymentContract={protocol:s.sale.terms.protocol,saleId,obligationId:s.obligation.id,operationId:intentId,terms:s.sale.terms,fingerprint:s.sale.fingerprint,context:c.context,
   customerId:customer.object.id,periodNumber:s.obligation.period_number,amountCents:s.obligation.amount_cents,acceptedAt:Math.floor(Date.parse(s.sale.accepted_at)/1000),expiresAt:Math.floor(Date.parse(s.collection_expires_at??s.setup!.expires_at)/1000),kind:"payment"};
  const later=s.obligation.period_number>1;
  await teamRpc(c.admin,later?"reserve_sales_team_period_intent_v1":"reserve_sales_team_intent_v1",{p_sale_id:saleId,p_buyer_id:buyerId,p_operation_id:intentId,p_contract:contract,p_request:teamIntentRequest(contract,await c.observeEvidence()),...(later?{p_obligation_id:s.obligation.id}:{})});s=await read();}
 check(s.attempt&&s.attempt.intent_operation_id===intentId);if(!admitNew&&!await prior(c,intentId))return {saved:s,view:teamCollectionView(s)};
 const attempt=s.attempt,evidence=await c.observeEvidence();
 const retrieve=async(id:string)=>{const pi=await originalIntent(c,s,id);return {id:pi.id,requestId:requestId(pi),pi};};
 const intent=await runTeamProviderOperation({admin:c.admin,scope:intentScope,context:c.context,observeContext:c.observeContext,request:attempt.request,
  assertSource:async()=>{check(admitNew);await assertContext(c,s);},
  create:async(r,o)=>{check(admitNew);const pi=await c.stripe.rawRequest(r.method,r.path,r.params,o) as unknown as Stripe.PaymentIntent;return {id:pi.id,requestId:requestId(pi),pi};},retrieve,
  reconcileUnknown:async()=>{const page=await get<Stripe.ApiList<Stripe.PaymentIntent>>(c,"/v1/payment_intents",{customer:attempt.contract.customerId,limit:100});
   if(page.has_more!==false||!Array.isArray(page.data)||page.data.length>100)return null;const matches=page.data.filter(v=>isDeepStrictEqual(v.metadata,attempt.request.params.metadata));return matches.length===1?retrieve(matches[0].id):null;},
  validate:o=>inspectTeamPaymentIntent(attempt.contract,evidence,o.pi,o.id)});
 if(intent.status!=="bound")throw review();await observeState(c,s,intent.object.pi);s=await read();
 return {saved:s,pi:intent.object.pi,view:teamCollectionView(s,intent.object.pi)};
}

/** Buyer-invoked admission of the next exact due period. SQL derives dates and
 * amount from the accepted schedule; no new customer or automatic debit. */
export async function prepareNextTeamCollection(c:Composition,saleId:string,buyerId:string){
 const selected=await teamRpc<TeamCollection&{status?:string;periodNumber?:number;dueAt?:string}>(c.admin,"reserve_sales_team_next_payment_v1",{p_sale_id:teamId(saleId),p_buyer_id:teamId(buyerId),p_context:c.context});
 if(selected.status){const saved=await readTeamCollection(c,saleId,buyerId);return {saved,view:teamCollectionView(saved),next:{status:selected.status,periodNumber:selected.periodNumber,dueAt:selected.dueAt}};}
 check(selected.obligation&&selected.obligation.period_number>1);const result=await prepareTeamCollection(c,saleId,buyerId,true,selected.obligation.id);
 return {...result,next:{status:"ready",obligationId:selected.obligation.id}};
}

async function assertReconfirmation(c:Composition,s:TeamCollection,pi:Stripe.PaymentIntent,proof:TeamTokenProof){
 check(s.attempt&&pi.status==="requires_confirmation"&&objectId(pi.payment_method)===s.state?.payment_method_id);
 const token=await get<Stripe.ConfirmationToken>(c,`/v1/confirmation_tokens/${proof.tokenId}`);
 const checked=inspectTeamConfirmationToken(s.attempt.contract,await c.observeEvidence(),token,proof.tokenId,now(),pi.id);
 check(checked.previewHash===proof.previewHash&&checked.createdAt===proof.createdAt);
 const method=await get<Stripe.PaymentMethod>(c,`/v1/payment_methods/${objectId(pi.payment_method)}`),card=token.payment_method_preview?.card;
 check(method.id===objectId(pi.payment_method)&&method.livemode===pi.livemode&&objectId(method.customer)===s.attempt.contract.customerId&&method.type==="card"&&method.card?.country==="US"&&
  card?.fingerprint&&method.card.fingerprint===card.fingerprint&&method.card.exp_month===card.exp_month&&method.card.exp_year===card.exp_year);
 assertMembershipUsBilling(method);const date=new Date();check(method.card.exp_year>date.getUTCFullYear()||method.card.exp_year===date.getUTCFullYear()&&method.card.exp_month>=date.getUTCMonth()+1);
}
export async function confirmTeamCollection(c:Composition,saleId:string,buyerId:string,input:{requestId:string;kind:"token"|"reconfirm";tokenId?:string;recoveryOnly?:boolean;obligationId?:string}){
 const read=()=>readTeamCollection(c,saleId,buyerId,input.obligationId??null);
 teamId(input.requestId);let s=await read();await assertContext(c,s);check(s.attempt);
 const confirmationScope=scope(s,"confirmation",`confirm:${input.requestId}`),operationId=teamOperationId(confirmationScope);
 const existing=await c.admin.from("sales_team_payment_confirmations_v1").select("*").eq("obligation_id",s.attempt.contract.obligationId).eq("request_id",input.requestId).maybeSingle();if(existing.error)throw existing.error;
 let confirmation=existing.data as SavedConfirmation|null;
 if(input.recoveryOnly)check(confirmation&&await prior(c,operationId));
 if(confirmation){check(confirmation.kind===input.kind&&(input.kind!=="token"||confirmation.token_id===input.tokenId));}
 else{
  const op=await prior(c,s.attempt.intent_operation_id);check(op?.provider_id);const pi=await originalIntent(c,s,op.provider_id);await observeState(c,s,pi);s=await read();check(s.attempt);
  let proof:TeamTokenProof,request:TeamProviderRequest;
  if(input.kind==="token"){
   check(/^ctoken_[A-Za-z0-9]+$/.test(input.tokenId||""));const token=await get<Stripe.ConfirmationToken>(c,`/v1/confirmation_tokens/${input.tokenId}`);
   proof=inspectTeamConfirmationToken(s.attempt.contract,await c.observeEvidence(),token,input.tokenId!,now());request=teamConfirmationRequest(s.attempt.contract,await c.observeEvidence(),pi.id,proof,now());
  }else{
   check(s.confirmation);proof=s.confirmation.token_proof;await assertReconfirmation(c,s,pi,proof);
   request={method:"POST",apiVersion:TEAM_STRIPE_API_VERSION,path:`/v1/payment_intents/${pi.id}/confirm`,params:{use_stripe_sdk:true,return_url:new URL(`/purchase/team/${saleId}`,c.context.siteOrigin).toString()}};
  }
  const later=s.attempt.contract.periodNumber>1;
  confirmation=await teamRpc<SavedConfirmation>(c.admin,later?"reserve_sales_team_period_confirmation_v1":"reserve_sales_team_confirmation_v1",{p_sale_id:saleId,p_buyer_id:buyerId,p_request_id:input.requestId,p_operation_id:operationId,p_kind:input.kind,p_token_proof:proof,p_request:request,...(later?{p_obligation_id:s.attempt.contract.obligationId}:{})});
 }
 check(s.attempt&&confirmation);const attempt=s.attempt,saved=confirmation;
 const intentId=String((await prior(c,attempt.intent_operation_id))?.provider_id||"");check(/^pi_[A-Za-z0-9]+$/.test(intentId));
 const retrieve=async()=>{const pi=await originalIntent(c,s,intentId),token=await get<Stripe.ConfirmationToken>(c,`/v1/confirmation_tokens/${saved.token_id}`);return {id:pi.id,requestId:requestId(pi),pi,token};};
 // Each provider validation uses independently observed context, captured once
 // for this operation; the journal re-observes it before and after every read.
 const evidence=await c.observeEvidence();
 const outcome=await runTeamProviderOperation({admin:c.admin,scope:confirmationScope,context:c.context,observeContext:c.observeContext,request:saved.request,
  assertSource:async()=>{const pi=await originalIntent(c,s,intentId);if(saved.kind==="reconfirm")await assertReconfirmation(c,s,pi,saved.token_proof);
   else{const token=await get<Stripe.ConfirmationToken>(c,`/v1/confirmation_tokens/${saved.token_id}`);const proof=inspectTeamConfirmationToken(attempt.contract,await c.observeEvidence(),token,saved.token_id,now());check(isDeepStrictEqual(proof,saved.token_proof)&&pi.status==="requires_payment_method");}},
  create:async(r,o)=>{const pi=await c.stripe.rawRequest(r.method,r.path,r.params,o) as unknown as Stripe.PaymentIntent;const token=await get<Stripe.ConfirmationToken>(c,`/v1/confirmation_tokens/${saved.token_id}`);return {id:pi.id,requestId:requestId(pi),pi,token};},retrieve,
  reconcileUnknown:async()=>{const o=await retrieve();if(o.pi.status==="canceled")return o;
   if(saved.kind==="token")return o.token.payment_intent===intentId?o:null;
   return ["requires_action","processing","succeeded"].includes(o.pi.status)||o.pi.status==="requires_payment_method"&&objectId(o.pi.latest_charge)!==String(s.state?.proof.latestChargeId??"")?o:null;},
  validate:o=>{inspectTeamPaymentIntent(attempt.contract,evidence,o.pi,intentId);check(o.id===intentId);
   if(o.pi.status==="canceled"&&o.token.payment_intent===null)return;
   const proof=inspectTeamConfirmationToken(attempt.contract,evidence,o.token,saved.token_id,now(),intentId);check(proof.previewHash===saved.token_proof.previewHash&&proof.createdAt===saved.token_proof.createdAt);}});
 if(outcome.status!=="bound")throw review();s=await read();await observeState(c,s,outcome.object.pi);s=await read();
 return teamCollectionView(s,outcome.object.pi);
}

export async function stopTeamCollection(c:Composition,saleId:string,buyerId:string,obligationId:string|null=null){
 const read=()=>readTeamCollection(c,saleId,buyerId,obligationId);
 await teamRpc(c.admin,"stop_sales_team_payment_v1",{p_sale_id:teamId(saleId),p_buyer_id:teamId(buyerId)});
 let s=await read();await assertContext(c,s);if(s.closed||s.receipt)return teamCollectionView(s);
 if(!s.attempt||!await prior(c,s.attempt.intent_operation_id)){
  if(!s.obligation||s.obligation.period_number===1)await teamRpc(c.admin,"close_unpaid_sales_team_payment_v1",{p_sale_id:saleId,p_buyer_id:buyerId,p_proof:{noIntentDispatched:true}});return teamCollectionView(await read());
 }
 const original=await prepareTeamCollection(c,saleId,buyerId,false,obligationId);s=original.saved;check(s.attempt&&original.pi);let pi=original.pi;
 if(pi.status==="succeeded"||pi.status==="processing")return teamCollectionView(s,pi);
 if(pi.status!=="canceled"){
  const request:TeamProviderRequest={method:"POST",apiVersion:TEAM_STRIPE_API_VERSION,path:`/v1/payment_intents/${pi.id}/cancel`,params:{cancellation_reason:"requested_by_customer"}};
  const retrieve=async()=>{const value=await originalIntent(c,s,pi.id);return {id:value.id,requestId:requestId(value),pi:value};},evidence=await c.observeEvidence();
  const result=await runTeamProviderOperation({admin:c.admin,scope:scope(s,"cancellation",`cancel:${s.attempt.contract.obligationId}`),context:c.context,observeContext:c.observeContext,request,
   assertSource:async()=>{const fresh=await read();check(fresh.runtime?.stop_requested_at);},
   create:async(r,o)=>{const value=await c.stripe.rawRequest(r.method,r.path,r.params,o) as unknown as Stripe.PaymentIntent;return {id:value.id,requestId:requestId(value),pi:value};},retrieve,
   reconcileUnknown:async()=>{const value=await retrieve();return ["canceled","succeeded"].includes(value.pi.status)?value:null;},
   validate:o=>{inspectTeamPaymentIntent(s.attempt!.contract,evidence,o.pi,pi.id);check(o.id===pi.id&&["canceled","succeeded"].includes(o.pi.status));}});
  if(result.status!=="bound")throw review();pi=result.object.pi;
 }
 const proof=await observeState(c,s,pi);if(pi.status==="canceled"&&s.attempt.contract.periodNumber===1)await teamRpc(c.admin,"close_unpaid_sales_team_payment_v1",{p_sale_id:saleId,p_buyer_id:buyerId,p_proof:proof});
 return teamCollectionView(await read(),pi);
}
