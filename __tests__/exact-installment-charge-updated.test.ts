import type Stripe from "stripe";
import {dispatchExactInstallmentEventSandbox,type ExactEventBindingStore} from "../lib/installments/eventBridge";
import {exactActivationDates,type ActivationClaim,type ExactActivationStore} from "../lib/installments/activation";
import {installmentMonthBoundary} from "../lib/installments/checkoutPreparation";
import {exactInstallmentFixture} from "../test-support/exact-installment-fixture";

// Real bridge, first-evidence, credit orchestration and held-activation code.
// Only provider/persistence boundaries are synthetic; no network or real keys.
function fixture() {
  const f=exactInstallmentFixture();f.paid();
  const binding={agreementId:f.agreement.id,purchaseId:"99999999-9999-4999-8999-999999999999",
    sessionId:f.session.id,subscriptionId:f.subscription.id,customerId:f.customer.id,
    status:"awaiting_first",previewOrigin:f.terms.previewOrigin};
  const bindings={bySession:jest.fn(async()=>binding as typeof binding|null),bySubscription:jest.fn(),
    byIntent:jest.fn<ReturnType<ExactEventBindingStore["byIntent"]>,[string]>(async()=>null)};
  const balance={id:"txn_fixture",source:f.charge.id,type:"charge",amount:66633,currency:"usd",fee:1962,net:64671};
  const creditResults:boolean[]=[];
  let counted=false,activationComplete=false,activationBusy=false;
  const creditStore={bindPurchase:jest.fn(),recordRefundEvidence:jest.fn(),
    credit:jest.fn(async()=>{const fresh=!counted;counted=true;creditResults.push(fresh);return fresh;}),
    reconcileDispute:jest.fn()};
  const lifecycleStore={seed:jest.fn(),fulfillFirst:jest.fn()};
  const dates=exactActivationDates(f.charge.created,3);
  const auth={agreementId:f.agreement.id,firstPaymentIntentId:f.pi.id,firstPaidAt:f.charge.created,
    paymentMethodId:"pm_fixture",subscriptionItemId:"si_fixture",...dates};
  const activationStore={claim:jest.fn<Promise<ActivationClaim>,Parameters<ExactActivationStore["claim"]>>(async()=>{
    if(activationComplete)return {status:"complete",authorization:auth};
    if(activationBusy)return {status:"busy"};
    activationBusy=true;return {status:"new",authorization:auth};
  }),complete:jest.fn(async()=>{activationComplete=true;activationBusy=false;})};
  const sub=f.subscription;
  Object.assign(sub,{cancel_at_period_end:false,trial_end:f.agreement.createdAt+48*3600,
    cancel_at:installmentMonthBoundary(f.agreement.createdAt+48*3600,2),
    billing_cycle_anchor:f.agreement.createdAt+48*3600,pause_collection:{behavior:"keep_as_draft",resumes_at:null}});
  Object.assign(sub.items.data[0],{id:"si_fixture",subscription:sub.id});
  Object.assign(sub.items.data[0].price,{billing_scheme:"per_unit"});
  Object.assign(sub.items.data[0].price.recurring!,{usage_type:"licensed"});
  const update=jest.fn(async(_id:string,p:Stripe.SubscriptionUpdateParams,o:Stripe.RequestOptions)=>{
    expect(o.idempotencyKey).toBe(`exact-cents-held-v1:${f.agreement.id}:activate-first-paid-v1`);
    expect(p.pause_collection).toEqual({behavior:"keep_as_draft"});expect(p.proration_behavior).toBe("none");
    Object.assign(sub,{trial_end:p.trial_end,billing_cycle_anchor:p.trial_end,cancel_at:p.cancel_at,
      default_payment_method:p.default_payment_method,metadata:{...sub.metadata,...p.metadata as Stripe.Metadata}});
    return sub;
  });
  const mocks={...f.mocks,subscriptions:{...f.mocks.subscriptions,update},
    paymentMethods:{retrieve:jest.fn(async()=>({id:"pm_fixture",livemode:false,type:"card",customer:f.customer.id}))},
    balanceTransactions:{retrieve:jest.fn(async()=>balance)},invoices:{list:jest.fn(async()=>({has_more:false,data:[]})),
      create:jest.fn(),finalizeInvoice:jest.fn(),pay:jest.fn()},
    paymentIntents:{...f.mocks.paymentIntents,create:jest.fn(),confirm:jest.fn()}};
  const env:Record<string,string|undefined>={...f.env,CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY:"true",
    CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT:"false"};
  const event=(type="charge.updated",eventId="evt_charge")=>({id:eventId,type,livemode:false,
    data:{object:structuredClone(type==="charge.updated"?f.charge:f.session)}} as Stripe.Event);
  const args={...f.args,env,stripe:mocks as unknown as Stripe,bindings,creditStore,activationStore,lifecycleStore,
    invoiceStore:{claim:jest.fn(),prepareDispatch:jest.fn(),admitDispatch:jest.fn(),recordReceipt:jest.fn(),
      completeAgreement:jest.fn(),priorPayments:jest.fn()},
    refundStore:{creditedReceipt:jest.fn(),hold:jest.fn(),apply:jest.fn(),confirmAdminDelivery:jest.fn()},
    lifecycleEventStore:{read:jest.fn(),hold:jest.fn(),observe:jest.fn(),dispute:jest.fn()},
    recoveryStore:{begin:jest.fn(),finish:jest.fn(),has:jest.fn()},verifiedEvent:event(),now:()=>f.agreement.createdAt+120};
  return {...f,binding,bindings,balance,creditResults,creditStore,activationStore,lifecycleStore,sub,update,mocks,env,args,event};
}
function noWrites(f:ReturnType<typeof fixture>) {
  expect(f.store.recordFirstReceipt).not.toHaveBeenCalled();expect(f.creditStore.bindPurchase).not.toHaveBeenCalled();
  expect(f.creditStore.recordRefundEvidence).not.toHaveBeenCalled();expect(f.creditStore.credit).not.toHaveBeenCalled();
  expect(f.lifecycleStore.fulfillFirst).not.toHaveBeenCalled();expect(f.activationStore.claim).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
}
function noDebit(f:ReturnType<typeof fixture>) {
  expect(f.mocks.invoices.create).not.toHaveBeenCalled();expect(f.mocks.invoices.finalizeInvoice).not.toHaveBeenCalled();
  expect(f.mocks.invoices.pay).not.toHaveBeenCalled();expect(f.mocks.paymentIntents.create).not.toHaveBeenCalled();
  expect(f.mocks.paymentIntents.confirm).not.toHaveBeenCalled();expect(f.mocks.subscriptions.create).not.toHaveBeenCalled();
  expect(f.mocks.checkout.sessions.create).not.toHaveBeenCalled();expect(f.args.invoiceStore.claim).not.toHaveBeenCalled();
}

