import type Stripe from "stripe";
import {exactRenewalFixture} from "../test-support/exact-renewal-fixture";
import {prepareHeldInstallmentInvoice} from "../lib/installments/heldInvoice";
import {recoverExactRenewalSandbox,createExactPaymentRecoveryStore,type RecoveryRead,type RecoveryOutcome,type ExactPaymentRecoveryStore} from "../lib/installments/paymentRecovery";

async function fixture(number:2|3=2) {
  const f=exactRenewalFixture(number);
  await prepareHeldInstallmentInvoice(f.args.stripe,f.a);f.setPhase("dispatching");
  Object.assign(f.pi,{amount_capturable:0,canceled_at:null,next_action:null});
  f.invoice.status_transitions.voided_at=null;
  const snapshot:RecoveryRead={revision:0,basis:{claimStatus:"dispatching",paymentIntentId:f.pi.id,receiptCountedAt:null},
    paymentIntentId:f.pi.id,subscriptionId:f.a.subscriptionId,periodStart:f.a.periodStart,periodEnd:f.a.periodEnd,dispatchStartedAt:f.args.now()};
  const recoveryStore={has:jest.fn(async()=>true),begin:jest.fn(async()=>snapshot),
    finish:jest.fn<ReturnType<ExactPaymentRecoveryStore["finish"]>,Parameters<ExactPaymentRecoveryStore["finish"]>>(async()=>true)};
  const env={...f.env,CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE:"false",CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT:"false",
    CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"true",CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY:"true"};
  const args={...f.args,eventId:"evt_recovery",recoveryStore,env};
  f.calls.length=0;jest.clearAllMocks();
  return {f,snapshot,recoveryStore,env,args};
}
const noStripeWrites=(f:Awaited<ReturnType<typeof fixture>>)=>{
  for(const method of [f.f.api.invoices.update,f.f.api.invoices.finalizeInvoice,f.f.api.invoices.addLines,f.f.api.invoices.pay,
    f.f.api.paymentIntents.confirm,f.f.api.subscriptions.update]) expect(method).not.toHaveBeenCalled();
  expect(f.f.invoiceStore.prepareDispatch).not.toHaveBeenCalled();expect(f.f.invoiceStore.admitDispatch).not.toHaveBeenCalled();
};

test.each<[Stripe.PaymentIntent.Status,RecoveryOutcome]>([["requires_payment_method","payment_method_required"],
  ["requires_action","action_required"],["requires_confirmation","payment_pending"],["processing","payment_pending"],["requires_capture","payment_pending"]])
("%s persists %s with collection paused, not a fresh charge attempt",async(status,outcome)=>{
  const f=await fixture();f.f.pi.status=status;if(status==="requires_capture") f.f.pi.amount_capturable=f.f.pi.amount;
  const result=await recoverExactRenewalSandbox(f.args);
  expect(result).toEqual({status:"payment_recovery_recorded",outcome});
  expect(f.recoveryStore.begin.mock.invocationCallOrder[0]).toBeLessThan(f.f.api.invoices.retrieve.mock.invocationCallOrder[0]);
  noStripeWrites(f);expect(f.f.creditStore.credit).not.toHaveBeenCalled();
});

test("observed Sandbox decline with cleared PI card remains actionable on repeated read-only recovery",async()=>{
  const f=await fixture();
  // Stripe's decline-after-attaching fixture leaves the original invoice open,
  // clears the PI payment_method, retains a failed latest_charge, and sets the
  // subscription past_due even while its collection pause remains in place.
  Object.assign(f.f.invoice,{attempted:true,attempt_count:1});
  Object.assign(f.f.pi,{status:"requires_payment_method",payment_method:null,latest_charge:f.f.charge.id});
  Object.assign(f.f.charge,{status:"failed",paid:false,captured:false,amount_captured:0,
    amount_refunded:0,balance_transaction:null});
  f.f.f.subscription.status="past_due";
  for(let observation=0;observation<2;observation++) {
    expect(await recoverExactRenewalSandbox(f.args)).toEqual({
      status:"payment_recovery_recorded",outcome:"payment_method_required",
    });
  }
  expect(f.recoveryStore.finish).toHaveBeenCalledTimes(2);
  expect(f.recoveryStore.finish).toHaveBeenLastCalledWith(f.f.a.planId,f.f.invoice.id,f.args.eventId,
    f.snapshot,"payment_method_required",{invoiceStatus:"open",paymentStatus:"requires_payment_method",
      amountReceived:0,amountCapturable:0,canceledAt:null,voidedAt:null});
  expect(f.f.invoiceStore.recordReceipt).not.toHaveBeenCalled();
  expect(f.f.creditStore.credit).not.toHaveBeenCalled();
  noStripeWrites(f);
});

