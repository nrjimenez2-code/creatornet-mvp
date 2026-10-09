import {serverPaymentFixture} from "./server-payment-fixture";
import {serverPaymentCreateRequest} from "../lib/serverPaymentConfirmation";

export function fullServerCaptureFixture(f=serverPaymentFixture("full")){
  const c=f.c;
  const consent={id:f.f.reservation.requestId,accepted_at:new Date(c.acceptedAt*1000).toISOString(),terms:{
    kind:"one_time",version:"accepted-policy",buyerId:c.buyerId,creatorId:c.creatorId,productId:c.productId,
    postId:f.f.reservation.postId,amountCents:c.amountCents,currency:"usd",serviceVersion:"fixed-service-months-v1",serviceMonths:36}};
  Object.assign(c.sourceMetadata,{order_id:f.f.reservation.id,checkout_attempt_key:f.f.reservation.attemptId,
    purchase_consent_id:consent.id,purchase_policy_version:consent.terms.version,post_id:consent.terms.postId,fixed_service_version:"fixed-service-months-v1"});
  Object.assign(f.pi,{...serverPaymentCreateRequest(c,f.f.contextEvidence).params,status:"succeeded",amount_received:c.amountCents,
    latest_charge:"ch_owned",payment_method:"pm_owned"});
  const data={paymentIntent:f.pi,paymentMethod:f.pm,charge:{...f.f.data.charge,customer:null},balance:f.f.data.balance};
  return {contract:c,consent,contextEvidence:f.f.contextEvidence,binding:f.args.binding,
    confirmationOperationId:f.admission.operationId,nowSeconds:f.now(),data};
}
