import type Stripe from "stripe";
import {createExactLifecycleStore,observeExactDisputeSandbox,observeExactSubscriptionSandbox,
  type ExactLifecycleStore,type LifecycleBasis,type LifecycleResult} from "../lib/installments/lifecycleEvents";
import {exactInstallmentFixture} from "../test-support/exact-installment-fixture";
import {exactActivationDates} from "../lib/installments/activation";
import {installmentMonthBoundary} from "../lib/installments/checkoutPreparation";
function fixture() {
  const f=exactInstallmentFixture();f.paid();
  const basis:LifecycleBasis={agreementStatus:"awaiting_first",activationStatus:null,activation:null,stopStatus:null,stopCanceledAt:null};
  const store={read:jest.fn(async()=>({revision:0,basis})),hold:jest.fn(async()=>{}),observe:jest.fn(async():Promise<boolean>=>true),
    dispute:jest.fn(async():Promise<LifecycleResult["status"]>=>"lifecycle_observed")} satisfies ExactLifecycleStore;
  const receipt={paymentNumber:1,amountCents:66633,applicationFeeCents:9958,chargeId:f.charge.id,
    balanceTransactionId:"txn_fixture",actualStripeFeeCents:1962,invoiceId:null as string|null};
  const refundStore={creditedReceipt:jest.fn(async()=>receipt as typeof receipt|null),hold:jest.fn(),apply:jest.fn(),confirmAdminDelivery:jest.fn()};
  const dispute={id:"du_fixture",charge:f.charge.id,payment_intent:f.pi.id,amount:66633,currency:"usd",livemode:false,status:"needs_response"} as Stripe.Dispute;
  const balance={id:"txn_fixture",type:"charge",source:f.charge.id,currency:"usd",amount:66633,fee:1962,net:64671};
  const api={...f.mocks,disputes:{retrieve:jest.fn(async()=>dispute)},balanceTransactions:{retrieve:jest.fn(async()=>balance)}};
  const stripe=api as unknown as Stripe;
  const env={...f.env,CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE:"false",CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"true",
    CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY:"true"};
  const common={agreementId:f.agreement.id,eventId:"evt_fixture",store:f.store,lifecycleEventStore:store,env,stripe};
  const dargs={...common,refundStore,paymentIntentId:f.pi.id,disputeId:dispute.id,eventCreated:1801396900};
  const sargs={...common,subscriptionId:f.subscription.id,now:()=>f.agreement.createdAt+100};
  const end=f.agreement.createdAt+48*3600;
  Object.assign(f.subscription,{pause_collection:{behavior:"keep_as_draft",resumes_at:null},trial_end:end,
    cancel_at:installmentMonthBoundary(end,2),cancel_at_period_end:false,canceled_at:null,ended_at:null});
  Object.assign(f.subscription.items.data[0],{id:"si_fixture",subscription:f.subscription.id});
  Object.assign(f.subscription.items.data[0].price,{billing_scheme:"per_unit"});
  f.subscription.items.data[0].price.recurring!.usage_type="licensed";
  return {f,basis,store,refundStore,receipt,api,dispute,balance,env,dargs,sargs};
}
function activate(f:ReturnType<typeof fixture>) {
  const dates=exactActivationDates(f.f.agreement.createdAt+60,3);
  Object.assign(f.basis,{agreementStatus:"active",activationStatus:"complete",activation:{agreementId:f.f.agreement.id,
    firstPaymentIntentId:f.f.pi.id,firstPaidAt:f.f.agreement.createdAt+60,paymentMethodId:"pm_fixture",subscriptionItemId:"si_fixture",...dates}});
  f.f.setAgreement({status:"active"});
  Object.assign(f.f.subscription,{status:"active",trial_end:dates.firstRenewalAt,billing_cycle_anchor:dates.firstRenewalAt,
    cancel_at:dates.cancelAt,default_payment_method:"pm_fixture"});
  f.f.subscription.metadata.installment_activation_version="first-paid-v1";
}
test.each(["needs_response","under_review","won","lost","warning_needs_response","warning_under_review","warning_closed","prevented"])
("dispute %s records actual state and hold without monetary/access writes",async(status)=>{
  const f=fixture();f.dispute.status=status as Stripe.Dispute.Status;
  expect(await observeExactDisputeSandbox(f.dargs)).toEqual({status:"lifecycle_observed"});
  expect(f.store.hold.mock.invocationCallOrder[0]).toBeLessThan(f.api.disputes.retrieve.mock.invocationCallOrder[0]);
  expect(f.store.dispute).toHaveBeenCalledWith(expect.objectContaining({objectId:"du_fixture",read:{revision:0,basis:f.basis}}),
    {paymentIntentId:f.f.pi.id,chargeId:f.f.charge.id,grossCents:66633,disputedCents:66633,status,eventCreated:f.dargs.eventCreated});
  expect(f.refundStore.apply).not.toHaveBeenCalled();expect(f.f.mocks.subscriptions.update).not.toHaveBeenCalled();
});
test("first-payment dispute still uses its receipt after later installments",async()=>{
  const f=fixture();activate(f);expect((await observeExactDisputeSandbox(f.dargs)).status).toBe("lifecycle_observed");
  expect(f.refundStore.creditedReceipt).toHaveBeenCalledWith(f.f.agreement.id,f.f.pi.id);
});
test("nullable dispute PI uses independently verified charge linkage",async()=>{
  const f=fixture();f.dispute.payment_intent=null;
  expect((await observeExactDisputeSandbox(f.dargs)).status).toBe("lifecycle_observed");
});
test("disputed amount may differ from charge; recording it does not allocate a debit",async()=>{
  const f=fixture();f.dispute.amount=70000;
  expect((await observeExactDisputeSandbox(f.dargs)).status).toBe("lifecycle_observed");
  expect(f.store.dispute).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({disputedCents:70000,grossCents:66633}));
});
test("missing credited receipt persists hold and requires reconciliation",async()=>{
  const f=fixture();f.refundStore.creditedReceipt.mockResolvedValue(null);
  expect((await observeExactDisputeSandbox(f.dargs)).status).toBe("reconciliation_required");
  expect(f.store.hold).toHaveBeenCalled();expect(f.store.dispute).not.toHaveBeenCalled();
});
test.each(["live","charge","PI","customer","fee","balance","amount","status"])("dispute with wrong %s never updates audit/earnings",async(problem)=>{
  const f=fixture();
  if(problem==="live") f.dispute.livemode=true;
  if(problem==="charge") f.dispute.charge="ch_other";
  if(problem==="PI") f.dispute.payment_intent="pi_other";
  if(problem==="customer") f.f.pi.customer="cus_other";
  if(problem==="fee") f.f.pi.application_fee_amount=1;
  if(problem==="balance") f.balance.fee=0;
  if(problem==="amount") f.dispute.amount=0;
  if(problem==="status") f.dispute.status="new-unknown-status" as never;
  await expect(observeExactDisputeSandbox(f.dargs)).rejects.toThrow();expect(f.store.dispute).not.toHaveBeenCalled();
});
test("lost Stripe read retains hold without logging provider payload",async()=>{
  const f=fixture();f.api.disputes.retrieve.mockRejectedValueOnce(new Error("private-provider-data"));
  await expect(observeExactDisputeSandbox(f.dargs)).rejects.toThrow("Exact lifecycle Stripe evidence unavailable");
  expect(f.store.hold).toHaveBeenCalled();
});
test("revision conflict requires fresh retrieval, not successful acknowledgment",async()=>{
  const f=fixture();f.store.dispute.mockResolvedValueOnce("reconciliation_required");
  expect((await observeExactDisputeSandbox(f.dargs)).status).toBe("reconciliation_required");
});
test.each(["bootstrap","activated","activation running"])("expected %s subscription is observed without a new hold",async(state)=>{
  const f=fixture();if(state!=="bootstrap") activate(f);
  if(state==="activation running") {Object.assign(f.basis,{activationStatus:"running",agreementStatus:"awaiting_first"});f.f.setAgreement({status:"awaiting_first"});}
  expect((await observeExactSubscriptionSandbox(f.sargs)).status).toBe("lifecycle_observed");
  expect(f.store.observe).toHaveBeenCalledWith(expect.anything(),"expected_held_schedule",expect.anything());expect(f.store.hold).not.toHaveBeenCalled();
});

