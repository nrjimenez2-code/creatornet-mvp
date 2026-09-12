import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAgreementId } from "./agreementStore";
import type { HeldInvoiceAuthorization } from "./heldInvoice";
import { calculateInstallmentPlan } from "../installmentPlan";

export type RenewalAuthorization = HeldInvoiceAuthorization & Readonly<{ paymentMethodId:string;
  cardAuthorizationId?:string; defaultPaymentMethodId?:string }>;
export type RenewalClaim = { status:"busy" } |
  { status:"prepare"; authorization:RenewalAuthorization } |
  { status:"reconcile"; authorization:RenewalAuthorization; paymentIntentId:string|null };
export type RenewalReceipt = Readonly<{
  invoiceId:string; paymentIntentId:string; amountCents:number; applicationFeeCents:number; paidAt:number;
}>;
export interface ExactInvoiceStore {
  claim(agreementId:string,invoiceId:string,subscriptionId:string,start:number,end:number,token:string):Promise<RenewalClaim>;
  prepareDispatch(agreementId:string,invoiceId:string,paymentIntentId:string,token:string):Promise<void>;
  admitDispatch(agreementId:string,invoiceId:string,token:string):Promise<void>;
  recordReceipt(agreementId:string,receipt:RenewalReceipt):Promise<boolean>;
  completeAgreement(agreementId:string):Promise<void>;
  priorPayments(agreementId:string):Promise<ReadonlyArray<{paymentNumber:number;paymentIntentId:string}>>;
}

export function parseRenewalAuthorization(value:unknown):RenewalAuthorization {
  if(!value || typeof value!=="object" || Array.isArray(value)) throw new Error("Invalid renewal authorization");
  const a=value as RenewalAuthorization;
  assertAgreementId(a.planId); assertAgreementId(a.bookingPaymentId);
  for(const [v,re] of [[a.invoiceId,/^in_[a-zA-Z0-9]+$/],[a.subscriptionId,/^sub_[a-zA-Z0-9]+$/],
    [a.subscriptionItemId,/^si_[a-zA-Z0-9]+$/],[a.customerId,/^cus_[a-zA-Z0-9]+$/],
    [a.destinationId,/^acct_[a-zA-Z0-9]+$/],[a.paymentMethodId,/^pm_[a-zA-Z0-9]+$/]] as const) {
    if(typeof v!=="string" || !re.test(v)) throw new Error("Invalid renewal Stripe identity");
  }
  if(a.currency!=="usd" || !Number.isInteger(a.paymentNumber) || a.paymentNumber<2 || a.paymentNumber>a.paymentCount ||
    ![a.periodStart,a.periodEnd,a.cancelAt].every(v=>Number.isSafeInteger(v)&&v>0) ||
    a.periodStart>=a.periodEnd || a.periodEnd>a.cancelAt || !a.feeSchedule ||
    typeof a.feeSchedule.enabled!=="boolean" || !Number.isSafeInteger(a.feeSchedule.basisPoints) ||
    a.feeSchedule.basisPoints<0 || a.feeSchedule.basisPoints>10000 || !Number.isSafeInteger(a.feeSchedule.fixedCents) ||
    a.feeSchedule.fixedCents<0 || typeof a.feeSchedule.version!=="string" || !a.feeSchedule.version.trim()) {
    throw new Error("Invalid renewal period/fee snapshot");
  }
  calculateInstallmentPlan(a.totalCents,a.paymentCount,a.feeSchedule);
  if(a.cardAuthorizationId!==undefined || a.defaultPaymentMethodId!==undefined) {
    assertAgreementId(a.cardAuthorizationId!);
    if(typeof a.defaultPaymentMethodId!=="string" || !/^pm_[a-zA-Z0-9]+$/.test(a.defaultPaymentMethodId) || a.paymentNumber<3)
      throw new Error("Invalid future card authorization");
  }
  return Object.freeze({planId:a.planId,bookingPaymentId:a.bookingPaymentId,invoiceId:a.invoiceId,
    subscriptionId:a.subscriptionId,subscriptionItemId:a.subscriptionItemId,customerId:a.customerId,
    destinationId:a.destinationId,paymentMethodId:a.paymentMethodId,currency:"usd",totalCents:a.totalCents,
    paymentCount:a.paymentCount,paymentNumber:a.paymentNumber,periodStart:a.periodStart,periodEnd:a.periodEnd,
    cancelAt:a.cancelAt,feeSchedule:Object.freeze({...a.feeSchedule}),
    ...(a.cardAuthorizationId ? {cardAuthorizationId:a.cardAuthorizationId,defaultPaymentMethodId:a.defaultPaymentMethodId} : {})});
}

