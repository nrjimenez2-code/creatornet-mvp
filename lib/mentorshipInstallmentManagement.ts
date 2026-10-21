import "server-only";
import type {BuyerPaymentQuote} from "./installments/buyerRecoveryView";
import {readBuyerMentorshipRetryReview} from "./mentorshipInstallmentRetry";
import {createClient} from "@supabase/supabase-js";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {readBuyerMentorshipBootstrapReservation} from "./mentorshipInstallmentReservation";
import {calculateInstallmentPlan} from "./installmentPlan";
import {assertAgreementId} from "./installments/agreementStore";
export type BuyerMentorshipManagementView={requestId:string;title:string;mode:"test"|"live";totalCents:number;paymentCount:number;
  serviceMonths:number|null;serviceEndsAt:number|null;collectionState?:"paused"|"authorized"|"complete"|"not_activated"|"stopped"|"review";financialReview:boolean;debitStopped:boolean;canStopDebit?:boolean;
  payments:Array<{paymentNumber:number;amountCents:number;dueAt:number;invoiceId:string|null;outcome:string;canVerifyBank:boolean;canCheck:boolean;
    retry?:{admitted:boolean;quote:BuyerPaymentQuote|null;canReview:boolean;canPay:boolean;canUseFutureCard:boolean};
    canStartCard?:boolean;cardSetup?:{requestId:string;state:"reserved"|"prepared"|"verified"|"expired";canPrepare:boolean;canOpen:boolean;canVerify:boolean}}>};
function check(v:unknown):asserts v {if(!v)throw Error("Saved payment records require review");}
export function buyerMentorshipManagementEnabled(env:Record<string,string|undefined>) {
  return ["MANAGEMENT_READY","RESERVATIONS_SCHEMA_READY","LATER_RECEIPT_SCHEMA_READY","RECOVERY_SCHEMA_READY"]
    .every(flag=>env[`CREATOR_MENTORSHIP_INSTALLMENT_${flag}`]==="true");
}
/** Authenticated read only; explicit projection excludes provider capabilities
 * and operation requests. Action eligibility is advisory and rechecked by POST. */
