import "server-only";
import type Stripe from "stripe";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId,operationHash} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {validateExactPaymentContext,type ExactPaymentContext} from "./installments/paymentContext";
import {calculateCreatorFees,creatorFeeMetadata,type ProcessingFeeSchedule} from "./money";

export const SERVER_PAYMENT_PROTOCOL="creatornet-us-manual-confirmation-v1" as const;
export type ServerPaymentContract=Readonly<{
  protocol:typeof SERVER_PAYMENT_PROTOCOL;
  attemptId:string;buyerId:string;creatorId:string;productId:string;termsFingerprint:string;
  context:ExactPaymentContext;customerId:string|null;destinationId:string;
  amountCents:number;processingFees:ProcessingFeeSchedule;
  kind:"full"|"first_installment"|"monthly_first"|"monthly_payoff";
  // Kept exactly as authorized by the source purchase; the new adapter must
  // feed the existing accounting path, never invent a Checkout Session.
  sourceMetadata:Readonly<Record<string,string>>;
  acceptedAt:number;expiresAt:number;
}>;
type Request<P>={apiVersion:typeof CONTEXT_CUSTOMER_API_VERSION;method:"POST";path:string;params:P};
const check:(value:unknown)=>asserts value=value=>{if(!value)throw Error("Server payment requires review");};
const id=(value:string|{id:string}|null|undefined)=>typeof value==="string"?value:value?.id??null;
const stripeId=(value:unknown,prefix:string)=>check(typeof value==="string"&&new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value));
const seconds=(value:number)=>check(Number.isSafeInteger(value)&&value>0);
const providerOptions={apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000};
const savesFutureCard=(kind:ServerPaymentContract['kind'])=>kind==='first_installment'||kind==='monthly_first';
const fingerprintKey=(kind:ServerPaymentContract['kind'])=>kind==='full'?'checkout_terms_fingerprint':
  kind==='monthly_first'?'creatornet_membership_fingerprint':kind==='monthly_payoff'?'creatornet_membership_payoff_fingerprint':'terms_fingerprint';

function contract(c:ServerPaymentContract,contextEvidence:unknown) {
  const context=validateExactPaymentContext(c.context,contextEvidence);
  for(const value of [c.attemptId,c.buyerId,c.creatorId,c.productId])assertAgreementId(value);
  check(c.protocol===SERVER_PAYMENT_PROTOCOL&&c.buyerId!==c.creatorId&&/^[a-f0-9]{64}$/.test(c.termsFingerprint)&&
    ["full","first_installment","monthly_first","monthly_payoff"].includes(c.kind)&&Number.isSafeInteger(c.amountCents)&&c.amountCents>=50&&c.amountCents<=99999999);
  seconds(c.acceptedAt);seconds(c.expiresAt);check(c.expiresAt>c.acceptedAt);
  stripeId(c.destinationId,"acct");if(c.customerId!==null)stripeId(c.customerId,"cus");
  check(c.kind==='full'||c.customerId!==null);
  check(typeof c.processingFees?.enabled==="boolean");
  const fees=calculateCreatorFees(c.amountCents,c.processingFees);
  const metadata=c.sourceMetadata;
  check(metadata&&typeof metadata==="object"&&!Array.isArray(metadata)&&Object.keys(metadata).length<=45&&
    Object.entries(metadata).every(([key,value])=>key.length>0&&key.length<=40&&typeof value==="string"&&value.length<=500)&&
    metadata.buyer_id===c.buyerId&&metadata.creator_id===c.creatorId&&metadata.product_id===c.productId&&
    metadata[fingerprintKey(c.kind)]===c.termsFingerprint&&
    !Object.keys(metadata).some(key=>key.startsWith("server_payment_"))&&
    Object.entries(creatorFeeMetadata(fees)).every(([key,value])=>metadata[key]===value));
  return {context,fees,metadata:{...metadata,server_payment_protocol:c.protocol,server_payment_attempt_id:c.attemptId,
    server_payment_terms:c.termsFingerprint}};
}

