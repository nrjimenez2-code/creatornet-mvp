import "server-only";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {PAY_NOW_CONSENT_VERSION,FUTURE_CARD_CONSENT_VERSION,type BuyerPaymentQuote} from "./installments/buyerRecoveryView";
import {parseExactFutureCardQuote} from "./installments/paymentRetryStore";
import {inspectExactCardSetupUnpaid} from "./installments/cardRecovery";
import {readBuyerMentorshipAdmittedPayment} from "./mentorshipInstallmentReconciliation";
import {readBuyerMentorshipRecoveryAction,recoverBuyerMentorshipPayment} from "./mentorshipInstallmentPaymentRecovery";
import {verifyBuyerMentorshipSavedCard} from "./mentorshipInstallmentCardSetup";
type Args={buyerId:string;requestId:string;invoiceId:string;setupId:string;quoteId:string;env?:Record<string,string|undefined>};
function check(v:unknown):asserts v {if(!v)throw Error("Original buyer retry requires review");}
function gate(args:Args) {
  const env=args.env??process.env;
  check(["RETRY_SCHEMA_READY","RETRY_READY","RETRY_RECEIPT_READY","RETRY_RECOVERY_SCHEMA_READY","RECOVERY_SCHEMA_READY","RECOVERY_READY","LATER_RECEIPT_SCHEMA_READY","RECONCILIATION_READY"].every(k=>env[`CREATOR_MENTORSHIP_INSTALLMENT_${k}`]==="true"));
  assertAgreementId(args.setupId);assertAgreementId(args.quoteId);return env;
}
async function current(args:Args) {
  check((await verifyBuyerMentorshipSavedCard(args)).status==="card_saved_payment_not_attempted");
  const original=await readBuyerMentorshipRecoveryAction(args,"payment_method_required");
  const card=await original.admin.from("buyer_mentorship_saved_card_proofs_v1").select("*").eq("setup_id",args.setupId).maybeSingle();
  check(!card.error && card.data?.setup_id===args.setupId && card.data.billing_country==="US" &&
    /^pm_[A-Za-z0-9]+$/.test(card.data.payment_method_id) && /^seti_[A-Za-z0-9]+$/.test(card.data.setup_intent_id));
  return {...original,card:card.data};
}
function parseQuote(raw:unknown,args:Args,o:Pick<Awaited<ReturnType<typeof current>>,"r"|"a"|"payment"|"paymentMethodId"|"paymentIntentId"|"card">):BuyerPaymentQuote {
  check(raw && typeof raw==="object" && !Array.isArray(raw));const q=raw as Record<string,unknown>;
  const {r,a,payment,paymentMethodId,paymentIntentId,card}=o;
  check(q.id===args.quoteId && q.setup_id===args.setupId && q.reservation_id===r.id && q.buyer_id===args.buyerId &&
    q.payment_number===a.paymentNumber && q.invoice_id===a.invoiceId && q.original_payment_intent_id===paymentIntentId &&
    q.replacement_payment_method_id===card.payment_method_id && q.setup_intent_id===card.setup_intent_id &&
    q.amount_cents===payment.amountCents && q.consent_version===PAY_NOW_CONSENT_VERSION && typeof q.future_card_option==="boolean" &&
    isDeepStrictEqual(q.authorization_snapshot,{...a,paymentMethodId}) && typeof q.created_at==="string" && typeof q.expires_at==="number");
  const created=Date.parse(q.created_at)/1000;
  check(Number.isFinite(created) && created<=Date.now()/1000 && Number.isSafeInteger(q.expires_at) && q.expires_at>created &&
    q.expires_at<=created+300 && q.expires_at<=a.periodEnd);
  return {id:args.quoteId,amountCents:payment.amountCents,paymentNumber:a.paymentNumber,paymentCount:a.paymentCount,expiresAt:q.expires_at,
    confirmed:false,consentVersion:PAY_NOW_CONSENT_VERSION,...parseExactFutureCardQuote({...q,confirmed_at:null,future_card_accepted:null},a,PAY_NOW_CONSENT_VERSION)};
}
export async function reviewBuyerMentorshipRetry(args:Args & {futureCardOption?:boolean}) {
  try {
    const env=gate(args),future=args.futureCardOption??false;
    check(typeof future==="boolean" && (!future || env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_CARD_READY==="true"));
    const o=await current(args);await o.assertFresh();
    const result=await o.admin.rpc("quote_buyer_mentorship_retry_v1",{p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:o.context,
      p_setup_id:args.setupId,p_quote_id:args.quoteId,p_future:future});
    check(!result.error && result.data?.paymentAllowed===false && result.data.quote?.future_card_option===future);
    return {status:"payment_review" as const,quote:parseQuote(result.data.quote,args,o)};
  } catch {throw Error("Payment review is unavailable. Check the original installment before continuing.");}
}

