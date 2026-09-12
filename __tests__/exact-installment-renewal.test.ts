import type Stripe from "stripe";
import {collectExactRenewalSandbox} from "../lib/installments/renewal";
import {exactRenewalFixture} from "../test-support/exact-renewal-fixture";
import {parseRenewalAuthorization} from "../lib/installments/invoiceStore";

function futureRenewal(){
  const f=exactRenewalFixture(3);
  Object.assign(f.a,{paymentMethodId:"pm_newCard",defaultPaymentMethodId:"pm_fixture",cardAuthorizationId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"});
  f.pm.id="pm_newCard";f.pi.payment_method="pm_newCard";f.charge.payment_method="pm_newCard";
  Object.assign(f.args.env,{CREATOR_EXACT_INSTALLMENTS_FUTURE_CARD_READY:"true"});
  return f;
}
test("future renewal uses the independently bound card, unchanged default and original final cent, once",async()=>{
  const f=futureRenewal(),sub=structuredClone(f.f.subscription);
  expect(parseRenewalAuthorization(f.a)).toEqual(f.a);
  expect(await collectExactRenewalSandbox(f.args)).toEqual({status:"credited",paymentNumber:3});
  expect(f.api.invoices.pay).toHaveBeenCalledWith("in_renewal",{payment_method:"pm_newCard",off_session:true},expect.any(Object));
  expect(f.f.subscription).toEqual(sub);expect(f.f.mocks.subscriptions.update).not.toHaveBeenCalled();
  expect(f.invoice.amount_paid).toBe(66634);expect(f.pi.application_fee_amount).toBe(10425);
  expect(await collectExactRenewalSandbox(f.args)).toEqual({status:"already_credited",paymentNumber:3});
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1);
});
test.each(["gate off","other customer card","default changed","prior refund"])("future renewal %s cannot admit payment",async(problem)=>{
  const f=futureRenewal();
  if(problem==="gate off")Object.assign(f.args.env,{CREATOR_EXACT_INSTALLMENTS_FUTURE_CARD_READY:"false"});
  if(problem==="other customer card")f.pm.customer="cus_other";
  if(problem==="default changed")f.f.subscription.default_payment_method="pm_other";
  if(problem==="prior refund")f.priorCharges[0].amount_refunded=1;
  await expect(collectExactRenewalSandbox(f.args)).rejects.toThrow();expect(f.api.invoices.pay).not.toHaveBeenCalled();
  expect(f.invoiceStore.admitDispatch).not.toHaveBeenCalled();
});
test.each([{cardAuthorizationId:"invalid"},{defaultPaymentMethodId:"bad"},{cardAuthorizationId:undefined},{paymentNumber:2}])
("future card parser rejects incomplete or malformed binding %j",extra=>{
  const f=futureRenewal();expect(()=>parseRenewalAuthorization({...f.a,...extra})).toThrow();
});

test.each([2,3])("installment %i: exact fee verified before one off-session pay; capture credits once",async(number)=>{
  const f=exactRenewalFixture(number);
  expect(await collectExactRenewalSandbox(f.args)).toEqual({status:"credited",paymentNumber:number});
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1);
  expect(f.api.invoices.pay).toHaveBeenCalledWith("in_renewal",{payment_method:"pm_fixture",off_session:true},
    {idempotencyKey:expect.stringContaining(":in_renewal:pay-once-v1"),maxNetworkRetries:0});
  expect(f.calls.indexOf("admit")).toBeLessThan(f.calls.indexOf("pay"));
  expect(f.calls.indexOf("pay")).toBeLessThan(f.calls.indexOf("receipt"));
  expect(f.creditStore.credit).toHaveBeenCalledWith(f.a.planId,{paymentNumber:number,chargeId:"ch_renewal",
    balanceTransactionId:"txn_renewal",actualStripeFeeCents:1962});
  expect(f.api.invoices.addLines).toHaveBeenCalledTimes(number===3?1:0);
  expect(f.invoiceStore.completeAgreement).toHaveBeenCalledTimes(number===3?1:0);
  expect(await collectExactRenewalSandbox(f.args)).toEqual({status:"already_credited",paymentNumber:number});
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1);
  expect(f.api.paymentIntents.confirm).not.toHaveBeenCalled();
  expect(f.f.mocks.subscriptions.update).not.toHaveBeenCalled();
  expect(f.creditStore.bindPurchase).not.toHaveBeenCalled();
});

test("synthetic Stripe port rejects the observed mutually exclusive false flags before attempting payment",async()=>{
  const f=exactRenewalFixture();f.setPhase("dispatching");
  await expect(f.api.invoices.pay(f.invoice.id,{payment_method:"pm_fixture",off_session:true,
    forgive:false,paid_out_of_band:false},{idempotencyKey:"synthetic-only",maxNetworkRetries:0}))
    .rejects.toThrow("Mutually exclusive invoice payment parameters");
  expect(f.invoice.attempt_count).toBe(0);expect(f.invoice.attempted).toBe(false);
  expect(f.invoice.amount_paid).toBe(0);expect(f.pi.amount_received).toBe(0);
});