/** Constructs only an UNCONFIRMED original intent. No customer payment details
 * are accepted here and no client secret is returned. Manual confirmation is
 * essential: an automatic intent would let a client bypass subsequent checks.
 * Method discovery is disabled because this protocol preserves the existing
 * card-only consent/economics. The independently retrieved intent must actually
 * report card-only support before any confirmation; provider acceptance of the
 * pinned request remains a required release gate. */
export function serverPaymentCreateRequest(c:ServerPaymentContract,contextEvidence:unknown,originalRequest?:unknown):Request<Stripe.PaymentIntentCreateParams> {
  const {fees,metadata}=contract(c,contextEvidence);
  const request:Request<Stripe.PaymentIntentCreateParams>={apiVersion:CONTEXT_CUSTOMER_API_VERSION,method:"POST",path:"/v1/payment_intents",params:{
    amount:c.amountCents,currency:"usd",confirm:false,confirmation_method:"manual",capture_method:"automatic_async",
    payment_method_types:["card"],
    ...(c.customerId?{customer:c.customerId}:{}),...(savesFutureCard(c.kind)?{setup_future_usage:"off_session" as const}:{}),
    application_fee_amount:fees.totalCreatorDeductionCents,transfer_data:{destination:c.destinationId},metadata}};
  if(originalRequest!==undefined){
    // A persisted request is immutable even if a newer shape fixes a provider
    // validation error. Legacy operations retain their original parameters/key.
    const legacy=JSON.parse(JSON.stringify(request)) as Request<Stripe.PaymentIntentCreateParams>;
    delete legacy.params.payment_method_types;legacy.params.automatic_payment_methods={enabled:false};
    check(isDeepStrictEqual(originalRequest,request)||isDeepStrictEqual(originalRequest,legacy));
    return JSON.parse(JSON.stringify(originalRequest)) as Request<Stripe.PaymentIntentCreateParams>;
  }
  return request;
}

/** Identity and money checks are independent of status. Success here is never
 * a receipt, entitlement or earnings proof. Provider reads must be independent
 * of browser input and use the pinned account/API version. */
export function inspectServerPaymentIntent(c:ServerPaymentContract,evidence:unknown,pi:Stripe.PaymentIntent,
  binding:{paymentIntentId:string;firstDispatchAt:number},now:number) {
  const expected=serverPaymentCreateRequest(c,evidence).params;
  seconds(now);seconds(binding.firstDispatchAt);stripeId(binding.paymentIntentId,"pi");
  check(binding.firstDispatchAt>=c.acceptedAt&&binding.firstDispatchAt<=now&&pi.object==="payment_intent"&&
    pi.id===binding.paymentIntentId&&pi.livemode===(c.context.mode==="live")&&id(pi.customer)===c.customerId&&
    pi.amount===c.amountCents&&pi.currency==="usd"&&pi.confirmation_method==="manual"&&pi.capture_method==="automatic_async"&&
    pi.application_fee_amount===expected.application_fee_amount&&id(pi.transfer_data?.destination)===c.destinationId&&
    pi.transfer_data?.amount==null&&pi.on_behalf_of===null&&pi.shipping===null&&
    // Stripe assigns this exact group when it creates the destination transfer.
    // Only the captured original may acquire it; arbitrary/foreign groups still fail.
    (pi.transfer_group===null||(pi.status==="succeeded"&&pi.transfer_group===`group_${binding.paymentIntentId}`))&&
    pi.setup_future_usage===(savesFutureCard(c.kind)?"off_session":null)&&
    isDeepStrictEqual(pi.payment_method_types,["card"])&&pi.automatic_payment_methods?.enabled!==true&&
    isDeepStrictEqual(pi.metadata,expected.metadata)&&Number.isSafeInteger(pi.created)&&
    pi.created>=binding.firstDispatchAt-5&&pi.created<=now&&pi.created<c.expiresAt&&
    pi.amount_capturable===0&&Number.isSafeInteger(pi.amount_received)&&
    (pi.status==="succeeded"?pi.amount_received===c.amountCents:pi.amount_received===0));
  return pi;
}

