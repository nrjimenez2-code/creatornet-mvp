import type Stripe from "stripe";
import {createClient} from "@supabase/supabase-js";
import {dispatchExactInstallmentEventSandbox,createExactEventBindingStore} from "../lib/installments/eventBridge";
import {creditVerifiedFirstInstallmentSandbox} from "../lib/installments/receiptCredit";
import {activateExactInstallmentSandbox} from "../lib/installments/activation";
import {collectExactRenewalSandbox} from "../lib/installments/renewal";
import {exactRenewalFixture} from "../test-support/exact-renewal-fixture";
import {reconcileExactRefundEventSandbox} from "../lib/installments/refundEvent";
import {observeExactDisputeSandbox,observeExactSubscriptionSandbox} from "../lib/installments/lifecycleEvents";
import {recoverExactRenewalSandbox} from "../lib/installments/paymentRecovery";
import {observeExpiredExactCheckoutSandbox} from "../lib/installments/checkoutExpiry";
jest.mock("../lib/installments/checkoutExpiry",()=>({observeExpiredExactCheckoutSandbox:jest.fn()}));

jest.mock("../lib/installments/receiptCredit",()=>({creditVerifiedFirstInstallmentSandbox:jest.fn()}));
jest.mock("../lib/installments/activation",()=>({activateExactInstallmentSandbox:jest.fn()}));
jest.mock("../lib/installments/renewal",()=>({collectExactRenewalSandbox:jest.fn()}));
jest.mock("../lib/installments/refundEvent",()=>({reconcileExactRefundEventSandbox:jest.fn()}));
jest.mock("../lib/installments/lifecycleEvents",()=>({observeExactDisputeSandbox:jest.fn(),observeExactSubscriptionSandbox:jest.fn()}));
jest.mock("../lib/installments/paymentRecovery",()=>({recoverExactRenewalSandbox:jest.fn()}));
const recoveryHandler=jest.mocked(recoverExactRenewalSandbox);
const disputeHandler=jest.mocked(observeExactDisputeSandbox),subscriptionHandler=jest.mocked(observeExactSubscriptionSandbox);
const refund=jest.mocked(reconcileExactRefundEventSandbox);
const first=jest.mocked(creditVerifiedFirstInstallmentSandbox),activation=jest.mocked(activateExactInstallmentSandbox),
  renewal=jest.mocked(collectExactRenewalSandbox);
beforeEach(()=>{jest.clearAllMocks();disputeHandler.mockReset();subscriptionHandler.mockReset();recoveryHandler.mockReset();first.mockResolvedValue({credited:true,paymentNumber:1});
  activation.mockResolvedValue({status:"activated_held",firstRenewalAt:1800000000,cancelAt:1900000000});
  renewal.mockResolvedValue({status:"credited",paymentNumber:2});});
function fixture(type="checkout.session.completed") {
  const f=exactRenewalFixture();
  const binding={agreementId:f.a.planId,purchaseId:"99999999-9999-4999-8999-999999999999",sessionId:"cs_test_fixture",
    subscriptionId:"sub_fixture",customerId:"cus_fixture",status:"awaiting_first",previewOrigin:f.f.terms.previewOrigin};
  const bindings={bySession:jest.fn(async()=>binding as typeof binding|null),
    bySubscription:jest.fn(async()=>binding as typeof binding|null),byIntent:jest.fn(async()=>binding as typeof binding|null)};
  const activationStore={claim:jest.fn(),complete:jest.fn()};
  const lifecycleStore={seed:jest.fn(),fulfillFirst:jest.fn().mockResolvedValue(undefined)};
  const refundStore={creditedReceipt:jest.fn(),hold:jest.fn(),apply:jest.fn(),confirmAdminDelivery:jest.fn()};
  const object=type.startsWith("invoice.")?f.invoice:type.startsWith("payment_intent.")?f.pi:f.f.session;
  const event={id:"evt_synthetic",type,livemode:false,data:{object}} as Stripe.Event;
  const lifecycleEventStore={read:jest.fn(),hold:jest.fn(),observe:jest.fn(),dispute:jest.fn()};
  const recoveryStore={begin:jest.fn(),finish:jest.fn(),has:jest.fn()};
  const args={...f.args,activationStore,lifecycleStore,refundStore,lifecycleEventStore,recoveryStore,bindings,verifiedEvent:event};
  return {f,binding,bindings,args,event};
}
test("first paid Checkout uses exact receipt accounting then held activation, never renewal accounting",async()=>{
  const f=fixture();
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"first_credited_held"});
  expect(first).toHaveBeenCalledWith(expect.objectContaining({agreementId:f.binding.agreementId,
    sessionId:"cs_test_fixture",purchaseId:f.binding.purchaseId}));
  expect(activation).toHaveBeenCalledTimes(1);expect(renewal).not.toHaveBeenCalled();
  expect(first.mock.invocationCallOrder[0]).toBeLessThan(activation.mock.invocationCallOrder[0]);
  expect(first.mock.invocationCallOrder[0]).toBeLessThan(f.args.lifecycleStore.fulfillFirst.mock.invocationCallOrder[0]);
  expect(f.args.lifecycleStore.fulfillFirst.mock.invocationCallOrder[0]).toBeLessThan(activation.mock.invocationCallOrder[0]);
});

