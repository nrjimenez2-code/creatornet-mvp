import { exactRetryFixture } from "../test-support/exact-retry-fixture";
import { collectExactBuyerRetrySandbox, reconcileExactRetryReceiptSandbox } from "../lib/installments/paymentRetry";
import { parseExactRetryAuthorization, createExactPaymentRetryStore } from "../lib/installments/paymentRetryStore";
import { PAY_NOW_CONSENT_VERSION } from "../lib/installments/buyerRecoveryView";
import { verifyExactCardSetupSandbox } from "../lib/installments/cardRecovery";
import { verifyExactRetryHistorySandbox } from "../lib/installments/renewal";
import { recoverExactRenewalSandbox, type ExactPaymentRecoveryStore, type RecoveryRead } from "../lib/installments/paymentRecovery";

function noDefaults(f:Awaited<ReturnType<typeof exactRetryFixture>>,expectedDefault="pm_fixture") {
  expect(f.api.subscriptions.update).not.toHaveBeenCalled();expect(f.api.invoices.update).not.toHaveBeenCalled();
  expect(f.api.invoices.finalizeInvoice).not.toHaveBeenCalled();expect(f.api.invoices.addLines).not.toHaveBeenCalled();
  expect(f.api.paymentIntents.confirm).not.toHaveBeenCalled();
  expect(f.f.f.subscription.default_payment_method).toBe(expectedDefault);
  expect(f.f.a.paymentMethodId).toBe("pm_fixture");
}
test("replacement-card and original-history preflights are independently valid",async()=>{
  const f=await exactRetryFixture();
  await expect(verifyExactCardSetupSandbox({requestId:f.card.id,buyerId:f.args.buyerId,store:f.cardStore,
    agreementStore:f.args.store,stripe:f.args.stripe,env:f.env,now:f.args.now})).resolves.toMatchObject({status:"card_saved_payment_not_attempted"});
  await expect(verifyExactRetryHistorySandbox(f.args,f.f.a)).resolves.toBeUndefined();
});
test("explicit confirmed retry uses the original invoice/PI, exact fee, replacement card and one on-session attempt",async()=>{
  const f=await exactRetryFixture();expect(await collectExactBuyerRetrySandbox(f.args)).toEqual({status:"credited",paymentNumber:2});
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1);
  expect(f.api.invoices.pay).toHaveBeenCalledWith(f.args.invoiceId,{payment_method:"pm_replacement",off_session:false},
    {idempotencyKey:`exact-buyer-retry:${f.args.quoteId}:v1`,maxNetworkRetries:0});
  expect(f.retryStore.admit.mock.invocationCallOrder[0]).toBeLessThan(f.api.invoices.pay.mock.invocationCallOrder[0]);
  expect(f.retryStore.recordReceipt).toHaveBeenCalledWith(f.args.quoteId,{invoiceId:f.args.invoiceId,paymentIntentId:f.f.pi.id,
    amountCents:66633,applicationFeeCents:10425,paidAt:f.args.now(),
    actualStripeFeeCents:1962,balanceTransactionId:"txn_renewal",chargeId:"ch_renewal",refundedAmountCents:0});
  noDefaults(f);
});
test("repeat/refresh after successful retry only reconciles the original receipt",async()=>{
  const f=await exactRetryFixture();await collectExactBuyerRetrySandbox(f.args);
  f.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_BUYER_RETRY="false";
  f.args.now=()=>f.record().expiresAt+86400;
  expect(await collectExactBuyerRetrySandbox(f.args)).toEqual({status:"already_credited",paymentNumber:2});
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1);expect(f.retryStore.admit).toHaveBeenCalledTimes(1);noDefaults(f);
});
test("lost admission acknowledgement consumes the attempt and NEVER leads to a pay call",async()=>{
  const f=await exactRetryFixture();f.retryStore.admit.mockImplementationOnce(async()=>{
    f.setRecord({admittedAt:f.args.now()});throw new Error("private database details");
  });
  await expect(collectExactBuyerRetrySandbox(f.args)).rejects.toThrow("do not repeat");
  expect(await collectExactBuyerRetrySandbox(f.args)).toMatchObject({status:"reconciliation_required"});
  expect(f.api.invoices.pay).not.toHaveBeenCalled();expect(f.f.creditStore.credit).not.toHaveBeenCalled();noDefaults(f);
});
test("simultaneous confirmations share one permanent admission and at most one pay call",async()=>{
  const f=await exactRetryFixture();await Promise.allSettled([collectExactBuyerRetrySandbox(f.args),collectExactBuyerRetrySandbox(f.args)]);
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1);noDefaults(f);
});
test.each(["timeout","decline","bank challenge","processing","lost successful response"])("%s never authorizes a second attempt",async(problem)=>{
  const f=await exactRetryFixture();f.api.invoices.pay.mockImplementationOnce(async()=>{
    if(problem==="lost successful response") {f.f.pi.payment_method=f.pm.id;f.f.charge.payment_method=f.pm.id;f.f.markPaid();}
    else {f.f.pi.payment_method=f.pm.id;f.f.pi.status=problem==="bank challenge"?"requires_action":problem==="processing"?"processing":"requires_payment_method";}
    throw new Error("private Stripe error client_secret");
  });
  const result=await collectExactBuyerRetrySandbox(f.args);expect(result.status).toBe(problem==="lost successful response"?"credited":"reconciliation_required");
  await collectExactBuyerRetrySandbox(f.args);expect(f.api.invoices.pay).toHaveBeenCalledTimes(1);noDefaults(f);
});
test.each(["production","live key","wrong project","gate off","payment gate off","wrong buyer","wrong quote","expired",
  "wrong original claim","wrong confirmed card","unverified setup","wrong setup owner","wrong replacement owner","held canceled",
  "resumed subscription","changed default","past end","uncredited prior","prior refund","prior dispute","prior wrong fee","new hold",
  "paid elsewhere","changed current fee","changed current destination","extra invoice payment"])("%s blocks payment admission",async(problem)=>{
  const f=await exactRetryFixture();
  if(problem==="production") f.env.VERCEL_ENV="production";
  if(problem==="live key") f.env.STRIPE_SECRET_KEY="sk_live_synthetic";
  if(problem==="wrong project") f.env.NEXT_PUBLIC_SUPABASE_URL="https://other.supabase.co";
  if(problem==="gate off") f.env.CREATOR_EXACT_INSTALLMENTS_RETRY_READY="false";
  if(problem==="payment gate off") f.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_BUYER_RETRY="false";
  if(problem==="wrong buyer") f.args.buyerId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  if(problem==="wrong quote") f.args.quoteId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  if(problem==="expired") f.args.now=()=>f.record().expiresAt;
  if(problem==="wrong original claim") f.f.invoiceStore.claim.mockResolvedValue({status:"reconcile",paymentIntentId:"pi_other",authorization:f.f.a});
  if(problem==="wrong confirmed card") f.setRecord({replacementPaymentMethodId:"pm_other"});
  if(problem==="unverified setup") f.setup.status="requires_action";
  if(problem==="wrong setup owner") f.setup.customer="cus_other";
  if(problem==="wrong replacement owner") f.pm.customer="cus_other";
  if(problem==="held canceled") f.f.f.subscription.status="canceled";
  if(problem==="resumed subscription") f.f.f.subscription.pause_collection=null;
  if(problem==="changed default") f.f.f.subscription.default_payment_method="pm_other";
  if(problem==="past end") f.f.f.subscription.cancel_at=f.args.now()-1;
  if(problem==="uncredited prior") f.f.invoiceStore.priorPayments.mockResolvedValue([]);
  if(problem==="prior refund") f.f.priorCharges[0].amount_refunded=1;
  if(problem==="prior dispute") f.f.priorCharges[0].disputed=true;
  if(problem==="prior wrong fee") f.f.priorPis[0].application_fee_amount=1;
  if(problem==="new hold") f.retryStore.admit.mockRejectedValue(new Error("hold"));
  if(problem==="paid elsewhere") f.f.markPaid();
  if(problem==="changed current fee") f.f.pi.application_fee_amount=1;
  if(problem==="changed current destination") f.f.pi.transfer_data!.destination="acct_other";
  if(problem==="extra invoice payment") f.api.invoicePayments.list.mockResolvedValue({has_more:false,data:[f.f.link,f.f.link]});
  await expect(collectExactBuyerRetrySandbox(f.args)).rejects.toThrow("do not repeat");
  expect(f.api.invoices.pay).not.toHaveBeenCalled();expect(f.f.creditStore.credit).not.toHaveBeenCalled();noDefaults(f,problem==="changed default"?"pm_other":"pm_fixture");
});
test.each(["no admission","old card","wrong card","old charge","future charge","wrong invoice payment","wrong fee","wrong balance"])
("replacement receipt with %s is not credited",async(problem)=>{
  const f=await exactRetryFixture();f.setRecord({admittedAt:f.args.now()});f.f.pi.payment_method=f.pm.id;f.f.charge.payment_method=f.pm.id;f.f.markPaid();
  if(problem==="no admission") f.setRecord({admittedAt:null});
  if(problem==="old card") f.f.pi.payment_method="pm_fixture";
  if(problem==="wrong card") f.f.charge.payment_method="pm_other";
  if(problem==="old charge") f.f.charge.created=f.args.now()-1;
  if(problem==="future charge") f.f.charge.created=f.args.now()+1;
  if(problem==="wrong invoice payment") f.f.link.payment.payment_intent="pi_other";
  if(problem==="wrong fee") f.f.pi.application_fee_amount=1;
  if(problem==="wrong balance") f.f.balance.source="ch_other";
  await expect(reconcileExactRetryReceiptSandbox(f.args)).rejects.toThrow("reconciliation unavailable");
  expect(f.retryStore.recordReceipt).not.toHaveBeenCalled();expect(f.f.creditStore.credit).not.toHaveBeenCalled();
  expect(f.api.invoices.pay).not.toHaveBeenCalled();noDefaults(f);
});
test("final-cent retry credits $666.34 with the exact $104.25 fee",async()=>{
  const f=await exactRetryFixture(3);expect(await collectExactBuyerRetrySandbox(f.args)).toEqual({status:"credited",paymentNumber:3});
  expect(f.retryStore.recordReceipt.mock.calls[0][1]).toMatchObject({amountCents:66634,applicationFeeCents:10425});
  expect(f.f.invoiceStore.completeAgreement).toHaveBeenCalledWith(f.args.agreementId);noDefaults(f);
});

