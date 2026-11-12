import {serverPaymentFixture} from "../test-support/server-payment-fixture";
import {inspectServerCardMethod,serverPaymentConfirmationRequest,dispatchServerPaymentConfirmation,
  observeServerPaymentConfirmation,type ServerConfirmationBasis} from "../lib/serverPaymentConfirmation";

function fixture(kind:"full"|"first_installment"="full"){
  const f=serverPaymentFixture(kind);f.pm.created=f.now()-2;f.pm.card!.country="US";
  const method=inspectServerCardMethod(f.c,f.f.contextEvidence,f.pm,f.pm.id,f.now());
  const basis:ServerConfirmationBasis={kind:"card",method};
  Object.assign(f.admission,{basis,request:serverPaymentConfirmationRequest(f.c,f.pi.id,basis)});
  return f;
}
test.each(["full","first_installment"] as const)("%s confirms an independently checked Card Element method with the original phase key",async kind=>{
  const f=fixture(kind),result=await dispatchServerPaymentConfirmation(f.args);
  expect(result.observation.status).toBe("succeeded");expect(result.dispatched).toBe(true);
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledWith(f.pi.id,
    {payment_method:f.pm.id,use_stripe_sdk:true,return_url:expect.stringContaining(f.c.attemptId)},
    expect.objectContaining({idempotencyKey:f.admission.idempotencyKey,apiVersion:"2025-10-29.clover",maxNetworkRetries:0}));
  expect(f.stripe.confirmationTokens.retrieve).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toMatch(/secret|billing_details|fingerprint/);
});
test.each(["issuer","billing","customer","mode","old method","future method","expired card","expired window","changed fingerprint","changed request","changed method","stop"])
("card method %s fails before confirmation",async issue=>{
  const f=fixture();
  if(issue==="issuer")f.pm.card!.country="CA";
  if(issue==="billing")f.pm.billing_details.address!.country="CA";
  if(issue==="customer")f.pm.customer="cus_foreign";
  if(issue==="mode")f.pm.livemode=true;
  if(issue==="old method")f.pm.created=f.c.acceptedAt-1;
  if(issue==="future method")f.pm.created=f.now()+1;
  if(issue==="expired card")f.pm.card!.exp_year=2000;
  if(issue==="expired window")(f.admission.basis as any).method={...(f.admission.basis as any).method,expiresAt:f.now()};
  if(issue==="changed fingerprint")f.pm.card!.fingerprint="changed";
  if(issue==="changed request")f.admission.request.params.payment_method="pm_foreign";
  if(issue==="changed method")f.pm.id="pm_foreign";
  if(issue==="stop")f.store.assertDispatch.mockRejectedValueOnce(Error("stopped"));
  await expect(dispatchServerPaymentConfirmation(f.args)).rejects.toThrow();
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
test("issuer checks may update after confirmation without changing the admitted card identity",async()=>{
  const f=fixture();const original=f.stripe.paymentIntents.confirm.getMockImplementation()!;
  f.stripe.paymentIntents.confirm.mockImplementation(async()=>{const result=await original();f.pm.card!.checks={address_line1_check:"pass",address_postal_code_check:"pass",cvc_check:"pass"};return result;});
  expect((await dispatchServerPaymentConfirmation(f.args)).observation.status).toBe("succeeded");
});
test("lost reply recovers the same captured method without another confirmation",async()=>{
  const f=fixture();await dispatchServerPaymentConfirmation(f.args);f.stripe.paymentIntents.confirm.mockClear();
  expect((await observeServerPaymentConfirmation(f.args)).status).toBe("succeeded");
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
test("an unrelated method on the bound intent is not success evidence",async()=>{
  const f=fixture();Object.assign(f.pi,{status:"succeeded",amount_received:f.c.amountCents,payment_method:"pm_other",latest_charge:"ch_owned"});
  await expect(observeServerPaymentConfirmation(f.args)).rejects.toThrow();expect(f.store.recordObservation).not.toHaveBeenCalled();
});
test("manual bank challenge remains an observation and never automatically reconfirms",async()=>{
  const f=fixture();f.stripe.paymentIntents.confirm.mockImplementation(async()=>{
    Object.assign(f.pi,{status:"requires_action",payment_method:f.pm.id,next_action:{type:"use_stripe_sdk",use_stripe_sdk:{type:"three_d_secure_redirect"}}});return f.pi;
  });
  expect((await dispatchServerPaymentConfirmation(f.args)).observation.status).toBe("requires_action");
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(1);
});
