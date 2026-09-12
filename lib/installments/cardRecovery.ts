import "server-only";
import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import {assertAgreementId,type ExactAgreementStore} from "./agreementStore";
import {assertExactInstallmentEnvironment} from "./checkoutPreparation";
import {assertRecoveryHeldInvoiceUsingContract,HELD_INSTALLMENT_VERSION,type HeldInvoicePreparationContract} from "./heldInvoice";
import {parseRenewalAuthorization,type RenewalAuthorization} from "./invoiceStore";
import {CARD_SETUP_CONSENT_TEXT,CARD_SETUP_CONSENT_VERSION} from "./buyerRecoveryView";
export {CARD_SETUP_CONSENT_TEXT,CARD_SETUP_CONSENT_VERSION} from "./buyerRecoveryView";

export type CardSetup=Readonly<{id:string;buyerId:string;agreementId:string;invoiceId:string;originalPaymentIntentId:string;
  authorization:RenewalAuthorization;createdAt:number;expiresAt:number;sessionId:string|null;setupIntentId:string|null;paymentMethodId:string|null}>;
export interface ExactCardSetupStore {
  reserve(id:string,agreementId:string,invoiceId:string,buyerId:string,consentVersion:string):Promise<CardSetup>;
  current(id:string,buyerId:string):Promise<CardSetup>;
  bind(id:string,buyerId:string,sessionId:string):Promise<void>;
  verify(id:string,buyerId:string,sessionId:string,setupIntentId:string,paymentMethodId:string):Promise<void>;
}
function requireThat(v:unknown,why:string):asserts v {if(!v) throw new Error(`Installment card setup: ${why}`);}
const id=(v:string|{id:string}|null|undefined)=>typeof v==="string"?v:v?.id;
export function parseExactCardSetup(value:unknown,live=false):CardSetup {
  requireThat(value&&typeof value==="object"&&!Array.isArray(value),"invalid saved setup");
  const r=value as Record<string,unknown>;
  for(const key of ["id","buyer_id","agreement_id"]) {requireThat(typeof r[key]==="string","invalid setup identity");assertAgreementId(r[key]);}
  requireThat(r.consent_version===CARD_SETUP_CONSENT_VERSION,"unknown consent version");
  const a=parseRenewalAuthorization(r.authorization_snapshot);
  requireThat(a.planId===r.agreement_id&&a.invoiceId===r.stripe_invoice_id&&typeof r.original_payment_intent_id==="string"&&
    /^pi_[a-zA-Z0-9]+$/.test(r.original_payment_intent_id),"saved binding differs");
  for(const [key,re] of [["stripe_checkout_session_id",live?/^cs_(?!test_)[a-zA-Z0-9_]+$/:/^cs_test_[a-zA-Z0-9]+$/],["stripe_setup_intent_id",/^seti_[a-zA-Z0-9]+$/],
    ["replacement_payment_method_id",/^pm_[a-zA-Z0-9]+$/]] as const) {
    requireThat(r[key]===null||typeof r[key]==="string"&&re.test(r[key]),"invalid saved Stripe identity");
  }
  const createdAt=typeof r.created_at==="string"?Math.floor(Date.parse(r.created_at)/1000):NaN;
  requireThat(Number.isSafeInteger(createdAt)&&createdAt>0&&r.expires_at===createdAt+3600&&
    (r.stripe_setup_intent_id===null)===(r.replacement_payment_method_id===null)&&
    (r.verified_at===null)===(r.stripe_setup_intent_id===null)&&
    (r.stripe_setup_intent_id===null||r.stripe_checkout_session_id!==null),"invalid setup lifetime/state");
  return Object.freeze({id:r.id as string,buyerId:r.buyer_id as string,agreementId:r.agreement_id as string,invoiceId:a.invoiceId,
    originalPaymentIntentId:r.original_payment_intent_id,authorization:a,createdAt,expiresAt:r.expires_at as number,
    sessionId:r.stripe_checkout_session_id as string|null,setupIntentId:r.stripe_setup_intent_id as string|null,
    paymentMethodId:r.replacement_payment_method_id as string|null});
}
/** Only a trusted, authenticated buyer route may provide buyerId, after showing
 * CARD_SETUP_CONSENT_TEXT and receiving explicit acceptance of its version.
 * Webhooks/background tasks must never manufacture that buyer consent.
 * No client amount, customer/card ID, URL or raw card data is accepted. */