test.each(["valid","record only","unconfirmed","expired before confirmation","wrong fee","wrong PI","wrong buyer shape","wrong admission","admitted before consent"])
("retry authorization parser: %s",async(problem)=>{
  const f=await exactRetryFixture(),r=f.record(),now=f.args.now();
  const q={id:r.id,agreement_id:r.agreementId,buyer_id:r.buyerId,setup_request_id:r.setupId,setup_intent_id:r.setupIntentId,
    stripe_invoice_id:r.authorization.invoiceId,original_payment_intent_id:r.originalPaymentIntentId,replacement_payment_method_id:r.replacementPaymentMethodId,
    authorization_snapshot:r.authorization,amount_cents:r.amountCents,application_fee_cents:r.applicationFeeCents,consent_version:PAY_NOW_CONSENT_VERSION as string,
    created_at:new Date(now*1000).toISOString(),confirmed_at:new Date(now*1000).toISOString() as string|null,expires_at:now+300};
  const admitted={confirmation_id:r.id,agreement_id:r.agreementId,stripe_invoice_id:r.authorization.invoiceId,admitted_at:new Date(now*1000).toISOString()};
  if(problem==="record only") q.consent_version="single-invoice-retry-v1";
  if(problem==="unconfirmed") q.confirmed_at=null;
  if(problem==="expired before confirmation") q.expires_at=now;
  if(problem==="wrong fee") q.application_fee_cents=1;
  if(problem==="wrong PI") q.original_payment_intent_id="secret";
  if(problem==="wrong buyer shape") q.buyer_id="other";
  if(problem==="wrong admission") admitted.stripe_invoice_id="in_other";
  if(problem==="admitted before consent") admitted.admitted_at=new Date((now-1)*1000).toISOString();
  if(problem==="valid") expect(parseExactRetryAuthorization(q,admitted)).toEqual({...r,admittedAt:now});
  else expect(()=>parseExactRetryAuthorization(q,admitted)).toThrow();
});
test("adapter treats RPC failure/unknown result as no permission and never exposes provider details",async()=>{
  const f=await exactRetryFixture(),rpc=jest.fn().mockResolvedValue({data:null,error:{message:"SECRET"}});
  const store=createExactPaymentRetryStore({rpc} as never);
  await expect(store.admit(f.args.quoteId,f.args.buyerId)).rejects.toThrow("evidence unavailable");
  rpc.mockResolvedValueOnce({data:"true",error:null});await expect(store.admit(f.args.quoteId,f.args.buyerId)).rejects.toThrow();
  rpc.mockResolvedValueOnce({data:false,error:null});expect(await store.admit(f.args.quoteId,f.args.buyerId)).toBe(false);
});