function usAddress(value:Stripe.Address|null|undefined) {
  check(value?.country==="US"&&typeof value.line1==="string"&&value.line1.trim().length>0&&
    typeof value.city==="string"&&value.city.trim().length>0&&typeof value.state==="string"&&/^[A-Z]{2}$/.test(value.state)&&
    typeof value.postal_code==="string"&&/^\d{5}(?:-\d{4})?$/.test(value.postal_code));
}
export type ServerTokenProof=Readonly<{tokenId:string;createdAt:number;expiresAt:number;previewHash:string;country:"US"}>;
/** Stripe-observed billing country is eligibility evidence, not independent
 * proof of residency. No PAN, address or client secret is stored in this proof. */
export function inspectServerConfirmationToken(c:ServerPaymentContract,evidence:unknown,t:Stripe.ConfirmationToken,
  tokenId:string,now:number,usedByIntent?:string,saved?:ServerTokenProof):ServerTokenProof {
  contract(c,evidence);seconds(now);stripeId(tokenId,"ctoken");
  if(usedByIntent)stripeId(usedByIntent,"pi");
  const p=t.payment_method_preview;
  check((usedByIntent||now<c.expiresAt)&&t.object==="confirmation_token"&&t.id===tokenId&&t.livemode===(c.context.mode==="live")&&
    t.payment_intent===(usedByIntent??null)&&t.setup_intent===null&&Number.isSafeInteger(t.created)&&t.created>=c.acceptedAt&&t.created<=now&&
    (Number.isSafeInteger(t.expires_at)||(usedByIntent&&t.expires_at===null&&saved&&Number.isSafeInteger(saved.expiresAt)))&&
    (usedByIntent||t.expires_at!>now+30)&&t.use_stripe_sdk===true&&
    t.setup_future_usage===(savesFutureCard(c.kind)?"off_session":null)&&t.shipping===null&&
    (t.return_url===null||t.return_url===serverPaymentReturnUrl(c))&&
    p?.type==="card"&&p.card&&(id(p.customer)===null||id(p.customer)===c.customerId)&&
    t.payment_method_options==null&&t.mandate_data==null);
  usAddress(p.billing_details.address);
  // A captured original stays reconcilable after its card later expires.
  const month=new Date((usedByIntent?t.created:now)*1000);
  check(Number.isInteger(p.card.exp_month)&&p.card.exp_month>=1&&p.card.exp_month<=12&&Number.isInteger(p.card.exp_year)&&
    (p.card.exp_year>month.getUTCFullYear()||p.card.exp_year===month.getUTCFullYear()&&p.card.exp_month>=month.getUTCMonth()+1));
  const proof={tokenId:t.id,createdAt:t.created,expiresAt:t.expires_at??saved!.expiresAt,previewHash:operationHash(p),country:"US" as const};
  if(saved)check(isDeepStrictEqual(proof,saved));
  return Object.freeze(proof);
}
export type ServerCardMethodProof=Readonly<{paymentMethodId:string;createdAt:number;expiresAt:number;previewHash:string;country:"US"}>;
/** Card Element produces a PaymentMethod compatible with manual confirmation.
 * Independently read issuer and billing country; retain only an immutable hash,
 * never an address or card details. Expiry here is our admission window. */