export function createExactCardSetupStore(admin:SupabaseClient):ExactCardSetupStore {
  const rpc=async(name:string,params:Record<string,unknown>,row=false)=>{
    const q=admin.rpc(name,params);const {data,error}=await(row?q.single():q);
    if(error) throw new Error("Installment card setup state unavailable");return data as unknown;
  };
  const identity=(requestId:string,buyerId:string)=>{assertAgreementId(requestId);assertAgreementId(buyerId);};
  return {
    async reserve(requestId,agreementId,invoiceId,buyerId,consentVersion) {
      identity(requestId,buyerId);assertAgreementId(agreementId);
      requireThat(/^in_[a-zA-Z0-9]+$/.test(invoiceId)&&consentVersion===CARD_SETUP_CONSENT_VERSION,"invalid request");
      const r=parseExactCardSetup(await rpc("reserve_exact_card_setup",{p_id:requestId,p_agreement_id:agreementId,p_invoice_id:invoiceId,
        p_buyer_id:buyerId,p_consent_version:consentVersion},true));
      requireThat(r.id===requestId&&r.buyerId===buyerId&&r.agreementId===agreementId&&r.invoiceId===invoiceId,"request binding differs");return r;
    },
    async current(requestId,buyerId) {
      identity(requestId,buyerId);
      const r=parseExactCardSetup(await rpc("read_current_exact_card_setup",{p_id:requestId,p_buyer_id:buyerId},true));
      requireThat(r.id===requestId&&r.buyerId===buyerId,"buyer binding differs");return r;
    },
    async bind(requestId,buyerId,sessionId) {
      identity(requestId,buyerId);requireThat(/^cs_test_[a-zA-Z0-9]+$/.test(sessionId),"invalid session");
      await rpc("bind_exact_card_setup",{p_id:requestId,p_buyer_id:buyerId,p_session_id:sessionId});
    },
    async verify(requestId,buyerId,sessionId,setupIntentId,paymentMethodId) {
      identity(requestId,buyerId);requireThat(/^cs_test_[a-zA-Z0-9]+$/.test(sessionId)&&/^seti_[a-zA-Z0-9]+$/.test(setupIntentId)&&
        /^pm_[a-zA-Z0-9]+$/.test(paymentMethodId),"invalid setup result");
      await rpc("verify_exact_card_setup",{p_id:requestId,p_buyer_id:buyerId,p_session_id:sessionId,
        p_setup_intent_id:setupIntentId,p_payment_method_id:paymentMethodId});
    },
  };
}
type Input={requestId:string;buyerId:string;store:ExactCardSetupStore;agreementStore:ExactAgreementStore;
  stripe:Pick<Stripe,"checkout"|"setupIntents"|"paymentMethods"|"invoices"|"invoicePayments"|"paymentIntents"|"subscriptions">;
  env:Record<string,string|undefined>;now?:()=>number};
