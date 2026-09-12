import type Stripe from "stripe";
import { createExactBillingStopStore, stopExactInstallmentBillingSandbox, type ExactBillingStopStore } from "../lib/installments/billingStop";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";

function fixture(paid=false) {
  const f=exactInstallmentFixture();f.paid();
  f.subscription.pause_collection={behavior:"keep_as_draft",resumes_at:null};
  f.session.status=paid?"complete":"open";f.session.payment_status=paid?"paid":"unpaid";
  if(!paid) f.session.payment_intent=null;
  const stopStore={
    claim:jest.fn<ReturnType<ExactBillingStopStore["claim"]>,Parameters<ExactBillingStopStore["claim"]>>(async()=>"ready"),
    assertClaim:jest.fn(async()=>{}),accounted:jest.fn(async():Promise<boolean>=>true),complete:jest.fn(async()=>{}),
  } satisfies ExactBillingStopStore;
  const stripe={...f.mocks,
    subscriptions:{...f.mocks.subscriptions,
      list:jest.fn(async()=>({has_more:false,data:[f.subscription]})),
      cancel:jest.fn(async()=>{f.subscription.status="canceled";f.subscription.canceled_at=f.agreement.createdAt+2;
        f.subscription.ended_at=f.agreement.createdAt+2;return f.subscription;}),
    },
    checkout:{sessions:{...f.mocks.checkout.sessions,
      expire:jest.fn(async()=>{f.session.status="expired";return f.session;}),
    }},
    invoices:{list:jest.fn<Promise<Stripe.ApiList<Stripe.Invoice>>,unknown[]>(async()=>({has_more:false,data:[]} as never))},
    invoicePayments:{list:jest.fn<Promise<Stripe.ApiList<Stripe.InvoicePayment>>,unknown[]>(async()=>({has_more:false,data:[]} as never))},
    invoiceItems:{list:jest.fn(async()=>({has_more:false,data:[]}))},
  };
  const args={agreementId:f.agreement.id,requestId:f.terms.bookingId,actorId:f.terms.creatorId,store:f.store,stopStore,
    stripe:stripe as unknown as Parameters<typeof stopExactInstallmentBillingSandbox>[0]["stripe"],
    env:{...f.env,CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE:"false",CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"true",
      CREATOR_EXACT_INSTALLMENTS_BILLING_STOPS_READY:"true"},now:()=>f.agreement.createdAt+3};
  return {...f,stopStore,stripe,args};
}
test("unpaid stop claims the hold, expires Checkout, cancels only its held subscription, and confirms evidence",async()=>{
  const f=fixture();expect(await stopExactInstallmentBillingSandbox(f.args)).toEqual({status:"collection_stopped"});
  expect(f.stopStore.claim.mock.invocationCallOrder[0]).toBeLessThan(f.stripe.customers.retrieve.mock.invocationCallOrder[0]);
  expect(f.stopStore.assertClaim).toHaveBeenCalledTimes(2);
  expect(f.stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_test_fixture",{},
    {idempotencyKey:expect.stringContaining(":expire-approved-stop-v1"),maxNetworkRetries:0});
  expect(f.stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_fixture",{invoice_now:false,prorate:false},{maxNetworkRetries:0});
  expect(f.stopStore.complete).toHaveBeenCalledWith(expect.objectContaining({agreementId:f.agreement.id}),{
    subscriptionId:"sub_fixture",sessionId:"cs_test_fixture",canceledAt:f.agreement.createdAt+2,
    checkoutStatus:"expired",firstPaymentIntentId:null});
  expect(f.stripe.subscriptions.update).not.toHaveBeenCalled();
});
test("paid first installment must already be accounted and is never expired or refunded",async()=>{
  const f=fixture(true);expect((await stopExactInstallmentBillingSandbox(f.args)).status).toBe("collection_stopped");
  expect(f.stripe.checkout.sessions.expire).not.toHaveBeenCalled();
  expect(f.stopStore.accounted).toHaveBeenCalledWith(f.agreement.id,"intent","pi_fixture",66633);
  expect(f.stopStore.complete).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({firstPaymentIntentId:"pi_fixture",checkoutStatus:"complete"}));
});
test.each(["busy","reconciliation_required","complete"] as const)("claim %s makes no Stripe request",async(status)=>{
  const f=fixture();f.stopStore.claim.mockResolvedValueOnce(status);
  expect((await stopExactInstallmentBillingSandbox(f.args)).status).toBe(status==="complete"?"collection_stopped":status);
  expect(f.stripe.customers.retrieve).not.toHaveBeenCalled();expect(f.stripe.subscriptions.cancel).not.toHaveBeenCalled();
});
test.each([
  {VERCEL_ENV:"production"},{STRIPE_SECRET_KEY:"sk_live_synthetic"},
  {NEXT_PUBLIC_SUPABASE_URL:"https://other.supabase.co"},{NEXT_PUBLIC_SITE_URL:"https://www.creatornet.net"},
  {CREATOR_EXACT_INSTALLMENTS_BILLING_STOPS_READY:"false"},{CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"false"},
])("invalid environment %j rejects before database or Stripe",async(overrides)=>{
  const f=fixture();Object.assign(f.args.env,overrides);
  await expect(stopExactInstallmentBillingSandbox(f.args)).rejects.toThrow();
  expect(f.store.load).not.toHaveBeenCalled();expect(f.stopStore.claim).not.toHaveBeenCalled();
});
test("invalid caller identities cannot reach database",async()=>{
  const f=fixture();f.args.actorId="not-a-uuid";await expect(stopExactInstallmentBillingSandbox(f.args)).rejects.toThrow();
  expect(f.stopStore.claim).not.toHaveBeenCalled();
});
test.each([
  ["foreign customer",(f:ReturnType<typeof fixture>)=>{f.customer.metadata.installment_plan_id="another";}],
  ["foreign subscription",f=>{f.subscription.customer="cus_other";}],
  ["changed destination",f=>{f.subscription.transfer_data!.destination="acct_other";}],
  ["resume scheduled",f=>{f.subscription.pause_collection!.resumes_at=f.args.now()+30;}],
  ["no hold",f=>{f.subscription.pause_collection=null;}],
  ["other subscription",f=>{f.stripe.subscriptions.list.mockResolvedValue({has_more:false,data:[f.subscription,{...f.subscription,id:"sub_other"}]});}],
  ["subscription pagination",f=>{f.stripe.subscriptions.list.mockResolvedValue({has_more:true,data:[f.subscription]});}],
  ["pending invoice items",f=>{f.stripe.invoiceItems.list.mockResolvedValue({has_more:true,data:[]});}],
  ["foreign Checkout",f=>{f.session.customer="cus_other";}],
  ["live Checkout",f=>{f.session.livemode=true;}],
  ["wrong first price",f=>{f.session.amount_total=1;}],
] satisfies Array<[string,(f:ReturnType<typeof fixture>)=>void]>)
("%s leaves hold and refuses all Stripe writes",async(_name,mutate)=>{
  const f=fixture();mutate(f);await expect(stopExactInstallmentBillingSandbox(f.args)).rejects.toThrow();
  expect(f.stopStore.claim).toHaveBeenCalled();expect(f.stripe.checkout.sessions.expire).not.toHaveBeenCalled();
  expect(f.stripe.subscriptions.cancel).not.toHaveBeenCalled();expect(f.stopStore.complete).not.toHaveBeenCalled();
});
test("lost expire response re-reads the expired session and continues",async()=>{
  const f=fixture();f.stripe.checkout.sessions.expire.mockImplementationOnce(async()=>{f.session.status="expired";throw new Error("private");});
  expect((await stopExactInstallmentBillingSandbox(f.args)).status).toBe("collection_stopped");
});
test("Checkout wins expiry race: wait for first accounting without canceling a paid mentorship",async()=>{
  const f=fixture();f.stripe.checkout.sessions.expire.mockImplementationOnce(async()=>{
    f.session.status="complete";f.session.payment_status="paid";f.session.payment_intent="pi_fixture";throw new Error("race");});
  f.stopStore.accounted.mockResolvedValue(false);
  expect((await stopExactInstallmentBillingSandbox(f.args)).status).toBe("reconciliation_required");
  expect(f.stripe.subscriptions.cancel).not.toHaveBeenCalled();expect(f.stopStore.complete).not.toHaveBeenCalled();
});
test("expired Checkout with a canceled unpaid PI can complete",async()=>{
  const f=fixture();f.session.payment_intent="pi_fixture";f.pi.status="canceled";f.pi.amount_received=0;f.pi.amount_capturable=0;
  expect((await stopExactInstallmentBillingSandbox(f.args)).status).toBe("collection_stopped");
});
test.each(["processing","requires_action","requires_capture","requires_payment_method","succeeded"] as const)
("expired Checkout with %s PI requires review, never directly cancels/captures/refunds it",async(status)=>{
  const f=fixture();f.session.payment_intent="pi_fixture";f.pi.status=status;
  expect((await stopExactInstallmentBillingSandbox(f.args)).status).toBe("reconciliation_required");
  expect(f.stripe.subscriptions.cancel).not.toHaveBeenCalled();expect(f.stopStore.complete).not.toHaveBeenCalled();
});
test("expire error without terminal evidence cannot stop subscription or complete",async()=>{
  const f=fixture();f.stripe.checkout.sessions.expire.mockRejectedValueOnce(new Error("private"));
  expect((await stopExactInstallmentBillingSandbox(f.args)).status).toBe("reconciliation_required");
  expect(f.stripe.subscriptions.cancel).not.toHaveBeenCalled();expect(f.stopStore.complete).not.toHaveBeenCalled();
});
test("lost cancellation response uses retrieved canceled state; later completion retry makes no second Stripe mutation",async()=>{
  const f=fixture();f.stripe.subscriptions.cancel.mockImplementationOnce(async()=>{
    f.subscription.status="canceled";f.subscription.canceled_at=f.args.now();f.subscription.ended_at=f.args.now();throw new Error("private");});
  f.stopStore.complete.mockRejectedValueOnce(new Error("completion unavailable"));
  await expect(stopExactInstallmentBillingSandbox(f.args)).rejects.toThrow("completion unavailable");
  expect((await stopExactInstallmentBillingSandbox(f.args)).status).toBe("collection_stopped");
  expect(f.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);expect(f.stripe.checkout.sessions.expire).toHaveBeenCalledTimes(1);
});
test("unconfirmed cancellation never records success",async()=>{
  const f=fixture();f.stripe.subscriptions.cancel.mockRejectedValueOnce(new Error("private"));
  expect((await stopExactInstallmentBillingSandbox(f.args)).status).toBe("reconciliation_required");
  expect(f.stopStore.complete).not.toHaveBeenCalled();
});
test("lost authorization stops before expire",async()=>{
  const f=fixture();f.stopStore.assertClaim.mockRejectedValueOnce(new Error("claim lost"));
  await expect(stopExactInstallmentBillingSandbox(f.args)).rejects.toThrow("claim lost");
  expect(f.stripe.checkout.sessions.expire).not.toHaveBeenCalled();
});
function invoice(f:ReturnType<typeof fixture>,overrides:Partial<Stripe.Invoice>={}) {
  return {id:"in_fixture",livemode:false,customer:f.customer.id,parent:{subscription_details:{subscription:f.subscription.id}},
    currency:"usd",status:"draft",auto_advance:false,amount_paid:0,...overrides} as Stripe.Invoice;
}
test("held unpaid invoices are preserved without voiding or paying",async()=>{
  const f=fixture();f.stripe.invoices.list.mockResolvedValue({has_more:false,data:[invoice(f)]} as never);
  expect((await stopExactInstallmentBillingSandbox(f.args)).status).toBe("collection_stopped");
});
test.each(["foreign subscription","automatic collection","paid but uncredited"])("invoice %s blocks cleanup",async(reason)=>{
  const f=fixture();const inv=invoice(f);
  if(reason==="foreign subscription") inv.parent!.subscription_details!.subscription="sub_other";
  if(reason==="automatic collection") inv.auto_advance=true;
  if(reason==="paid but uncredited") {inv.status="paid";inv.amount_paid=66633;f.stopStore.accounted.mockResolvedValue(false);}
  f.stripe.invoices.list.mockResolvedValue({has_more:false,data:[inv]} as never);
  await expect(stopExactInstallmentBillingSandbox(f.args)).rejects.toThrow();
  expect(f.stripe.subscriptions.cancel).not.toHaveBeenCalled();expect(f.stripe.checkout.sessions.expire).not.toHaveBeenCalled();
});
test("later credited paid invoice is checked by its own invoice identity",async()=>{
  const f=fixture(true);f.stripe.invoices.list.mockResolvedValue({has_more:false,data:[invoice(f,{status:"paid",amount_paid:66633})]} as never);
  expect((await stopExactInstallmentBillingSandbox(f.args)).status).toBe("collection_stopped");
  expect(f.stopStore.accounted).toHaveBeenCalledWith(f.agreement.id,"invoice","in_fixture",66633);
});
test("Stripe read errors cannot leak provider details",async()=>{
  const f=fixture();f.stripe.customers.retrieve.mockRejectedValueOnce(new Error("private-secret-value"));
  await expect(stopExactInstallmentBillingSandbox(f.args)).rejects.toThrow("Exact billing stop: Stripe evidence unavailable");
});
test.each(["requires_payment_method","canceled"] as const)("open invoice with a verified %s PI preserves the unpaid invoice",async(status)=>{
  const f=fixture();const inv=invoice(f,{status:"open"});
  f.stripe.invoices.list.mockResolvedValue({has_more:false,data:[inv]} as never);
  const link={livemode:false,invoice:inv.id,is_default:true,currency:"usd",status:"open",amount_paid:null,
    amount_requested:66633,payment:{type:"payment_intent",payment_intent:f.pi.id}} as Stripe.InvoicePayment;
  f.stripe.invoicePayments.list.mockResolvedValue({has_more:false,data:[link]} as never);
  f.pi.status=status;f.pi.amount_received=0;f.pi.amount_capturable=0;
  expect((await stopExactInstallmentBillingSandbox(f.args)).status).toBe("collection_stopped");
  expect(inv.status).toBe("open");expect(link.status).toBe("open");
});
test.each(["processing","requires_action","requires_capture","succeeded","requires_confirmation"] as const)
("unpaid invoice with %s PI requires review before any cleanup",async(status)=>{
  const f=fixture();const inv=invoice(f,{status:"open"});
  f.stripe.invoices.list.mockResolvedValue({has_more:false,data:[inv]} as never);
  f.stripe.invoicePayments.list.mockResolvedValue({has_more:false,data:[{livemode:false,invoice:inv.id,is_default:true,
    currency:"usd",status:"open",amount_paid:null,amount_requested:66633,payment:{type:"payment_intent",payment_intent:f.pi.id}}]} as never);
  f.pi.status=status;f.pi.amount_received=0;f.pi.amount_capturable=0;
  await expect(stopExactInstallmentBillingSandbox(f.args)).rejects.toThrow("invoice payment still unsettled");
  expect(f.stripe.subscriptions.cancel).not.toHaveBeenCalled();expect(f.stripe.checkout.sessions.expire).not.toHaveBeenCalled();
});
test("a canceled-looking response without ended_at is not completion",async()=>{
  const f=fixture();f.stripe.subscriptions.cancel.mockImplementationOnce(async()=>{
    f.subscription.status="canceled";f.subscription.canceled_at=f.args.now();f.subscription.ended_at=null;return f.subscription;});
  expect((await stopExactInstallmentBillingSandbox(f.args)).status).toBe("reconciliation_required");
  expect(f.stopStore.complete).not.toHaveBeenCalled();
});
test("invoice pagination examines the next page and refuses unrelated records",async()=>{
  const f=fixture();f.stripe.invoices.list.mockResolvedValueOnce({has_more:true,data:[invoice(f)]} as never)
    .mockResolvedValueOnce({has_more:false,data:[invoice(f,{id:"in_other",customer:"cus_other"})]} as never);
  await expect(stopExactInstallmentBillingSandbox(f.args)).rejects.toThrow("invoice identity differs");
  expect(f.stripe.invoices.list).toHaveBeenLastCalledWith({customer:f.customer.id,limit:100,starting_after:"in_fixture"});
  expect(f.stripe.subscriptions.cancel).not.toHaveBeenCalled();
});
test("invoice pagination cannot loop on the same ID",async()=>{
  const f=fixture();f.stripe.invoices.list.mockResolvedValue({has_more:true,data:[invoice(f)]} as never);
  await expect(stopExactInstallmentBillingSandbox(f.args)).rejects.toThrow("invoice identity differs");
  expect(f.stripe.invoices.list).toHaveBeenCalledTimes(2);
});
test("adapter reads the receipt's ledger, not the purchase's latest payment",async()=>{
  const f=fixture();const receipt={ledger_id:f.terms.productId,counted_at:"2026-09-05T00:00:00Z",
    amount_cents:"66633",stripe_payment_intent_id:"pi_fixture",stripe_invoice_id:null};
  const ledger={earnings_credited_at:"2026-09-05T00:00:00Z",gross_amount_cents:"66633",
    stripe_payment_intent_id:"pi_fixture",stripe_invoice_id:null};
  const builder=(data:unknown)=>{const b={select:jest.fn(),eq:jest.fn(),maybeSingle:jest.fn(async()=>({data,error:null}))};
    b.select.mockReturnValue(b);b.eq.mockReturnValue(b);return b;};
  const r=builder(receipt),l=builder(ledger);const from=jest.fn((table)=>table==="exact_installment_receipts"?r:l);
  const store=createExactBillingStopStore({from} as never);
  expect(await store.accounted(f.agreement.id,"intent","pi_fixture",66633)).toBe(true);
  expect(r.eq).toHaveBeenCalledWith("agreement_id",f.agreement.id);expect(l.eq).toHaveBeenCalledWith("id",f.terms.productId);
  expect(from).not.toHaveBeenCalledWith("purchases");
  ledger.stripe_payment_intent_id="pi_foreign";
  expect(await store.accounted(f.agreement.id,"intent","pi_fixture",66633)).toBe(false);
});
test("adapter completion uses only explicit identities and verified terminal proof",async()=>{
  const f=fixture(),rpc=jest.fn(async()=>({error:null}));
  const i={agreementId:f.agreement.id,requestId:f.terms.bookingId,actorId:f.terms.creatorId,token:f.terms.buyerId};
  const store=createExactBillingStopStore({rpc} as never);
  await store.assertClaim(i);
  await store.complete(i,{subscriptionId:"sub_fixture",sessionId:"cs_test_fixture",canceledAt:f.args.now(),
    checkoutStatus:"expired",firstPaymentIntentId:null});
  expect(rpc).toHaveBeenLastCalledWith("complete_exact_installment_billing_stop",{p_agreement_id:f.agreement.id,
    p_request_id:f.terms.bookingId,p_actor_id:f.terms.creatorId,p_claim_token:f.terms.buyerId,
    p_subscription_id:"sub_fixture",p_session_id:"cs_test_fixture",p_canceled_at:f.args.now(),
    p_checkout_status:"expired",p_first_payment_intent_id:null});
});
test.each(["ready","busy","complete","reconciliation_required"])("adapter validates claim %s",async(data)=>{
  const rpc=jest.fn().mockResolvedValue({data,error:null});const f=fixture();
  const s=createExactBillingStopStore({rpc} as never);
  expect(await s.claim({agreementId:f.agreement.id,requestId:f.terms.bookingId,actorId:f.terms.creatorId,token:f.terms.buyerId})).toBe(data);
});
test.each([null,true,{},"stopped"])("adapter rejects malformed claim %j",async(data)=>{
  const rpc=jest.fn().mockResolvedValue({data,error:null});const f=fixture();
  await expect(createExactBillingStopStore({rpc} as never).claim({agreementId:f.agreement.id,requestId:f.terms.bookingId,
    actorId:f.terms.creatorId,token:f.terms.buyerId})).rejects.toThrow("Invalid");
});
