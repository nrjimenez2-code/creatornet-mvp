import type Stripe from "stripe";
import { exactRenewalFixture } from "./exact-renewal-fixture";
import { prepareHeldInstallmentInvoice } from "../lib/installments/heldInvoice";
import { CARD_SETUP_CONSENT_VERSION, type CardSetup, type ExactCardSetupStore } from "../lib/installments/cardRecovery";
import type { ExactPaymentRetryStore, ExactRetryAuthorization } from "../lib/installments/paymentRetryStore";
import type { ExactInvoiceStore } from "../lib/installments/invoiceStore";

/** Synthetic API/storage ports only: no client, network or real payment. */
export async function exactRetryFixture(number=2) {
  const f=exactRenewalFixture(number);await prepareHeldInstallmentInvoice(f.args.stripe,f.a);f.setPhase("dispatching");
  Object.assign(f.invoice,{attempted:true,attempt_count:1});Object.assign(f.pi,{amount_capturable:0,payment_method:null});
  Object.assign(f.f.subscription,{status:"past_due",ended_at:null,payment_settings:{save_default_payment_method:"off"}});
  const now=f.args.now(),setupId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",buyerId=f.f.terms.buyerId;
  const quoteId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const card:CardSetup={id:setupId,buyerId,agreementId:f.a.planId,invoiceId:f.invoice.id,originalPaymentIntentId:f.pi.id,
    authorization:f.a,createdAt:now-10,expiresAt:now+3590,sessionId:"cs_test_cardsetup",setupIntentId:"seti_retry",paymentMethodId:"pm_replacement"};
  const metadata={card_setup_version:CARD_SETUP_CONSENT_VERSION,card_setup_request_id:setupId,installment_plan_id:f.a.planId};
  const session={id:card.sessionId,mode:"setup",ui_mode:"hosted",livemode:false,customer:f.a.customerId,client_reference_id:setupId,
    metadata,payment_method_types:["card"],expires_at:card.expiresAt,created:now-10,payment_intent:null,subscription:null,invoice:null,
    payment_status:"no_payment_required",amount_total:null,status:"complete",setup_intent:card.setupIntentId} as unknown as Stripe.Checkout.Session;
  const setup={id:card.setupIntentId,livemode:false,customer:f.a.customerId,metadata,created:now-5,usage:"off_session",on_behalf_of:null,
    payment_method_types:["card"],status:"succeeded",payment_method:card.paymentMethodId} as unknown as Stripe.SetupIntent;
  const pm={id:card.paymentMethodId,livemode:false,type:"card",customer:f.a.customerId} as Stripe.PaymentMethod;
  const cardStore={reserve:jest.fn(),current:jest.fn(async()=>card),bind:jest.fn(),verify:jest.fn()} satisfies ExactCardSetupStore;
  let record:ExactRetryAuthorization={id:quoteId,buyerId,agreementId:f.a.planId,setupId,setupIntentId:setup.id,originalPaymentIntentId:f.pi.id,
    replacementPaymentMethodId:pm.id,authorization:f.a,amountCents:f.invoice.total,applicationFeeCents:f.pi.application_fee_amount!,
    confirmedAt:now,expiresAt:now+300,admittedAt:null};
  const retryStore={load:jest.fn(async()=>record),find:jest.fn(async()=>record.admittedAt===null?null:record),
    admit:jest.fn(async()=>{f.calls.push("retry-admit");if(record.admittedAt!==null)return false;record={...record,admittedAt:now};return true;}),
    recordReceipt:jest.fn(async(_id,r)=>{f.calls.push("retry-receipt");if(record.admittedAt===null)throw new Error("Not admitted");
      return (f.invoiceStore as ExactInvoiceStore).recordReceipt(f.a.planId,r);})} satisfies ExactPaymentRetryStore;
  const api={...f.api,checkout:{sessions:{retrieve:jest.fn(async()=>session),create:jest.fn()}},
    setupIntents:{retrieve:jest.fn(async()=>setup)},
    paymentMethods:{retrieve:jest.fn(async(id:string)=>id===pm.id?pm:f.pm)}};
  api.invoices.pay.mockImplementation(async(_id,params)=>{
    f.calls.push("pay");if(record.admittedAt===null)throw new Error("No retry admission");
    f.pi.payment_method=params.payment_method!;f.charge.payment_method=params.payment_method!;f.markPaid();return f.invoice;
  });
  const env={...f.env,CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_READY:"true",CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY:"true",
    CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"true",CREATOR_EXACT_INSTALLMENTS_RETRY_READY:"true",
    CREATOR_EXACT_INSTALLMENTS_SANDBOX_BUYER_RETRY:"true"};
  const args={...f.args,quoteId,buyerId,cardStore,retryStore,stripe:api as unknown as Stripe,env};
  f.calls.length=0;jest.clearAllMocks();
  return {f,card,session,setup,pm,cardStore,retryStore,api,env,args,record:()=>record,
    setRecord:(change:Partial<ExactRetryAuthorization>)=>{record={...record,...change};}};
}