test("declined original invoice cannot be prepared for another attempt even if the subscription is active",async()=>{
  const f=await fixture();
  Object.assign(f.f.invoice,{attempted:true,attempt_count:1});
  Object.assign(f.f.pi,{status:"requires_payment_method",payment_method:null,latest_charge:f.f.charge.id});
  await expect(prepareHeldInstallmentInvoice(f.args.stripe,f.f.a)).rejects.toThrow("collection has already been attempted");
  noStripeWrites(f);
});

test.each([2,3] as const)("lost successful response for installment %s reconciles exact original receipt once",async(number)=>{
  const f=await fixture(number);f.f.markPaid();
  expect(await recoverExactRenewalSandbox(f.args)).toEqual({status:"payment_recovery_recorded",outcome:"paid_accounted"});
  await recoverExactRenewalSandbox(f.args);
  expect(f.f.invoiceStore.recordReceipt).toHaveBeenCalledWith(f.f.a.planId,expect.objectContaining({paymentIntentId:f.f.pi.id,
    amountCents:number===3?66634:66633,applicationFeeCents:10425}));
  expect(f.f.creditStore.credit.mock.results.map(r=>r.type)).toEqual(["return","return"]);
  expect(await f.f.creditStore.credit.mock.results[0].value).toBe(true);
  expect(await f.f.creditStore.credit.mock.results[1].value).toBe(false);
  expect(f.recoveryStore.begin).toHaveBeenCalledTimes(4);noStripeWrites(f);
});

test("a paid invoice on a replacement card cannot rewrite the original buyer authorization",async()=>{
  const f=await fixture();f.f.markPaid();
  // The isolated Sandbox manual recovery kept the same invoice, default
  // invoice-payment record and PI, but used a different attached card. A paid
  // status (or unchanged attempt_count) is not buyer consent to adopt that card.
  f.f.pi.payment_method="pm_replacement";
  f.f.charge.payment_method="pm_replacement";
  Object.assign(f.f.invoice,{attempted:true,attempt_count:1});
  for(let observation=0;observation<2;observation++) {
    await expect(recoverExactRenewalSandbox(f.args)).rejects.toThrow(
      "Exact recovery captured-payment reconciliation unavailable");
  }
  expect(f.f.a.paymentMethodId).toBe("pm_fixture");
  expect(f.recoveryStore.begin).toHaveBeenCalledTimes(2);
  expect(f.recoveryStore.finish).not.toHaveBeenCalled();
  expect(f.f.invoiceStore.recordReceipt).not.toHaveBeenCalled();
  expect(f.f.creditStore.credit).not.toHaveBeenCalled();
  noStripeWrites(f);
});

test("a clock-fixture capture before its authorized service period cannot be credited",async()=>{
  const f=await fixture();f.f.markPaid();
  // The isolated future-clock invoice was paid through the real-time API.
  // Its charge timestamp preceded the line period. Do not relax the production
  // receipt-time predicate just to turn that API-only fixture into app evidence.
  f.f.charge.created=f.f.a.periodStart-1;
  await expect(recoverExactRenewalSandbox(f.args)).rejects.toThrow(
    "Exact recovery captured-payment reconciliation unavailable");
  expect(f.recoveryStore.finish).not.toHaveBeenCalled();
  expect(f.f.invoiceStore.recordReceipt).not.toHaveBeenCalled();
  expect(f.f.creditStore.credit).not.toHaveBeenCalled();
  noStripeWrites(f);
});

