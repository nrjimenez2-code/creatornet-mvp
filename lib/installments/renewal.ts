import "server-only";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { calculateInstallmentPlan } from "../installmentPlan";
import type { ExactAgreement, ExactAgreementStore } from "./agreementStore";
import { assertExactInstallmentSandbox,assertExactInstallmentEnvironment } from "./checkoutPreparation";
import { assertPaidHeldInvoiceUsingContract, HELD_INSTALLMENT_VERSION, prepareHeldInstallmentInvoice, type HeldInvoicePreparationContract } from "./heldInvoice";
import type { ExactInvoiceStore, RenewalAuthorization } from "./invoiceStore";
import type { ExactReceiptCreditStore } from "./receiptCredit";
import { hasExpectedFutureEnd } from "./scheduledEnd";

type RenewalStripe=Pick<Stripe,"invoices"|"invoicePayments"|"subscriptions"|"paymentIntents"|
  "charges"|"balanceTransactions"|"customers"|"paymentMethods">;
const id=(v:string|{id:string}|null|undefined)=>typeof v==="string"?v:v?.id;
function requireThat(v:unknown,reason:string):asserts v {
  if(!v) throw new Error(`Exact renewal stopped: ${reason}`);
}
export type ExactRenewalResult=Readonly<{
  status:"busy"|"prepared_unpaid"|"credited"|"already_credited"|"reconciliation_required";
  paymentNumber?:number;
}>;
type Input={agreementId:string;invoiceId:string;store:ExactAgreementStore;invoiceStore:ExactInvoiceStore;
  creditStore:ExactReceiptCreditStore;stripe:RenewalStripe;env:Record<string,string|undefined>;now?:()=>number;
  /** Receipt-event mode: a claim may resolve existing admission, but no Stripe
   * invoice preparation, new dispatch admission or pay call is permitted. */
  reconcileOnly?:boolean;
  /** Additional lower bound for independently admitted replacement-card receipts. */
  minimumChargeCreatedAt?:number};

function checkAgreement(a:ExactAgreement,r:RenewalAuthorization) {
  const t=a.terms;
  requireThat(a.id===r.planId && a.subscriptionId===r.subscriptionId && a.customerId===r.customerId &&
    t.bookingPaymentId===r.bookingPaymentId && t.destinationId===r.destinationId && t.totalCents===r.totalCents &&
    t.paymentCount===r.paymentCount && t.currency===r.currency &&
    t.renewalFeeSchedule.enabled===r.feeSchedule.enabled && t.renewalFeeSchedule.basisPoints===r.feeSchedule.basisPoints &&
    t.renewalFeeSchedule.fixedCents===r.feeSchedule.fixedCents && t.renewalFeeSchedule.version===r.feeSchedule.version,
  "agreement and durable invoice claim differ");
}

/** A paid invoice is not evidence enough: verify its default invoice payment,
 * captured card charge, actual integer application fee and balance transaction.
 * No new Stripe mutation, nor trusting money fields in the webhook payload. */
type ReceiptStripe = {
  invoices: { retrieve(id:string):Promise<Stripe.Invoice> };
  invoicePayments: { list(params:Stripe.InvoicePaymentListParams):Promise<Stripe.ApiList<Stripe.InvoicePayment>> };
  paymentIntents: { retrieve(id:string):Promise<Stripe.PaymentIntent> };
  charges: { retrieve(id:string):Promise<Stripe.Charge> };
  balanceTransactions: { retrieve(id:string):Promise<Stripe.BalanceTransaction> };
};
export type RenewalReceiptContract = Pick<HeldInvoicePreparationContract,"expectedLiveMode"|"collectionVersion"|"metadata"> &
  Readonly<{ now:()=>number; minimumChargeCreatedAt?:number }>;