/** Authenticated explicit confirmation only. Any consumed admission, uncertain
 * admission reply or provider response is reconciled; never redispatched. */
export async function executeBuyerMentorshipRetry(args:Args & {consent:unknown}) {
  try {
    const env=gate(args);
    const future=isDeepStrictEqual(args.consent,{accepted:true,consentVersion:PAY_NOW_CONSENT_VERSION,futureCardConsentVersion:FUTURE_CARD_CONSENT_VERSION});
    check((future && env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_CARD_READY==="true") ||
      isDeepStrictEqual(args.consent,{accepted:true,consentVersion:PAY_NOW_CONSENT_VERSION}));
    const initial=await readBuyerMentorshipAdmittedPayment(args);
    const previous=await initial.admin.from("buyer_mentorship_retry_admissions_v1").select("quote_id").eq("reservation_id",initial.r.id).eq("payment_number",initial.a.paymentNumber).maybeSingle();
    check(!previous.error);
    if(previous.data)return await recoverBuyerMentorshipPayment(args);
    const o=await current(args),{a,admin,stripe,context,paymentIntentId,paymentMethodId,contract,card}=o;
    const scope={p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:context,p_quote_id:args.quoteId};
    const saved=await admin.from("buyer_mentorship_retry_quotes_v1").select("*").eq("id",args.quoteId).eq("buyer_id",args.buyerId).maybeSingle();
    check(!saved.error);const quote=parseQuote(saved.data,args,o);
    check(quote.expiresAt>Date.now()/1000 && (!future || saved.data.future_card_option===true));
    await inspectExactCardSetupUnpaid(stripe,{invoiceId:a.invoiceId,originalPaymentIntentId:paymentIntentId,authorization:{...a,paymentMethodId}},contract,o.defaultPaymentMethodId);
    await o.assertFresh();
    const confirmed=await admin.rpc("confirm_buyer_mentorship_retry_v1",{...scope,p_consent:args.consent});
    check(!confirmed.error && confirmed.data?.paymentAllowed===false && isDeepStrictEqual(confirmed.data.quote,saved.data) &&
      confirmed.data.consent?.quote_id===args.quoteId && confirmed.data.consent.future_card_accepted===future);
    const params={payment_method:card.payment_method_id as string,off_session:false};
    const request={apiVersion:CONTEXT_CUSTOMER_API_VERSION,method:"POST",path:`/v1/invoices/${a.invoiceId}/pay`,params};
    // Losing the SQL acknowledgement must not turn into another dispatch. The
    // original invoice recovery can observe either a consumed retry or the
    // unchanged original attempt, and never grants payment permission.
    const admitted=await Promise.resolve(admin.rpc("admit_buyer_mentorship_retry_v1",{...scope,p_basis:o.bound,p_request:request}))
      .catch(()=>null);
    if(!admitted || admitted.error)return await recoverBuyerMentorshipPayment(args);
    check(["dispatch_once","reconcile_admitted"].includes(admitted.data?.status));
    if(admitted.data.status==="dispatch_once") {
      const d=admitted.data.admission,deadline=Date.parse(d?.dispatch_before),now=Date.now();
      check(d?.quote_id===args.quoteId && d.reservation_id===o.r.id && d.invoice_id===a.invoiceId && d.payment_intent_id===paymentIntentId &&
        d.payment_method_id===card.payment_method_id && isDeepStrictEqual(d.request,request) && d.idempotency_key===`cn-buyer-retry-v1:${args.quoteId}` &&
        Number.isFinite(deadline) && deadline>now && deadline<=now+26000 && deadline<=quote.expiresAt*1000);
      try {await stripe.invoices.pay(a.invoiceId,params,{idempotencyKey:d.idempotency_key,maxNetworkRetries:0,timeout:Math.min(10000,deadline-now)});}
      catch { /* A failed/uncertain response never authorizes another dispatch. */ }
    }
    return await recoverBuyerMentorshipPayment(args);
  } catch {throw Error("The payment needs confirmation. Check the original installment; do not repeat the payment request.");}
}