test("late paid recovery does not require an active subscription or enable new collection",async()=>{
  const f=await fixture();f.f.markPaid();f.f.f.setAgreement({status:"review_required"});
  f.f.f.subscription.status="canceled";
  expect((await recoverExactRenewalSandbox(f.args)).outcome).toBe("paid_accounted");noStripeWrites(f);
});

test("void invoice plus canceled original PI records terminal unpaid without voiding anything itself",async()=>{
  const f=await fixture();Object.assign(f.f.invoice,{status:"void",amount_remaining:0});
  f.f.invoice.status_transitions.voided_at=f.args.now();f.f.pi.status="canceled";f.f.pi.canceled_at=f.args.now();f.f.link.status="canceled";
  expect(await recoverExactRenewalSandbox(f.args)).toEqual({status:"payment_recovery_recorded",outcome:"terminal_unpaid"});noStripeWrites(f);
});

test.each(["invoice still open","uncollectible","PI still actionable","link not canceled","future cancel"])
("%s is not mistaken for a terminal unpaid invoice",async(problem)=>{
  const f=await fixture();Object.assign(f.f.invoice,{status:"void",amount_remaining:0});f.f.invoice.status_transitions.voided_at=f.args.now();
  Object.assign(f.f.pi,{status:"canceled",canceled_at:f.args.now()});f.f.link.status="canceled";
  if(problem==="invoice still open") {f.f.invoice.status="open";f.f.invoice.amount_remaining=f.f.invoice.amount_due;}
  if(problem==="uncollectible") {f.f.invoice.status="uncollectible";f.f.invoice.amount_remaining=f.f.invoice.amount_due;}
  if(problem==="PI still actionable") f.f.pi.status="requires_action";
  if(problem==="link not canceled") f.f.link.status="open";
  if(problem==="future cancel") f.f.pi.canceled_at=f.args.now()+100;
  expect((await recoverExactRenewalSandbox(f.args)).outcome).toBe("review_required");noStripeWrites(f);
});

test("terminal proof inspects the last failed charge when present",async()=>{
  const f=await fixture();Object.assign(f.f.invoice,{status:"void",amount_remaining:0});f.f.invoice.status_transitions.voided_at=f.args.now();
  Object.assign(f.f.pi,{status:"canceled",canceled_at:f.args.now(),latest_charge:f.f.charge.id});f.f.link.status="canceled";
  Object.assign(f.f.charge,{status:"failed",paid:false,captured:false,amount_captured:0,amount_refunded:0,balance_transaction:null});
  expect((await recoverExactRenewalSandbox(f.args)).outcome).toBe("terminal_unpaid");
  f.f.charge.paid=true;await expect(recoverExactRenewalSandbox(f.args)).rejects.toThrow("terminal charge evidence differs");
});

test.each(["live","customer","PI","fee","destination","amount","received","invoice customer","tax","auto retry","additional payment","card"])
("wrong %s evidence stays held without acknowledgment or monetary mutation",async(problem)=>{
  const f=await fixture();
  if(problem==="live") f.f.pi.livemode=true;
  if(problem==="customer") f.f.pi.customer="cus_other";
  if(problem==="PI") f.f.link.payment.payment_intent="pi_other";
  if(problem==="fee") f.f.pi.application_fee_amount=1;
  if(problem==="destination") f.f.pi.transfer_data!.destination="acct_other";
  if(problem==="amount") f.f.pi.amount=1;
  if(problem==="received") f.f.pi.amount_received=1;
  if(problem==="invoice customer") f.f.invoice.customer="cus_other";
  if(problem==="tax") f.f.invoice.automatic_tax.enabled=true;
  if(problem==="auto retry") f.f.invoice.next_payment_attempt=f.args.now()+60;
  if(problem==="additional payment") f.f.api.invoicePayments.list.mockResolvedValueOnce({has_more:false,data:[f.f.link,f.f.link]});
  if(problem==="card") f.f.pi.payment_method="pm_other";
  await expect(recoverExactRenewalSandbox(f.args)).rejects.toThrow();expect(f.recoveryStore.begin).toHaveBeenCalled();
  expect(f.recoveryStore.finish).not.toHaveBeenCalled();noStripeWrites(f);
});

