import type Stripe from "stripe";
import {buyerFirstCaptureFixture} from "./buyer-mentorship-receipt-fixture";
import {SERVER_PAYMENT_PROTOCOL,serverPaymentCreateRequest,serverPaymentConfirmationRequest,inspectServerConfirmationToken,
  type ServerPaymentContract,type ServerConfirmationAdmission,type ServerConfirmationStore} from "../lib/serverPaymentConfirmation";
export function serverPaymentFixture(kind:ServerPaymentContract["kind"]="first_installment") {
  const f=buyerFirstCaptureFixture(),now=()=>f.nowSeconds;
  const c:ServerPaymentContract={protocol:SERVER_PAYMENT_PROTOCOL,attemptId:f.reservation.attemptId,buyerId:f.reservation.buyerId,
    creatorId:f.reservation.terms.creatorId,productId:f.reservation.productId,termsFingerprint:f.reservation.fingerprint,
    context:f.context,customerId:kind==="full"?null:f.customer.id,destinationId:f.reservation.destinationId,
    amountCents:3333,processingFees:f.reservation.terms.firstPaymentFeeSchedule,kind,
    sourceMetadata:{...f.originalRequest.params.payment_intent_data!.metadata as Record<string,string>,
      ...(kind==="full"?{checkout_terms_fingerprint:f.reservation.fingerprint}:{}),
      ...(kind==="monthly_first"?{creatornet_membership_fingerprint:f.reservation.fingerprint}:{})},
    acceptedAt:Math.floor(Date.parse(f.reservation.acceptedAt)/1000),expiresAt:f.nowSeconds+3600};
  const request=serverPaymentCreateRequest(c,f.contextEvidence);
  const pi={...f.data.paymentIntent,...request.params,object:"payment_intent",id:"pi_owned",customer:c.customerId,
    created:now()-10,status:"requires_payment_method",amount_received:0,amount_capturable:0,
    confirmation_method:"manual",payment_method:null,latest_charge:null,last_payment_error:null,next_action:null,
    setup_future_usage:kind==="full"?null:"off_session",on_behalf_of:null,shipping:null,transfer_group:null,
    payment_method_types:["card"],client_secret:"pi_owned_secret_synthetic"} as unknown as Stripe.PaymentIntent;
  const address={country:"US",line1:"1 Fixture Way",line2:null,city:"Phoenix",state:"AZ",postal_code:"85001"};
  const token={id:"ctoken_owned",object:"confirmation_token",created:now()-5,expires_at:now()+1800,livemode:false,
    payment_intent:null,setup_intent:null,setup_future_usage:kind==="full"?null:"off_session",shipping:null,
    return_url:null,use_stripe_sdk:true,payment_method_options:null,mandate_data:null,
    payment_method_preview:{type:"card",customer:null,billing_details:{name:"Test buyer",address,email:null,phone:null},
      card:{exp_month:12,exp_year:2035,fingerprint:"syntheticfingerprint",last4:"4242",wallet:null}}} as Stripe.ConfirmationToken;
  const pm={...f.data.paymentMethod,customer:null,card:token.payment_method_preview!.card,
    billing_details:token.payment_method_preview!.billing_details} as Stripe.PaymentMethod;
  const proof=inspectServerConfirmationToken(c,f.contextEvidence,token,token.id,now());
  const admission:ServerConfirmationAdmission={operationId:f.reservation.requestId,leaseToken:f.reservation.buyerId,
    attemptId:c.attemptId,paymentIntentId:pi.id,firstDispatchAt:now(),dispatchBefore:now()+30,
    idempotencyKey:`${SERVER_PAYMENT_PROTOCOL}:${f.reservation.requestId}`,basis:{kind:"token",token:proof},
    request:serverPaymentConfirmationRequest(c,pi.id,{kind:"token",token:proof})};
  const store={assertReadable:jest.fn(async()=>{}),assertDispatch:jest.fn(async()=>{}),recordObservation:jest.fn(async()=>{})} satisfies ServerConfirmationStore;
  const stripe={paymentIntents:{retrieve:jest.fn(async()=>JSON.parse(JSON.stringify(pi)) as Stripe.PaymentIntent),confirm:jest.fn(async()=>{
    Object.assign(pi,{status:"succeeded",payment_method:pm.id,latest_charge:"ch_owned",amount_received:c.amountCents});
    token.payment_intent=pi.id;return JSON.parse(JSON.stringify(pi)) as Stripe.PaymentIntent;
  })},charges:{retrieve:jest.fn()},paymentMethods:{retrieve:jest.fn(async()=>JSON.parse(JSON.stringify(pm)) as Stripe.PaymentMethod)},confirmationTokens:{retrieve:jest.fn(async()=>JSON.parse(JSON.stringify(token)) as Stripe.ConfirmationToken)}};
  const args={contract:c,contextEvidence:jest.fn(async()=>f.contextEvidence),binding:{paymentIntentId:pi.id,firstDispatchAt:now()-10},
    admission,stripe:stripe as unknown as Parameters<typeof import("../lib/serverPaymentConfirmation").dispatchServerPaymentConfirmation>[0]["stripe"],store,now};
  return {f,c,pi,pm,token,proof,admission,store,stripe,args,now};
}