test("delayed balance transaction recovers from charge.updated using fresh objects, then replays once",async()=>{
  const f=fixture();f.charge.balance_transaction=null;
  await expect(dispatchExactInstallmentEventSandbox({...f.args,verifiedEvent:f.event("checkout.session.completed","evt_checkout")}))
    .rejects.toThrow("balance transaction is not available");
  noWrites(f);
  // This stale snapshot still says null/unpaid/wrong amounts. Only its charge ID is used.
  const event=f.event();Object.assign(event.data.object,{balance_transaction:null,paid:false,amount:1,payment_intent:"pi_stale"});
  f.charge.balance_transaction="txn_fixture";
  expect(await dispatchExactInstallmentEventSandbox({...f.args,verifiedEvent:event})).toEqual({handled:true,disposition:"first_credited_held"});
  expect(f.creditResults).toEqual([true]);expect(f.receipts).toHaveLength(1);
  expect(f.creditStore.credit).toHaveBeenCalledWith(f.agreement.id,{paymentNumber:1,chargeId:f.charge.id,
    balanceTransactionId:"txn_fixture",actualStripeFeeCents:1962});
  expect(f.creditStore.credit.mock.invocationCallOrder[0]).toBeLessThan(f.lifecycleStore.fulfillFirst.mock.invocationCallOrder[0]);
  expect(f.lifecycleStore.fulfillFirst.mock.invocationCallOrder[0]).toBeLessThan(f.activationStore.claim.mock.invocationCallOrder[0]);
  await dispatchExactInstallmentEventSandbox({...f.args,verifiedEvent:f.event("checkout.session.completed","evt_checkout")});
  await dispatchExactInstallmentEventSandbox({...f.args,verifiedEvent:event});
  expect(f.creditResults).toEqual([true,false,false]);expect(f.receipts).toHaveLength(1);expect(f.update).toHaveBeenCalledTimes(1);
  expect(f.sub.pause_collection).toEqual({behavior:"keep_as_draft",resumes_at:null});noDebit(f);
});

test("concurrent distinct Checkout/charge deliveries converge; busy activation retries without another update",async()=>{
  const f=fixture();
  const results=await Promise.allSettled([
    dispatchExactInstallmentEventSandbox({...f.args,verifiedEvent:f.event("checkout.session.completed","evt_checkout")}),
    dispatchExactInstallmentEventSandbox({...f.args,verifiedEvent:f.event("charge.updated","evt_charge")}),
  ]);
  expect(results.some(r=>r.status==="fulfilled")).toBe(true);
  for(const r of results)if(r.status==="rejected")expect(String(r.reason)).toContain("busy");
  await dispatchExactInstallmentEventSandbox({...f.args,verifiedEvent:f.event()});
  expect(f.creditResults.filter(Boolean)).toHaveLength(1);expect(f.receipts).toHaveLength(1);
  expect(f.update).toHaveBeenCalledTimes(1);expect(f.activationStore.complete).toHaveBeenCalledTimes(1);noDebit(f);
});

