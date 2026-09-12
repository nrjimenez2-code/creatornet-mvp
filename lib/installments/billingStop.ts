import "server-only";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateInstallmentPlan } from "../installmentPlan";
import { assertAgreementId, type ExactAgreementStore, type ExactAgreementTerms } from "./agreementStore";
import { assertExactInstallmentEnvironment } from "./checkoutPreparation";

export type BillingStopIdentity = Readonly<{ agreementId:string; requestId:string; actorId:string; token:string }>;
type Identity = BillingStopIdentity;
type Proof = Readonly<{ subscriptionId:string; sessionId:string; canceledAt:number;
  checkoutStatus:"complete"|"expired"; firstPaymentIntentId:string|null }>;
export interface ExactBillingStopStore {
  claim(identity:Identity):Promise<"ready"|"busy"|"complete"|"reconciliation_required">;
  assertClaim(identity:Identity):Promise<void>;
  accounted(agreementId:string,kind:"intent"|"invoice",id:string,amount:number):Promise<boolean>;
  complete(identity:Identity,proof:Proof):Promise<void>;
}
export type BillingStopProvider = {
  customers: { retrieve(id: string): Promise<Stripe.Customer | Stripe.DeletedCustomer> };
  subscriptions: {
    retrieve(id: string): Promise<Stripe.Subscription>;
    list(params: { customer: string; status: "all"; limit: 100 }): Promise<Stripe.ApiList<Stripe.Subscription>>;
    cancel(id: string, params: { invoice_now: false; prorate: false }, options: { maxNetworkRetries: 0 }): Promise<Stripe.Subscription>;
  };
  checkout: { sessions: {
    retrieve(id: string): Promise<Stripe.Checkout.Session>;
    expire(id: string, params: Record<string, never>, options: { idempotencyKey: string; maxNetworkRetries: 0 }): Promise<Stripe.Checkout.Session>;
  } };
  invoices: { list(params: { customer: string; limit: 100; starting_after?: string }): Promise<Stripe.ApiList<Stripe.Invoice>> };
  invoiceItems: { list(params: { customer: string; pending: true; limit: 100 }): Promise<Stripe.ApiList<Stripe.InvoiceItem>> };
  invoicePayments: { list(params: { invoice: string; limit: 100 }): Promise<Stripe.ApiList<Stripe.InvoicePayment>> };
  paymentIntents: { retrieve(id: string): Promise<Stripe.PaymentIntent> };
};
function requireThat(value:unknown,reason:string):asserts value {
  if(!value) throw new Error(`Exact billing stop: ${reason}`);
}
const id=(v:string|{id:string}|null|undefined)=>typeof v==="string"?v:v?.id;
async function read<T>(fn:()=>Promise<T>):Promise<T> {
  try{return await fn();}catch{throw new Error("Exact billing stop: Stripe evidence unavailable");}
}
const identityParams=(i:Identity)=>{
  for(const v of Object.values(i)) assertAgreementId(v);
  return {p_agreement_id:i.agreementId,p_request_id:i.requestId,p_actor_id:i.actorId,p_claim_token:i.token};
};
export function createExactBillingStopStore(admin:SupabaseClient):ExactBillingStopStore {
  return {
    async claim(i) {
      const {data,error}=await admin.rpc("claim_exact_installment_billing_stop",identityParams(i));
      if(error) throw new Error("Exact billing stop claim failed");
      if(data!=="ready"&&data!=="busy"&&data!=="complete"&&data!=="reconciliation_required")
        throw new Error("Invalid exact billing stop claim");
      return data;
    },
    async assertClaim(i) {
      const {error}=await admin.rpc("assert_exact_installment_billing_stop",identityParams(i));
      if(error) throw new Error("Exact billing stop authorization unavailable");
    },
    async accounted(agreementId,kind,value,amount) {
      assertAgreementId(agreementId);
      requireThat((kind==="intent"?/^pi_[a-zA-Z0-9]+$/:/^in_[a-zA-Z0-9]+$/).test(value)&&
        Number.isSafeInteger(amount)&&amount>0,"invalid receipt lookup");
      const column=kind==="intent"?"stripe_payment_intent_id":"stripe_invoice_id";
      const {data:r,error}=await admin.from("exact_installment_receipts")
        .select("ledger_id,counted_at,amount_cents,stripe_payment_intent_id,stripe_invoice_id")
        .eq("agreement_id",agreementId).eq(column,value).maybeSingle();
      if(error) throw new Error("Exact billing stop receipt lookup failed");
      if(!r?.counted_at||!r.ledger_id) return false;
      const {data:l,error:ledgerError}=await admin.from("payment_fee_ledger")
        .select("earnings_credited_at,stripe_payment_intent_id,stripe_invoice_id,gross_amount_cents")
        .eq("id",r.ledger_id).maybeSingle();
      if(ledgerError) throw new Error("Exact billing stop ledger lookup failed");
      return !!l?.earnings_credited_at&&Number(r.amount_cents)===amount&&Number(l.gross_amount_cents)===amount&&
        l.stripe_payment_intent_id===r.stripe_payment_intent_id&&l.stripe_invoice_id===r.stripe_invoice_id;
    },
    async complete(i,p) {
      const {error}=await admin.rpc("complete_exact_installment_billing_stop",{...identityParams(i),
        p_subscription_id:p.subscriptionId,p_session_id:p.sessionId,p_canceled_at:p.canceledAt,
        p_checkout_status:p.checkoutStatus,p_first_payment_intent_id:p.firstPaymentIntentId});
      if(error) throw new Error("Exact billing stop completion failed");
    },
  };
}

