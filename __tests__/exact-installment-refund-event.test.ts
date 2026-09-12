import type Stripe from "stripe";
import {createClient} from "@supabase/supabase-js";
import {createExactRefundEventStore,reconcileExactRefundEventSandbox,type ExactRefundEventStore} from "../lib/installments/refundEvent";
import {confirmAdminRefundWebhookDelivery} from "../lib/paymentRefunds";
import {exactInstallmentFixture} from "../test-support/exact-installment-fixture";
jest.mock("../lib/paymentRefunds",()=>({confirmAdminRefundWebhookDelivery:jest.fn()}));
beforeEach(()=>jest.clearAllMocks());
function fixture(number=1) {
  const f=exactInstallmentFixture();f.paid();
  const fee=number===1?9958:10425;
  f.pi.application_fee_amount=fee;f.charge.amount_refunded=10000;
  const receipt={paymentNumber:number,amountCents:66633,applicationFeeCents:fee,chargeId:f.charge.id,
    balanceTransactionId:"txn_fixture",actualStripeFeeCents:1962,invoiceId:number===1?null:"in_fixture2"};
  const refundStore={creditedReceipt:jest.fn(async()=>receipt as typeof receipt|null),
    hold:jest.fn(async()=>{}),apply:jest.fn(async()=>10000),confirmAdminDelivery:jest.fn(async()=>{})} satisfies ExactRefundEventStore;
  const balance={id:"txn_fixture",source:f.charge.id,type:"charge",amount:66633,currency:"usd",fee:1962,net:64671};
  const refunds=[{id:"re_fixture",charge:f.charge.id,payment_intent:f.pi.id,currency:"usd",amount:10000,status:"succeeded"}];
  const api={...f.mocks,balanceTransactions:{retrieve:jest.fn(async()=>balance)},
    refunds:{create:jest.fn(),list:jest.fn(async()=>({has_more:false,data:refunds}))}};
  const env={...f.env,CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY:"true",CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"true",
    CREATOR_EXACT_INSTALLMENTS_REFUND_EVENTS_READY:"true"};
  const args={agreementId:f.agreement.id,paymentIntentId:f.pi.id,chargeId:f.charge.id,eventId:"evt_refundfixture",
    store:f.store,refundStore,stripe:api as unknown as Stripe,env};
  return {f,receipt,refundStore,balance,api,env,args,refunds};
}
test.each([1,2])("refund on credited installment %i verifies actual money and uses only its immutable receipt",async(number)=>{
  const f=fixture(number);expect(await reconcileExactRefundEventSandbox(f.args)).toEqual({status:"refund_reconciled"});
  expect(f.refundStore.apply).toHaveBeenCalledWith(f.f.agreement.id,"evt_refundfixture",{
    paymentIntentId:"pi_fixture",chargeId:"ch_fixture",chargeAmountCents:66633,refundedAmountCents:10000});
  expect(f.refundStore.apply.mock.invocationCallOrder[0]).toBeLessThan(f.refundStore.confirmAdminDelivery.mock.invocationCallOrder[0]);
  expect(f.api.refunds.create).not.toHaveBeenCalled();expect(f.api.subscriptions.update).not.toHaveBeenCalled();
});
test("full first refund doesn't call one-time access revocation or cancel a subscription",async()=>{
  const f=fixture();f.f.charge.amount_refunded=66633;f.f.charge.refunded=true;f.refunds[0].amount=66633;f.refundStore.apply.mockResolvedValue(66633);
  expect(await reconcileExactRefundEventSandbox(f.args)).toEqual({status:"refund_reconciled"});
  expect(f.api.subscriptions.update).not.toHaveBeenCalled();expect(f.api.refunds.create).not.toHaveBeenCalled();
});
test.each(["canceled","review_required","complete"] as const)("late refund on a %s agreement can reconcile without reopening it",async(status)=>{
  const f=fixture();f.f.setAgreement({status});expect(await reconcileExactRefundEventSandbox(f.args)).toEqual({status:"refund_reconciled"});
});
test("preparation pause still permits explicitly enabled refund accounting",async()=>{
  const f=fixture();f.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE="false";
  expect(await reconcileExactRefundEventSandbox(f.args)).toEqual({status:"refund_reconciled"});
});
test("uncounted/missing receipt waits; it cannot grant access or create a ledger",async()=>{
  const f=fixture();f.refundStore.creditedReceipt.mockResolvedValue(null);
  expect(await reconcileExactRefundEventSandbox(f.args)).toEqual({status:"reconciliation_required"});
  expect(f.refundStore.apply).not.toHaveBeenCalled();expect(f.api.paymentIntents.retrieve).not.toHaveBeenCalled();
});
test.each([{VERCEL_ENV:"production"},{STRIPE_SECRET_KEY:"sk_live_synthetic"},
  {NEXT_PUBLIC_SUPABASE_URL:"https://example.invalid"},{CREATOR_EXACT_INSTALLMENTS_REFUND_EVENTS_READY:"false"},
  {CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"false"}])("unsafe/unready environment rejects before any lookup: %j",async(override)=>{
  const f=fixture();Object.assign(f.env,override);await expect(reconcileExactRefundEventSandbox(f.args)).rejects.toThrow();
  expect(f.f.store.load).not.toHaveBeenCalled();expect(f.api.charges.retrieve).not.toHaveBeenCalled();
});
test.each(["customer","fee","destination","latest charge","live PI","gross","receipt fee","charge owner","uncaptured",
  "refund exceeds charge","wrong full marker","balance fee","balance source"])("mismatched %s cannot update accounting",async(problem)=>{
  const f=fixture();
  if(problem==="customer") f.f.pi.customer="cus_other";
  if(problem==="fee") f.f.pi.application_fee_amount=1;
  if(problem==="destination") f.f.pi.transfer_data={destination:"acct_other"};
  if(problem==="latest charge") f.f.pi.latest_charge="ch_other";
  if(problem==="live PI") f.f.pi.livemode=true;
  if(problem==="gross") f.f.pi.amount=100;
  if(problem==="receipt fee") f.receipt.applicationFeeCents=1;
  if(problem==="charge owner") f.f.charge.payment_intent="pi_other";
  if(problem==="uncaptured") f.f.charge.captured=false;
  if(problem==="refund exceeds charge") f.f.charge.amount_refunded=66634;
  if(problem==="wrong full marker") f.f.charge.refunded=true;
  if(problem==="balance fee") f.balance.fee=1;
  if(problem==="balance source") f.balance.source="ch_other";
  await expect(reconcileExactRefundEventSandbox(f.args)).rejects.toThrow();
  expect(f.refundStore.apply).not.toHaveBeenCalled();expect(f.refundStore.confirmAdminDelivery).not.toHaveBeenCalled();
});
test("failed accounting does not confirm successful webhook delivery",async()=>{
  const f=fixture();f.refundStore.apply.mockRejectedValue(new Error("accounting unavailable"));
  await expect(reconcileExactRefundEventSandbox(f.args)).rejects.toThrow("accounting unavailable");
  expect(f.refundStore.confirmAdminDelivery).not.toHaveBeenCalled();
});
test("lost confirmation retries the same event/receipt instead of refunding again",async()=>{
  const f=fixture();f.refundStore.confirmAdminDelivery.mockRejectedValueOnce(new Error("confirmation unavailable"));
  await expect(reconcileExactRefundEventSandbox(f.args)).rejects.toThrow("confirmation unavailable");
  expect(await reconcileExactRefundEventSandbox(f.args)).toEqual({status:"refund_reconciled"});
  expect(f.refundStore.apply.mock.calls[0]).toEqual(f.refundStore.apply.mock.calls[1]);
  expect(f.api.refunds.create).not.toHaveBeenCalled();
});
test.each(["pending","requires_action","failed","canceled","unknown"])("%s refund is held, not counted as successful",async(status)=>{
  const f=fixture();f.refunds[0].status=status;
  expect(await reconcileExactRefundEventSandbox(f.args)).toEqual({status:"reconciliation_required"});
  expect(f.refundStore.hold).toHaveBeenCalledTimes(1);expect(f.refundStore.apply).not.toHaveBeenCalled();
  expect(f.refundStore.confirmAdminDelivery).not.toHaveBeenCalled();
});
test("zero confirmed refund preserves a review hold without changing earnings",async()=>{
  const f=fixture();f.refunds[0].status="pending";f.f.charge.amount_refunded=0;
  expect(await reconcileExactRefundEventSandbox(f.args)).toEqual({status:"reconciliation_required"});
  expect(f.refundStore.hold).toHaveBeenCalled();expect(f.refundStore.apply).not.toHaveBeenCalled();
});
test("an older larger local reversal cannot be silently marked reconciled after refund failure",async()=>{
  const f=fixture();f.refundStore.apply.mockResolvedValue(20000);
  expect(await reconcileExactRefundEventSandbox(f.args)).toEqual({status:"reconciliation_required"});
  expect(f.refundStore.confirmAdminDelivery).not.toHaveBeenCalled();
});
test("refund listing failure leaves the prior durable hold and no new reversal",async()=>{
  const f=fixture();f.api.refunds.list.mockRejectedValueOnce(new Error("listing unavailable"));
  await expect(reconcileExactRefundEventSandbox(f.args)).rejects.toThrow("Exact refund Stripe evidence unavailable");
  expect(f.refundStore.hold).toHaveBeenCalled();expect(f.refundStore.apply).not.toHaveBeenCalled();
});
test("successful refunds on multiple pages must add to the actual charge total",async()=>{
  const f=fixture();const first={...f.refunds[0],id:"re_first",amount:6000},last={...f.refunds[0],id:"re_last",amount:4000};
  f.api.refunds.list.mockResolvedValueOnce({has_more:true,data:[first]}).mockResolvedValueOnce({has_more:false,data:[last]});
  expect(await reconcileExactRefundEventSandbox(f.args)).toEqual({status:"refund_reconciled"});
  expect(f.api.refunds.list).toHaveBeenNthCalledWith(2,{charge:"ch_fixture",limit:100,starting_after:"re_first"});
});
test.each(["duplicate","wrong payment","wrong currency","non-advancing"])("%s refund listing cannot update earnings",async(problem)=>{
  const f=fixture();
  if(problem==="duplicate") f.refunds.push({...f.refunds[0]});
  if(problem==="wrong payment") f.refunds[0].payment_intent="pi_other";
  if(problem==="wrong currency") f.refunds[0].currency="eur";
  if(problem==="non-advancing") f.api.refunds.list.mockResolvedValue({has_more:true,data:[]});
  await expect(reconcileExactRefundEventSandbox(f.args)).rejects.toThrow();
  expect(f.refundStore.hold).toHaveBeenCalled();expect(f.refundStore.apply).not.toHaveBeenCalled();
});
test("real receipt adapter reads ledger by receipt ID, not latest purchase PI, and sanitizes errors",async()=>{
  const f=fixture();const calls:string[]=[];let broken=false;
  const client=createClient("https://fixture.invalid","synthetic",{auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:async(input)=>{const url=String(input);calls.push(url);
      const data=url.includes("exact_installment_receipts")?{payment_number:1,amount_cents:"66633",application_fee_cents:"9958",
        stripe_invoice_id:null,ledger_id:f.f.terms.bookingId,counted_at:"2026-09-05T00:00:00Z"}:
        {stripe_payment_intent_id:"pi_fixture",stripe_charge_id:"ch_fixture",stripe_balance_transaction_id:"txn_fixture",
          actual_stripe_fee_cents:1962,earnings_credited_at:"2026-09-05T00:00:00Z"};
      return new Response(JSON.stringify(broken?{message:"private-database-detail"}:data),{status:broken?500:200,
        headers:{"content-type":"application/json"}});}}});
  const store=createExactRefundEventStore(client);
  expect(await store.creditedReceipt(f.f.agreement.id,"pi_fixture")).toEqual(f.receipt);
  expect(calls[1]).toContain(`id=eq.${f.f.terms.bookingId}`);expect(calls.join("")).not.toContain("/purchases");
  broken=true;await expect(store.creditedReceipt(f.f.agreement.id,"pi_fixture")).rejects.toThrow("Exact refund receipt lookup failed");
});
test.each([null,"bad",99999999,-1])("RPC cumulative result %j fails closed",async(data)=>{
  const f=fixture();const store=createExactRefundEventStore({rpc:jest.fn(async()=>({data,error:null}))} as never);
  await expect(store.apply(f.f.agreement.id,"evt_fixture",{paymentIntentId:"pi_fixture",chargeId:"ch_fixture",
    chargeAmountCents:66633,refundedAmountCents:10000})).rejects.toThrow("invalid");
});
test("confirmation adapter reuses the existing exact admin-operation verifier and sanitizes errors",async()=>{
  const client={} as never;const store=createExactRefundEventStore(client),f=fixture();
  const state={paymentIntentId:"pi_fixture",chargeId:"ch_fixture",chargeAmountCents:66633,refundedAmountCents:10000};
  await store.confirmAdminDelivery(state,f.args.stripe);
  expect(confirmAdminRefundWebhookDelivery).toHaveBeenCalledWith(client,f.args.stripe,state);
  jest.mocked(confirmAdminRefundWebhookDelivery).mockRejectedValueOnce(new Error("private detail"));
  await expect(store.confirmAdminDelivery(state,f.args.stripe)).rejects.toThrow("Exact admin refund delivery confirmation failed");
});
