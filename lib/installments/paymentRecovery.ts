import "server-only";
import {randomUUID} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import type Stripe from "stripe";
import {assertAgreementId,operationHash} from "./agreementStore";
import {assertExactInstallmentEnvironment} from "./checkoutPreparation";
import {assertRecoveryHeldInvoiceUsingContract,HELD_INSTALLMENT_VERSION,type HeldInvoicePreparationContract} from "./heldInvoice";
import type {RenewalAuthorization} from "./invoiceStore";
import {reconcileExactRenewalReceiptSandbox} from "./renewal";
import {reconcileExactRetryReceiptSandbox} from "./paymentRetry";
import type {ExactPaymentRetryStore} from "./paymentRetryStore";

export type RecoveryOutcome="action_required"|"payment_method_required"|"payment_pending"|"terminal_unpaid"|"paid_accounted"|"review_required";
export type RecoveryRead=Readonly<{revision:number;basis:Record<string,unknown>;paymentIntentId:string;subscriptionId:string;
  periodStart:number;periodEnd:number;dispatchStartedAt:number}>;
export type RecoveryEvidence=Readonly<{invoiceStatus:string|null;paymentStatus:string;amountReceived:number;amountCapturable:number;
  canceledAt:number|null;voidedAt:number|null}>;
export interface ExactPaymentRecoveryStore {
  has(agreementId:string,invoiceId:string):Promise<boolean>;
  begin(agreementId:string,invoiceId:string):Promise<RecoveryRead>;
  finish(agreementId:string,invoiceId:string,eventId:string,read:RecoveryRead,outcome:RecoveryOutcome,evidence:RecoveryEvidence):Promise<boolean>;
}
function requireThat(v:unknown,why:string):asserts v {if(!v) throw new Error(`Exact payment recovery: ${why}`);}
const id=(v:string|{id:string}|null|undefined)=>typeof v==="string"?v:v?.id;
export function parseExactRecoveryRead(value:unknown):RecoveryRead {
  requireThat(value&&typeof value==="object"&&!Array.isArray(value),"invalid recovery basis");
  const r=value as Record<string,unknown>, basis=r.basis as Record<string,unknown>;
  requireThat(Number.isSafeInteger(r.revision)&&Number(r.revision)>=0&&basis&&typeof basis==="object"&&!Array.isArray(basis)&&
    typeof r.paymentIntentId==="string"&&/^pi_[a-zA-Z0-9]+$/.test(r.paymentIntentId)&&
    typeof r.subscriptionId==="string"&&/^sub_[a-zA-Z0-9]+$/.test(r.subscriptionId)&&
    [r.periodStart,r.periodEnd,r.dispatchStartedAt].every(v=>Number.isSafeInteger(v)&&Number(v)>0)&&
    Number(r.periodStart)<Number(r.periodEnd)&&Number(r.dispatchStartedAt)>=Number(r.periodStart)&&Number(r.dispatchStartedAt)<Number(r.periodEnd)&&
    basis.paymentIntentId===r.paymentIntentId&&["dispatching","paid"].includes(String(basis.claimStatus)),"invalid recovery basis");
  return value as RecoveryRead;
}
export function createExactPaymentRecoveryStore(admin:SupabaseClient):ExactPaymentRecoveryStore {
  const rpc=async(name:string,params:Record<string,unknown>)=>{
    const {data,error}=await admin.rpc(name,params);if(error) throw new Error(`Exact recovery database operation failed: ${name}`);return data;
  };
  const identity=(agreementId:string,invoiceId:string)=>{assertAgreementId(agreementId);requireThat(/^in_[a-zA-Z0-9]+$/.test(invoiceId),"invalid invoice identity");};
  return {
    async has(agreementId,invoiceId) {
      identity(agreementId,invoiceId);
      const {data,error}=await admin.from("exact_installment_payment_recoveries").select("stripe_invoice_id")
        .eq("agreement_id",agreementId).eq("stripe_invoice_id",invoiceId).maybeSingle();
      if(error) throw new Error("Exact recovery lookup failed");return Boolean(data);
    },
    async begin(agreementId,invoiceId) {
      identity(agreementId,invoiceId);const r=await rpc("begin_exact_installment_recovery",{p_agreement_id:agreementId,p_invoice_id:invoiceId});
      return parseExactRecoveryRead(r);
    },
    async finish(agreementId,invoiceId,eventId,r,outcome,evidence) {
      identity(agreementId,invoiceId);requireThat(/^evt_[a-zA-Z0-9]+$/.test(eventId),"invalid event identity");
      const value=await rpc("finish_exact_installment_recovery",{p_agreement_id:agreementId,p_invoice_id:invoiceId,
        p_payment_intent_id:r.paymentIntentId,p_revision:r.revision,p_basis:r.basis,p_outcome:outcome,p_event_id:eventId,p_evidence:evidence});
      requireThat(typeof value==="boolean","invalid recovery result");return value;
    },
  };
}

type Input=Parameters<typeof reconcileExactRenewalReceiptSandbox>[0]&{eventId:string;recoveryStore:ExactPaymentRecoveryStore;
  retryStore?:ExactPaymentRetryStore};