/** INTERNAL Sandbox candidate; not a public route or a new cancellation policy.
 * A verified administrator must explicitly approve stopping future billing.
 * No refund, void, amount change, pay, access change, or deletion of evidence.
 * The durable review hold precedes Stripe reads/writes. Existing dispatches and
 * activations must reconcile before cleanup; an expired lease proves nothing.
 * DELETE/expire retries are based on actual terminal state, not HTTP success.
 */
export async function stopExactInstallmentBillingSandbox(args:{
  agreementId:string;requestId:string;actorId:string;store:ExactAgreementStore;stopStore:ExactBillingStopStore;
  stripe:BillingStopProvider;
  env:Record<string,string|undefined>;now?:()=>number;
}):Promise<{status:"collection_stopped"|"busy"|"reconciliation_required"}> {
  assertExactInstallmentEnvironment(args.env,args.env.NEXT_PUBLIC_SITE_URL||"");
  requireThat(args.env.CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY==="true"&&
    args.env.CREATOR_EXACT_INSTALLMENTS_BILLING_STOPS_READY==="true","billing-stop schema not enabled");
  const identity={agreementId:args.agreementId,requestId:args.requestId,actorId:args.actorId,token:randomUUID()};
  identityParams(identity);
  const a=await args.store.load(args.agreementId);
  assertExactInstallmentEnvironment(args.env,a.terms.previewOrigin);
  requireThat(a.id===args.agreementId,"agreement identity mismatch");
  return stopExactBillingUsingContract({identity,agreement:a,stopStore:args.stopStore,stripe:args.stripe,now:args.now,
    expectedLiveMode:false,matchesMetadata:(_kind,m)=>m?.installment_plan_id===a.id&&
      m.installment_collection_version===a.terms.version&&m.booking_payment_id===a.terms.bookingPaymentId});
}

/** Shared existing stop algorithm. The separately selected server composition
 * supplies a real owned contract and narrowly bound provider/store operations.
 * This is not a public authorization surface or a different cancellation policy. */