function gate(args:Input) {
  assertAgreementId(args.requestId);assertAgreementId(args.buyerId);
  assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
  requireThat([args.env.CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_READY,args.env.CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY,
    args.env.CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY].every(v=>v==="true"),"setup is not enabled");
}
const meta=(r:CardSetup)=>({card_setup_version:CARD_SETUP_CONSENT_VERSION,card_setup_request_id:r.id,installment_plan_id:r.agreementId});
function hasMeta(v:Stripe.Metadata|null|undefined,r:CardSetup) {return Object.entries(meta(r)).every(([key,value])=>v?.[key]===value);}
async function context(args:Input) {
  gate(args);const r=await args.store.current(args.requestId,args.buyerId);
  const a=await args.agreementStore.load(r.agreementId), auth=r.authorization;
  assertExactInstallmentEnvironment(args.env,a.terms.previewOrigin);
  requireThat(r.id===args.requestId&&r.buyerId===args.buyerId&&a.terms.buyerId===args.buyerId&&a.status==="active"&&
    a.id===auth.planId&&a.customerId===auth.customerId&&a.subscriptionId===auth.subscriptionId&&
    a.terms.bookingPaymentId===auth.bookingPaymentId&&a.terms.totalCents===auth.totalCents&&a.terms.paymentCount===auth.paymentCount&&
    a.terms.destinationId===auth.destinationId&&a.terms.renewalFeeSchedule.enabled===auth.feeSchedule.enabled&&
    a.terms.renewalFeeSchedule.basisPoints===auth.feeSchedule.basisPoints&&a.terms.renewalFeeSchedule.fixedCents===auth.feeSchedule.fixedCents&&
    a.terms.renewalFeeSchedule.version===auth.feeSchedule.version,"agreement differs");
  const now=(args.now??(()=>Math.floor(Date.now()/1000)))();
  requireThat(now>=r.createdAt&&now<r.expiresAt&&now>=auth.periodStart&&now<auth.periodEnd,"setup window expired");
  await inspectExactCardSetupUnpaid(args.stripe,r,{expectedLiveMode:false,collectionVersion:HELD_INSTALLMENT_VERSION,metadata:{}});
  return {r,a,now};
}
type CardReader={invoices:{retrieve(id:string):Promise<Stripe.Invoice>};
  invoicePayments:{list(p:Stripe.InvoicePaymentListParams):Promise<Stripe.ApiList<Stripe.InvoicePayment>>};
  paymentIntents:{retrieve(id:string):Promise<Stripe.PaymentIntent>};subscriptions:{retrieve(id:string):Promise<Stripe.Subscription>}};
/** Existing decline/hold checks, shared with the context-scoped transport. */
export async function inspectExactCardSetupUnpaid(stripe:CardReader,r:CardSetup,
  contract:Pick<HeldInvoicePreparationContract,"expectedLiveMode"|"collectionVersion"|"metadata">) {
  const auth=r.authorization,live=contract.expectedLiveMode;
  const invoice=await stripe.invoices.retrieve(r.invoiceId);
  const payment=assertRecoveryHeldInvoiceUsingContract(invoice,auth,contract);
  requireThat(invoice.status==="open","invoice no longer unpaid");
  const links=await stripe.invoicePayments.list({invoice:r.invoiceId,limit:100});
  requireThat(!links.has_more&&links.data.length===1,"ambiguous invoice payment");
  const link=links.data[0];
  requireThat(link.livemode===live&&link.is_default===true&&id(link.invoice)===r.invoiceId&&link.status==="open"&&
    link.currency==="usd"&&(link.amount_paid==null||link.amount_paid===0)&&link.amount_requested===payment.amountCents&&
    link.payment.type==="payment_intent"&&id(link.payment.payment_intent)===r.originalPaymentIntentId,"original payment changed");
  const pi=await stripe.paymentIntents.retrieve(r.originalPaymentIntentId);
  requireThat(pi.id===r.originalPaymentIntentId&&pi.livemode===live&&pi.status==="requires_payment_method"&&
    id(pi.customer)===auth.customerId&&pi.currency==="usd"&&pi.amount===payment.amountCents&&pi.amount_received===0&&
    pi.amount_capturable===0&&pi.application_fee_amount===payment.fees.totalCreatorDeductionCents&&
    id(pi.transfer_data?.destination)===auth.destinationId&&pi.transfer_data?.amount==null&&
    pi.payment_method_types.length===1&&pi.payment_method_types[0]==="card"&&
    (pi.payment_method==null||id(pi.payment_method)===auth.paymentMethodId),"original payment needs review");
  const sub=await stripe.subscriptions.retrieve(auth.subscriptionId);
  requireThat(sub.id===auth.subscriptionId&&sub.livemode===live&&id(sub.customer)===auth.customerId&&
    ["active","past_due"].includes(sub.status)&&sub.ended_at===null&&sub.pause_collection?.behavior==="keep_as_draft"&&
    sub.pause_collection.resumes_at===null&&id(sub.default_payment_method)===auth.paymentMethodId&&
    sub.payment_settings?.save_default_payment_method==="off","subscription hold/default changed");
}
export function assertExactCardSetupSession(s:Stripe.Checkout.Session,r:CardSetup,live=false,metadata:Record<string,string>={}) {
  requireThat((live?/^cs_(?!test_)[a-zA-Z0-9_]+$/:/^cs_test_[a-zA-Z0-9]+$/).test(s.id)&&s.livemode===live&&s.mode==="setup"&&s.ui_mode==="hosted"&&
    id(s.customer)===r.authorization.customerId&&s.client_reference_id===r.id&&hasMeta(s.metadata,r)&&
    Object.entries(metadata).every(([k,v])=>s.metadata?.[k]===v)&&
    s.payment_intent===null&&s.subscription===null&&s.invoice===null&&s.payment_status==="no_payment_required"&&
    (s.amount_total===null||s.amount_total===0)&&s.payment_method_types.length===1&&s.payment_method_types[0]==="card"&&
    s.expires_at===r.expiresAt&&s.created>=r.createdAt&&s.created<=r.expiresAt,"setup Checkout differs");
}
export function exactCardSetupParams(r:CardSetup,origin:string,metadata:Record<string,string>={}):Stripe.Checkout.SessionCreateParams {
  const returnUrl=`${origin}/payments/recovery/${r.agreementId}`,m={...meta(r),...metadata};
  return {mode:"setup",ui_mode:"hosted",customer:r.authorization.customerId,client_reference_id:r.id,payment_method_types:["card"],
    expires_at:r.expiresAt,success_url:returnUrl,cancel_url:returnUrl,metadata:m,setup_intent_data:{metadata:m},
    custom_text:{submit:{message:CARD_SETUP_CONSENT_TEXT}}};
}

