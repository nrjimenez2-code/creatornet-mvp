import {createMockClient} from "./__mocks__/supabaseQueryMock";
import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {SERVER_PAYMENT_PROTOCOL} from "../lib/serverPaymentConfirmation";
import {reconcileFullRefundReview,parseRefundReviewReconciliation} from "../lib/fullRefundReviewReconciliation";
const context=buyerFirstCaptureFixture().context;
const env=Object.fromEntries(["CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY","CREATOR_FULL_REFUND_REVIEW_SCHEMA_READY","CREATOR_FULL_REFUND_REVIEW_ADMIN_SCHEMA_READY",
  "CREATOR_FULL_REFUND_REVIEW_ADMIN_READY","CREATOR_FULL_REFUND_EVENT_SCHEMA_READY","CREATOR_FULL_REFUND_RECONCILE_READY"].map(k=>[k,"true"]));
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const input={eventId:"evt_original",revision:3,confirmOriginalOnly:true as const};
function fixture(){
  const e={event_id:input.eventId,attempt_id:id(1),refund_id:"re_original",charge_id:"ch_original",event_created:1700000000};
  const hold={attempt_id:id(1),payment_intent_id:"pi_original",revision:3};
  const source={attempt_id:id(1),buyer_id:id(2),kind:"full",protocol:SERVER_PAYMENT_PROTOCOL,context,source:{attempt_key:id(3)}};
  const db=createMockClient(op=>({data:op.table==="full_server_payment_refund_object_events_v1"?e:
    op.table==="full_server_payment_financial_holds_v1"?hold:source,error:null}));
  const observe=jest.fn().mockResolvedValue(context),reconcile=jest.fn().mockResolvedValue({status:"refund_observed",attemptId:id(1),paymentIntentId:"pi_original"});
  return {e,hold,source,db,observe,reconcile,run:(flags=env)=>reconcileFullRefundReview(db as any,input,flags,{context,observe,reconcile})};
}
test("only saved original metadata reaches the existing engine; raw evidence never escapes",async()=>{
  const f=fixture();expect(await f.run()).toEqual({status:"original_reconciled_hold_retained",holdRetained:true,observation:"refund_observed"});
  expect(f.reconcile).toHaveBeenCalledWith({buyerId:id(2),attemptId:id(1),attemptKey:id(3),eventId:input.eventId,refundId:"re_original",eventCreated:1700000000,
    expectedEvent:{paymentIntentId:"pi_original",chargeId:"ch_original",livemode:false},env});
  expect(f.observe).toHaveBeenCalledTimes(3);expect(f.db.ops.every(op=>op.kind==="select")).toBe(true);
  expect(f.db.opsFor("full_server_payment_refund_object_events_v1")[0].filters).toEqual({event_id:input.eventId});
  expect(f.db.opsFor("full_server_payment_financial_holds_v1")[0].filters).toEqual({attempt_id:id(1)});
  expect(f.db.opsFor("server_payment_protocols_v1")[0].filters).toEqual({attempt_id:id(1)});
});
test.each(["missing provenance","stale revision","foreign context","wrong kind","wrong protocol","wrong owner","wrong hold","foreign event"])("%s cannot invoke reconciliation",async issue=>{
  const f=fixture();
  if(issue==="missing provenance")f.e.event_created=null as any;
  if(issue==="stale revision")f.hold.revision=4;
  if(issue==="foreign context")f.source.context={...context,platformAccountId:"acct_foreign"};
  if(issue==="wrong kind")f.source.kind="first_installment";
  if(issue==="wrong protocol")f.source.protocol="legacy" as any;
  if(issue==="wrong owner")f.source.buyer_id="invalid";
  if(issue==="wrong hold")f.hold.attempt_id=id(9);
  if(issue==="foreign event")f.e.event_id="evt_other";
  await expect(f.run()).rejects.toThrow();expect(f.reconcile).not.toHaveBeenCalled();
});
test.each(Object.keys(env))("%s disabled prevents all reads and writes",async key=>{
  const f=fixture();await expect(f.run({...env,[key]:"false"})).rejects.toThrow();expect(f.db.ops).toHaveLength(0);expect(f.reconcile).not.toHaveBeenCalled();
});
test("uncertain engine outcome and late context change cannot become resolved review",async()=>{
  const f=fixture();f.reconcile.mockResolvedValue({status:"reconciliation_required",refundApplied:false});
  expect(await f.run()).toEqual({status:"reconciliation_required",holdRetained:true});
  f.observe.mockResolvedValueOnce(context).mockResolvedValueOnce(context).mockRejectedValueOnce(Error("changed"));
  await expect(f.run()).rejects.toThrow("changed");
});
test("an observed original with incomplete accounting remains reconciliation required",async()=>{
  const f=fixture();f.reconcile.mockResolvedValue({status:"refund_recorded_accounting_review",attemptId:id(1),paymentIntentId:"pi_original"});
  expect(await f.run()).toEqual({status:"reconciliation_required",holdRetained:true});
});
test.each([{...input,confirmOriginalOnly:false},{...input,eventCreated:1700000000},{...input,buyerId:id(2)},{...input,paymentIntentId:"pi_other"},{...input,revision:-1}])("reject browser authority or malformed input %p",body=>{expect(parseRefundReviewReconciliation(body)).toBeNull();});