/** Shared captured-payment inspector only: no dispatch, credit or provider writes. */
export async function inspectPaidRenewal(stripe:ReceiptStripe,a:RenewalAuthorization,expectedPI:string,contract:RenewalReceiptContract) {
  const invoice=await stripe.invoices.retrieve(a.invoiceId);
  if(invoice.status!=="paid") return null;
  const payment=assertPaidHeldInvoiceUsingContract(invoice,a,contract);
  const links=await stripe.invoicePayments.list({invoice:a.invoiceId,limit:100});
  requireThat(!links.has_more && links.data.length===1,"ambiguous captured invoice linkage");
  const link=links.data[0];
  requireThat(link.livemode===contract.expectedLiveMode && link.is_default===true && id(link.invoice)===a.invoiceId &&
    link.currency==="usd" && link.status==="paid" && link.amount_requested===payment.amountCents &&
    link.amount_paid===payment.amountCents && link.payment.type==="payment_intent" &&
    id(link.payment.payment_intent)===expectedPI,"captured default payment differs");
  const pi=await stripe.paymentIntents.retrieve(expectedPI);
  requireThat(pi.livemode===contract.expectedLiveMode && pi.id===expectedPI && pi.status==="succeeded" &&
    id(pi.customer)===a.customerId && pi.currency==="usd" && pi.amount===payment.amountCents &&
    pi.amount_received===payment.amountCents && pi.application_fee_amount===payment.fees.totalCreatorDeductionCents &&
    id(pi.transfer_data?.destination)===a.destinationId && pi.transfer_data?.amount==null &&
    id(pi.payment_method)===a.paymentMethodId && pi.payment_method_types.length===1 && pi.payment_method_types[0]==="card",
  "captured renewal PaymentIntent differs");
  const chargeId=id(pi.latest_charge);
  requireThat(chargeId,"captured renewal charge missing");
  const charge=await stripe.charges.retrieve(chargeId);
  requireThat(charge.id===chargeId && charge.livemode===contract.expectedLiveMode && charge.paid===true && charge.captured===true &&
    charge.status==="succeeded" && id(charge.payment_intent)===expectedPI && id(charge.customer)===a.customerId &&
    charge.currency==="usd" && charge.amount===payment.amountCents && charge.amount_captured===payment.amountCents &&
    charge.payment_method===a.paymentMethodId && charge.payment_method_details?.type==="card" &&
    Number.isSafeInteger(charge.created) && charge.created>=a.periodStart &&
    (contract.minimumChargeCreatedAt===undefined || Number.isSafeInteger(contract.minimumChargeCreatedAt) && charge.created>=contract.minimumChargeCreatedAt) &&
    charge.created<=contract.now(),"captured renewal charge differs");
  requireThat(Number.isSafeInteger(charge.amount_refunded) && charge.amount_refunded>=0 &&
    charge.amount_refunded<=charge.amount && charge.refunded===(charge.amount_refunded===charge.amount),"invalid refund evidence");
  const balanceId=id(charge.balance_transaction);
  requireThat(balanceId && /^txn_[a-zA-Z0-9]+$/.test(balanceId),"renewal balance transaction not available");
  const balance=await stripe.balanceTransactions.retrieve(balanceId);
  requireThat(balance.id===balanceId && id(balance.source)===charge.id && balance.type==="charge" &&
    balance.currency==="usd" && balance.amount===payment.amountCents && Number.isSafeInteger(balance.fee) &&
    balance.fee>=0 && balance.fee<=99999999 && balance.net===balance.amount-balance.fee,"renewal balance evidence differs");
  return Object.freeze({ invoiceId:a.invoiceId,paymentIntentId:expectedPI,amountCents:payment.amountCents,
    applicationFeeCents:payment.fees.totalCreatorDeductionCents,paidAt:charge.created,chargeId:charge.id,
    balanceTransactionId:balanceId,actualStripeFeeCents:balance.fee,refundedAmountCents:charge.amount_refunded });
}