/** Backend candidate only: no route or buyer-visible URL is published yet.
 * Only setup-mode creation is permitted. No pay/confirm, defaults or unhold. */
export async function prepareExactCardSetupSandbox(args:Input):Promise<{status:"prepared_unpublished";sessionId:string}> {
  try {
    const {r,a,now}=await context(args);
    const params=exactCardSetupParams(r,a.terms.previewOrigin);
    let session:Stripe.Checkout.Session;
    if(r.sessionId) session=await args.stripe.checkout.sessions.retrieve(r.sessionId);
    else {
      // Stripe Checkout needs at least 30 minutes to expire. No stale recreate,
      // even after an uncertain response or Stripe's idempotency window.
      requireThat(r.expiresAt-now>=31*60,"setup creation window expired; review required");
      const fresh=await args.store.current(r.id,args.buyerId);
      requireThat(fresh.sessionId===null&&JSON.stringify(fresh)===JSON.stringify(r),"setup changed before creation");
      session=await args.stripe.checkout.sessions.create(params,{idempotencyKey:`exact-card-setup:${r.id}:v1`,maxNetworkRetries:0});
    }
    assertExactCardSetupSession(session,r);
    requireThat(session.status==="open"||session.status==="complete","setup Checkout expired");
    requireThat(!r.sessionId||r.sessionId===session.id,"bound session changed");
    await args.store.bind(r.id,args.buyerId,session.id);
    return {status:"prepared_unpublished",sessionId:session.id};
  } catch {throw new Error("Installment card setup unavailable; keep the original request for review");}
}

/** Separately gated, authenticated buyer handoff for SETUP only. No payable
 * invoice URL/client secret can escape, and no default or collection changes. */