test("delivery failure is retryable and cannot activate the monthly schedule",async()=>{
  const f=fixture();f.args.lifecycleStore.fulfillFirst.mockRejectedValueOnce(new Error("delivery unavailable"));
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("delivery unavailable");
  expect(first).toHaveBeenCalledTimes(1);expect(activation).not.toHaveBeenCalled();
});
test("first credit failure cannot activate a monthly schedule",async()=>{
  const f=fixture();first.mockRejectedValueOnce(new Error("credit unavailable"));
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("credit unavailable");
  expect(activation).not.toHaveBeenCalled();
});
test.each(["active","complete"])("replayed first Checkout on %s plan does not shift the monthly anchor",async(status)=>{
  const f=fixture();f.binding.status=status;
  expect((await dispatchExactInstallmentEventSandbox(f.args))).toEqual({handled:true,disposition:"first_already_activated"});
  expect(first).toHaveBeenCalledTimes(1);expect(activation).not.toHaveBeenCalled();
});
test("missing seeded purchase is a retryable failure, not an acknowledged paid Checkout",async()=>{
  const f=fixture();f.bindings.bySession.mockResolvedValueOnce({...f.binding,purchaseId:null} as unknown as typeof f.binding);
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("pending purchase not ready");
  expect(first).not.toHaveBeenCalled();
});
test.each(["invoice.created","invoice.payment_succeeded","invoice.paid"])("%s routes the bound invoice to exact renewal only",async(type)=>{
  const f=fixture(type);
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"credited"});
  expect(renewal).toHaveBeenCalledWith(expect.objectContaining({invoiceId:"in_renewal",agreementId:f.binding.agreementId}));
  expect(renewal).toHaveBeenCalledWith(expect.objectContaining({reconcileOnly:type!=="invoice.created",
    env:expect.objectContaining({CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT:"false"})}));
  expect(first).not.toHaveBeenCalled();expect(activation).not.toHaveBeenCalled();
});
test("bootstrap zero invoice is not counted or credited as a first installment",async()=>{
  const f=fixture("invoice.paid");Object.assign(f.f.invoice,{billing_reason:"subscription_create",total:0,subtotal:0,amount_due:0,amount_paid:0});
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"bootstrap_zero"});
  expect(first).not.toHaveBeenCalled();expect(renewal).not.toHaveBeenCalled();
});
test("zero discounted renewal is NOT mistaken for a zero bootstrap",async()=>{
  const f=fixture("invoice.paid");Object.assign(f.f.invoice,{total:0,amount_due:0,amount_paid:0});
  await dispatchExactInstallmentEventSandbox(f.args);expect(renewal).toHaveBeenCalledTimes(1);
});
test("busy/uncertain collector results remain explicit, not reported as a completed payment",async()=>{
  const f=fixture("invoice.created");renewal.mockResolvedValueOnce({status:"reconciliation_required",paymentNumber:2});
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"reconciliation_required"});
});
test.each(["payment_intent.succeeded","payment_intent.payment_failed"])("known %s cannot enter legacy one-time accounting",async(type)=>{
  const f=fixture(type);
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"separate_receipt_handler"});
  expect(first).not.toHaveBeenCalled();expect(renewal).not.toHaveBeenCalled();
});
test("unknown tagged first PI before its Checkout receipt requires retry rather than legacy fallthrough",async()=>{
  const f=fixture("payment_intent.succeeded");f.bindings.byIntent.mockResolvedValueOnce(null);
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("receipt not ready");
});
test.each(["checkout.session.completed","invoice.created"])("unknown untagged %s is left to legacy handler",async(type)=>{
  const f=fixture(type);Object.assign(f.event.data.object,{metadata:{}});
  f.bindings.bySession.mockResolvedValueOnce(null);f.bindings.bySubscription.mockResolvedValueOnce(null);
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:false});
});
test("unknown tagged Checkout and disabled tagged event never fall through to one-time accounting",async()=>{
  const f=fixture();f.bindings.bySession.mockResolvedValueOnce(null);
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("binding not ready");
  f.f.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE="false";
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("cannot fall back");
});
test("disabled untagged legacy event does not query the unapplied new tables",async()=>{
  const f=fixture();Object.assign(f.event.data.object,{metadata:{}});f.f.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE="false";
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:false});
  expect(f.bindings.bySession).not.toHaveBeenCalled();
});
test("feature pause quarantines a known untagged invoice PI after the schema is installed",async()=>{
  const f=fixture("payment_intent.succeeded");f.f.pi.metadata={};
  Object.assign(f.f.env,{CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE:"false",CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY:"true"});
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"reconciliation_required"});
  expect(f.bindings.byIntent).toHaveBeenCalledWith("pi_renewal");
  expect(first).not.toHaveBeenCalled();expect(renewal).not.toHaveBeenCalled();
});
test.each(["live event","production env","wrong bound origin"])("%s cannot run any money handler",async(reason)=>{
  const f=fixture();
  if(reason==="live event") f.event.livemode=true;
  if(reason==="production env") f.f.env.VERCEL_ENV="production";
  if(reason==="wrong bound origin") f.binding.previewOrigin="https://another.vercel.app";
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow();
  expect(first).not.toHaveBeenCalled();expect(renewal).not.toHaveBeenCalled();
});
test("a stale invoice payload cannot override a different retrieved customer",async()=>{
  const f=fixture("invoice.created");f.f.api.invoices.retrieve.mockResolvedValueOnce({...f.f.invoice,customer:"cus_other"});
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("binding mismatch");
  expect(renewal).not.toHaveBeenCalled();
});
test("expiry with its schema gate off remains quarantined, not successful cleanup",async()=>{
  const f=fixture("checkout.session.expired");
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"reconciliation_required"});
  expect(observeExpiredExactCheckoutSandbox).not.toHaveBeenCalled();
});
test("bound expired checkout uses its read-only observer even while new preparation is paused",async()=>{
  const f=fixture("checkout.session.expired");Object.assign(f.args.env,{CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE:"false",
    CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY:"true"});
  jest.mocked(observeExpiredExactCheckoutSandbox).mockResolvedValueOnce({status:"lifecycle_review_recorded"});
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"lifecycle_review_recorded"});
  expect(observeExpiredExactCheckoutSandbox).toHaveBeenCalledWith(expect.objectContaining({agreementId:f.binding.agreementId,sessionId:f.binding.sessionId}));
  expect(first).not.toHaveBeenCalled();expect(activation).not.toHaveBeenCalled();expect(renewal).not.toHaveBeenCalled();
});