async function reconcilePaid(args:Input,a:RenewalAuthorization,expectedPI:string):Promise<ExactRenewalResult> {
  const receipt=await inspectPaidRenewal(args.stripe,a,expectedPI,{expectedLiveMode:false,collectionVersion:HELD_INSTALLMENT_VERSION,
    metadata:{},now:args.now??(()=>Math.floor(Date.now()/1000)),minimumChargeCreatedAt:args.minimumChargeCreatedAt});
  if(!receipt) return {status:"reconciliation_required",paymentNumber:a.paymentNumber};
  await args.invoiceStore.recordReceipt(a.planId,receipt);
  await args.creditStore.recordRefundEvidence(expectedPI,receipt.chargeId,receipt.amountCents,receipt.refundedAmountCents);
  const credited=await args.creditStore.credit(a.planId,{paymentNumber:a.paymentNumber,chargeId:receipt.chargeId,
    balanceTransactionId:receipt.balanceTransactionId,actualStripeFeeCents:receipt.actualStripeFeeCents});
  await args.creditStore.reconcileDispute(expectedPI);
  if(a.paymentNumber===a.paymentCount) await args.invoiceStore.completeAgreement(a.planId);
  return {status:credited?"credited":"already_credited",paymentNumber:a.paymentNumber};
}

/** Recovery for an ORIGINAL persisted admission. No prepare/admit/pay path is
 * reachable here, even when creation and new collection have been paused. */
export async function reconcileExactRenewalReceiptSandbox(args:Input,a:RenewalAuthorization,expectedPI:string):Promise<ExactRenewalResult> {
  assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
  requireThat(args.env.CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY==="true"&&
    args.env.CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY==="true","recovery schema not enabled");
  const agreement=await args.store.load(args.agreementId);
  assertExactInstallmentEnvironment(args.env,agreement.terms.previewOrigin);checkAgreement(agreement,a);
  requireThat(a.planId===args.agreementId&&a.invoiceId===args.invoiceId&&/^pi_[a-zA-Z0-9]+$/.test(expectedPI),"recovery binding differs");
  try {return await reconcilePaid(args,a,expectedPI);}
  catch {throw new Error("Exact recovery captured-payment reconciliation unavailable");}
}

/** Re-read previous Stripe payments as well as database refund mirrors; an
 * out-of-order or delayed refund/dispute webhook must not authorize a new debit.
 * Dashboard changes after admission remain a reconciliation boundary, not an
 * impossible promise of an atomic transaction across Stripe and Postgres. */
async function verifyBeforeDispatch(args:Input,a:RenewalAuthorization,allowPastDue=false) {
  const {stripe}=args;
  const current=await args.store.load(a.planId);
  checkAgreement(current,a);
  requireThat(current.status==="active","agreement no longer active");
  const now=(args.now??(()=>Math.floor(Date.now()/1000)))();
  requireThat(now>=a.periodStart && now<a.periodEnd,"collection outside authorized period");
  if(a.cardAuthorizationId) requireThat(args.env.CREATOR_EXACT_INSTALLMENTS_FUTURE_CARD_READY==="true",
    "future card authorization not enabled");
  const prior=await args.invoiceStore.priorPayments(a.planId);
  const payments=calculateInstallmentPlan(current.terms.totalCents,current.terms.paymentCount,
    current.terms.renewalFeeSchedule,current.terms.firstPaymentFeeSchedule).payments;
  await verifyRenewalProviderHistory(stripe,a,prior,payments,false);
  const originalDefault=a.defaultPaymentMethodId || a.paymentMethodId;
  const sub=await stripe.subscriptions.retrieve(a.subscriptionId);
  requireThat(sub.id===a.subscriptionId && sub.livemode===false && (sub.status==="active" || allowPastDue && sub.status==="past_due") &&
    sub.pause_collection?.behavior==="keep_as_draft" && sub.pause_collection.resumes_at==null &&
    sub.collection_method==="charge_automatically" && hasExpectedFutureEnd(sub,a.cancelAt,current.createdAt,now,allowPastDue) &&
    sub.pending_update==null && sub.schedule==null &&
    id(sub.customer)===a.customerId && id(sub.default_payment_method)===originalDefault && !sub.default_source &&
    sub.application_fee_percent==null && id(sub.transfer_data?.destination)===a.destinationId &&
    sub.transfer_data?.amount_percent==null && sub.metadata.installment_plan_id===a.planId &&
    sub.metadata.installment_collection_version===HELD_INSTALLMENT_VERSION,"held subscription changed before dispatch");
}

