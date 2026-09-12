import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAgreementId } from "./agreementStore";
import { parseRenewalAuthorization, type RenewalAuthorization, type RenewalReceipt } from "./invoiceStore";
import { calculateInstallmentPlan } from "../installmentPlan";
import { PAY_NOW_CONSENT_VERSION, type RemainingCardPayment, type BuyerPaymentQuote } from "./buyerRecoveryView";

export type ExactRetryAuthorization = Readonly<{
  id:string; agreementId:string; buyerId:string; setupId:string; setupIntentId:string;
  originalPaymentIntentId:string; replacementPaymentMethodId:string; authorization:RenewalAuthorization;
  amountCents:number; applicationFeeCents:number; confirmedAt:number; expiresAt:number; admittedAt:number|null;
}>;
export interface ExactPaymentRetryStore {
  load(quoteId:string,agreementId:string,buyerId:string):Promise<ExactRetryAuthorization>;
  find(agreementId:string,invoiceId:string):Promise<ExactRetryAuthorization|null>;
  /** true is a newly consumed admission, not an idempotently reusable lease. */
  admit(quoteId:string,buyerId:string):Promise<boolean>;
  recordReceipt(quoteId:string,receipt:RenewalReceipt):Promise<boolean>;
}
function check(v:unknown):asserts v {if(!v) throw new Error("Installment retry evidence unavailable");}
const seconds=(v:unknown)=>typeof v==="string"?Date.parse(v)/1000:NaN;
/** Reuse the existing prospective review contract; no default, debt or schedule
 * mutation is implied by returning a separately selectable future-card option. */
export function parseExactFutureCardQuote(r:Record<string,unknown>,auth:RenewalAuthorization,version:unknown):
  Pick<BuyerPaymentQuote,"remainingPayments"|"futureCardAccepted"> {
  if(r.future_card_option!==true) return {};
  check(version===PAY_NOW_CONSENT_VERSION && auth.paymentNumber<auth.paymentCount && Array.isArray(r.future_card_periods));
  const scheduled=calculateInstallmentPlan(auth.totalCents,auth.paymentCount,auth.feeSchedule).payments;
  let due=auth.periodEnd;
  const remainingPayments=Object.freeze(r.future_card_periods.map((value:unknown,index:number)=>{
    check(value && typeof value==="object" && !Array.isArray(value));const p=value as RemainingCardPayment;
    check(p.paymentNumber===auth.paymentNumber+index+1 && p.paymentNumber<=auth.paymentCount &&
      p.amountCents===scheduled[p.paymentNumber-1].amountCents && p.dueAt===due && Number.isSafeInteger(p.periodEnd) &&
      p.periodEnd>p.dueAt && p.periodEnd<=auth.cancelAt);
    due=p.periodEnd;
    return Object.freeze({paymentNumber:p.paymentNumber,amountCents:p.amountCents,dueAt:p.dueAt,periodEnd:p.periodEnd});
  }));
  check(remainingPayments.length===auth.paymentCount-auth.paymentNumber && due===auth.cancelAt);
  check(r.confirmed_at===null ? r.future_card_accepted==null : typeof r.future_card_accepted==="boolean");
  return {remainingPayments,...(r.confirmed_at!==null ? {futureCardAccepted:r.future_card_accepted as boolean} : {})};
}
export function parseExactRetryAuthorization(value:unknown,admission:unknown):ExactRetryAuthorization {
  check(value&&typeof value==="object"&&!Array.isArray(value));const q=value as Record<string,unknown>;
  for(const key of ["id","agreement_id","buyer_id","setup_request_id"]) {check(typeof q[key]==="string");assertAgreementId(q[key]);}
  check(q.consent_version===PAY_NOW_CONSENT_VERSION);
  const a=parseRenewalAuthorization(q.authorization_snapshot);
  check(a.planId===q.agreement_id&&a.invoiceId===q.stripe_invoice_id);
  for(const [key,re] of [["original_payment_intent_id",/^pi_[a-zA-Z0-9]+$/],["replacement_payment_method_id",/^pm_[a-zA-Z0-9]+$/],
    ["setup_intent_id",/^seti_[a-zA-Z0-9]+$/]] as const) check(typeof q[key]==="string"&&re.test(q[key]));
  const expected=calculateInstallmentPlan(a.totalCents,a.paymentCount,a.feeSchedule).payments[a.paymentNumber-1];
  check(q.amount_cents===expected.amountCents&&q.application_fee_cents===expected.fees.totalCreatorDeductionCents);
  const created=seconds(q.created_at),confirmed=seconds(q.confirmed_at),expires=q.expires_at as number;
  check(Number.isFinite(created)&&created>0&&Number.isFinite(confirmed)&&confirmed>=created&&Number.isSafeInteger(expires)&&
    expires>confirmed&&expires<=Math.floor(created)+300);
  let admittedAt:number|null=null;
  if(admission!==null) {
    check(admission&&typeof admission==="object"&&!Array.isArray(admission));const r=admission as Record<string,unknown>;
    const admitted=seconds(r.admitted_at);
    check(r.confirmation_id===q.id&&r.agreement_id===q.agreement_id&&r.stripe_invoice_id===q.stripe_invoice_id&&
      Number.isFinite(admitted)&&admitted>=confirmed&&admitted<expires);
    admittedAt=Math.floor(admitted);
  }
  return Object.freeze({id:q.id as string,agreementId:a.planId,buyerId:q.buyer_id as string,setupId:q.setup_request_id as string,
    setupIntentId:q.setup_intent_id as string,originalPaymentIntentId:q.original_payment_intent_id as string,
    replacementPaymentMethodId:q.replacement_payment_method_id as string,authorization:a,amountCents:expected.amountCents,
    applicationFeeCents:expected.fees.totalCreatorDeductionCents,confirmedAt:Math.floor(confirmed),expiresAt:expires,admittedAt});
}

