import "server-only";
import Stripe from "stripe";
import {createClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {verifyRenewalProviderHistory} from "./installments/renewal";
import {calculateInstallmentPlan} from "./installmentPlan";
import {readBuyerMentorshipBootstrapReservation} from "./mentorshipInstallmentReservation";
import {prepareBuyerMentorshipInvoice} from "./mentorshipInstallmentInvoicePreparation";
import {reconcileBuyerMentorshipInvoice} from "./mentorshipInstallmentReconciliation";
function check(v:unknown):asserts v {if(!v)throw Error("Buyer installment collection requires review");}

/** Internal once-only pay stage. Uncertain dispatch and declined/SCA results
 * retain the original admission and are reconciliation, never a new pay retry.
 * When enabled, receipt reconciliation follows dispatch; otherwise the caller
 * must subsequently reconcile capture and atomic receipt accounting. */
export async function collectBuyerMentorshipInvoice(args:{buyerId:string;requestId:string;env?:Record<string,string|undefined>}) {
  try {
    const env=args.env??process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_DEBIT_SCHEMA_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_READY==="true");
    assertAgreementId(args.buyerId);assertAgreementId(args.requestId);
    const canReconcile=env.CREATOR_MENTORSHIP_INSTALLMENT_LATER_RECEIPT_SCHEMA_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_RECONCILIATION_READY==="true";
    const reconcileOriginal=async(invoiceId:string)=>{
      if(env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_SCHEMA_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_READY==="true") {
        const {recoverBuyerMentorshipPayment}=await import("./mentorshipInstallmentPaymentRecovery");
        return recoverBuyerMentorshipPayment({...args,env,invoiceId});
      }
      return reconcileBuyerMentorshipInvoice({...args,env,invoiceId});
    };
    const prepared=await prepareBuyerMentorshipInvoice({...args,env});
    if(prepared.status!=="verified_unpaid") {
      if(prepared.status==="reconcile_admitted" && canReconcile && "invoiceId" in prepared && typeof prepared.invoiceId==="string")
        return reconcileOriginal(prepared.invoiceId);
      return prepared;
    }
    assertAgreementId(prepared.claimToken);
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config),observed=await runtime.observeContext();
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const r=await readBuyerMentorshipBootstrapReservation({...args,admin,context:config.approvedContext,contextEvidence:observed.contextEvidence});check(r && r.id===prepared.reservationId);
    const receipt=await admin.from("buyer_mentorship_first_receipts_v1").select("reservation_id,purchase_id,proof").eq("reservation_id",r.id).maybeSingle();
    check(!receipt.error && receipt.data?.reservation_id===r.id);const first=receipt.data.proof,purchaseId=receipt.data.purchase_id;
    check(first?.version==="buyer-mentorship-first-capture-v1" && first.buyerId===args.buyerId && first.requestId===args.requestId &&
      first.reservationId===r.id && first.termsFingerprint===r.fingerprint && /^pm_[A-Za-z0-9]+$/.test(first.paymentMethodId));
    const card=prepared.card;
    check(card && /^pm_[A-Za-z0-9]+$/.test(card.paymentMethodId) && card.defaultPaymentMethodId===first.paymentMethodId);
    if(card.cardAuthorizationId) {
      assertAgreementId(card.cardAuthorizationId);
      check(prepared.paymentNumber>=3 && ["INVOICE_CARD_SCHEMA_READY","FUTURE_CARD_SCHEMA_READY","FUTURE_CARD_READY","FUTURE_COLLECTION_READY","CARD_RECOVERY_SCHEMA_READY"]
        .every(k=>env[`CREATOR_MENTORSHIP_INSTALLMENT_${k}`]==="true"));
    } else check(card.paymentMethodId===first.paymentMethodId);
    const context=validateExactPaymentContext(first.context,observed.contextEvidence);
    const observe=async()=>validateExactPaymentContext(context,(await runtime.observeContext()).contextEvidence);
    const [periods,admissions,ledger]=await Promise.all([
      admin.from("buyer_mentorship_collection_periods_v1").select("reservation_id,payment_number,invoice_id,counted_at").eq("reservation_id",r.id).order("payment_number").limit(24),
      admin.from("buyer_mentorship_payment_admissions_v1").select("reservation_id,payment_number,invoice_id,payment_intent_id").eq("reservation_id",r.id).order("payment_number").limit(24),
      admin.from("payment_fee_ledger").select("purchase_id,stripe_payment_intent_id,stripe_invoice_id,earnings_credited_at,status").eq("purchase_id",receipt.data.purchase_id).limit(25)]);
    check(!periods.error && Array.isArray(periods.data) && periods.data.length===r.terms.paymentCount-1 &&
      !admissions.error && Array.isArray(admissions.data) && admissions.data.length<24 && !ledger.error && Array.isArray(ledger.data) && ledger.data.length<25);
    const prior:Array<{paymentNumber:number;paymentIntentId:string;invoiceId:string|null}>=[{paymentNumber:1,paymentIntentId:first.paymentIntentId,invoiceId:null}];
    for(let number=2;number<prepared.paymentNumber;number++) {
      const p=periods.data.filter(p=>p.reservation_id===r.id && p.payment_number===number),a=admissions.data.filter(a=>a.reservation_id===r.id && a.payment_number===number);
      check(p.length===1 && p[0].counted_at && a.length===1 && a[0].invoice_id===p[0].invoice_id);
      prior.push({paymentNumber:number,paymentIntentId:a[0].payment_intent_id,invoiceId:a[0].invoice_id});
    }
    for(const p of prior) {
      const rows=ledger.data.filter(l=>l.purchase_id===purchaseId && l.stripe_payment_intent_id===p.paymentIntentId);
      check(rows.length===1 && rows[0].earnings_credited_at && rows[0].status==="paid" &&
        (rows[0].stripe_invoice_id??null)===p.invoiceId);
    }
    const plan=calculateInstallmentPlan(r.terms.amountCents,r.terms.paymentCount,r.terms.renewalFeeSchedule,r.terms.firstPaymentFeeSchedule);
    const payment=plan.payments[prepared.paymentNumber-1];check(payment && payment.amountCents===prepared.amountCents && payment.fees.totalCreatorDeductionCents===prepared.applicationFeeCents);
    const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    await verifyRenewalProviderHistory(stripe,{paymentMethodId:card.paymentMethodId,defaultPaymentMethodId:card.defaultPaymentMethodId,customerId:first.customerId,destinationId:r.destinationId,paymentNumber:prepared.paymentNumber},
      prior.map(({paymentNumber,paymentIntentId})=>({paymentNumber,paymentIntentId})),plan.payments,context.mode==="live");
    const [invoice,links,intent,method]=await Promise.all([stripe.invoices.retrieve(prepared.invoiceId),stripe.invoicePayments.list({invoice:prepared.invoiceId,limit:100}),
      stripe.paymentIntents.retrieve(prepared.paymentIntentId),stripe.paymentMethods.retrieve(card.paymentMethodId)]);
    check(links.has_more===false && links.data.length===1 && method.billing_details.address?.country==="US");
    const request={apiVersion:CONTEXT_CUSTOMER_API_VERSION,method:"POST",path:`/v1/invoices/${prepared.invoiceId}/pay`,params:{payment_method:card.paymentMethodId,off_session:true}};
    await prepared.verifySubscription();
    await observe();
    const admitted=await admin.rpc("admit_buyer_mentorship_payment_v1",{p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:context,
      p_payment_number:prepared.paymentNumber,p_token:prepared.claimToken,p_invoice:invoice,p_intent:intent,p_method:method,p_link:links.data[0],p_request:request});
    check(!admitted.error && admitted.data);
    const a=admitted.data.admission;
    check(a?.reservation_id===r.id && a.payment_number===prepared.paymentNumber && a.invoice_id===prepared.invoiceId && a.payment_intent_id===prepared.paymentIntentId &&
      a.payment_method_id===card.paymentMethodId && isDeepStrictEqual(a.request,request) && /^cn-buyer-pay-v1:[0-9a-f-]{36}$/.test(a.idempotency_key));
    const reconciliation={status:"reconciliation_required" as const,reservationId:r.id,invoiceId:prepared.invoiceId,paymentNumber:prepared.paymentNumber};
    const reconcile=()=>canReconcile?reconcileOriginal(prepared.invoiceId):Promise.resolve(reconciliation);
    if(admitted.data.status==="reconcile_admitted")return reconcile();
    check(admitted.data.status==="dispatch_once");
    const deadline=Date.parse(a.dispatch_before);check(Number.isFinite(deadline) && deadline>Date.now() && deadline<=Date.now()+26000);
    await observe();check(Date.now()<deadline);
    try {await stripe.invoices.pay(prepared.invoiceId,a.request.params,{idempotencyKey:a.idempotency_key});}
    catch {return reconcile();}
    return reconcile();
  } catch {throw Error("Buyer installment collection requires review");}
}