export async function readBuyerMentorshipManagement(args:{buyerId:string;requestId:string;env?:Record<string,string|undefined>}):Promise<BuyerMentorshipManagementView|null> {
  const env=args.env??process.env;check(buyerMentorshipManagementEnabled(env));
  const config=exactContextServerConfig(env),observed=await createExactContextRuntime(config).observeContext();
  const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const r=await readBuyerMentorshipBootstrapReservation({...args,admin,context:config.approvedContext,contextEvidence:observed.contextEvidence});if(!r)return null;
  const collectionControls=env.CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_CONTROLS_SCHEMA_READY==="true";
  const [billing,first,periods,recoveries,controls]=await Promise.all([
    admin.from("buyer_mentorship_billing_state_v1").select("reservation_id,paid_count,service_end_at,financial_hold_at,debit_revoked_at").eq("reservation_id",r.id).maybeSingle(),
    admin.from("buyer_mentorship_first_receipts_v1").select("reservation_id,payment_intent_id,proof").eq("reservation_id",r.id).maybeSingle(),
    admin.from("buyer_mentorship_collection_periods_v1").select("reservation_id,payment_number,invoice_id,due_at,amount_cents,counted_at,admitted_at")
      .eq("reservation_id",r.id).order("payment_number").limit(24),
    admin.from("buyer_mentorship_payment_recoveries_v1").select("reservation_id,payment_number,invoice_id,payment_intent_id,outcome")
      .eq("reservation_id",r.id).order("payment_number").limit(24),
    collectionControls?admin.from("buyer_mentorship_billing_state_v1").select("reservation_id,collection_enabled_at,collection_hold_at").eq("reservation_id",r.id).maybeSingle():null]);
  check(!billing.error && !first.error && !periods.error && !recoveries.error && Array.isArray(periods.data) && Array.isArray(recoveries.data) &&
    periods.data.length<24 && recoveries.data.length<24);
  const view:BuyerMentorshipManagementView={requestId:r.requestId,title:r.terms.title,mode:config.approvedContext.mode,
    totalCents:r.terms.amountCents,paymentCount:r.terms.paymentCount,serviceMonths:r.terms.serviceMonths??null,
    serviceEndsAt:billing.data?.service_end_at??null,financialReview:Boolean(billing.data?.financial_hold_at),debitStopped:Boolean(billing.data?.debit_revoked_at),payments:[]};
  if(!first.data){check(!billing.data && periods.data.length===0 && recoveries.data.length===0);return view;}
  check(first.data.reservation_id===r.id && billing.data?.reservation_id===r.id);
  if(collectionControls)check(controls && !controls.error && controls.data?.reservation_id===r.id);
  view.canStopDebit=!view.debitStopped && env.CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_CONTROLS_SCHEMA_READY==="true" &&
    env.CREATOR_MENTORSHIP_INSTALLMENT_DEBIT_STOP_READY==="true";
  const credited=await admin.rpc("read_buyer_mentorship_credited_payment_v1",{p_request_id:r.requestId,p_buyer_id:args.buyerId,p_context:config.approvedContext,p_payment_intent_id:first.data.payment_intent_id});
  check(!credited.error && credited.data?.reservationId===r.id && credited.data.proof?.paymentNumber===1);
  const plan=calculateInstallmentPlan(r.terms.amountCents,r.terms.paymentCount,r.terms.renewalFeeSchedule,r.terms.firstPaymentFeeSchedule);
  view.payments.push({paymentNumber:1,amountCents:plan.payments[0].amountCents,dueAt:credited.data.proof.paidAt,invoiceId:null,outcome:"paid_accounted",canVerifyBank:false,canCheck:false});
  let counted=1;
  const cardSchema=env.CREATOR_MENTORSHIP_INSTALLMENT_CARD_SETUP_SCHEMA_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_SAVED_CARD_SCHEMA_READY==="true";
  const setups=cardSchema?await admin.from("buyer_mentorship_card_setup_requests_v1")
    .select("id,reservation_id,buyer_id,payment_number,invoice_id,original_payment_intent_id,expires_at").eq("reservation_id",r.id).order("payment_number").limit(24):null;
  if(setups)check(!setups.error && Array.isArray(setups.data) && setups.data.length<24 &&
    setups.data.every(s=>s.reservation_id===r.id && s.buyer_id===args.buyerId && periods.data.some(p=>p.payment_number===s.payment_number && p.invoice_id===s.invoice_id)));
  for(const [index,p] of periods.data.entries()) {
    check(p.reservation_id===r.id && p.payment_number===index+2 && p.payment_number<=r.terms.paymentCount &&
      p.amount_cents===plan.payments[index+1].amountCents && Number.isSafeInteger(p.due_at));
    const matching=recoveries.data.filter(x=>x.payment_number===p.payment_number);check(matching.length<=1);
    const recovery=matching[0];if(recovery)check(recovery.reservation_id===r.id && recovery.invoice_id===p.invoice_id);
    let outcome=p.admitted_at?"payment_pending":"scheduled";
    if(recovery?.outcome){check(["action_required","payment_method_required","payment_pending","terminal_unpaid","paid_accounted","review_required"].includes(recovery.outcome));outcome=recovery.outcome;}
    if(p.counted_at) {
      const receipt=await admin.from("buyer_mentorship_later_receipts_v1").select("payment_intent_id").eq("reservation_id",r.id).eq("payment_number",p.payment_number).maybeSingle();
      check(!receipt.error && receipt.data);
      const proof=await admin.rpc("read_buyer_mentorship_credited_payment_v1",{p_request_id:r.requestId,p_buyer_id:args.buyerId,p_context:config.approvedContext,p_payment_intent_id:receipt.data.payment_intent_id});
      check(!proof.error && proof.data?.reservationId===r.id && proof.data.invoiceId===p.invoice_id && proof.data.proof?.paymentNumber===p.payment_number);
      outcome="paid_accounted";counted++;
    } else check(outcome!=="paid_accounted");
    const payment:BuyerMentorshipManagementView["payments"][number]={paymentNumber:p.payment_number,amountCents:p.amount_cents,dueAt:p.due_at,invoiceId:p.invoice_id,
      outcome,canVerifyBank:outcome==="action_required" && !view.financialReview && !view.debitStopped &&
        env.CREATOR_MENTORSHIP_INSTALLMENT_BANK_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_BANK_SCHEMA_READY==="true" &&
        env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_READY==="true",
      canCheck:Boolean(p.admitted_at) && env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_READY==="true" &&
        (outcome!=="paid_accounted" || collectionControls && Boolean(controls?.data?.collection_hold_at) && !view.debitStopped && !view.financialReview &&
          p.payment_number<r.terms.paymentCount && env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_RESUME_HANDOFF_READY==="true")};
    if(setups) {
      const matches=setups.data.filter(s=>s.payment_number===p.payment_number);check(matches.length<=1);
      const s=matches[0],eligible=outcome==="payment_method_required" && !view.financialReview && !view.debitStopped &&
        env.CREATOR_MENTORSHIP_INSTALLMENT_CARD_SETUP_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_READY==="true";
      payment.canStartCard=eligible && !s;
      if(s) {
        assertAgreementId(s.id);check(recovery && s.original_payment_intent_id===recovery.payment_intent_id && Number.isSafeInteger(s.expires_at));
        const [binding,proof]=await Promise.all([
          admin.from("buyer_mentorship_card_setup_bindings_v1").select("setup_id,session_id").eq("setup_id",s.id).maybeSingle(),
          admin.from("buyer_mentorship_saved_card_proofs_v1").select("setup_id,session_id,billing_country").eq("setup_id",s.id).maybeSingle()]);
        check(!binding.error && !proof.error);
        if(binding.data)check(binding.data.setup_id===s.id && typeof binding.data.session_id==="string");
        if(proof.data)check(proof.data.setup_id===s.id && binding.data && proof.data.session_id===binding.data.session_id && proof.data.billing_country==="US");
        const now=Math.floor(Date.now()/1000),expired=s.expires_at<=now;
        payment.cardSetup={requestId:s.id,state:proof.data?"verified":expired?"expired":binding.data?"prepared":"reserved",
          canPrepare:eligible && !binding.data && s.expires_at>now+31*60,
          canOpen:eligible && Boolean(binding.data) && !proof.data && !expired && env.CREATOR_MENTORSHIP_INSTALLMENT_CARD_SETUP_PUBLISH_READY==="true",
          canVerify:eligible && Boolean(binding.data) && !proof.data && env.CREATOR_MENTORSHIP_INSTALLMENT_SAVED_CARD_READY==="true"};
        if(proof.data && env.CREATOR_MENTORSHIP_INSTALLMENT_RETRY_SCHEMA_READY==="true") {
          const saved=await readBuyerMentorshipRetryReview({buyerId:args.buyerId,requestId:args.requestId,invoiceId:p.invoice_id!,setupId:s.id,env});
          const actions=["RETRY_ACTIONS_READY","RETRY_READY","RETRY_RECEIPT_READY","RETRY_RECOVERY_SCHEMA_READY",
            "RECOVERY_READY","RECONCILIATION_READY","SAVED_CARD_READY"].every(flag=>env[`CREATOR_MENTORSHIP_INSTALLMENT_${flag}`]==="true");
          const canReview=actions && eligible && !expired && !saved.admitted;
          payment.retry={...saved,canReview,canPay:canReview && Boolean(saved.quote && saved.quote.expiresAt>now),
            canUseFutureCard:canReview && p.payment_number<r.terms.paymentCount && env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_CARD_READY==="true"};
        }
      }
    }
    view.payments.push(payment);
  }
  check(counted===billing.data.paid_count);
  if(collectionControls) {
    check([controls?.data?.collection_enabled_at,controls?.data?.collection_hold_at].every(value=>value===null || typeof value==="string" && Number.isFinite(Date.parse(value))));
    view.collectionState=view.financialReview?"review":view.debitStopped?"stopped":counted===r.terms.paymentCount?"complete":
      controls?.data?.collection_hold_at?"paused":controls?.data?.collection_enabled_at?"authorized":"not_activated";
  }
  return view;
}
