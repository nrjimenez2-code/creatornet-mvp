import "server-only";
import {readBuyerMentorshipInvoiceCard} from "./mentorshipInstallmentInvoiceCard";
import {assertBuyerFinancialInspectionReady} from "./mentorshipInstallmentReceipt";
import Stripe from "stripe";
import {createClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {inspectPaidRenewal} from "./installments/renewal";
import type {BuyerHeldInvoiceAuthorization} from "./installments/heldInvoice";
import {calculateInstallmentPlan} from "./installmentPlan";
import {readBuyerMentorshipBootstrapReservation} from "./mentorshipInstallmentReservation";

function check(value:unknown):asserts value {if(!value)throw Error("Buyer installment reconciliation requires review");}
function sid(value:unknown,prefix:string):string {
  const id=typeof value==="string"?value:value && typeof value==="object"?(value as {id?:unknown}).id:null;
  check(typeof id==="string" && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(id));return id;
}

/** Reconcile only the original admitted invoice, including after collection is
 * disabled, its lease expires, or a debit stop is requested. This adapter has
 * no preparation, admission, pay, confirm, retry or subscription mutation path.
 * Provider capture inspection precedes atomic receipt/ledger/earnings/counting.
 * Financial changes still require the separate refund/dispute lifecycle. */
export async function inspectBuyerMentorshipAdmittedCapture(args:{buyerId:string;requestId:string;invoiceId:string;
  env?:Record<string,string|undefined>;
  financialInspection?:"refund"|"dispute";
  expectedEvent?:{object:"invoice"|"payment_intent"|"charge";id:string;customerId:string;livemode:boolean};
}) {
  try {
    const env=args.env??process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_LATER_RECEIPT_SCHEMA_READY==="true" &&
      env.CREATOR_MENTORSHIP_INSTALLMENT_RECONCILIATION_READY==="true");
    if(args.financialInspection)assertBuyerFinancialInspectionReady(env,args.financialInspection);
    const original=await readBuyerMentorshipAdmittedPayment(args);
    const {r,a,context,paymentIntentId,payment,config,runtime,contract,purchaseId}=original;
    const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    let observedCard:string|undefined;
    if(env.CREATOR_MENTORSHIP_INSTALLMENT_RETRY_SCHEMA_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_RETRY_RECEIPT_READY==="true") {
      const current=await stripe.paymentIntents.retrieve(paymentIntentId);
      check(current.id===paymentIntentId && current.livemode===contract.expectedLiveMode && sid(current.customer,"cus")===a.customerId);
      if(current.payment_method)observedCard=sid(current.payment_method,"pm");
    }
    const {paymentMethodId,admittedAt}=await readBuyerMentorshipAdmittedAttempt(original,env,observedCard);
    const capture=await inspectPaidRenewal(stripe,{...a,paymentMethodId},paymentIntentId,{
      ...contract,
      now:()=>Math.floor(Date.now()/1000),minimumChargeCreatedAt:admittedAt});
    if(!capture)return {status:"reconciliation_required" as const,reservationId:r.id,invoiceId:a.invoiceId,paymentNumber:a.paymentNumber};
    const charge=await stripe.charges.retrieve(capture.chargeId);
    // Financial inspection returns evidence only. Ordinary reconciliation still
    // rejects refunds; the refund adapter uses a separate atomic SQL composition.
    check(charge.object==="charge" && charge.id===capture.chargeId && sid(charge.payment_intent,"pi")===paymentIntentId &&
      sid(charge.customer,"cus")===a.customerId && charge.livemode===(context.mode==="live") &&
      charge.paid===true && charge.captured===true && charge.status==="succeeded" && charge.currency==="usd" &&
      charge.amount===capture.amountCents && charge.amount_captured===capture.amountCents && charge.created===capture.paidAt &&
      charge.application_fee_amount===payment.fees.totalCreatorDeductionCents && sid(charge.payment_method,"pm")===paymentMethodId &&
      charge.payment_method_details?.type==="card" && sid(charge.balance_transaction,"txn")===capture.balanceTransactionId &&
      (args.financialInspection==="refund"?Number.isSafeInteger(charge.amount_refunded) && charge.amount_refunded>=0 &&
        charge.amount_refunded<=capture.amountCents && charge.refunded===(charge.amount_refunded===capture.amountCents) &&
        capture.refundedAmountCents===charge.amount_refunded:
        charge.amount_refunded===0 && charge.refunded===false && capture.refundedAmountCents===0) && (args.financialInspection==="dispute"?typeof charge.disputed==="boolean":charge.disputed===false) &&
      charge.billing_details.address?.country==="US");
    const transferId=sid(charge.transfer,"tr");
    if(args.expectedEvent) {
      const e=args.expectedEvent,id=e.object==="invoice"?a.invoiceId:e.object==="payment_intent"?paymentIntentId:charge.id;
      check(e.id===id && e.customerId===a.customerId && e.livemode===(context.mode==="live"));
    }
    validateExactPaymentContext(context,(await runtime.observeContext()).contextEvidence);
    const proof={version:"buyer-mentorship-later-capture-v1",reservationId:r.id,requestId:r.requestId,buyerId:r.buyerId,
      creatorId:r.terms.creatorId,termsFingerprint:r.fingerprint,context,paymentNumber:a.paymentNumber,invoiceId:a.invoiceId,
      paymentIntentId,chargeId:capture.chargeId,balanceTransactionId:capture.balanceTransactionId,transferId,paymentMethodId,
      customerId:a.customerId,subscriptionId:a.subscriptionId,destinationId:r.destinationId,amountCents:payment.amountCents,
      fees:payment.fees,actualStripeFeeCents:capture.actualStripeFeeCents,paidAt:capture.paidAt,buyerCountry:"US"};
    return {status:"captured" as const,proof,purchaseId};
  } catch {throw Error("Buyer installment reconciliation requires review");}
}