export function inspectServerCardMethod(c:ServerPaymentContract,evidence:unknown,pm:Stripe.PaymentMethod,
  paymentMethodId:string,now:number,used=false,saved?:ServerCardMethodProof):ServerCardMethodProof {
  contract(c,evidence);seconds(now);stripeId(paymentMethodId,"pm");
  check(pm.object==="payment_method"&&pm.id===paymentMethodId&&pm.livemode===(c.context.mode==="live")&&
    pm.type==="card"&&pm.card?.country==="US"&&(id(pm.customer)===null||id(pm.customer)===c.customerId)&&
    Number.isSafeInteger(pm.created)&&pm.created>=c.acceptedAt&&pm.created<=now);
  usAddress(pm.billing_details.address);
  const expiresAt=Math.min(c.expiresAt,pm.created+12*3600),month=new Date((used?pm.created:now)*1000);
  check((used||expiresAt>now+30)&&Number.isInteger(pm.card.exp_month)&&pm.card.exp_month>=1&&pm.card.exp_month<=12&&
    Number.isInteger(pm.card.exp_year)&&(pm.card.exp_year>month.getUTCFullYear()||
      pm.card.exp_year===month.getUTCFullYear()&&pm.card.exp_month>=month.getUTCMonth()+1));
  const proof={paymentMethodId:pm.id,createdAt:pm.created,expiresAt,
    previewHash:operationHash({type:pm.type,card:{brand:pm.card.brand,country:pm.card.country,
      exp_month:pm.card.exp_month,exp_year:pm.card.exp_year,fingerprint:pm.card.fingerprint,
      funding:pm.card.funding,last4:pm.card.last4},billing_details:pm.billing_details}),country:"US" as const};
  if(saved)check(isDeepStrictEqual(proof,saved));return Object.freeze(proof);
}
export function serverPaymentReturnUrl(c:ServerPaymentContract) {
  const monthly=c.kind==='monthly_first'||c.kind==='monthly_payoff';
  const url=new URL(monthly?"/memberships/payment/return":"/purchase/payment/return",c.context.siteOrigin);url.searchParams.set("attempt",c.attemptId);return url.toString();
}

export type ServerConfirmationBasis=
  | Readonly<{kind:"card";method:ServerCardMethodProof}>
  | Readonly<{kind:"card_replacement";method:ServerCardMethodProof;previousOperationId:string;failure:ServerFailureProof}>
  | Readonly<{kind:"token";token:ServerTokenProof}>
  | Readonly<{kind:"replacement";token:ServerTokenProof;previousOperationId:string;failure:ServerFailureProof}>
  | Readonly<{kind:"after_authentication";paymentMethodId:string;previousOperationId:string}>;
export type ServerFailureProof=Readonly<{chargeId:string;paymentMethodId:string;code:string}>;
export type ServerConfirmationAdmission=Readonly<{
  operationId:string;leaseToken:string;attemptId:string;paymentIntentId:string;
  firstDispatchAt:number;dispatchBefore:number;idempotencyKey:string;
  basis:ServerConfirmationBasis;request:Request<Stripe.PaymentIntentConfirmParams>;
}>;
export type ServerConfirmationObservation=Readonly<{paymentIntentId:string;status:Stripe.PaymentIntent.Status;
  paymentMethodId:string|null;chargeId:string|null;observedAt:number;nextActionHash:string|null;failure?:ServerFailureProof}>;
export interface ServerConfirmationStore {
  // Owner/context/original-phase verification, including when dispatch has
  // expired or was stopped. Reads must still be able to recover captured money.
  assertReadable(admission:ServerConfirmationAdmission):Promise<void>;
  // MUST be backed by committed, owner-scoped original admission. Rechecks the
  // exact immutable request/lease, stops, receipt, consent, context and exclusive
  // protocol before every dispatch. The concrete adapter remains gated off.
  assertDispatch(admission:ServerConfirmationAdmission):Promise<void>;
  recordObservation(admission:ServerConfirmationAdmission,observation:ServerConfirmationObservation):Promise<void>;
}
type Provider=Pick<Stripe,"paymentIntents"|"paymentMethods"|"confirmationTokens"|"charges">;
type ConfirmationArguments={contract:ServerPaymentContract;contextEvidence:()=>Promise<unknown>;
  binding:{paymentIntentId:string;firstDispatchAt:number};admission:ServerConfirmationAdmission;
  stripe:Provider;store:ServerConfirmationStore;now?:()=>number};