/** Read-only saved review for refresh/lost-response recovery. No new quote,
 * provider call, consent, or payment is created by this projection. */
export async function readBuyerMentorshipRetryReview(args:Omit<Args,"quoteId">) {
  const env=args.env??process.env;
  check(env.CREATOR_MENTORSHIP_INSTALLMENT_RETRY_SCHEMA_READY==="true");
  assertAgreementId(args.setupId);
  const o=await readBuyerMentorshipAdmittedPayment(args),{admin,r,a}=o;
  const [card,retry]=await Promise.all([
    admin.from("buyer_mentorship_saved_card_proofs_v1").select("*").eq("setup_id",args.setupId).maybeSingle(),
    admin.from("buyer_mentorship_retry_admissions_v1").select("quote_id,reservation_id,payment_number,invoice_id,payment_intent_id").eq("reservation_id",r.id).eq("payment_number",a.paymentNumber).maybeSingle()]);
  check(!card.error && card.data?.setup_id===args.setupId && card.data.billing_country==="US" && !retry.error);
  if(retry.data)check(retry.data.reservation_id===r.id && retry.data.payment_number===a.paymentNumber &&
    retry.data.invoice_id===a.invoiceId && retry.data.payment_intent_id===o.paymentIntentId);
  const selected=retry.data?
    await admin.from("buyer_mentorship_retry_quotes_v1").select("*").eq("id",retry.data.quote_id).eq("buyer_id",args.buyerId).maybeSingle():
    await admin.from("buyer_mentorship_retry_quotes_v1").select("*").eq("setup_id",args.setupId).eq("buyer_id",args.buyerId)
      .order("created_at",{ascending:false}).order("id",{ascending:false}).limit(1).maybeSingle();
  check(!selected.error);
  if(!selected.data){check(!retry.data);return {admitted:false,quote:null};}
  const q=selected.data;assertAgreementId(q.id);check(!retry.data || q.id===retry.data.quote_id);
  const quote=parseQuote(q,{...args,quoteId:q.id},{...o,card:card.data});
  const consent=await admin.from("buyer_mentorship_retry_consents_v1").select("quote_id,confirmed_at,future_card_accepted").eq("quote_id",q.id).maybeSingle();
  check(!consent.error && (!retry.data || consent.data));
  if(consent.data)check(consent.data.quote_id===q.id && typeof consent.data.future_card_accepted==="boolean" &&
    (!consent.data.future_card_accepted || q.future_card_option===true) && Number.isFinite(Date.parse(consent.data.confirmed_at)) &&
    Date.parse(consent.data.confirmed_at)>=Date.parse(q.created_at) && Date.parse(consent.data.confirmed_at)<q.expires_at*1000 &&
    Date.parse(consent.data.confirmed_at)<=Date.now());
  return {admitted:Boolean(retry.data),quote:{...quote,confirmed:Boolean(consent.data),
    ...(consent.data?{futureCardAccepted:consent.data.future_card_accepted}:{})}};
}