export async function reconcileBuyerMentorshipInvoice(args:Omit<Parameters<typeof inspectBuyerMentorshipAdmittedCapture>[0],"financialInspection">) {
  try {
    const inspected=await inspectBuyerMentorshipAdmittedCapture({buyerId:args.buyerId,requestId:args.requestId,invoiceId:args.invoiceId,
      env:args.env,expectedEvent:args.expectedEvent});
    if(inspected.status!=="captured")return inspected;
    const proof=inspected.proof,config=exactContextServerConfig(args.env??process.env);
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const result=await admin.rpc("record_buyer_mentorship_later_receipt_v1",{p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:proof.context,p_proof:proof});
    check(!result.error && result.data?.reservationId===proof.reservationId && result.data.paymentNumber===proof.paymentNumber &&
      result.data.purchaseId===inspected.purchaseId && typeof result.data.recorded==="boolean");
    assertAgreementId(result.data.ledgerId);
    return {status:result.data.recorded?"credited" as const:"already_credited" as const,reservationId:proof.reservationId,invoiceId:proof.invoiceId,
      paymentNumber:proof.paymentNumber,purchaseId:result.data.purchaseId as string,ledgerId:result.data.ledgerId as string};
  } catch {throw Error("Buyer installment reconciliation requires review");}
}

/** Shared immutable retry binding; never authorizes another dispatch. */
export async function readBuyerMentorshipAdmittedAttempt(
  original:Awaited<ReturnType<typeof readBuyerMentorshipAdmittedPayment>>,
  env:Record<string,string|undefined>, observedCard?:string,
) {
  const {r,a,payment,paymentIntentId,paymentMethodId:originalCard,admittedAt:originalAt,admin}=original;
  const fallback={paymentMethodId:originalCard,admittedAt:originalAt};
  if(observedCard===originalCard)return fallback;
  if(env.CREATOR_MENTORSHIP_INSTALLMENT_RETRY_SCHEMA_READY!=="true" || env.CREATOR_MENTORSHIP_INSTALLMENT_RETRY_RECEIPT_READY!=="true")return fallback;
  const retry=await admin.from("buyer_mentorship_retry_admissions_v1").select("*").eq("reservation_id",r.id).eq("payment_number",a.paymentNumber).maybeSingle();
  check(!retry.error);
  if(!retry.data){check(!observedCard);return fallback;}
  const d=retry.data;assertAgreementId(d.quote_id);
        const [quote,consent]=await Promise.all([
          admin.from("buyer_mentorship_retry_quotes_v1").select("*").eq("id",d.quote_id).eq("buyer_id",r.buyerId).maybeSingle(),
          admin.from("buyer_mentorship_retry_consents_v1").select("*").eq("quote_id",d.quote_id).maybeSingle()]);
        check(!quote.error && !consent.error && quote.data && consent.data);const q=quote.data,c=consent.data;
        const card=sid(d.payment_method_id,"pm"),admitted=Date.parse(d.admitted_at),confirmed=Date.parse(c.confirmed_at);
        check(d.reservation_id===r.id && d.payment_number===a.paymentNumber && d.invoice_id===a.invoiceId && d.payment_intent_id===paymentIntentId &&
          d.payment_method_id===card && d.idempotency_key===`cn-buyer-retry-v1:${d.quote_id}` &&
          isDeepStrictEqual(d.request,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,method:"POST",path:`/v1/invoices/${a.invoiceId}/pay`,params:{payment_method:card,off_session:false}}) &&
          q.id===d.quote_id && q.reservation_id===r.id && q.buyer_id===r.buyerId && q.payment_number===a.paymentNumber && q.invoice_id===a.invoiceId &&
          q.original_payment_intent_id===paymentIntentId && q.replacement_payment_method_id===card && q.amount_cents===payment.amountCents &&
          q.consent_version==="single-invoice-pay-now-v1" && isDeepStrictEqual(q.authorization_snapshot,{...a,paymentMethodId:originalCard}) &&
          c.quote_id===q.id && typeof c.future_card_accepted==="boolean" && (!c.future_card_accepted || q.future_card_option===true) &&
          Number.isFinite(admitted) && Number.isFinite(confirmed) && confirmed>=Date.parse(q.created_at) && admitted>=confirmed &&
          admitted>=originalAt*1000 && admitted<q.expires_at*1000 && admitted<=Date.now());

  check(!observedCard || observedCard===card);
  return {paymentMethodId:card,admittedAt:Math.floor(admitted/1000)};
}