test("unknown/mismatched capture state is not declared failed just because the invoice is still open",async()=>{
  const f=await fixture();f.f.pi.status="succeeded";f.f.pi.amount_received=f.f.pi.amount;
  await expect(recoverExactRenewalSandbox(f.args)).rejects.toThrow("capture needs reconciliation");noStripeWrites(f);
});

test("recovery cannot adopt a preparation claim or bind a replacement PI",async()=>{
  const f=await fixture();f.f.setPhase("prepared");
  await expect(recoverExactRenewalSandbox(f.args)).rejects.toThrow("original admission");noStripeWrites(f);
});

test("stale observation reports reconciliation, not a successful recovery",async()=>{
  const f=await fixture();f.recoveryStore.finish.mockResolvedValueOnce(false);
  expect(await recoverExactRenewalSandbox(f.args)).toEqual({status:"reconciliation_required"});
});

test.each(["read","paid receipt"])("%s outage is redacted and cannot authorize another payment",async(step)=>{
  const f=await fixture();if(step==="read") f.f.api.invoices.retrieve.mockRejectedValueOnce(new Error("secret-provider-data"));
  else {f.f.markPaid();f.f.api.balanceTransactions.retrieve.mockRejectedValueOnce(new Error("secret-provider-data"));}
  await expect(recoverExactRenewalSandbox(f.args)).rejects.toThrow(/Exact recovery .*unavailable/);
  expect(f.recoveryStore.finish).not.toHaveBeenCalled();noStripeWrites(f);
});

test("observations never include provider error text, hosted URLs or client secrets",async()=>{
  const f=await fixture();Object.assign(f.f.pi,{client_secret:"synthetic-secret",last_payment_error:{message:"private"}});
  Object.assign(f.f.invoice,{hosted_invoice_url:"https://example.invalid/private"});
  await recoverExactRenewalSandbox(f.args);
  const evidence=f.recoveryStore.finish.mock.calls[0][5];
  expect(Object.keys(evidence).sort()).toEqual(["amountCapturable","amountReceived","canceledAt","invoiceStatus","paymentStatus","voidedAt"].sort());
});

test.each([{VERCEL_ENV:"production"},{STRIPE_SECRET_KEY:"sk_live_synthetic"},{NEXT_PUBLIC_SITE_URL:"https://www.creatornet.net"},
  {CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY:"false"},{CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"false"}])
("unsafe environment %j stops before any persisted hold or Stripe read",async(override)=>{
  const f=await fixture();Object.assign(f.env,override);
  await expect(recoverExactRenewalSandbox(f.args)).rejects.toThrow();expect(f.recoveryStore.begin).not.toHaveBeenCalled();
  expect(f.f.api.invoices.retrieve).not.toHaveBeenCalled();
});

test("real adapter validates its persisted basis and uses only narrow recovery RPCs",async()=>{
  const f=await fixture();const rpc=jest.fn().mockResolvedValue({data:f.snapshot,error:null});
  const adapter=createExactPaymentRecoveryStore({rpc} as never);
  expect(await adapter.begin(f.f.a.planId,f.f.invoice.id)).toEqual(f.snapshot);
  rpc.mockResolvedValueOnce({data:{...f.snapshot,revision:-1},error:null});
  await expect(adapter.begin(f.f.a.planId,f.f.invoice.id)).rejects.toThrow("invalid recovery basis");
  rpc.mockResolvedValueOnce({data:null,error:{message:"private-database-message"}});
  await expect(adapter.begin(f.f.a.planId,f.f.invoice.id)).rejects.toThrow("Exact recovery database operation failed");
});