test.each(["bootstrap","activated"])("expected %s with scheduled canceled_at is not classified as an early stop",async(state)=>{
  const f=fixture();if(state==="activated")activate(f);
  f.f.subscription.canceled_at=f.f.agreement.createdAt;
  expect((await observeExactSubscriptionSandbox(f.sargs)).status).toBe("lifecycle_observed");
  expect(f.store.hold).not.toHaveBeenCalled();
});
test.each(["price","end","card","resumption","fee percent","quantity","schedule","status","metadata","cancellation"])
("changed subscription %s creates a durable review record, never rewrites it in Stripe",async(change)=>{
  const f=fixture();activate(f);const s=f.f.subscription;
  if(change==="price") s.items.data[0].price.unit_amount=100;
  if(change==="end") s.cancel_at=null;
  if(change==="card") s.default_payment_method="pm_other";
  if(change==="resumption") s.pause_collection!.resumes_at=f.sargs.now()+60;
  if(change==="fee percent") s.application_fee_percent=12;
  if(change==="quantity") s.items.data[0].quantity=2;
  if(change==="schedule") s.schedule="sub_sched_other";
  if(change==="status") s.status="past_due";
  if(change==="metadata") s.metadata={};
  if(change==="cancellation") s.cancel_at_period_end=true;
  expect((await observeExactSubscriptionSandbox(f.sargs)).status).toBe("lifecycle_review_recorded");
  expect(f.store.hold).toHaveBeenCalledWith(f.f.agreement.id,"evt_fixture","sub_fixture",null);
  expect(f.f.mocks.subscriptions.update).not.toHaveBeenCalled();
});
test("unexpected canceled plan stays held and does not lose paid access",async()=>{
  const f=fixture();activate(f);Object.assign(f.f.subscription,{status:"canceled",canceled_at:f.sargs.now(),ended_at:f.sargs.now()});
  expect((await observeExactSubscriptionSandbox(f.sargs)).status).toBe("lifecycle_review_recorded");
  expect(f.store.observe).toHaveBeenCalledWith(expect.anything(),"review_required",expect.anything());
});
test("already completed approved billing stop is acknowledged using stored terminal evidence",async()=>{
  const f=fixture();Object.assign(f.basis,{stopStatus:"complete",stopCanceledAt:f.sargs.now()});
  Object.assign(f.f.subscription,{status:"canceled",canceled_at:f.sargs.now(),ended_at:f.sargs.now()});
  expect((await observeExactSubscriptionSandbox(f.sargs)).status).toBe("lifecycle_observed");
  expect(f.store.observe).toHaveBeenCalledWith(expect.anything(),"billing_stop_observed",expect.anything());
});
test("a fully paid plan ending after its saved final period is not mistaken for early cancellation",async()=>{
  const f=fixture();activate(f);Object.assign(f.basis,{agreementStatus:"complete"});f.f.setAgreement({status:"complete"});
  f.sargs.now=()=>f.basis.activation!.cancelAt+1;
  Object.assign(f.f.subscription,{status:"canceled",canceled_at:f.sargs.now()-1,ended_at:f.sargs.now()-1});
  expect((await observeExactSubscriptionSandbox(f.sargs)).status).toBe("lifecycle_observed");
  expect(f.store.observe).toHaveBeenCalledWith(expect.anything(),"scheduled_end_observed",expect.anything());
});
test("complete local plan with early Stripe termination requires review",async()=>{
  const f=fixture();activate(f);Object.assign(f.basis,{agreementStatus:"complete"});f.f.setAgreement({status:"complete"});
  Object.assign(f.f.subscription,{status:"canceled",canceled_at:f.sargs.now(),ended_at:f.sargs.now()});
  expect((await observeExactSubscriptionSandbox(f.sargs)).status).toBe("lifecycle_review_recorded");
});
test("subscription compare-and-swap failure is not acknowledged",async()=>{
  const f=fixture();f.store.observe.mockResolvedValueOnce(false);
  expect((await observeExactSubscriptionSandbox(f.sargs)).status).toBe("reconciliation_required");
});
test.each([{VERCEL_ENV:"production"},{STRIPE_SECRET_KEY:"sk_live_synthetic"},{NEXT_PUBLIC_SITE_URL:"https://www.creatornet.net"},
  {CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY:"false"},{CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"false"}])
("unready environment %j fails before Stripe/database lookups",async(override)=>{
  const f=fixture();Object.assign(f.env,override);
  await expect(observeExactSubscriptionSandbox(f.sargs)).rejects.toThrow();await expect(observeExactDisputeSandbox(f.dargs)).rejects.toThrow();
  expect(f.f.store.load).not.toHaveBeenCalled();expect(f.store.read).not.toHaveBeenCalled();
});
test("adapter returns validated revision/basis and rejects malformed state",async()=>{
  const f=fixture();const rpc=jest.fn().mockResolvedValue({data:{revision:0,basis:f.basis},error:null});
  const store=createExactLifecycleStore({rpc} as never);
  expect(await store.read(f.f.agreement.id,"sub_fixture")).toEqual({revision:0,basis:f.basis});
  rpc.mockResolvedValueOnce({data:{revision:-1,basis:f.basis},error:null});
  await expect(store.read(f.f.agreement.id,"sub_fixture")).rejects.toThrow("invalid lifecycle read");
});
