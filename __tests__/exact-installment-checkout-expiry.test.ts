import { observeExpiredExactCheckoutSandbox } from "../lib/installments/checkoutExpiry";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";
function fixture(){
  const f=exactInstallmentFixture();f.paid();f.session.status="expired";f.session.payment_status="unpaid";f.session.expires_at=f.agreement.createdAt+86400;
  f.pi.status="canceled";f.pi.amount_received=0;f.pi.amount_capturable=0;
  const lifecycleEventStore={read:jest.fn().mockResolvedValue({revision:0,basis:{}}),hold:jest.fn(),observe:jest.fn().mockResolvedValue(true),dispute:jest.fn()};
  const args={...f.args,sessionId:f.session.id,eventId:"evt_expiry",lifecycleEventStore,
    env:{...f.env,CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY:"true",CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"true"},
    now:()=>f.session.expires_at+1};return {f,args,lifecycleEventStore};
}
test.each([true,false])("expired first Checkout with PI=%s is only a saved review hold",async(hasPI)=>{
  const x=fixture();if(!hasPI)x.f.session.payment_intent=null;
  expect(await observeExpiredExactCheckoutSandbox(x.args)).toEqual({status:"lifecycle_review_recorded"});
  expect(x.lifecycleEventStore.hold).toHaveBeenCalledWith(x.f.agreement.id,"evt_expiry","sub_fixture",null);
  expect(x.lifecycleEventStore.observe).toHaveBeenCalledWith(expect.anything(),"review_required",
    {reason:"checkout_expired_unpaid",checkoutStatus:"expired"});
  expect(x.f.store.recordFirstReceipt).not.toHaveBeenCalled();expect(x.f.mocks.subscriptions.update).not.toHaveBeenCalled();
});
test.each(["succeeded","processing","requires_action"] as const)("expired Checkout with %s payment remains an unsettled review",async(status)=>{
  const x=fixture();x.f.pi.status=status;
  await observeExpiredExactCheckoutSandbox(x.args);
  expect(x.lifecycleEventStore.observe).toHaveBeenCalledWith(expect.anything(),"review_required",
    {reason:"checkout_expired_payment_unsettled",checkoutStatus:"expired"});
});
test.each(["open","complete"] as const)("stale expired event cannot label a currently %s session abandoned",async(status)=>{
  const x=fixture();x.f.session.status=status;
  expect(await observeExpiredExactCheckoutSandbox(x.args)).toEqual({status:"reconciliation_required"});expect(x.lifecycleEventStore.hold).not.toHaveBeenCalled();
});
test.each(["live","owner","fee","future expiry","destination","amount"])("refuses %s evidence",async(problem)=>{
  const x=fixture();if(problem==="live")x.f.session.livemode=true;if(problem==="owner")x.f.session.customer="cus_foreign";
  if(problem==="fee")x.f.pi.application_fee_amount=1;if(problem==="future expiry")x.f.session.expires_at=Number.MAX_SAFE_INTEGER;
  if(problem==="destination")x.f.pi.transfer_data={destination:"acct_foreign"};if(problem==="amount")x.f.session.amount_total=1;
  // Fixed observation time, not a function of mutated provider evidence.
  x.args.now=()=>x.f.agreement.createdAt+86401;
  await expect(observeExpiredExactCheckoutSandbox(x.args)).rejects.toThrow();expect(x.lifecycleEventStore.hold).not.toHaveBeenCalled();
});
test("changed lifecycle revision is retryable, not acknowledged",async()=>{
  const x=fixture();x.lifecycleEventStore.observe.mockResolvedValueOnce(false);
  expect(await observeExpiredExactCheckoutSandbox(x.args)).toEqual({status:"reconciliation_required"});
});
test("production config and disabled gates stop before reads",async()=>{
  const x=fixture();x.args.env.VERCEL_ENV="production";await expect(observeExpiredExactCheckoutSandbox(x.args)).rejects.toThrow();
  expect(x.f.store.load).not.toHaveBeenCalled();
});
test("provider errors are redacted and no payment/stop is performed",async()=>{
  const x=fixture();x.f.mocks.checkout.sessions.retrieve.mockRejectedValueOnce(new Error("SECRET"));
  await expect(observeExpiredExactCheckoutSandbox(x.args)).rejects.toThrow("evidence unavailable");expect(x.lifecycleEventStore.hold).not.toHaveBeenCalled();
});