export function serverPaymentConfirmationRequest(c:ServerPaymentContract,paymentIntentId:string,basis:ServerConfirmationBasis):Request<Stripe.PaymentIntentConfirmParams> {
  stripeId(paymentIntentId,"pi");
  if(basis.kind==="card"||basis.kind==="card_replacement"){
    stripeId(basis.method.paymentMethodId,"pm");
    if(basis.kind==="card_replacement"){assertAgreementId(basis.previousOperationId);stripeId(basis.failure.chargeId,"ch");stripeId(basis.failure.paymentMethodId,"pm");}
  }else if(basis.kind!=="after_authentication"){
    stripeId(basis.token.tokenId,"ctoken");
    if(basis.kind==="replacement"){assertAgreementId(basis.previousOperationId);stripeId(basis.failure.chargeId,"ch");stripeId(basis.failure.paymentMethodId,"pm");}
  }
  else {stripeId(basis.paymentMethodId,"pm");assertAgreementId(basis.previousOperationId);}
  return {apiVersion:CONTEXT_CUSTOMER_API_VERSION,method:"POST",path:`/v1/payment_intents/${paymentIntentId}/confirm`,params:{
    ...(basis.kind==="card"||basis.kind==="card_replacement"?{payment_method:basis.method.paymentMethodId}:
      basis.kind!=="after_authentication"?{confirmation_token:basis.token.tokenId}:{}),
    return_url:serverPaymentReturnUrl(c),use_stripe_sdk:true}};
}

/** A single DURABLY ADMITTED confirmation phase. This primitive does not create
 * another intent, choose a new idempotency key, authorize retries, count money,
 * or grant access. The store must separately admit a new phase after a recorded
 * requires_action observation; reusing its old key would replay the prior reply.
 * Not wired to a route until the durable store and receipt adapters are ready. */
export async function dispatchServerPaymentConfirmation(args:ConfirmationArguments) {
  try {
    const {contract:c,admission:a,stripe,store}=args,now=args.now??(()=>Math.floor(Date.now()/1000));
    assertAdmissionIdentity(args);
    const inWindow=()=>{
      const time=now();seconds(time);seconds(a.firstDispatchAt);seconds(a.dispatchBefore);
      check(time<c.expiresAt&&a.firstDispatchAt>=args.binding.firstDispatchAt&&a.firstDispatchAt<=time&&
        a.dispatchBefore>time&&a.dispatchBefore<=time+30&&a.dispatchBefore<=a.firstDispatchAt+23*3600);
    };
    inWindow();await store.assertDispatch(a);
    const read=async()=>inspectServerPaymentIntent(c,await args.contextEvidence(),await stripe.paymentIntents.retrieve(a.paymentIntentId,providerOptions),args.binding,now());
    let pi=await read();
    const remember=()=>recordServerConfirmationObservation(args,pi);
    // Provider success or an ongoing payment after an uncertain reply is a read
    // recovery, never a reason to confirm again or to declare a paid purchase.
    if(["succeeded","processing","canceled","requires_action"].includes(pi.status))return {observation:await remember(),dispatched:false};
    if(a.basis.kind==="card"||a.basis.kind==="card_replacement") {
      if(a.basis.kind==="card")check(pi.status==="requires_payment_method"&&pi.payment_method===null&&pi.latest_charge===null&&pi.last_payment_error===null);
      else check(isDeepStrictEqual(await readServerPaymentFailure(args,pi,args.binding.firstDispatchAt),a.basis.failure));
      const pm=await stripe.paymentMethods.retrieve(a.basis.method.paymentMethodId,providerOptions);
      inspectServerCardMethod(c,await args.contextEvidence(),pm,a.basis.method.paymentMethodId,now(),false,a.basis.method);
    }else if(a.basis.kind!=="after_authentication") {
      if(a.basis.kind==="token")check(pi.status==="requires_payment_method"&&pi.payment_method===null&&pi.latest_charge===null&&pi.last_payment_error===null);
      else check(isDeepStrictEqual(await readServerPaymentFailure(args,pi,args.binding.firstDispatchAt),a.basis.failure));
      const token=await stripe.confirmationTokens.retrieve(a.basis.token.tokenId,providerOptions);
      const proof=inspectServerConfirmationToken(c,await args.contextEvidence(),token,a.basis.token.tokenId,now());
      check(isDeepStrictEqual(proof,a.basis.token));
    }else{
      check(pi.status==="requires_confirmation"&&id(pi.payment_method)===a.basis.paymentMethodId&&pi.last_payment_error===null&&pi.next_action===null);
      const pm=await stripe.paymentMethods.retrieve(a.basis.paymentMethodId,providerOptions);
      check(pm.object==="payment_method"&&pm.id===a.basis.paymentMethodId&&pm.livemode===(c.context.mode==="live")&&
        pm.type==="card"&&pm.card&&(id(pm.customer)===null||id(pm.customer)===c.customerId));
      usAddress(pm.billing_details.address);
    }
    // No request/body parameter may override the checked token or saved method.
    // Re-read after external eligibility checks and immediately before dispatch.
    const before=pi;pi=await read();check(isDeepStrictEqual(pi,before));
    await store.assertDispatch(a);contract(c,await args.contextEvidence());inWindow();
    try {await stripe.paymentIntents.confirm(pi.id,a.request.params,{...providerOptions,idempotencyKey:a.idempotencyKey});}
    catch {/* Original intent state is authoritative after a lost reply; no new key. */}
    pi=await read();
    return {observation:await remember(),dispatched:true};
  }catch{throw Error("Server payment requires review");}
}

