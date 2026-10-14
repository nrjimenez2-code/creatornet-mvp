import "server-only";
import Stripe from "stripe";
import {isDeepStrictEqual} from "node:util";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {inspectUnpaidExactRecovery} from "./installments/paymentRecovery";
import {readBuyerMentorshipAdmittedAttempt,readBuyerMentorshipAdmittedPayment,reconcileBuyerMentorshipInvoice} from "./mentorshipInstallmentReconciliation";
import {inspectExactBankChallenge} from "./installments/bankVerification";
import {verifyRenewalProviderHistory} from "./installments/renewal";
import {calculateInstallmentPlan} from "./installmentPlan";
import {inspectBuyerMentorshipActivationSubscription} from "./mentorshipInstallmentActivation";
function check(v:unknown):asserts v {if(!v)throw Error("Buyer payment recovery requires review");}
const id=(v:string|{id:string}|null|undefined)=>typeof v==="string"?v:v?.id;

export const buyerMentorshipPaidContinuationReady=(env:Record<string,string|undefined>)=>
  env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_RESUME_HANDOFF_READY==="true" ||
  env.CREATOR_MENTORSHIP_INSTALLMENT_SAME_CARD_RECOVERY_READY==="true";

/** Called only after receipt accounting; the existing release helper independently
 * verifies the credited retry and saved future consent before clearing a hold. */
export async function handoffBuyerMentorshipPaidFutureCollection(args:{buyerId:string;requestId:string;invoiceId:string;env?:Record<string,string|undefined>}) {
  const env=args.env??process.env;
  if(!buyerMentorshipPaidContinuationReady(env))return "disabled" as const;
  try {
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_RETRY_SCHEMA_READY==="true");
    const original=await readBuyerMentorshipAdmittedPayment(args),{admin,r,a,paymentIntentId}=original;
    const retry=await admin.from("buyer_mentorship_retry_admissions_v1").select("quote_id,reservation_id,payment_number,invoice_id,payment_intent_id")
      .eq("reservation_id",r.id).eq("payment_number",a.paymentNumber).maybeSingle();
    check(!retry.error);
    if(!retry.data) {
      if(env.CREATOR_MENTORSHIP_INSTALLMENT_SAME_CARD_RECOVERY_READY!=="true")return "not_requested" as const;
      const {resumeBuyerMentorshipSameCard}=await import("./mentorshipInstallmentSameCard");
      return await resumeBuyerMentorshipSameCard(args);
    }
    if(env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_RESUME_HANDOFF_READY!=="true")return "review_required" as const;
    const d=retry.data;
    check(d.reservation_id===r.id && d.payment_number===a.paymentNumber && d.invoice_id===a.invoiceId && d.payment_intent_id===paymentIntentId);
    const consent=await admin.from("buyer_mentorship_retry_consents_v1").select("quote_id,future_card_accepted")
      .eq("quote_id",d.quote_id).maybeSingle();
    check(!consent.error && consent.data && consent.data.quote_id===d.quote_id && typeof consent.data.future_card_accepted==="boolean");
    if(!consent.data.future_card_accepted)return "not_requested" as const;
    const {resumeBuyerMentorshipFutureCollection}=await import("./mentorshipInstallmentFutureCard");
    const result=await resumeBuyerMentorshipFutureCollection({...args,env,quoteId:d.quote_id});
    check(result.status==="collection_resumed");
    return "collection_resumed" as const;
  } catch {return "review_required" as const;}
}

/** Shared internal recovery authorization. The caller performs its specific
 * provider inspection, then rechecks this snapshot before any handoff/write. */
export async function readBuyerMentorshipRecoveryAction(args:{buyerId:string;requestId:string;invoiceId:string;env?:Record<string,string|undefined>},
  outcome:"action_required"|"payment_method_required") {
    const env=args.env??process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_SCHEMA_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_READY==="true");
    const original=await readBuyerMentorshipAdmittedPayment(args);
    const {r,a,context,paymentMethodId,defaultPaymentMethodId,cardAuthorizationId,paymentIntentId,config,runtime,admin,contract}=original;
    if(cardAuthorizationId)check(env.CREATOR_MENTORSHIP_INSTALLMENT_CARD_RECOVERY_SCHEMA_READY==="true");
    const read=async()=>{
      const scope={p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:context,p_invoice_id:a.invoiceId};
      const result=await (outcome==="action_required"?admin.rpc("read_buyer_mentorship_bank_context_v1",scope):
        admin.rpc("read_buyer_mentorship_recovery_action_context_v1",{...scope,p_outcome:outcome}));
      check(!result.error && result.data?.reservationId===r.id && result.data.paymentIntentId===paymentIntentId &&
        result.data.paymentMethodId===paymentMethodId && Array.isArray(result.data.prior));
      if(env.CREATOR_MENTORSHIP_INSTALLMENT_CARD_RECOVERY_SCHEMA_READY==="true")check(result.data.defaultPaymentMethodId===defaultPaymentMethodId && result.data.cardAuthorizationId===cardAuthorizationId);
      return result.data;
    };
    const bound=await read();
    const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    const verifySubscription=async()=>{
      const sub=await stripe.subscriptions.retrieve(a.subscriptionId);
      const inspected=inspectBuyerMentorshipActivationSubscription({reservation:r,context,dependencies:bound.dependencies,
        paidAt:bound.firstProof.paidAt,paymentMethodId:defaultPaymentMethodId,subscription:sub,nowSeconds:Math.floor(Date.now()/1000),allowActivated:true,allowPastDueRecovery:true});
      check(inspected.activated && inspected.itemId===a.subscriptionItemId && inspected.cancelAt===a.cancelAt && ["active","past_due"].includes(sub.status));
    };
    await verifySubscription();
    const plan=calculateInstallmentPlan(r.terms.amountCents,r.terms.paymentCount,r.terms.renewalFeeSchedule,r.terms.firstPaymentFeeSchedule);
    await verifyRenewalProviderHistory(stripe,{paymentMethodId,defaultPaymentMethodId,customerId:a.customerId,destinationId:a.destinationId,paymentNumber:a.paymentNumber},
      bound.prior,plan.payments,contract.expectedLiveMode);
    const assertFresh=async()=>{
      await verifySubscription();
      validateExactPaymentContext(context,(await runtime.observeContext()).contextEvidence);
      check(isDeepStrictEqual(await read(),bound));
    };
    return {...original,stripe,bound,assertFresh};
}

