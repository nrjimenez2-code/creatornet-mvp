import "server-only";
import Stripe from "stripe";
import {createClient} from "@supabase/supabase-js";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {inspectInstallmentDisputeCapture} from "./installments/lifecycleEvents";
import {inspectBuyerMentorshipFinancialReceipt} from "./mentorshipInstallmentReceipt";
import {readBuyerMentorshipBootstrapReservation} from "./mentorshipInstallmentReservation";
import {inspectBuyerMentorshipUncreditedCapture} from "./mentorshipInstallmentAccounting";
function check(v:unknown):asserts v {if(!v)throw Error("Buyer dispute requires review");}
const id=(v:string|{id:string}|null|undefined)=>typeof v==="string"?v:v?.id;

/** Current provider dispute audit only. Preserve the existing no-automatic-
 * creator-debit policy; keep financial hold until independent resolution. */
export async function observeBuyerMentorshipDispute(args:{buyerId:string;requestId:string;eventId:string;eventCreated:number;
  disputeId:string;paymentIntentId:string;chargeId:string;customerId:string;livemode:boolean;env?:Record<string,string|undefined>}) {
  try {
    const env=args.env??process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_SCHEMA_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_EVENTS_READY==="true");
    assertAgreementId(args.buyerId);assertAgreementId(args.requestId);
    for(const [value,prefix] of [[args.eventId,"evt"],[args.disputeId,"du"],[args.paymentIntentId,"pi"],[args.chargeId,"ch"],[args.customerId,"cus"]])
      check(new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value));
    check(Number.isSafeInteger(args.eventCreated) && args.eventCreated>0);
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config),observed=await runtime.observeContext();
    const context=validateExactPaymentContext(config.approvedContext,observed.contextEvidence);
    check(args.livemode===(context.mode==="live"));
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const r=await readBuyerMentorshipBootstrapReservation({...args,admin,context,contextEvidence:observed.contextEvidence});check(r);
    const scope={p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:context,p_payment_intent_id:args.paymentIntentId};
    const saved=await admin.rpc("read_buyer_mentorship_credited_payment_v1",scope);check(!saved.error);
    const recovering=!saved.data;
    if(recovering && env.CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_RECOVERY_READY!=="true")return {status:"reconciliation_required" as const};
    let f=saved.data?.proof,invoiceId=saved.data?.invoiceId??null;
    if(recovering) {
      const inspected=await inspectBuyerMentorshipUncreditedCapture({admin,reservation:r,paymentIntentId:args.paymentIntentId,env,financialInspection:"dispute"});
      if(!inspected)return {status:"reconciliation_required" as const};
      f=inspected.proof;invoiceId=inspected.invoiceId;
    } else {check(saved.data.reservationId===r.id);assertAgreementId(saved.data.ledgerId);assertAgreementId(saved.data.purchaseId);}
    const receipt=inspectBuyerMentorshipFinancialReceipt({reservation:r,proof:f,invoiceId,
      contextEvidence:observed.contextEvidence,paymentIntentId:args.paymentIntentId,chargeId:args.chargeId,customerId:args.customerId});
    const params={...scope,p_event_id:args.eventId,p_dispute_id:args.disputeId,p_charge_id:args.chargeId};
    const held=recovering?null:await admin.rpc("hold_buyer_mentorship_dispute_v1",params);
    if(held)check(!held.error && Number.isSafeInteger(held.data?.revision) && held.data.revision>=0 && Array.isArray(held.data.basis));
    const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    const d=await stripe.disputes.retrieve(args.disputeId);
    check(d.object==="dispute" && d.id===args.disputeId && d.livemode===args.livemode && d.currency==="usd" &&
      (d.payment_intent==null || id(d.payment_intent)===args.paymentIntentId) && id(d.charge)===args.chargeId &&
      Number.isSafeInteger(d.amount) && d.amount>0 && d.amount<=99999999 &&
      ["warning_needs_response","warning_under_review","warning_closed","needs_response","under_review","won","lost","prevented"].includes(d.status));
    await inspectInstallmentDisputeCapture({stripe,paymentIntentId:args.paymentIntentId,customerId:args.customerId,destinationId:r.destinationId,
      expectedLiveMode:args.livemode,receipt});
    validateExactPaymentContext(context,(await runtime.observeContext()).contextEvidence);
    const evidence={p_disputed_cents:d.amount,p_status:d.status,p_event_created:args.eventCreated};
    const applied=recovering?await admin.rpc("record_buyer_mentorship_disputed_capture_v1",{
      p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:context,p_proof:f,p_event_id:args.eventId,p_dispute_id:args.disputeId,...evidence
    }):await admin.rpc("apply_buyer_mentorship_dispute_v1",{...params,p_read:held!.data,...evidence});
    check(!applied.error && ["dispute_observed","dispute_review_recorded","reconciliation_required"].includes(applied.data));
    return {status:applied.data as "dispute_observed"|"dispute_review_recorded"|"reconciliation_required"};
  } catch {throw Error("Buyer dispute requires review");}
}