export type PaymentRecoveryResult=Readonly<{status:"payment_recovery_recorded"|"reconciliation_required";outcome?:RecoveryOutcome}>;

/** No Stripe writes. Holds the original admitted invoice before reads. A lost
 * successful response can be reconciled through the existing once-only receipt
 * path. Declines/SCA remain actionable records, never renewed pay permission. */
export async function recoverExactRenewalSandbox(args:Input):Promise<PaymentRecoveryResult> {
  assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
  requireThat(args.env.CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY==="true"&&args.env.CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY==="true",
    "recovery schema not enabled");
  assertAgreementId(args.agreementId);requireThat(/^in_[a-zA-Z0-9]+$/.test(args.invoiceId)&&/^evt_[a-zA-Z0-9]+$/.test(args.eventId),"invalid identity");
  const agreement=await args.store.load(args.agreementId);
  assertExactInstallmentEnvironment(args.env,agreement.terms.previewOrigin);
  let snapshot=await args.recoveryStore.begin(args.agreementId,args.invoiceId);
  requireThat(snapshot.subscriptionId===agreement.subscriptionId,"saved subscription differs");
  const claim=await args.invoiceStore.claim(agreement.id,args.invoiceId,snapshot.subscriptionId,snapshot.periodStart,snapshot.periodEnd,randomUUID());
  requireThat(claim.status==="reconcile"&&claim.paymentIntentId===snapshot.paymentIntentId,"original admission not available");
  const a=claim.authorization;
  requireThat(a.planId===agreement.id&&a.invoiceId===args.invoiceId&&a.customerId===agreement.customerId&&a.subscriptionId===agreement.subscriptionId&&
    a.totalCents===agreement.terms.totalCents&&a.paymentCount===agreement.terms.paymentCount&&a.destinationId===agreement.terms.destinationId&&
    a.bookingPaymentId===agreement.terms.bookingPaymentId&&a.periodStart===snapshot.periodStart&&a.periodEnd===snapshot.periodEnd&&
    a.feeSchedule.enabled===agreement.terms.renewalFeeSchedule.enabled&&a.feeSchedule.basisPoints===agreement.terms.renewalFeeSchedule.basisPoints&&
    a.feeSchedule.fixedCents===agreement.terms.renewalFeeSchedule.fixedCents&&a.feeSchedule.version===agreement.terms.renewalFeeSchedule.version,
  "saved authorization differs");
  // New-card evidence is considered only behind the separately installed schema
  // gate. No optional-table query occurs for existing/unflagged deployments.
  const retryEnabled=args.env.CREATOR_EXACT_INSTALLMENTS_RETRY_READY==="true";
  if(retryEnabled) requireThat(args.retryStore,"retry receipt store unavailable");
  const retry=retryEnabled?await args.retryStore!.find(agreement.id,args.invoiceId):null;
  if(retry) requireThat(retry.agreementId===agreement.id&&retry.buyerId===agreement.terms.buyerId&&retry.admittedAt!==null&&
    retry.admittedAt<=(args.now??(()=>Math.floor(Date.now()/1000)))()&&retry.originalPaymentIntentId===snapshot.paymentIntentId&&
    operationHash(retry.authorization)===operationHash(a),"replacement admission differs");
  const authorizedCard=retry?.replacementPaymentMethodId??a.paymentMethodId;
  const read=async<T,>(fn:()=>Promise<T>):Promise<T>=>{try{return await fn();}catch{throw new Error("Exact recovery Stripe evidence unavailable");}};
  const invoice=await read(()=>args.stripe.invoices.retrieve(args.invoiceId));
  requireThat(invoice.id===a.invoiceId&&invoice.livemode===false&&id(invoice.customer)===a.customerId&&
    id(invoice.parent?.subscription_details?.subscription)===a.subscriptionId,"invoice ownership differs");
  if(invoice.status==="paid") {
    // This helper has no prepare/pay branch and verifies invoice, PI, captured
    // charge, fee, destination and balance before once-only ledger credit.
    const result=retry?await reconcileExactRetryReceiptSandbox({...args,retryStore:args.retryStore!}):
      await reconcileExactRenewalReceiptSandbox(args,a,snapshot.paymentIntentId);
    if(result.status!=="credited"&&result.status!=="already_credited") return {status:"reconciliation_required"};
    snapshot=await args.recoveryStore.begin(agreement.id,args.invoiceId); // credit changed the local basis
    const saved=await args.recoveryStore.finish(agreement.id,args.invoiceId,args.eventId,snapshot,"paid_accounted",
      {invoiceStatus:"paid",paymentStatus:"succeeded",amountReceived:invoice.amount_paid,amountCapturable:0,canceledAt:null,voidedAt:null});
    return saved?{status:"payment_recovery_recorded",outcome:"paid_accounted"}:{status:"reconciliation_required"};
  }
  const observed=await inspectUnpaidExactRecovery(args.stripe,invoice,a,snapshot,authorizedCard,
    {expectedLiveMode:false,collectionVersion:HELD_INSTALLMENT_VERSION,metadata:{}},args.now);
  const saved=await args.recoveryStore.finish(agreement.id,args.invoiceId,args.eventId,snapshot,observed.outcome,observed.evidence);
  return saved?{status:"payment_recovery_recorded",outcome:observed.outcome}:{status:"reconciliation_required"};
}