/** Authenticated buyer POST only. Returns an ephemeral SDK capability for the
 * original admitted PaymentIntent; never logs, persists or confirms it. */
export async function readBuyerMentorshipBankChallenge(args:{buyerId:string;requestId:string;invoiceId:string;env?:Record<string,string|undefined>}) {
  try {
    const env=args.env??process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_BANK_SCHEMA_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_BANK_READY==="true");
    const publicKey=env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;check(typeof publicKey==="string");
    const original=await readBuyerMentorshipRecoveryAction(args,"action_required");
    const {a,paymentIntentId,stripe,contract,assertFresh}=original;
    const {paymentMethodId}=await readBuyerMentorshipAdmittedAttempt(original,env);
    const challenge=await inspectExactBankChallenge(stripe,{authorization:a,paymentMethodId,paymentIntentId},contract,publicKey,{requiredBillingCountry:"US"});
    await assertFresh();
    return challenge;
  } catch {throw Error("Bank verification unavailable. Check payment status before continuing.");}
}

/** Classifies only the original admitted invoice. No pay, confirm, cancel or
 * replacement charge. Paid evidence uses the existing receipt reconciler. */
export async function recoverBuyerMentorshipPayment(args:{buyerId:string;requestId:string;invoiceId:string;eventId?:string;
  expectedEvent?:{object:"invoice"|"payment_intent";id:string;customerId:string;livemode:boolean};env?:Record<string,string|undefined>}) {
  try {
    const env=args.env??process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_SCHEMA_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_READY==="true");
    if(args.eventId)check(/^evt_[A-Za-z0-9]+$/.test(args.eventId));
    const original=await readBuyerMentorshipAdmittedPayment(args);
    const {r,a,context,paymentIntentId,config,runtime,admin,contract}=original;
    if(args.expectedEvent){const e=args.expectedEvent;check(e.id===(e.object==="invoice"?a.invoiceId:paymentIntentId) &&
      e.customerId===a.customerId && e.livemode===contract.expectedLiveMode);}
    const scope={p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:context,p_invoice_id:a.invoiceId};
    const begin=async()=>{
      const result=await admin.rpc("begin_buyer_mentorship_payment_recovery_v1",scope);
      check(!result.error && result.data?.reservationId===r.id && result.data.paymentIntentId===paymentIntentId && result.data.paymentNumber===a.paymentNumber &&
        Number.isSafeInteger(result.data.revision) && result.data.revision>=0 && Number.isSafeInteger(result.data.recoveryRevision) && result.data.recoveryRevision>=0);
      return result.data;
    };
    let snapshot;
    const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    const invoice=await stripe.invoices.retrieve(a.invoiceId);
    check(invoice.object==="invoice" && invoice.id===a.invoiceId && invoice.livemode===contract.expectedLiveMode &&
      id(invoice.customer)===a.customerId && id(invoice.parent?.subscription_details?.subscription)===a.subscriptionId);
    let observed;
    if(invoice.status==="paid") {
      // Account independently verified capture before beginning recovery. Begin
      // holds uncounted periods; calling it first would pause even a successful
      // original payment and strand the next agreed installment. Existing holds
      // are never cleared here, and an unpaid original still enters held recovery.
      const result=await reconcileBuyerMentorshipInvoice({buyerId:args.buyerId,requestId:args.requestId,invoiceId:a.invoiceId,env});
      if(result.status!=="credited" && result.status!=="already_credited")return {status:"reconciliation_required" as const};
      snapshot=await begin();
      observed={outcome:"paid_accounted" as const,evidence:{invoiceStatus:"paid",paymentStatus:"succeeded",amountReceived:invoice.amount_paid,
        amountCapturable:0,canceledAt:null,voidedAt:null}};
    } else {
      snapshot=await begin();
      const {paymentMethodId,admittedAt}=await readBuyerMentorshipAdmittedAttempt(original,env);
      observed=await inspectUnpaidExactRecovery(stripe,invoice,a,{paymentIntentId,dispatchStartedAt:admittedAt},paymentMethodId,contract);
    }
    validateExactPaymentContext(context,(await runtime.observeContext()).contextEvidence);
    const saved=await admin.rpc("finish_buyer_mentorship_payment_recovery_v1",{...scope,p_read:snapshot,
      p_outcome:observed.outcome,p_evidence:observed.evidence,p_event_id:args.eventId??null});
    check(!saved.error && typeof saved.data==="boolean");
    if(!saved.data)return {status:"reconciliation_required" as const};
    if(observed.outcome==="paid_accounted" && buyerMentorshipPaidContinuationReady(env)) {
      const futureCollection=await handoffBuyerMentorshipPaidFutureCollection(args);
      return {status:"payment_recovery_recorded" as const,outcome:observed.outcome,futureCollection};
    }
    return {status:"payment_recovery_recorded" as const,outcome:observed.outcome};
  } catch {throw Error("Buyer payment recovery requires review");}
}