/** Shared read-only original-admission binding for receipt and unpaid recovery. */
export async function readBuyerMentorshipAdmittedPayment(args:{buyerId:string;requestId:string;invoiceId:string;env?:Record<string,string|undefined>}) {
  const env=args.env??process.env;
    assertAgreementId(args.buyerId);assertAgreementId(args.requestId);sid(args.invoiceId,"in");
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config),observed=await runtime.observeContext();
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const r=await readBuyerMentorshipBootstrapReservation({...args,admin,context:config.approvedContext,contextEvidence:observed.contextEvidence});check(r);
    const [first,admitted,claim]=await Promise.all([
      admin.from("buyer_mentorship_first_receipts_v1").select("reservation_id,purchase_id,proof").eq("reservation_id",r.id).maybeSingle(),
      admin.from("buyer_mentorship_payment_admissions_v1").select("*").eq("reservation_id",r.id).eq("invoice_id",args.invoiceId).maybeSingle(),
      admin.from("buyer_mentorship_invoice_claims_v1").select("reservation_id,payment_number,invoice_id,authorization_snapshot")
        .eq("reservation_id",r.id).eq("invoice_id",args.invoiceId).maybeSingle()]);
    check(!first.error && first.data?.reservation_id===r.id && !admitted.error && admitted.data?.reservation_id===r.id &&
      !claim.error && claim.data?.reservation_id===r.id);
    const f=first.data.proof,d=admitted.data,a=claim.data.authorization_snapshot as BuyerHeldInvoiceAuthorization;
    const context=validateExactPaymentContext(f.context,observed.contextEvidence);
    check(f.version==="buyer-mentorship-first-capture-v1" && f.reservationId===r.id && f.requestId===args.requestId &&
      f.buyerId===args.buyerId && f.termsFingerprint===r.fingerprint && a?.protocol==="buyer-mentorship-installments-v1" &&
      !("bookingPaymentId" in a) && a.planId===r.id && a.buyerReservationId===r.id && a.buyerRequestId===args.requestId &&
      a.invoiceId===args.invoiceId && claim.data.invoice_id===a.invoiceId && d.invoice_id===a.invoiceId &&
      a.paymentNumber===d.payment_number && a.paymentNumber===claim.data.payment_number &&
      a.customerId===f.customerId && a.subscriptionId===f.subscriptionId && a.destinationId===r.destinationId &&
      a.totalCents===r.terms.amountCents && a.paymentCount===r.terms.paymentCount && isDeepStrictEqual(a.feeSchedule,r.terms.renewalFeeSchedule));
    const period=await admin.from("buyer_mentorship_collection_periods_v1").select("*").eq("reservation_id",r.id).eq("payment_number",a.paymentNumber).maybeSingle();
    check(!period.error && period.data?.reservation_id===r.id && period.data.invoice_id===args.invoiceId &&
      period.data.payment_number===a.paymentNumber && period.data.due_at===a.periodStart && period.data.period_end===a.periodEnd &&
      Date.parse(period.data.admitted_at)===Date.parse(d.admitted_at));
    const payment=calculateInstallmentPlan(r.terms.amountCents,r.terms.paymentCount,r.terms.renewalFeeSchedule,r.terms.firstPaymentFeeSchedule).payments[a.paymentNumber-1];
    check(payment && payment.amountCents===period.data.amount_cents && isDeepStrictEqual(period.data.fee_schedule,a.feeSchedule));
    const paymentMethodId=sid(d.payment_method_id,"pm"),paymentIntentId=sid(d.payment_intent_id,"pi");
    const card=await readBuyerMentorshipInvoiceCard({admin,authorization:a,originalPaymentMethodId:f.paymentMethodId,env});
    check(paymentMethodId===card.paymentMethodId && isDeepStrictEqual(d.request,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,method:"POST",
      path:`/v1/invoices/${a.invoiceId}/pay`,params:{payment_method:paymentMethodId,off_session:true}}) &&
      /^cn-buyer-pay-v1:[0-9a-f-]{36}$/.test(d.idempotency_key));
    const admittedAt=Math.floor(Date.parse(d.admitted_at)/1000);check(Number.isSafeInteger(admittedAt) && admittedAt>=a.periodStart);

  const contract={expectedLiveMode:context.mode==="live",collectionVersion:"buyer-mentorship-collection-v1",
    metadata:{creatornet_installment_version:a.protocol,terms_fingerprint:r.fingerprint,payment_mode:context.mode,
      platform_account_id:context.platformAccountId,supabase_project_ref:context.supabaseProjectRef,site_origin:context.siteOrigin}};
  return {r,a,context,paymentMethodId,defaultPaymentMethodId:card.defaultPaymentMethodId,cardAuthorizationId:card.cardAuthorizationId,paymentIntentId,admittedAt,payment,admin,runtime,config,contract,purchaseId:first.data.purchase_id as string};
}