type RecoveryReader={
  invoicePayments:{list(p:Stripe.InvoicePaymentListParams):Promise<Stripe.ApiList<Stripe.InvoicePayment>>};
  paymentIntents:{retrieve(id:string):Promise<Stripe.PaymentIntent>};
  charges:{retrieve(id:string):Promise<Stripe.Charge>};
};
/** Shared original unpaid classifier. No write-capable provider is required.
 * Caller must persist the original admission's recovery hold before these reads. */
export async function inspectUnpaidExactRecovery(stripe:RecoveryReader,invoice:Stripe.Invoice,a:RenewalAuthorization,
  snapshot:RecoveryRead,authorizedCard:string,
  contract:Pick<HeldInvoicePreparationContract,"expectedLiveMode"|"collectionVersion"|"metadata">,
  clock:()=>number=()=>Math.floor(Date.now()/1000)):Promise<{outcome:RecoveryOutcome;evidence:RecoveryEvidence}> {
  const read=async<T,>(fn:()=>Promise<T>):Promise<T>=>{try{return await fn();}catch{throw new Error("Exact recovery Stripe evidence unavailable");}};
  const expected=assertRecoveryHeldInvoiceUsingContract(invoice,a,contract);
  const links=await read(()=>stripe.invoicePayments.list({invoice:a.invoiceId,limit:100}));
  requireThat(!links.has_more&&links.data.length===1,"ambiguous invoice payments");
  const link=links.data[0];
  requireThat(link.livemode===contract.expectedLiveMode&&id(link.invoice)===a.invoiceId&&link.is_default===true&&link.currency==="usd"&&
    (link.status==="open"||link.status==="canceled")&&(link.amount_paid===null||link.amount_paid===0)&&
    link.amount_requested===expected.amountCents&&link.payment.type==="payment_intent"&&
    id(link.payment.payment_intent)===snapshot.paymentIntentId,"invoice payment changed");
  const pi=await read(()=>stripe.paymentIntents.retrieve(snapshot.paymentIntentId));
  requireThat(pi.id===snapshot.paymentIntentId&&pi.livemode===contract.expectedLiveMode&&id(pi.customer)===a.customerId&&pi.currency==="usd"&&
    pi.amount===expected.amountCents&&pi.application_fee_amount===expected.fees.totalCreatorDeductionCents&&
    id(pi.transfer_data?.destination)===a.destinationId&&pi.transfer_data?.amount==null&&
    pi.payment_method_types.length===1&&pi.payment_method_types[0]==="card"&&
    (pi.payment_method==null||id(pi.payment_method)===authorizedCard)&&
    Number.isSafeInteger(pi.amount_received)&&pi.amount_received===0&&Number.isSafeInteger(pi.amount_capturable)&&
    pi.amount_capturable>=0&&pi.amount_capturable<=expected.amountCents,"payment evidence differs or capture needs reconciliation");
  const now=clock();
  let outcome:RecoveryOutcome="review_required";
  if(invoice.status==="open"&&pi.amount_capturable===0&&link.status==="open") {
    if(pi.status==="requires_action") outcome="action_required";
    if(pi.status==="requires_payment_method") outcome="payment_method_required";
    if(pi.status==="processing"||pi.status==="requires_confirmation") outcome="payment_pending";
  }
  if(invoice.status==="open"&&pi.status==="requires_capture") outcome="payment_pending";
  if(invoice.status==="void"&&pi.status==="canceled"&&link.status==="canceled"&&pi.amount_capturable===0&&pi.next_action==null&&
    Number.isSafeInteger(pi.canceled_at)&&pi.canceled_at!>=snapshot.dispatchStartedAt&&pi.canceled_at!<=now&&
    Number.isSafeInteger(invoice.status_transitions.voided_at)&&invoice.status_transitions.voided_at!>=snapshot.dispatchStartedAt&&
    invoice.status_transitions.voided_at!<=now) {
    const cid=id(pi.latest_charge);
    if(cid) {
      const c=await read(()=>stripe.charges.retrieve(cid));
      requireThat(c.id===cid&&c.livemode===contract.expectedLiveMode&&id(c.payment_intent)===pi.id&&id(c.customer)===a.customerId&&
        c.currency==="usd"&&c.amount===expected.amountCents&&c.status==="failed"&&c.paid===false&&c.captured===false&&
        c.amount_captured===0&&c.amount_refunded===0&&c.balance_transaction==null,"terminal charge evidence differs");
    }
    outcome="terminal_unpaid";
  }
  return {outcome,evidence:{invoiceStatus:invoice.status,paymentStatus:pi.status,amountReceived:pi.amount_received,amountCapturable:pi.amount_capturable,
    canceledAt:pi.canceled_at,voidedAt:invoice.status_transitions.voided_at}};
}