export async function stopExactBillingUsingContract(args:{
  identity:BillingStopIdentity;
  agreement:Readonly<{id:string;customerId:string|null;subscriptionId:string|null;sessionId:string|null;
    terms:Pick<ExactAgreementTerms,"totalCents"|"paymentCount"|"firstPaymentFeeSchedule"|"renewalFeeSchedule"|"destinationId">&{version:string}}>;
  stopStore:ExactBillingStopStore;stripe:Parameters<typeof stopExactInstallmentBillingSandbox>[0]["stripe"];
  expectedLiveMode:boolean;matchesMetadata:(kind:"customer"|"subscription"|"checkout",metadata:Stripe.Metadata|null)=>boolean;
  now?:()=>number;
}):Promise<{status:"collection_stopped"|"busy"|"reconciliation_required"}> {
  const {identity,agreement:a}=args; identityParams(identity);
  requireThat(identity.agreementId===a.id,"agreement identity mismatch");
  const result=await args.stopStore.claim(identity);
  if(result==="complete") return {status:"collection_stopped"};
  if(result!=="ready") return {status:result};
  requireThat(a.customerId&&a.subscriptionId&&a.sessionId,"Stripe binding missing");
  const now=args.now??(()=>Math.floor(Date.now()/1000));
  const first=calculateInstallmentPlan(a.terms.totalCents,a.terms.paymentCount,
    a.terms.renewalFeeSchedule,a.terms.firstPaymentFeeSchedule).payments[0];
  const {stripe,stopStore}=args;
  const checkSession=(s:Stripe.Checkout.Session)=>{
    requireThat(s.id===a.sessionId&&s.livemode===args.expectedLiveMode&&s.mode==="payment"&&id(s.customer)===a.customerId&&
      s.currency==="usd"&&s.amount_total===first.amountCents&&s.amount_subtotal===first.amountCents&&
      !s.total_details?.amount_tax&&!s.total_details?.amount_discount&&!s.total_details?.amount_shipping&&args.matchesMetadata("checkout",s.metadata),
    "Checkout identity differs");
  };
  const checkSub=(s:Stripe.Subscription)=>{
    requireThat(s.id===a.subscriptionId&&s.livemode===args.expectedLiveMode&&id(s.customer)===a.customerId&&args.matchesMetadata("subscription",s.metadata)&&
      id(s.transfer_data?.destination)===a.terms.destinationId&&s.application_fee_percent==null&&s.schedule==null,
    "subscription identity differs");
    if(s.status!=="canceled") requireThat(s.pause_collection?.behavior==="keep_as_draft"&&
      s.pause_collection.resumes_at==null&&s.collection_method==="charge_automatically","subscription no longer held");
  };
  const checkCustomer=async()=>{
    const c=await read(()=>stripe.customers.retrieve(a.customerId!));
    requireThat(!c.deleted&&c.id===a.customerId&&c.livemode===args.expectedLiveMode&&args.matchesMetadata("customer",c.metadata),"isolated customer differs");
    // Cancellation affects invoice collection. Refuse a shared customer rather
    // than altering another subscription or standalone invoice's behavior.
    const subs=await read(()=>stripe.subscriptions.list({customer:a.customerId!,status:"all",limit:100}));
    requireThat(!subs.has_more&&subs.data.length===1&&subs.data[0].id===a.subscriptionId,"customer has other subscriptions");
    const pending=await read(()=>stripe.invoiceItems.list({customer:a.customerId!,pending:true,limit:100}));
    requireThat(!pending.has_more&&pending.data.length===0,"pending invoice items require review");
  };
  const checkInvoices=async()=>{
    let cursor:string|undefined;
    const seen=new Set<string>();
    for(let pageNumber=0;;pageNumber++) {
      requireThat(pageNumber<100,"invoice pagination needs review");
      const page:Stripe.ApiList<Stripe.Invoice>=await read(()=>stripe.invoices.list({customer:a.customerId!,limit:100,
        ...(cursor?{starting_after:cursor}:{})}));
      for(const inv of page.data) {
        requireThat(/^in_[a-zA-Z0-9]+$/.test(inv.id)&&!seen.has(inv.id)&&inv.livemode===args.expectedLiveMode&&id(inv.customer)===a.customerId&&
          id(inv.parent?.subscription_details?.subscription)===a.subscriptionId&&inv.currency==="usd","invoice identity differs");
        seen.add(inv.id);
        if(inv.status==="paid") {
          const zero=inv.billing_reason==="subscription_create"&&inv.total===0&&inv.subtotal===0&&inv.amount_paid===0&&
            inv.amount_due===0&&inv.starting_balance===0&&!inv.discounts?.length&&!inv.total_discount_amounts?.length&&
            !inv.pre_payment_credit_notes_amount&&!inv.post_payment_credit_notes_amount;
          if(!zero) requireThat(await stopStore.accounted(a.id,"invoice",inv.id,inv.amount_paid),"paid invoice not accounted");
        } else {
          requireThat((inv.status==="open"||inv.status==="draft"||inv.status==="void"||inv.status==="uncollectible")&&
            inv.auto_advance===false&&inv.amount_paid===0,"invoice collection needs reconciliation");
          if(inv.status==="open"||inv.status==="uncollectible") {
            const payments=await read(()=>stripe.invoicePayments.list({invoice:inv.id,limit:100}));
            requireThat(!payments.has_more&&payments.data.length===1,"invoice payment needs review");
            const link=payments.data[0];const piId=id(link.payment.payment_intent);
            requireThat(link.livemode===args.expectedLiveMode&&id(link.invoice)===inv.id&&link.is_default===true&&link.currency==="usd"&&
              (link.status==="open"||link.status==="canceled")&&(link.amount_paid===null||link.amount_paid===0)&&
              link.payment.type==="payment_intent"&&piId,
            "unpaid invoice payment differs");
            const pi=await read(()=>stripe.paymentIntents.retrieve(piId));
            requireThat(pi.id===piId&&pi.livemode===args.expectedLiveMode&&id(pi.customer)===a.customerId&&pi.currency==="usd"&&
              Number.isSafeInteger(pi.amount)&&pi.amount>0&&pi.amount===link.amount_requested&&
              (pi.status==="canceled"||pi.status==="requires_payment_method")&&pi.amount_received===0&&pi.amount_capturable===0,
            "invoice payment still unsettled");
          }
        }
      }
      if(!page.has_more) break;
      const next=page.data.at(-1)?.id;requireThat(next&&next!==cursor,"invoice pagination did not advance");cursor=next;
    }
  };
  const terminalSession=async():Promise<Proof["checkoutStatus"]|null>=>{
    const s=await read(()=>stripe.checkout.sessions.retrieve(a.sessionId!));checkSession(s);
    const piId=id(s.payment_intent);
    if(s.status==="complete"&&s.payment_status==="paid"&&piId) {
      const pi=await read(()=>stripe.paymentIntents.retrieve(piId));
      requireThat(pi.id===piId&&pi.livemode===args.expectedLiveMode&&pi.status==="succeeded"&&id(pi.customer)===a.customerId&&
        pi.currency==="usd"&&pi.amount===first.amountCents&&pi.amount_received===first.amountCents&&
        pi.application_fee_amount===first.fees.totalCreatorDeductionCents&&
        id(pi.transfer_data?.destination)===a.terms.destinationId&&pi.transfer_data?.amount==null,"first payment differs");
      return await stopStore.accounted(a.id,"intent",piId,first.amountCents)?"complete":null;
    }
    if(s.status!=="expired"||s.payment_status!=="unpaid") return null;
    if(piId) {
      const pi=await read(()=>stripe.paymentIntents.retrieve(piId));
      requireThat(pi.id===piId&&pi.livemode===args.expectedLiveMode&&id(pi.customer)===a.customerId&&pi.currency==="usd"&&
        pi.amount===first.amountCents,"expired payment identity differs");
      // A Checkout PI cannot normally be canceled directly; expire the Session.
      // Pending/SCA/processing evidence is not a completed cancellation.
      if(pi.status!=="canceled"||pi.amount_received!==0||pi.amount_capturable!==0) return null;
    }
    return "expired";
  };
  await checkCustomer();
  let sub=await read(()=>stripe.subscriptions.retrieve(a.subscriptionId!));checkSub(sub);
  await checkInvoices();
  const session=await read(()=>stripe.checkout.sessions.retrieve(a.sessionId!));checkSession(session);
  if(session.status==="open") {
    requireThat(session.payment_status==="unpaid","open Checkout payment state changed");
    await stopStore.assertClaim(identity);
    try {await stripe.checkout.sessions.expire(session.id,{},
      {idempotencyKey:`${a.terms.version}:${a.id}:expire-approved-stop-v1`,maxNetworkRetries:0});}
    catch {/* Re-read terminal state after a race or lost response. Never log provider errors. */}
  }
  if(!await terminalSession()) return {status:"reconciliation_required"};
  await checkCustomer();await checkInvoices();
  sub=await read(()=>stripe.subscriptions.retrieve(a.subscriptionId!));checkSub(sub);
  if(sub.status!=="canceled") {
    await stopStore.assertClaim(identity);
    try {await stripe.subscriptions.cancel(sub.id,{invoice_now:false,prorate:false},{maxNetworkRetries:0});}
    catch {/* DELETE has terminal-state recovery; no payment retry is authorized. */}
  }
  sub=await read(()=>stripe.subscriptions.retrieve(a.subscriptionId!));checkSub(sub);
  if(sub.status!=="canceled"||!Number.isSafeInteger(sub.canceled_at)||!sub.canceled_at||
    sub.canceled_at>now()||!sub.ended_at||sub.ended_at>now()) return {status:"reconciliation_required"};
  await checkCustomer();await checkInvoices();
  const terminal=await terminalSession();
  if(!terminal) return {status:"reconciliation_required"};
  const final=await read(()=>stripe.checkout.sessions.retrieve(a.sessionId!));checkSession(final);
  requireThat(final.status===terminal,"terminal Checkout changed");
  await stopStore.complete(identity,{subscriptionId:sub.id,sessionId:final.id,canceledAt:sub.canceled_at,
    checkoutStatus:terminal,firstPaymentIntentId:terminal==="complete"?id(final.payment_intent)??null:null});
  return {status:"collection_stopped"};
}
