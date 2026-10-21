import "server-only";
import Stripe from "stripe";
import {createClient} from "@supabase/supabase-js";
import {isDeepStrictEqual} from "node:util";
import {assertAgreementId} from "./installments/agreementStore";
import {CONTEXT_CUSTOMER_API_VERSION} from "./installments/contextBootstrap";
import {exactContextServerConfig} from "./installments/contextServer";
import {createExactContextRuntime} from "./installments/contextRuntime";
import {validateExactPaymentContext} from "./installments/paymentContext";
import {exactActivationDates} from "./installments/activation";
import {installmentMonthBoundary} from "./installments/checkoutPreparation";
import {discoverExactRenewalUsingBinding} from "./installments/invoiceDiscovery";
import {calculateInstallmentPlan} from "./installmentPlan";
import {readBuyerMentorshipBootstrapReservation} from "./mentorshipInstallmentReservation";
type Reservation=NonNullable<Awaited<ReturnType<typeof readBuyerMentorshipBootstrapReservation>>>;
function check(v:unknown):asserts v {if(!v)throw Error("Buyer installment discovery requires review");}

export function buyerMentorshipDiscoveryPeriods(rows:unknown,r:Reservation,paidAt:number) {
  check(Array.isArray(rows) && rows.length===r.terms.paymentCount-1);
  const plan=calculateInstallmentPlan(r.terms.amountCents,r.terms.paymentCount,r.terms.renewalFeeSchedule,r.terms.firstPaymentFeeSchedule);
  const {firstRenewalAt}=exactActivationDates(paidAt,r.terms.paymentCount);
  let unpaidSeen=false;
  return rows.map((row,i)=>{
    const number=i+2,start=i===0?firstRenewalAt:installmentMonthBoundary(firstRenewalAt,i),end=installmentMonthBoundary(firstRenewalAt,i+1);
    check(row?.reservation_id===r.id && row.payment_number===number && row.due_at===start && row.period_end===end &&
      row.amount_cents===plan.payments[number-1].amountCents && isDeepStrictEqual(row.fee_schedule,r.terms.renewalFeeSchedule) &&
      (row.invoice_id===null || typeof row.invoice_id==="string" && /^in_[A-Za-z0-9]+$/.test(row.invoice_id)) &&
      (row.admitted_at===null || row.invoice_id && Number.isFinite(Date.parse(row.admitted_at))) &&
      (row.counted_at===null || row.admitted_at && Number.isFinite(Date.parse(row.counted_at)) && Date.parse(row.counted_at)>=Date.parse(row.admitted_at)));
    if(unpaidSeen)check(row.counted_at===null && row.admitted_at===null);
    if(row.counted_at===null)unpaidSeen=true;
    return {number,start,end,invoiceId:row.invoice_id as string|null,admitted:row.admitted_at!==null,counted:row.counted_at!==null};
  });
}

/** Initializes immutable agreed periods, then uses the existing shared invoice
 * discovery algorithm. No invoice mutation, catch-up debit or new payment is
 * authorized by a discovered result; collection needs its own durable claim. */
export async function discoverBuyerMentorshipRenewal(args:{buyerId:string;requestId:string;env?:Record<string,string|undefined>}) {
  try {
    const env=args.env??process.env;
    check(env.CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_PERIODS_SCHEMA_READY==="true" && env.CREATOR_MENTORSHIP_INSTALLMENT_DISCOVERY_READY==="true");
    assertAgreementId(args.buyerId);assertAgreementId(args.requestId);
    const config=exactContextServerConfig(env),runtime=createExactContextRuntime(config),observed=await runtime.observeContext();
    const admin=createClient(config.configuredSupabaseUrl,config.supabaseServiceKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const r=await readBuyerMentorshipBootstrapReservation({...args,admin,context:config.approvedContext,contextEvidence:observed.contextEvidence});check(r);
    const receipt=await admin.from("buyer_mentorship_first_receipts_v1").select("reservation_id,proof").eq("reservation_id",r.id).maybeSingle();
    check(!receipt.error && receipt.data?.reservation_id===r.id);
    const proof=receipt.data.proof;
    check(proof?.version==="buyer-mentorship-first-capture-v1" && proof.reservationId===r.id && proof.requestId===args.requestId &&
      proof.buyerId===args.buyerId && proof.termsFingerprint===r.fingerprint && proof.paymentNumber===1);
    const context=validateExactPaymentContext(proof.context,observed.contextEvidence);
    const initialized=await admin.rpc("initialize_buyer_mentorship_periods_v1",{p_request_id:args.requestId,p_buyer_id:args.buyerId,p_context:context});
    check(!initialized.error && initialized.data?.reservationId===r.id && initialized.data.periodCount===r.terms.paymentCount-1 && initialized.data.collectionAllowed===false);
    const [periodRows,state]=await Promise.all([
      admin.from("buyer_mentorship_collection_periods_v1").select("reservation_id,payment_number,due_at,period_end,amount_cents,fee_schedule,invoice_id,admitted_at,counted_at")
        .eq("reservation_id",r.id).order("payment_number").limit(24),
      admin.from("buyer_mentorship_billing_state_v1").select("reservation_id,paid_count,financial_hold_at,debit_revoked_at").eq("reservation_id",r.id).maybeSingle()]);
    check(!periodRows.error && !state.error && state.data?.reservation_id===r.id);
    const periods=buyerMentorshipDiscoveryPeriods(periodRows.data,r,proof.paidAt);
    check(state.data.paid_count===1+periods.filter(p=>p.counted).length);
    const status=state.data.financial_hold_at!=null || state.data.debit_revoked_at!=null?"review_required":state.data.paid_count===r.terms.paymentCount?"complete":"active";
    const stripe=new Stripe(config.stripeSecretKey,{apiVersion:CONTEXT_CUSTOMER_API_VERSION,maxNetworkRetries:0,timeout:10000});
    const result=await discoverExactRenewalUsingBinding({binding:{id:r.id,subscriptionId:proof.subscriptionId,customerId:proof.customerId,status,terms:r.terms},
      discoveryStore:{periods:async id=>{check(id===r.id);return periods;}},stripe,expectedLiveMode:context.mode==="live"});
    const fresh=await runtime.observeContext();validateExactPaymentContext(context,fresh.contextEvidence);
    return result;
  } catch {throw Error("Buyer installment discovery requires review");}
}