test.each(["true","false"])("refund handler works with preparation=%s and never enters one-time accounting",async(prepare)=>{
  const f=fixture();Object.assign(f.f.env,{CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE:prepare,
    CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY:"true",CREATOR_EXACT_INSTALLMENTS_REFUND_EVENTS_READY:"true"});
  f.args.verifiedEvent={...f.event,type:"charge.refunded",data:{object:{id:"ch_fixture",payment_intent:"pi_fixture",metadata:{}}}} as Stripe.Event;
  refund.mockResolvedValueOnce({status:"refund_reconciled"});
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"refund_reconciled"});
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({agreementId:f.binding.agreementId,chargeId:"ch_fixture",
    paymentIntentId:"pi_fixture",eventId:f.event.id}));
  expect(first).not.toHaveBeenCalled();expect(renewal).not.toHaveBeenCalled();
});
test("refund error remains retryable, not acknowledged or sent to legacy handler",async()=>{
  const f=fixture();Object.assign(f.f.env,{CREATOR_EXACT_INSTALLMENTS_REFUND_EVENTS_READY:"true"});
  f.args.verifiedEvent={...f.event,type:"charge.refunded",data:{object:{id:"ch_fixture",payment_intent:"pi_fixture",metadata:{}}}} as Stripe.Event;
  refund.mockRejectedValueOnce(new Error("refund ledger conflict"));
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("refund ledger conflict");
});
test.each(["refund.created","refund.updated","refund.failed"])("known %s uses current Stripe state, not the event's refund status/amount",async(type)=>{
  const f=fixture();Object.assign(f.f.env,{CREATOR_EXACT_INSTALLMENTS_REFUND_EVENTS_READY:"true"});
  f.args.verifiedEvent={...f.event,type,data:{object:{id:"re_fixture",charge:"ch_fixture",payment_intent:"pi_fixture",
    amount:99999,status:"pending",metadata:{}}}} as Stripe.Event;
  refund.mockResolvedValueOnce({status:"reconciliation_required"});
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"reconciliation_required"});
  expect(refund).toHaveBeenCalledWith(expect.objectContaining({chargeId:"ch_fixture",paymentIntentId:"pi_fixture"}));
});