test("separate collection flag is required; prepare alone cannot charge or credit",async()=>{
  const f=exactRenewalFixture();f.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT="false";
  expect(await collectExactRenewalSandbox(f.args)).toEqual({status:"prepared_unpaid",paymentNumber:2});
  expect(f.api.invoices.pay).not.toHaveBeenCalled();expect(f.invoiceStore.admitDispatch).not.toHaveBeenCalled();
  expect(f.creditStore.credit).not.toHaveBeenCalled();
});

test("active subscription with its expected future cancellation marker permits only the original admission",async()=>{
  const f=exactRenewalFixture();f.f.subscription.canceled_at=f.f.agreement.createdAt;
  expect((await collectExactRenewalSandbox(f.args)).status).toBe("credited");
  expect((await collectExactRenewalSandbox(f.args)).status).toBe("already_credited");
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1);
});
test.each(["production","live key","wrong project","disabled"])("%s fails before a Stripe call",async(reason)=>{
  const f=exactRenewalFixture();
  if(reason==="production") f.env.VERCEL_ENV="production";
  if(reason==="live key") f.env.STRIPE_SECRET_KEY="sk_live_synthetic";
  if(reason==="wrong project") f.env.NEXT_PUBLIC_SUPABASE_URL="https://other.supabase.co";
  if(reason==="disabled") f.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE="false";
  await expect(collectExactRenewalSandbox(f.args)).rejects.toThrow("isolated Sandbox");
  expect(f.api.invoices.retrieve).not.toHaveBeenCalled();expect(f.invoiceStore.claim).not.toHaveBeenCalled();
});
test("a busy invoice worker performs no Stripe mutation",async()=>{
  const f=exactRenewalFixture();f.invoiceStore.claim.mockResolvedValueOnce({status:"busy"});
  expect(await collectExactRenewalSandbox(f.args)).toEqual({status:"busy"});
  expect(f.api.invoices.update).not.toHaveBeenCalled();expect(f.api.invoices.pay).not.toHaveBeenCalled();
});
test.each(["timeout","decline","authentication"])("%s leaves admitted invoice held; replay never retries pay",async(reason)=>{
  const f=exactRenewalFixture();
  f.api.invoices.pay.mockImplementationOnce(async()=>{
    f.invoice.attempted=true;f.invoice.attempt_count=1;
    f.pi.status=reason==="authentication"?"requires_action":"requires_payment_method";
    throw new Error("Sensitive provider response must not escape");
  });
  expect(await collectExactRenewalSandbox(f.args)).toEqual({status:"reconciliation_required",paymentNumber:2});
  expect(await collectExactRenewalSandbox(f.args)).toEqual({status:"reconciliation_required",paymentNumber:2});
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1);expect(f.creditStore.credit).not.toHaveBeenCalled();
});
test("lost successful pay response is reconciled using captured evidence without another attempt",async()=>{
  const f=exactRenewalFixture();f.api.invoices.pay.mockImplementationOnce(async()=>{f.markPaid();throw new Error("lost response");});
  expect((await collectExactRenewalSandbox(f.args)).status).toBe("credited");
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1);
});
test("lost admission response cannot become a fresh pay on retry",async()=>{
  const f=exactRenewalFixture();f.invoiceStore.admitDispatch.mockImplementationOnce(async()=>{f.setPhase("dispatching");throw new Error("response lost");});
  await expect(collectExactRenewalSandbox(f.args)).rejects.toThrow("response lost");
  expect((await collectExactRenewalSandbox(f.args)).status).toBe("reconciliation_required");
  expect(f.api.invoices.pay).not.toHaveBeenCalled();
});
test("a late DB credit failure retries only accounting, never payment",async()=>{
  const f=exactRenewalFixture();f.creditStore.credit.mockRejectedValueOnce(new Error("temporary accounting failure"));
  await expect(collectExactRenewalSandbox(f.args)).rejects.toThrow("accounting failure");
  expect((await collectExactRenewalSandbox(f.args)).status).toBe("credited");
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1);
});
test.each([
  ["refund before webhook",(f:ReturnType<typeof exactRenewalFixture>)=>{f.priorCharges[0].amount_refunded=1;}],
  ["dispute before webhook",f=>{f.priorCharges[0].disputed=true;}],
  ["closed agreement",f=>{f.f.setAgreement({status:"canceled"});}],
  ["canceled subscription",f=>{f.f.subscription.status="canceled";}],
  ["cancel scheduled",f=>{f.f.subscription.cancel_at_period_end=true;}],
  ["automatic resume",f=>{f.f.subscription.pause_collection!.resumes_at=f.args.now()+1;}],
  ["customer credit",f=>{f.f.customer.balance=-100;}],
  ["foreign card",f=>{f.pm.customer="cus_other";}],
  ["changed subscription card",f=>{f.f.subscription.default_payment_method="pm_other";}],
  ["missing prior credit",f=>{f.invoiceStore.priorPayments.mockResolvedValueOnce([]);}],
] satisfies Array<[string,(f:ReturnType<typeof exactRenewalFixture>)=>void]>)
("%s blocks collection and accounting",async(_name,mutate)=>{
  const f=exactRenewalFixture();mutate(f);
  await expect(collectExactRenewalSandbox(f.args)).rejects.toThrow();
  expect(f.api.invoices.pay).not.toHaveBeenCalled();expect(f.creditStore.credit).not.toHaveBeenCalled();
});
test("database refund/cancellation admission rejection stops the debit",async()=>{
  const f=exactRenewalFixture();f.invoiceStore.admitDispatch.mockRejectedValueOnce(new Error("reconciliation required"));
  await expect(collectExactRenewalSandbox(f.args)).rejects.toThrow("reconciliation required");
  expect(f.api.invoices.pay).not.toHaveBeenCalled();
});
test.each([
  ["wrong paid amount",(f:ReturnType<typeof exactRenewalFixture>)=>{f.invoice.amount_paid-=1;}],
  ["wrong invoice marker",f=>{f.invoice.metadata!.installment_number="24";}],
  ["wrong actual PI fee",f=>{f.pi.application_fee_amount=1;}],
  ["wrong destination",f=>{f.pi.transfer_data!.destination="acct_other";}],
  ["other default payment",f=>{f.link.payment.payment_intent="pi_other";}],
  ["credit instead of card",f=>{f.invoice.starting_balance=-1;}],
  ["other balance transaction",f=>{f.balance.source="ch_other";}],
  ["uncaptured charge",f=>{f.charge.captured=false;}],
  ["wrong charge card",f=>{f.charge.payment_method="pm_other";}],
  ["future charge",f=>{f.charge.created=f.args.now()+999;}],
  ["live charge",f=>{f.charge.livemode=true;}],
  ["wrong payment type",f=>{f.charge.payment_method_details!.type="us_bank_account";}],
] satisfies Array<[string,(f:ReturnType<typeof exactRenewalFixture>)=>void]>)
("paid reconciliation rejects %s without granting access",async(_name,mutate)=>{
  const f=exactRenewalFixture();f.api.invoices.pay.mockImplementationOnce(async()=>{f.markPaid();mutate(f);return f.invoice;});
  await expect(collectExactRenewalSandbox(f.args)).rejects.toThrow();
  expect(f.invoiceStore.recordReceipt).not.toHaveBeenCalled();expect(f.creditStore.credit).not.toHaveBeenCalled();
});
test("captured refund evidence is mirrored before accounting, not dropped on paid retry",async()=>{
  const f=exactRenewalFixture();f.api.invoices.pay.mockImplementationOnce(async()=>{
    f.markPaid();f.charge.amount_refunded=100;return f.invoice;
  });
  expect((await collectExactRenewalSandbox(f.args)).status).toBe("credited");
  expect(f.creditStore.recordRefundEvidence).toHaveBeenCalledWith("pi_renewal","ch_renewal",66633,100);
});
test("raw card data, client secret, invoice link or Stripe errors never appear in results",async()=>{
  const f=exactRenewalFixture();f.invoice.hosted_invoice_url="https://example.invalid/private";
  const result=JSON.stringify(await collectExactRenewalSandbox(f.args));
  expect(result).toBe('{"status":"credited","paymentNumber":2}');
});
test("paid evidence can be reconciled after fixed subscription end without resuming it",async()=>{
  const f=exactRenewalFixture();await collectExactRenewalSandbox(f.args);f.f.subscription.status="canceled";
  f.f.setAgreement({status:"complete"});
  expect((await collectExactRenewalSandbox(f.args)).status).toBe("already_credited");
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1);
});
test("unsupported extra invoice payment is not treated as the authorized payment",async()=>{
  const f=exactRenewalFixture();f.api.invoices.pay.mockImplementationOnce(async()=>{
    f.markPaid();f.api.invoicePayments.list.mockResolvedValue({data:[f.link,{...f.link,id:"inpay_other"} as Stripe.InvoicePayment],has_more:false});
    return f.invoice;
  });
  await expect(collectExactRenewalSandbox(f.args)).rejects.toThrow("ambiguous");
  expect(f.creditStore.credit).not.toHaveBeenCalled();
});