/** Private service-only RPC adapter. No caller supplies an amount or fee to a
 * claim: the database constructs that authorization from the saved agreement. */
export function createExactInvoiceStore(admin:SupabaseClient):ExactInvoiceStore {
  const rpc=async(name:string,params:Record<string,unknown>)=>{
    const {data,error}=await admin.rpc(name,params);
    if(error) throw new Error(`Exact invoice operation failed: ${name}`);
    return data as unknown;
  };
  return {
    async claim(agreementId,invoiceId,subscriptionId,start,end,token) {
      assertAgreementId(agreementId); assertAgreementId(token);
      const raw=await rpc("claim_exact_installment_invoice",{p_agreement_id:agreementId,p_invoice_id:invoiceId,
        p_subscription_id:subscriptionId,p_period_start:start,p_period_end:end,p_claim_token:token});
      if(raw && typeof raw==="object" && !Array.isArray(raw) && "status" in raw) {
        if(raw.status==="busy") return {status:"busy"};
        if("authorization" in raw) {
          const a=parseRenewalAuthorization(raw.authorization);
          if(a.planId!==agreementId || a.invoiceId!==invoiceId || a.subscriptionId!==subscriptionId ||
            a.periodStart!==start || a.periodEnd!==end) throw new Error("Renewal claim identity mismatch");
          if(raw.status==="prepare") return {status:"prepare",authorization:a};
          if(raw.status==="reconcile" && "paymentIntentId" in raw && (raw.paymentIntentId===null ||
            typeof raw.paymentIntentId==="string" && /^pi_[a-zA-Z0-9]+$/.test(raw.paymentIntentId))) {
            return {status:"reconcile",authorization:a,paymentIntentId:raw.paymentIntentId};
          }
        }
      }
      throw new Error("Invalid renewal claim response");
    },
    async prepareDispatch(agreementId,invoiceId,paymentIntentId,token) {
      await rpc("prepare_exact_installment_dispatch",{p_agreement_id:agreementId,p_invoice_id:invoiceId,
        p_payment_intent_id:paymentIntentId,p_claim_token:token});
    },
    async admitDispatch(agreementId,invoiceId,token) {
      await rpc("admit_exact_installment_dispatch",{p_agreement_id:agreementId,p_invoice_id:invoiceId,p_claim_token:token});
    },
    async recordReceipt(agreementId,r) {
      const value=await rpc("record_exact_installment_renewal_receipt",{p_agreement_id:agreementId,p_invoice_id:r.invoiceId,
        p_payment_intent_id:r.paymentIntentId,p_amount_cents:r.amountCents,p_application_fee_cents:r.applicationFeeCents,
        p_paid_at:new Date(r.paidAt*1000).toISOString()});
      if(typeof value!=="boolean") throw new Error("Invalid renewal receipt response");
      return value;
    },
    async priorPayments(agreementId) {
      assertAgreementId(agreementId);
      const {data,error}=await admin.from("exact_installment_receipts")
        .select("payment_number,stripe_payment_intent_id").eq("agreement_id",agreementId)
        .not("counted_at","is",null).order("payment_number");
      if(error || !Array.isArray(data)) throw new Error("Prior installment evidence unavailable");
      return data.map((r,i)=>{
        if(r.payment_number!==i+1 || typeof r.stripe_payment_intent_id!=="string" ||
          !/^pi_[a-zA-Z0-9]+$/.test(r.stripe_payment_intent_id)) throw new Error("Invalid prior installment evidence");
        return Object.freeze({paymentNumber:r.payment_number as number,paymentIntentId:r.stripe_payment_intent_id as string});
      });
    },
    async completeAgreement(agreementId) {
      assertAgreementId(agreementId);
      await rpc("complete_exact_installment_agreement",{p_agreement_id:agreementId});
    },
  };
}