test("disabled parent-tagged invoice cannot enter legacy invoice handling",async()=>{
  const f=fixture("invoice.created");Object.assign(f.f.invoice,{metadata:{},parent:{subscription_details:{subscription:"sub_fixture",
    metadata:{installment_collection_version:"exact-cents-held-v1"}}}});
  f.f.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE="false";
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("cannot fall back");
});
test.each(["charge.refunded","charge.dispute.created","customer.subscription.deleted","customer.subscription.updated"])("known untagged %s waits for coordinated lifecycle handling",async(type)=>{
  const f=fixture();f.args.verifiedEvent={...f.event,type,data:{object:{id:"sub_fixture",payment_intent:"pi_fixture",metadata:{}}}} as Stripe.Event;
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"reconciliation_required"});
  expect(first).not.toHaveBeenCalled();expect(renewal).not.toHaveBeenCalled();
});

test("real binding adapter queries only persisted identifiers, and rejects DB failures",async()=>{
  const f=fixture();const calls:string[]=[];let code=200;
  const row={id:f.binding.agreementId,purchase_id:f.binding.purchaseId,stripe_checkout_session_id:f.binding.sessionId,
    stripe_subscription_id:f.binding.subscriptionId,stripe_customer_id:f.binding.customerId,status:f.binding.status,terms:f.f.f.terms};
  const admin=createClient("https://fixture.invalid","synthetic-not-a-key",{auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:async(input)=>{const url=String(input);calls.push(url);
      const result=url.includes("exact_installment_receipts")?{agreement_id:row.id}:row;
      return new Response(JSON.stringify(code===200?result:{message:"do not expose private details"}),
        {status:code,headers:{"content-type":"application/json"}});}}});
  const adapter=createExactEventBindingStore(admin);
  expect(await adapter.bySession("cs_test_fixture")).toEqual(f.binding);
  expect(await adapter.bySubscription("sub_fixture")).toEqual(f.binding);
  expect(await adapter.byIntent("pi_fixture")).toEqual(f.binding);
  expect(calls[0]).toContain("stripe_checkout_session_id=eq.cs_test_fixture");
  expect(calls[2]).toContain("stripe_payment_intent_id=eq.pi_fixture");
  code=403;await expect(adapter.bySession("cs_test_fixture")).rejects.toThrow("Exact webhook binding lookup failed");
});

function lifecycleFixture(type:string) {
  const f=fixture();Object.assign(f.f.env,{CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE:"false",
    CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY:"true",CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY:"true"});
  const object=type.startsWith("charge.dispute.")?{id:"du_fixture",charge:"ch_fixture",payment_intent:"pi_fixture",metadata:{}}:
    {id:"sub_fixture",metadata:{}};
  f.args.verifiedEvent={...f.event,type,created:1800000000,data:{object}} as Stripe.Event;
  disputeHandler.mockResolvedValue({status:"lifecycle_observed"});subscriptionHandler.mockResolvedValue({status:"lifecycle_observed"});
  return f;
}