function assertAdmissionIdentity(args:ConfirmationArguments) {
  const {contract:c,admission:a}=args;
  for(const value of [a.operationId,a.leaseToken,a.attemptId])assertAgreementId(value);
  check(a.attemptId===c.attemptId&&a.paymentIntentId===args.binding.paymentIntentId&&
    a.idempotencyKey===`${SERVER_PAYMENT_PROTOCOL}:${a.operationId}`&&
    isDeepStrictEqual(a.request,serverPaymentConfirmationRequest(c,a.paymentIntentId,a.basis)));
}
async function recordServerConfirmationObservation(args:ConfirmationArguments,pi:Stripe.PaymentIntent) {
  const {contract:c,admission:a,stripe,store}=args,now=args.now??(()=>Math.floor(Date.now()/1000));
  let failure=pi.status==="requires_payment_method"&&pi.last_payment_error?await readServerPaymentFailure(args,pi,
    (a.basis.kind==="replacement"||a.basis.kind==="card_replacement")?args.binding.firstDispatchAt:a.firstDispatchAt):undefined;
  // An unchanged predecessor failure after a lost replacement reply is still
  // unresolved. It is not evidence that the new token was attempted or failed.
  if((a.basis.kind==="replacement"||a.basis.kind==="card_replacement")&&isDeepStrictEqual(failure,a.basis.failure))failure=undefined;
  // Cancellation is a terminal state of this independently verified original
  // intent, including cancellation before Stripe consumes the current token.
  // It does not prove that token was attempted, nor authorize selection release.
  if((a.basis.kind==="token"||a.basis.kind==="replacement")&&pi.status!=="canceled"&&(pi.status!=="requires_payment_method"||failure)){
    const token=await stripe.confirmationTokens.retrieve(a.basis.token.tokenId,providerOptions);
    check(isDeepStrictEqual(inspectServerConfirmationToken(c,await args.contextEvidence(),token,a.basis.token.tokenId,now(),pi.id,a.basis.token),a.basis.token));
  }
  if((a.basis.kind==="card"||a.basis.kind==="card_replacement")&&pi.status!=="canceled"&&(pi.status!=="requires_payment_method"||failure)){
    const methodId=failure?.paymentMethodId??id(pi.payment_method);check(methodId===a.basis.method.paymentMethodId);
    const pm=await stripe.paymentMethods.retrieve(methodId!,providerOptions);
    inspectServerCardMethod(c,await args.contextEvidence(),pm,methodId!,now(),true,a.basis.method);
  }
  if(a.basis.kind==="after_authentication"&&!["canceled","requires_payment_method"].includes(pi.status))
    check(id(pi.payment_method)===a.basis.paymentMethodId);
  const observation:ServerConfirmationObservation={paymentIntentId:pi.id,status:pi.status,paymentMethodId:id(pi.payment_method),
    chargeId:id(pi.latest_charge),observedAt:now(),nextActionHash:pi.next_action?operationHash(pi.next_action):null,...(failure?{failure}:{})};
  await store.recordObservation(a,observation);return observation;
}

/** Failure is independently read from the original intent AND failed charge.
 * A timeout, absent method or browser error is not failed-payment evidence. */
