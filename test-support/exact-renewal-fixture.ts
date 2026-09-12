import type Stripe from "stripe";
import { exactInstallmentFixture } from "./exact-installment-fixture";
import type { ExactInvoiceStore, RenewalAuthorization, RenewalClaim } from "../lib/installments/invoiceStore";
import type { ExactReceiptCreditStore } from "../lib/installments/receiptCredit";
import { calculateInstallmentPlan } from "../lib/installmentPlan";

/** Synthetic API ports only. No instantiated client, network, real card or DB. */
export function exactRenewalFixture(number=2) {
  const f=exactInstallmentFixture(); f.paid(); f.setAgreement({status:"active"});
  const now=f.agreement.createdAt+70*86400;
  const a:RenewalAuthorization={planId:f.agreement.id,bookingPaymentId:f.terms.bookingPaymentId,
    invoiceId:"in_renewal",subscriptionId:"sub_fixture",subscriptionItemId:"si_fixture",customerId:"cus_fixture",
    destinationId:"acct_fixture",currency:"usd",totalCents:199900,paymentCount:3,paymentNumber:number,
    periodStart:now-60,periodEnd:now+28*86400,cancelAt:now+28*86400*(4-number),
    feeSchedule:f.terms.renewalFeeSchedule,paymentMethodId:"pm_fixture"};
  const plan=calculateInstallmentPlan(199900,3,f.terms.renewalFeeSchedule,f.terms.firstPaymentFeeSchedule);
  const expected=plan.payments[number-1];
  Object.assign(f.subscription,{status:"active",cancel_at:a.cancelAt,cancel_at_period_end:false,
    default_payment_method:"pm_fixture",pause_collection:{behavior:"keep_as_draft",resumes_at:null},
    items:{has_more:false,data:[{id:"si_fixture",quantity:1}]} });
  const line={id:"il_base",amount:66633,currency:"usd",quantity:1,livemode:false,invoice:a.invoiceId,
    period:{start:a.periodStart,end:a.periodEnd},parent:{type:"subscription_item_details",
      subscription_item_details:{subscription:a.subscriptionId,subscription_item:a.subscriptionItemId,proration:false}},
    discounts:[],discount_amounts:[],taxes:[],pretax_credit_amounts:[] } as unknown as Stripe.InvoiceLineItem;
  const invoice={id:a.invoiceId,livemode:false,customer:a.customerId,currency:"usd",status:"draft",
    parent:{subscription_details:{subscription:a.subscriptionId}},auto_advance:false,automatically_finalizes_at:null,
    next_payment_attempt:null,attempted:false,attempt_count:0,collection_method:"charge_automatically",
    billing_reason:"subscription_cycle",amount_due:66633,amount_remaining:66633,total:66633,subtotal:66633,
    amount_paid:0,amount_overpaid:0,starting_balance:0,pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0,
    automatic_tax:{enabled:false},discounts:[],total_discount_amounts:[],total_taxes:[],total_pretax_credit_amounts:[],
    lines:{data:[line],has_more:false},metadata:{},status_transitions:{paid_at:null}} as unknown as Stripe.Invoice;
  const pi={...structuredClone(f.pi),id:"pi_renewal",latest_charge:null,status:"requires_payment_method",amount:66633,
    amount_received:0,application_fee_amount:10425,payment_method_types:["card"]} as Stripe.PaymentIntent;
  const charge={...structuredClone(f.charge),id:"ch_renewal",payment_intent:pi.id,amount:expected.amountCents,
    amount_captured:expected.amountCents,created:now,balance_transaction:"txn_renewal"} as Stripe.Charge;
  const link={invoice:invoice.id,livemode:false,is_default:true,currency:"usd",status:"open",
    amount_requested:66633,amount_paid:null,payment:{type:"payment_intent",payment_intent:pi.id}} as Stripe.InvoicePayment;
  const balance={id:"txn_renewal",type:"charge",source:charge.id,amount:expected.amountCents,currency:"usd",
    fee:1962,net:expected.amountCents-1962} as Stripe.BalanceTransaction;
  const pm={id:"pm_fixture",livemode:false,type:"card",customer:f.customer.id} as Stripe.PaymentMethod;
  let phase:"none"|"prepared"|"dispatching"|"paid"="none";
  let credited=false;
  const calls:string[]=[];
  const priorPis=[f.pi,...number===3?[{...structuredClone(f.pi),id:"pi_previous",latest_charge:"ch_previous",application_fee_amount:10425}]:[]];
  const priorCharges=[f.charge,...number===3?[{...structuredClone(f.charge),id:"ch_previous",payment_intent:"pi_previous"}]:[]];
  const invoiceStore={
    claim:jest.fn<Promise<RenewalClaim>,Parameters<ExactInvoiceStore["claim"]>>(async()=>{
      calls.push("claim");
      return phase==="dispatching" || phase==="paid" ? {status:"reconcile",authorization:a,paymentIntentId:pi.id}
        :{status:"prepare",authorization:a};
    }),
    prepareDispatch:jest.fn(async()=>{calls.push("prepare-dispatch");phase="prepared";}),
    admitDispatch:jest.fn(async()=>{calls.push("admit"); if(phase!=="prepared") throw new Error("Not prepared"); phase="dispatching";}),
    recordReceipt:jest.fn(async()=>{calls.push("receipt");if(phase!=="dispatching"&&phase!=="paid") throw new Error("Not admitted");
      const fresh=phase!=="paid";phase="paid";return fresh;}),
    priorPayments:jest.fn(async()=>priorPis.map((p,i)=>({paymentNumber:i+1,paymentIntentId:p.id}))),
    completeAgreement:jest.fn(async()=>{calls.push("complete-agreement");}),
  } satisfies ExactInvoiceStore;
  const creditStore={bindPurchase:jest.fn(),recordRefundEvidence:jest.fn(),reconcileDispute:jest.fn(),
    credit:jest.fn(async()=>{calls.push("credit");const fresh=!credited;credited=true;return fresh;})} satisfies ExactReceiptCreditStore;
  const markPaid=()=>{
    pi.status="succeeded";pi.latest_charge=charge.id;pi.amount_received=expected.amountCents;
    invoice.status="paid";invoice.attempted=true;invoice.attempt_count=1;
    invoice.amount_paid=invoice.amount_due;invoice.amount_remaining=0;invoice.status_transitions.paid_at=now;
    link.status="paid";link.amount_paid=expected.amountCents;
  };
  const api={...f.mocks,
    invoices:{
      retrieve:jest.fn(async()=>invoice),
      addLines:jest.fn(async(_id:string,p:Stripe.InvoiceAddLinesParams)=>{
        calls.push("add-cent");const extra=p.lines[0];
        invoice.lines.data.push({...line,...extra,id:"il_extra",parent:{type:"invoice_item_details",
          invoice_item_details:{proration:false,subscription:null}}} as Stripe.InvoiceLineItem);
        invoice.total=invoice.subtotal=invoice.amount_due=invoice.amount_remaining=66633+extra.amount!;
        pi.amount=link.amount_requested=invoice.total;return invoice;
      }),
      update:jest.fn(async(_id:string,p:Stripe.InvoiceUpdateParams)=>{
        calls.push("configure");invoice.metadata=p.metadata as Stripe.Metadata;return invoice;
      }),
      finalizeInvoice:jest.fn(async()=>{calls.push("finalize");invoice.status="open";return invoice;}),
      pay:jest.fn(async(invoiceId:string,params:Stripe.InvoicePayParams,options:Stripe.RequestOptions)=>{
        calls.push("pay");
        // Observed in Sandbox: these fields are mutually exclusive even when
        // both values are false. Reject before recording a payment attempt.
        if(Object.prototype.hasOwnProperty.call(params,"forgive")&&
          Object.prototype.hasOwnProperty.call(params,"paid_out_of_band")) {
          throw new Error("Mutually exclusive invoice payment parameters");
        }
        if(invoiceId!==invoice.id||options.maxNetworkRetries!==0||!options.idempotencyKey) {
          throw new Error("Invalid synthetic payment request");
        }
        if(phase!=="dispatching") throw new Error("No durable admission");
        markPaid();return invoice;
      }),
    },
    invoicePayments:{list:jest.fn(async()=>({has_more:false,data:[link]}))},
    paymentIntents:{retrieve:jest.fn(async(id:string)=>id===pi.id?pi:priorPis.find(p=>p.id===id)!),confirm:jest.fn()},
    charges:{retrieve:jest.fn(async(id:string)=>id===charge.id?charge:priorCharges.find(c=>c.id===id)!)},
    balanceTransactions:{retrieve:jest.fn(async()=>balance)},
    paymentMethods:{retrieve:jest.fn(async()=>pm)},
  };
  const env={...f.env,CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT:"true"};
  const args={agreementId:a.planId,invoiceId:a.invoiceId,store:f.store,invoiceStore,creditStore,
    stripe:api as unknown as Stripe,env,now:()=>now};
  return {f,a,invoice,pi,charge,link,balance,pm,api,invoiceStore,creditStore,env,args,calls,markPaid,priorPis,priorCharges,
    setPhase:(p:typeof phase)=>{phase=p;}};
}