test.each(["created","updated","closed","funds_withdrawn","funds_reinstated"])
("bound dispute %s uses the receipt-linked observer with preparation paused",async(suffix)=>{
  const f=lifecycleFixture(`charge.dispute.${suffix}`);
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"lifecycle_observed"});
  expect(disputeHandler).toHaveBeenCalledWith(expect.objectContaining({agreementId:f.binding.agreementId,disputeId:"du_fixture",
    paymentIntentId:"pi_fixture",eventId:f.event.id,eventCreated:1800000000}));
  expect(first).not.toHaveBeenCalled();expect(renewal).not.toHaveBeenCalled();expect(refund).not.toHaveBeenCalled();
});

test.each(["created","updated","deleted","paused","resumed"])
("bound subscription %s uses its lifecycle observer, not the legacy cancel/count handler",async(suffix)=>{
  const f=lifecycleFixture(`customer.subscription.${suffix}`);
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"lifecycle_observed"});
  expect(subscriptionHandler).toHaveBeenCalledWith(expect.objectContaining({agreementId:f.binding.agreementId,subscriptionId:"sub_fixture"}));
  expect(renewal).not.toHaveBeenCalled();
});

test("nullable signed dispute PI is linked through the retrieved test charge",async()=>{
  const f=lifecycleFixture("charge.dispute.created");Object.assign(f.args.verifiedEvent.data.object,{payment_intent:null});
  f.f.api.charges.retrieve.mockResolvedValueOnce({id:"ch_fixture",livemode:false,payment_intent:"pi_fixture"} as never);
  await dispatchExactInstallmentEventSandbox(f.args);
  expect(disputeHandler).toHaveBeenCalledWith(expect.objectContaining({paymentIntentId:"pi_fixture"}));
});

test("untagged dispute before first receipt cannot fall through when its actual PI belongs to exact collection",async()=>{
  const f=lifecycleFixture("charge.dispute.created");f.bindings.byIntent.mockResolvedValueOnce(null);
  f.f.api.paymentIntents.retrieve.mockResolvedValueOnce({id:"pi_fixture",livemode:false,
    metadata:{installment_collection_version:"exact-cents-held-v1"}} as never);
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("receipt not ready");
  expect(disputeHandler).not.toHaveBeenCalled();
});

test("genuinely legacy dispute still falls through without touching new accounting",async()=>{
  const f=lifecycleFixture("charge.dispute.created");f.bindings.byIntent.mockResolvedValueOnce(null);
  f.f.api.paymentIntents.retrieve.mockResolvedValueOnce({id:"pi_fixture",livemode:false,metadata:{}} as never);
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:false});
  expect(disputeHandler).not.toHaveBeenCalled();
});

test.each(["customer.subscription.updated","charge.dispute.updated"])("%s persists review without claiming payment completion",async(type)=>{
  const f=lifecycleFixture(type);disputeHandler.mockResolvedValueOnce({status:"lifecycle_review_recorded"});
  subscriptionHandler.mockResolvedValueOnce({status:"lifecycle_review_recorded"});
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"lifecycle_review_recorded"});
});

test.each(["customer.subscription.updated","charge.dispute.updated"])("unready lifecycle schema quarantines %s",async(type)=>{
  const f=lifecycleFixture(type);Object.assign(f.f.env,{CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY:"false"});
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"reconciliation_required"});
  expect(disputeHandler).not.toHaveBeenCalled();expect(subscriptionHandler).not.toHaveBeenCalled();
});

test("unknown tagged subscription is retried until persisted binding exists",async()=>{
  const f=lifecycleFixture("customer.subscription.created");f.bindings.bySubscription.mockResolvedValueOnce(null);
  Object.assign(f.args.verifiedEvent.data.object,{metadata:{installment_collection_version:"exact-cents-held-v1"}});
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("binding not ready");
});