test.each(["wrong PI","wrong charge","wrong customer","unknown renewal","missing first marker","wrong agreement","unpaid","uncaptured","live object"])
("%s cannot use copied metadata to credit a different first payment",async(change)=>{
  const f=fixture();
  if(change==="wrong PI"){f.pi.id="pi_other";f.charge.payment_intent=f.pi.id;}
  if(change==="wrong charge")f.pi.latest_charge="ch_other";
  if(change==="wrong customer")f.charge.customer="cus_other";
  if(change==="unknown renewal"){f.pi.id="pi_renewal";f.charge.payment_intent=f.pi.id;f.pi.metadata={...f.pi.metadata,installment_number:"2"};}
  if(change==="missing first marker")f.pi.metadata={...f.pi.metadata,installment_number:""};
  if(change==="wrong agreement")f.pi.metadata={...f.pi.metadata,installment_plan_id:f.terms.buyerId};
  if(change==="unpaid")f.session.payment_status="unpaid";
  if(change==="uncaptured")f.charge.captured=false;
  if(change==="live object")f.charge.livemode=true;
  await expect(dispatchExactInstallmentEventSandbox({...f.args,verifiedEvent:f.event()})).rejects.toThrow();noWrites(f);noDebit(f);
});

test.each(["PI","charge"])("second fresh receipt inspection catches changed %s before all writes",async(change)=>{
  const f=fixture();
  // Initial routing evidence is correct; provider state changes before credit inspection.
  let reads=0;
  f.mocks.checkout.sessions.retrieve.mockImplementation(async()=>{
    if(++reads===2){
      if(change==="PI"){
        f.session.payment_intent="pi_changed";f.pi.id="pi_changed";f.charge.payment_intent="pi_changed";
      }else{f.pi.latest_charge="ch_changed";f.charge.id="ch_changed";}
    }
    return f.session;
  });
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("event identity mismatch");
  noWrites(f);noDebit(f);
});

test.each(["partial refund","full refund","dispute"])("%s evidence quarantines recovery before credit or fulfillment",async(change)=>{
  const f=fixture();
  if(change==="partial refund")f.charge.amount_refunded=100;
  else if(change==="full refund"){f.charge.amount_refunded=66633;f.charge.refunded=true;}
  else f.charge.disputed=true;
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("requires review");
  noWrites(f);noDebit(f);
});

test.each(["refund","dispute"])("new %s on second charge read quarantines recovery before any write",async(change)=>{
  const f=fixture();let reads=0;
  f.mocks.charges.retrieve.mockImplementation(async()=>{
    if(++reads===2){if(change==="refund")f.charge.amount_refunded=100;else f.charge.disputed=true;}
    return f.charge;
  });
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("requires review");noWrites(f);noDebit(f);
});

test.each([false,true])("preparation paused quarantines %s known exact charge without credit",async(known)=>{
  const f=fixture();f.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE="false";
  if(known){f.bindings.byIntent.mockResolvedValue(f.binding);f.pi.metadata={};}
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"reconciliation_required"});
  noWrites(f);expect(f.store.load).not.toHaveBeenCalled();noDebit(f);
});

test.each(["production","live event"])("%s fails before provider or binding access",async(change)=>{
  const f=fixture();if(change==="production")f.env.VERCEL_ENV="production";else f.args.verifiedEvent.livemode=true;
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow();
  expect(f.mocks.charges.retrieve).not.toHaveBeenCalled();expect(f.bindings.byIntent).not.toHaveBeenCalled();noWrites(f);
});

test.each([false,true])("all gates off with charge exact tag %s never reads Stripe or DB",async(tagged)=>{
  const f=fixture();f.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY="false";f.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE="false";
  if(tagged)(f.args.verifiedEvent.data.object as Stripe.Charge).metadata={installment_collection_version:f.terms.version};
  if(tagged)await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("cannot fall back");
  else expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:false});
  expect(f.mocks.charges.retrieve).not.toHaveBeenCalled();expect(f.bindings.byIntent).not.toHaveBeenCalled();
  expect(f.store.load).not.toHaveBeenCalled();noWrites(f);
});

test("unrelated current PI remains legacy even when preparation is enabled",async()=>{
  const f=fixture();f.pi.metadata={};
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:false});
  expect(f.store.load).not.toHaveBeenCalled();noWrites(f);noDebit(f);
});

test.each([false,true])("persisted renewal with exact metadata %s cannot credit/activate first payment",async(tagged)=>{
  const f=fixture();f.pi.id="pi_renewal";f.charge.payment_intent=f.pi.id;
  f.pi.metadata=tagged?{...f.pi.metadata,installment_number:"2"}:{};
  f.bindings.byIntent.mockResolvedValue(f.binding);
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"separate_receipt_handler"});
  noWrites(f);noDebit(f);
});

test("persisted intent with conflicting candidate agreement fails closed",async()=>{
  const f=fixture();f.bindings.byIntent.mockResolvedValue({...f.binding,agreementId:f.terms.buyerId});
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("agreement conflict");noWrites(f);
});