test.each(["paid","declined","bank challenge","no admission","gate off","mismatched admission","stale reader"])
("webhook replacement-card recovery: %s never makes a payment",async(problem)=>{
  const f=await exactRetryFixture();f.setRecord({admittedAt:f.args.now()});f.f.pi.payment_method=f.pm.id;f.f.charge.payment_method=f.pm.id;
  Object.assign(f.f.pi,{canceled_at:null,next_action:null});f.f.invoice.status_transitions.voided_at=null;
  if(["paid","no admission","gate off","mismatched admission"].includes(problem)) f.f.markPaid();
  if(problem==="bank challenge") f.f.pi.status="requires_action";
  if(problem==="no admission") f.setRecord({admittedAt:null});
  if(problem==="gate off") f.env.CREATOR_EXACT_INSTALLMENTS_RETRY_READY="false";
  if(problem==="mismatched admission") f.setRecord({originalPaymentIntentId:"pi_other"});
  const snapshot:RecoveryRead={revision:1,basis:{claimStatus:"dispatching",paymentIntentId:f.f.pi.id},paymentIntentId:f.f.pi.id,
    subscriptionId:f.f.a.subscriptionId,periodStart:f.f.a.periodStart,periodEnd:f.f.a.periodEnd,dispatchStartedAt:f.args.now()-10};
  const recoveryStore={has:jest.fn(async()=>true),begin:jest.fn(async()=>snapshot),
    finish:jest.fn<ReturnType<ExactPaymentRecoveryStore["finish"]>,Parameters<ExactPaymentRecoveryStore["finish"]>>(async()=>problem!=="stale reader")};
  const args={...f.args,recoveryStore,eventId:"evt_retryreceipt"};
  if(["no admission","gate off","mismatched admission"].includes(problem)) {
    await expect(recoverExactRenewalSandbox(args)).rejects.toThrow();expect(f.f.creditStore.credit).not.toHaveBeenCalled();
  } else {
    const expected=problem==="paid"?"paid_accounted":problem==="bank challenge"?"action_required":"payment_method_required";
    expect(await recoverExactRenewalSandbox(args)).toEqual(problem==="stale reader"?{status:"reconciliation_required"}:
      {status:"payment_recovery_recorded",outcome:expected});
    if(problem==="paid") {await recoverExactRenewalSandbox(args);expect(f.retryStore.recordReceipt).toHaveBeenCalledTimes(2);}
    else expect(f.f.creditStore.credit).not.toHaveBeenCalled();
  }
  if(problem==="gate off") expect(f.retryStore.find).not.toHaveBeenCalled();
  expect(f.retryStore.admit).not.toHaveBeenCalled();expect(f.api.invoices.pay).not.toHaveBeenCalled();noDefaults(f);
});