test("live lifecycle event fails before binding lookups or observers",async()=>{
  const f=lifecycleFixture("charge.dispute.created");f.args.verifiedEvent.livemode=true;
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("Live installment event");
  expect(f.bindings.byIntent).not.toHaveBeenCalled();expect(disputeHandler).not.toHaveBeenCalled();
});

function recoveryFixture(type="invoice.payment_failed") {
  const f=fixture(type);Object.assign(f.f.env,{CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE:"false",
    CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY:"true",CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY:"true"});
  recoveryHandler.mockResolvedValue({status:"payment_recovery_recorded",outcome:"action_required"});
  return f;
}

test.each(["invoice.payment_failed","invoice.payment_action_required","invoice.voided","invoice.marked_uncollectible"])
("%s goes to exact recovery while creation is paused, not to the legacy handler",async(type)=>{
  const f=recoveryFixture(type);
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"payment_recovery_recorded"});
  expect(recoveryHandler).toHaveBeenCalledWith(expect.objectContaining({agreementId:f.binding.agreementId,invoiceId:"in_renewal",eventId:f.event.id}));
  expect(renewal).not.toHaveBeenCalled();expect(first).not.toHaveBeenCalled();
});

test.each(["invoice.paid","invoice.payment_succeeded"])("%s reconciles an existing recovery without enabling collection",async(type)=>{
  const f=recoveryFixture(type);f.args.recoveryStore.has.mockResolvedValueOnce(true);
  recoveryHandler.mockResolvedValueOnce({status:"payment_recovery_recorded",outcome:"paid_accounted"});
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"payment_recovery_recorded"});
  expect(renewal).not.toHaveBeenCalled();
});

test("normal paid invoice without a failure record retains ordinary receipt handling and gets no recovery hold",async()=>{
  const f=recoveryFixture("invoice.paid");f.f.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE="true";
  f.args.recoveryStore.has.mockResolvedValueOnce(false);
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"credited"});
  expect(recoveryHandler).not.toHaveBeenCalled();expect(renewal).toHaveBeenCalledTimes(1);
});

test("unapplied recovery schema quarantines known failed invoices rather than acknowledging them",async()=>{
  const f=recoveryFixture();Object.assign(f.f.env,{CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY:"false"});
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"reconciliation_required"});
  expect(recoveryHandler).not.toHaveBeenCalled();expect(f.args.recoveryStore.has).not.toHaveBeenCalled();
});

test("legacy failed invoice still uses the existing handler",async()=>{
  const f=recoveryFixture();f.bindings.bySubscription.mockResolvedValueOnce(null);f.f.invoice.metadata={};
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:false});expect(recoveryHandler).not.toHaveBeenCalled();
});

test("unknown tagged failed invoice is retried until exact binding exists",async()=>{
  const f=recoveryFixture();f.bindings.bySubscription.mockResolvedValueOnce(null);
  f.f.invoice.metadata={installment_collection_version:"exact-cents-held-v1"};
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("binding not ready");
});

test("recovery observation conflict or failure is never acknowledged as completed",async()=>{
  const f=recoveryFixture();recoveryHandler.mockResolvedValueOnce({status:"reconciliation_required"});
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:true,disposition:"reconciliation_required"});
  recoveryHandler.mockRejectedValueOnce(new Error("recovery unavailable"));
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("recovery unavailable");
});

test("live invoice failure is rejected before a recovery query",async()=>{
  const f=recoveryFixture();f.args.verifiedEvent.livemode=true;
  await expect(dispatchExactInstallmentEventSandbox(f.args)).rejects.toThrow("Live installment event");
  expect(f.bindings.bySubscription).not.toHaveBeenCalled();expect(recoveryHandler).not.toHaveBeenCalled();
});

test("all recovery/schema flags off leave a legacy failed invoice untouched without new-table queries",async()=>{
  const f=fixture("invoice.payment_failed");f.f.invoice.metadata={};f.f.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE="false";
  expect(await dispatchExactInstallmentEventSandbox(f.args)).toEqual({handled:false});
  expect(f.bindings.bySubscription).not.toHaveBeenCalled();expect(f.args.recoveryStore.has).not.toHaveBeenCalled();
  expect(recoveryHandler).not.toHaveBeenCalled();
});