/** Private service-role adapter. No caller-supplied price, fee, card or PI is
 * admitted. Owner filtering applies even before a payment could be attempted. */
export function createExactPaymentRetryStore(admin:SupabaseClient):ExactPaymentRetryStore {
  async function load(quoteId:string,agreementId:string,buyerId:string) {
    [quoteId,agreementId,buyerId].forEach(assertAgreementId);
    const {data:q,error}=await admin.from("exact_installment_payment_confirmations").select("*")
      .eq("id",quoteId).eq("agreement_id",agreementId).eq("buyer_id",buyerId).single();
    check(!error&&q);
    const {data:r,error:retryError}=await admin.from("exact_installment_retry_admissions").select("*")
      .eq("confirmation_id",quoteId).maybeSingle();
    check(!retryError);
    const result=parseExactRetryAuthorization(q,r);
    check(result.id===quoteId&&result.agreementId===agreementId&&result.buyerId===buyerId);return result;
  }
  const rpc=async(name:string,params:Record<string,unknown>)=>{
    const {data,error}=await admin.rpc(name,params);check(!error&&typeof data==="boolean");return data as boolean;
  };
  return {load,
    async find(agreementId,invoiceId) {
      assertAgreementId(agreementId);check(/^in_[a-zA-Z0-9]+$/.test(invoiceId));
      const {data:r,error}=await admin.from("exact_installment_retry_admissions").select("*")
        .eq("agreement_id",agreementId).eq("stripe_invoice_id",invoiceId).maybeSingle();
      check(!error);if(!r) return null;
      const {data:q,error:quoteError}=await admin.from("exact_installment_payment_confirmations").select("*")
        .eq("id",r.confirmation_id).eq("agreement_id",agreementId).eq("stripe_invoice_id",invoiceId).single();
      check(!quoteError&&q);const result=parseExactRetryAuthorization(q,r);
      check(result.agreementId===agreementId&&result.authorization.invoiceId===invoiceId&&result.admittedAt!==null);return result;
    },
    async admit(quoteId,buyerId) {
      assertAgreementId(quoteId);assertAgreementId(buyerId);
      return rpc("admit_exact_installment_retry",{p_confirmation_id:quoteId,p_buyer_id:buyerId});
    },
    async recordReceipt(quoteId,r) {
      assertAgreementId(quoteId);
      return rpc("record_exact_installment_retry_receipt",{p_confirmation_id:quoteId,p_invoice_id:r.invoiceId,
        p_payment_intent_id:r.paymentIntentId,p_amount_cents:r.amountCents,p_application_fee_cents:r.applicationFeeCents,
        p_paid_at:new Date(r.paidAt*1000).toISOString()});
    },
  };
}