/** Original card/customer/prior-capture checks shared with the owned context.
 * Caller separately checks current agreement/time and its actual subscription. */
export async function verifyRenewalProviderHistory(stripe: {
  paymentMethods:{retrieve(id:string):Promise<Stripe.PaymentMethod>}; customers:{retrieve(id:string):Promise<Stripe.Customer|Stripe.DeletedCustomer>};
  paymentIntents:{retrieve(id:string):Promise<Stripe.PaymentIntent>}; charges:{retrieve(id:string):Promise<Stripe.Charge>};
},a:RenewalAuthorization,prior:ReadonlyArray<{paymentNumber:number;paymentIntentId:string}>,
payments:ReturnType<typeof calculateInstallmentPlan>["payments"],expectedLiveMode:boolean) {
  const originalDefault=a.defaultPaymentMethodId || a.paymentMethodId;
  const pm=await stripe.paymentMethods.retrieve(a.paymentMethodId);
  requireThat(pm.id===a.paymentMethodId && pm.livemode===expectedLiveMode && pm.type==="card" &&
    id(pm.customer)===a.customerId,"saved card no longer belongs to customer");
  const customer=await stripe.customers.retrieve(a.customerId);
  requireThat(!customer.deleted && customer.id===a.customerId && customer.livemode===expectedLiveMode && customer.balance===0 &&
    !customer.default_source && (!customer.invoice_settings.default_payment_method ||
      id(customer.invoice_settings.default_payment_method)===originalDefault),"customer balance/default changed");
  requireThat(prior.length===a.paymentNumber-1,"prior installments not all credited");
  for(const [i,r] of prior.entries()) {
    requireThat(r.paymentNumber===i+1,"prior payment order changed");
    const expected=payments[i];
    const pi=await stripe.paymentIntents.retrieve(r.paymentIntentId);
    requireThat(pi.id===r.paymentIntentId && pi.livemode===expectedLiveMode && pi.status==="succeeded" &&
      id(pi.customer)===a.customerId && pi.amount_received===expected.amountCents && pi.amount===expected.amountCents &&
      pi.application_fee_amount===expected.fees.totalCreatorDeductionCents &&
      id(pi.transfer_data?.destination)===a.destinationId && pi.transfer_data?.amount==null && pi.currency==="usd",
    "prior payment identity or fee changed");
    const cid=id(pi.latest_charge); requireThat(cid,"prior captured charge missing");
    const c=await stripe.charges.retrieve(cid);
    requireThat(c.id===cid && c.livemode===expectedLiveMode && c.paid===true && c.captured===true && c.status==="succeeded" &&
      id(c.payment_intent)===pi.id && id(c.customer)===a.customerId && c.amount===expected.amountCents &&
      c.amount_captured===expected.amountCents && c.currency==="usd" && c.amount_refunded===0 &&
      c.refunded===false && c.disputed===false,"prior payment refund/dispute requires review");
  }
}

/** Read-only preflight for a separately confirmed invoice retry. Defaults and
 * all prior receipt/refund/dispute checks still use the ORIGINAL card. Only a
 * past_due held subscription is additionally allowed; normal renewal admission
 * remains unchanged. This helper cannot admit, pay, or change defaults. */
export async function verifyExactRetryHistorySandbox(args:Input,a:RenewalAuthorization):Promise<void> {
  assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
  requireThat(args.env.CREATOR_EXACT_INSTALLMENTS_RETRY_READY==="true","retry schema not enabled");
  await verifyBeforeDispatch(args,a,true);
}