async function readServerPaymentFailure(args:ConfirmationArguments,pi:Stripe.PaymentIntent,since=args.admission.firstDispatchAt):Promise<ServerFailureProof>{
  const error=pi.last_payment_error,c=args.contract;
  check(pi.status==="requires_payment_method"&&pi.amount_received===0&&pi.amount_capturable===0&&pi.next_action===null&&error);
  const chargeId=id(pi.latest_charge),paymentMethodId=id(error.payment_method);
  stripeId(chargeId,"ch");stripeId(paymentMethodId,"pm");
  check(error.charge===chargeId&&typeof error.code==="string"&&/^[a-z0-9_]{1,100}$/.test(error.code)&&
    (id(pi.payment_method)===null||id(pi.payment_method)===paymentMethodId));
  if(args.admission.basis.kind==="after_authentication")check(paymentMethodId===args.admission.basis.paymentMethodId);
  const ch=await args.stripe.charges.retrieve(chargeId!,providerOptions);
  inspectServerUncapturedCharge(c,ch,pi.id,since,(args.now??(()=>Math.floor(Date.now()/1000)))());
  check(ch.id===chargeId&&ch.payment_method===paymentMethodId&&ch.failure_code===error.code);
  return {chargeId:chargeId!,paymentMethodId:paymentMethodId!,code:error.code};
}
/** Shared failed-charge financial check for decline recovery and terminal
 * cancellation history. Neither caller may treat a refunded capture as unpaid. */
export function inspectServerUncapturedCharge(c:ServerPaymentContract,ch:Stripe.Charge,paymentIntentId:string,since:number,now:number){
  stripeId(ch.id,"ch");
  check(ch.object==="charge"&&id(ch.payment_intent)===paymentIntentId&&id(ch.customer)===c.customerId&&
    ch.livemode===(c.context.mode==="live")&&ch.status==="failed"&&ch.paid===false&&ch.captured===false&&
    ch.amount===c.amountCents&&ch.currency==="usd"&&ch.amount_captured===0&&ch.amount_refunded===0&&
    ch.balance_transaction===null&&ch.transfer==null&&ch.application_fee==null&&ch.refunded===false&&ch.disputed===false&&
    ch.payment_method_details?.type==="card"&&Number.isSafeInteger(ch.created)&&ch.created>=since-5&&ch.created<=now);
}
/** Original-operation recovery remains readable after the dispatch window.
 * Never replays confirmation, rotates keys or counts a payment from metadata. */
export async function observeServerPaymentConfirmation(args:ConfirmationArguments) {
  try{
    assertAdmissionIdentity(args);await args.store.assertReadable(args.admission);
    const pi=inspectServerPaymentIntent(args.contract,await args.contextEvidence(),
      await args.stripe.paymentIntents.retrieve(args.binding.paymentIntentId,providerOptions),args.binding,(args.now??(()=>Math.floor(Date.now()/1000)))());
    await args.store.assertReadable(args.admission);
    return await recordServerConfirmationObservation(args,pi);
  }catch{throw Error("Server payment requires review");}
}

/** The authentication client receives a capability only for a manual intent.
 * Reading this does not admit the subsequent confirmation phase. */
export function serverPaymentAuthenticationCapability(c:ServerPaymentContract,evidence:unknown,pi:Stripe.PaymentIntent,
  binding:{paymentIntentId:string;firstDispatchAt:number},observation:ServerConfirmationObservation,now:number) {
  inspectServerPaymentIntent(c,evidence,pi,binding,now);
  check(now<c.expiresAt&&observation.paymentIntentId===pi.id&&observation.status==="requires_action"&&
    pi.status==="requires_action"&&observation.paymentMethodId===id(pi.payment_method)&&observation.paymentMethodId&&
    observation.nextActionHash===operationHash(pi.next_action)&&pi.next_action?.type==="use_stripe_sdk"&&
    observation.observedAt<=now&&observation.observedAt>=now-30&&typeof pi.client_secret==="string"&&
    pi.client_secret.startsWith(`${pi.id}_secret_`));
  return {clientSecret:pi.client_secret,paymentIntentId:pi.id};
}