export async function readExactCardSetupRedirectSandbox(args:Input):Promise<string> {
  try {
    requireThat(args.env.CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_PUBLISH_READY==="true","setup handoff disabled");
    const {r,a}=await context(args);requireThat(r.sessionId,"setup session unavailable");
    const s=await args.stripe.checkout.sessions.retrieve(r.sessionId);assertExactCardSetupSession(s,r);
    const returnUrl=`${a.terms.previewOrigin}/payments/recovery/${a.id}`;
    requireThat(s.id===r.sessionId&&s.status==="open"&&s.success_url===returnUrl&&s.cancel_url===returnUrl&&s.url,"setup is not open");
    const url=new URL(s.url);
    requireThat(url.protocol==="https:"&&url.hostname==="checkout.stripe.com"&&!url.username&&!url.password&&!url.port&&
      url.pathname.startsWith("/c/")&&url.pathname.includes(s.id),"invalid setup destination");
    await args.store.current(r.id,args.buyerId);
    return s.url;
  } catch {throw new Error("The secure card setup is unavailable. Refresh payment recovery before continuing.");}
}

/** A redirect or webhook's success flag never proves that a card was saved.
 * Retrieve the bound Checkout, SetupIntent and customer-owned card read-only. */
export async function verifyExactCardSetupSandbox(args:Input):Promise<{status:"setup_pending"|"card_saved_payment_not_attempted"}> {
  try {
    const {r,now}=await context(args);requireThat(r.sessionId,"no bound setup Checkout");
    const proof=await inspectExactSavedCard(args.stripe,r,now);
    if(proof.status==="setup_pending") return proof;
    await context(args);
    await args.store.verify(r.id,args.buyerId,r.sessionId,proof.setupIntentId,proof.paymentMethodId);
    return {status:"card_saved_payment_not_attempted"};
  } catch {throw new Error("Installment card setup could not be verified; payment recovery remains on hold");}
}
/** Read-only actual Checkout/SetupIntent/card verification. No success redirect
 * or caller-supplied card identity is evidence; binding remains a separate RPC. */
export async function inspectExactSavedCard(stripe:{checkout:{sessions:{retrieve(id:string):Promise<Stripe.Checkout.Session>}};
  setupIntents:{retrieve(id:string):Promise<Stripe.SetupIntent>};paymentMethods:{retrieve(id:string):Promise<Stripe.PaymentMethod>}},
  r:CardSetup,now:number,live=false,metadata:Record<string,string>={}):Promise<{status:"setup_pending"}|{status:"card_saved_payment_not_attempted";setupIntentId:string;paymentMethodId:string}> {
    requireThat(r.sessionId,"no bound setup Checkout");
    const s=await stripe.checkout.sessions.retrieve(r.sessionId);assertExactCardSetupSession(s,r,live,metadata);
    requireThat(s.id===r.sessionId&&(s.status==="open"||s.status==="complete"),"invalid setup session state");
    if(s.status!=="complete") return {status:"setup_pending"};
    const setupId=id(s.setup_intent);requireThat(setupId&&/^seti_[a-zA-Z0-9]+$/.test(setupId),"missing SetupIntent");
    const setup=await stripe.setupIntents.retrieve(setupId);
    requireThat(setup.id===setupId&&setup.livemode===live&&id(setup.customer)===r.authorization.customerId&&hasMeta(setup.metadata,r)&&
      Object.entries(metadata).every(([k,v])=>setup.metadata?.[k]===v)&&
      setup.created>=r.createdAt&&setup.created<=now&&setup.usage==="off_session"&&setup.on_behalf_of===null&&
      setup.payment_method_types.length===1&&setup.payment_method_types[0]==="card"&&
      setup.status==="succeeded","card setup not verified");
    const pmId=id(setup.payment_method);requireThat(pmId&&/^pm_[a-zA-Z0-9]+$/.test(pmId),"missing saved card");
    const pm=await stripe.paymentMethods.retrieve(pmId);
    requireThat(pm.id===pmId&&pm.livemode===live&&pm.type==="card"&&id(pm.customer)===r.authorization.customerId,"saved card ownership differs");
    return {status:"card_saved_payment_not_attempted",setupIntentId:setupId,paymentMethodId:pmId};
}