/** Sandbox candidate. One durable admission permits one pay call only.
 * A decline, SCA challenge, timeout, or lost response goes to reconciliation;
 * neither a webhook retry nor a stale worker is allowed to retry the charge.
 * The canonical webhook can select a bounded allowlisted staging agreement;
 * legacy checkout remains separate. Before enabling, accept the entire lifecycle
 * with real Sandbox events and a deployed staging schema. Receipt-only mode
 * must never configure an unpaid invoice or grant a new dispatch admission.
 */
export async function collectExactRenewalSandbox(args:Input):Promise<ExactRenewalResult> {
  const agreement=await args.store.load(args.agreementId);
  assertExactInstallmentSandbox(args.env,agreement.terms.previewOrigin);
  requireThat(agreement.customerId && agreement.subscriptionId,"agreement not bound");
  requireThat(/^in_[a-zA-Z0-9]+$/.test(args.invoiceId),"invalid invoice identity");
  const invoice=await args.stripe.invoices.retrieve(args.invoiceId);
  requireThat(invoice.id===args.invoiceId && invoice.livemode===false &&
    id(invoice.customer)===agreement.customerId && id(invoice.parent?.subscription_details?.subscription)===agreement.subscriptionId &&
    invoice.billing_reason==="subscription_cycle" && !invoice.lines.has_more,"not a bound renewal invoice");
  const base=invoice.lines.data.filter(l=>l.parent?.type==="subscription_item_details");
  requireThat(base.length===1 && base[0].parent?.subscription_item_details?.proration===false,"ambiguous invoice period");
  const token=randomUUID();
  const claim=await args.invoiceStore.claim(agreement.id,invoice.id,agreement.subscriptionId,
    base[0].period.start,base[0].period.end,token);
  if(claim.status==="busy") return {status:"busy"};
  const a=claim.authorization;
  checkAgreement(agreement,a);
  requireThat(a.invoiceId===invoice.id && a.periodStart===base[0].period.start && a.periodEnd===base[0].period.end,
    "claimed invoice period differs");
  if(claim.status==="reconcile") {
    if(!claim.paymentIntentId) return {status:"reconciliation_required",paymentNumber:a.paymentNumber};
    return reconcilePaid(args,a,claim.paymentIntentId);
  }
  if(args.reconcileOnly) return {status:"reconciliation_required",paymentNumber:a.paymentNumber};
  if(a.cardAuthorizationId) requireThat(args.env.CREATOR_EXACT_INSTALLMENTS_FUTURE_CARD_READY==="true",
    "future card authorization not enabled");
  const verified=await prepareHeldInstallmentInvoice(args.stripe,a);
  await args.invoiceStore.prepareDispatch(a.planId,a.invoiceId,verified.paymentIntentId,token);
  if(args.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT!=="true") {
    return {status:"prepared_unpaid",paymentNumber:a.paymentNumber};
  }
  await verifyBeforeDispatch(args,a);
  // Re-verify the actual invoice default PI after other network requests; a
  // changed amount/fee or outside payment must stop before durable admission.
  const final=await prepareHeldInstallmentInvoice(args.stripe,a);
  requireThat(final.paymentIntentId===verified.paymentIntentId,"default PaymentIntent changed before dispatch");
  await args.invoiceStore.admitDispatch(a.planId,a.invoiceId,token);
  try {
    // Stripe rejects forgive + paid_out_of_band together even when both are
    // false. Omit both: their documented defaults are false, preserving a real
    // full-amount card attempt without forgiveness or out-of-band settlement.
    await args.stripe.invoices.pay(a.invoiceId,{payment_method:a.paymentMethodId,off_session:true},
      {idempotencyKey:`${HELD_INSTALLMENT_VERSION}:${a.planId}:${a.invoiceId}:pay-once-v1`,
      maxNetworkRetries:0});
  } catch {
    // Never print raw Stripe errors: they may contain sensitive payment data.
    // Retrieve below may prove a lost successful response. Otherwise preserve
    // the admitted claim and report a hold; do not schedule another pay call.
  }
  return reconcilePaid(args,a,verified.paymentIntentId);
}
