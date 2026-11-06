import "server-only";
import Stripe from "stripe";
import {createClient} from "@supabase/supabase-js";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {inspectExactRefundCapture,inspectExactRefundTotals} from "./installments/refundEvent";
import {confirmAdminRefundWebhookDelivery} from "./paymentRefunds";
import {readBuyerMentorshipBootstrapReservation} from "./mentorshipInstallmentReservation";
import {inspectBuyerMentorshipFinancialReceipt} from "./mentorshipInstallmentReceipt";
import {inspectBuyerMentorshipUncreditedCapture} from "./mentorshipInstallmentAccounting";
function check(value:unknown):asserts value {if(!value)throw Error("Buyer installment refund requires review");}

/** Observe an existing refund only. Reuses provider capture/totals inspectors
 * and the established cumulative/proportional accounting functions. Cannot
 * create a refund, replace a charge, waive debt or remove a financial hold. */
export async function reconcileBuyerMentorshipRefund(args:{buyerId:string;requestId:string;eventId:string;
  paymentIntentId:string;chargeId:string;customerId:string;livemode:boolean;env?:Record<string,string|undefined>}) {
  try {
    const env=args.env??process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_REFUND_SCHEMA_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_REFUND_EVENTS_READY==="true");
    assertAgreementId(args.buyerId);assertAgreementId(args.requestId);
    for(const [id,re] of [[args.eventId,/^evt_[A-Za-z0-9]+$/],[args.paymentIntentId,/^pi_[A-Za-z0-9]+$/],
      [args.chargeId,/^ch_[A-Za-z0-9]+$/],[args.customerId,/^cus_[A-Za-z0-9]+$/]] as const)check(re.test(id));
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config),observed=await runtime.observeContext();
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const r=await readBuyerMentorshipBootstrapReservation({...args,admin,context:config.approvedContext,contextEvidence:observed.contextEvidence});check(r);
    const context=validateExactPaymentContext(config.approvedContext,observed.contextEvidence);
    check(args.livemode===(context.mode==="live"));
    const scope={p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:context,p_payment_intent_id:args.paymentIntentId};
    const saved=await admin.rpc("read_buyer_mentorship_credited_payment_v1",scope);check(!saved.error);
    const recovering=!saved.data;
    if(recovering && env.CREATOR_MENTORSHIP_INSTALLMENT_REFUND_RECOVERY_READY!=="true")return {status:"reconciliation_required" as const};
    let f=saved.data?.proof,invoiceId=saved.data?.invoiceId??null;
    if(recovering) {
      const inspected=await inspectBuyerMentorshipUncreditedCapture({admin,reservation:r,paymentIntentId:args.paymentIntentId,env,financialInspection:"refund"});
      if(!inspected)return {status:"reconciliation_required" as const};
      f=inspected.proof;invoiceId=inspected.invoiceId;
    }
    check(recovering || saved.data.reservationId===r.id);
    if(!recovering){assertAgreementId(saved.data.ledgerId);assertAgreementId(saved.data.purchaseId);}
    const receipt=inspectBuyerMentorshipFinancialReceipt({reservation:r,proof:f,invoiceId,contextEvidence:observed.contextEvidence,
      paymentIntentId:args.paymentIntentId,chargeId:args.chargeId,customerId:args.customerId});
    // Bound signed event + original receipt can fence billing/access before a
    // slow provider read. A timeout must not drop the financial review hold.
    const financial={...scope,p_event_id:args.eventId,p_charge_id:args.chargeId,p_gross_cents:receipt.amountCents};
    // A later capture already has billing state, even if its receipt is missing.
    // First-capture recovery has no entitlement/billing row until the atomic RPC.
    if(!recovering || f.paymentNumber>1){const held=await admin.rpc("hold_buyer_mentorship_refund_v1",financial);check(!held.error && held.data===r.id);}
    const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    const state=await inspectExactRefundCapture(stripe,{paymentIntentId:args.paymentIntentId,chargeId:args.chargeId,customerId:args.customerId,
      destinationId:r.destinationId,expectedLiveMode:args.livemode,receipt});
    const totals=await inspectExactRefundTotals(stripe,state);
    if(totals.uncertain || totals.confirmed<=0 || totals.confirmed!==state.refundedAmountCents)return {status:"reconciliation_required" as const};
    validateExactPaymentContext(context,(await runtime.observeContext()).contextEvidence);
    const applied=recovering?await admin.rpc("record_buyer_mentorship_refunded_capture_v1",{
      p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:context,p_proof:f,p_event_id:args.eventId,p_refunded_cents:state.refundedAmountCents
    }):await admin.rpc("apply_buyer_mentorship_refund_v1",{...financial,p_refunded_cents:state.refundedAmountCents});
    check(!applied.error && applied.data?.reservationId===r.id && Number.isSafeInteger(applied.data.cumulativeRefundedCents) &&
      applied.data.cumulativeRefundedCents>=state.refundedAmountCents && applied.data.cumulativeRefundedCents<=state.chargeAmountCents &&
      Number.isSafeInteger(applied.data.reversedCents) && applied.data.reversedCents>=0);
    if(applied.data.cumulativeRefundedCents!==state.refundedAmountCents)return {status:"reconciliation_required" as const};
    await confirmAdminRefundWebhookDelivery(admin,stripe,state);
    return {status:"refund_reconciled" as const,reservationId:r.id,paymentNumber:receipt.paymentNumber,cumulativeRefundedCents:state.refundedAmountCents};
  } catch {throw Error("Buyer installment refund requires review");}
}
