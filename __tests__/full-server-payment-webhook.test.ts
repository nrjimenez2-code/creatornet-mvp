import type Stripe from "stripe";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createMockClient} from "./__mocks__/supabaseQueryMock";
import {SERVER_PAYMENT_PROTOCOL} from "../lib/serverPaymentConfirmation";
const mockAccount=jest.fn(),mockRefund=jest.fn(),mockRefundConfirmation=jest.fn();
const mockDispute=jest.fn();
const mockRefundObject=jest.fn();
const mockLifecycle=jest.fn();
jest.mock("../lib/fullServerPaymentLifecycle",()=>({reconcileFullServerPaymentLifecycle:(...a:unknown[])=>mockLifecycle(...a)}));
jest.mock("../lib/fullServerPaymentReadback",()=>({accountFullServerPayment:(...a:unknown[])=>mockAccount(...a),
  reconcileFullServerPaymentRefund:(...a:unknown[])=>mockRefund(...a),reconcileFullServerPaymentDispute:(...a:unknown[])=>mockDispute(...a),
  reconcileFullServerRefundObject:(...a:unknown[])=>mockRefundObject(...a)}));
jest.mock("../lib/paymentRefunds",()=>({confirmAdminRefundWebhookDelivery:(...a:unknown[])=>mockRefundConfirmation(...a)}));
import {handoffFullServerPaymentWebhook} from "../lib/fullServerPaymentWebhook";
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
let original:any,pin:any,lookupError:any,event:any;
const db=createMockClient(op=>({data:op.table==="server_payment_intent_operations_v1"?original:pin,error:lookupError}));
const charge=jest.fn();const stripe={charges:{retrieve:charge}} as unknown as Pick<Stripe,"charges"|"refunds">;
const env={CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY:"true",CREATOR_FULL_SERVER_PAYMENT_WEBHOOK_READY:"true"};
const run=(overrides:Record<string,string|undefined>=env)=>handoffFullServerPaymentWebhook({event,admin:db as unknown as SupabaseClient,stripe,env:overrides});
beforeEach(()=>{
  jest.resetAllMocks();db.ops.length=0;lookupError=null;
  original={attempt_id:id(1),payment_intent_id:"pi_owned",bound_at:"2026-09-23T00:00:00Z"};
  pin={attempt_id:id(1),buyer_id:id(2),kind:"full",protocol:SERVER_PAYMENT_PROTOCOL,context:{mode:"test"},source:{attempt_key:id(3)}};
  event={id:"evt_owned",type:"payment_intent.succeeded",livemode:false,data:{object:{id:"pi_owned",object:"payment_intent",livemode:false,
    metadata:{buyer_id:"untrusted",amount:"1"}}}};
  mockAccount.mockResolvedValue({status:"original_capture_accounted"});
});
test("bound intent event chooses stored owner and independently inspected accounting, never metadata",async()=>{
  expect(await run()).toBe(true);
  expect(mockAccount).toHaveBeenCalledWith({buyerId:id(2),attemptId:id(1),attemptKey:id(3),env,
    expectedEvent:{paymentIntentId:"pi_owned",livemode:false}});
  expect(db.ops[0].filters).toEqual({payment_intent_id:"pi_owned"});
});
test.each(["charge.succeeded","charge.updated"])("%s requires matching original captured charge",async type=>{
  event.type=type;event.data.object={id:"ch_owned",object:"charge",livemode:false,payment_intent:{id:"pi_owned"}};
  expect(await run()).toBe(true);expect(mockAccount.mock.calls[0][0].expectedEvent.chargeId).toBe("ch_owned");
});
test.each(["payment_intent.payment_failed","payment_intent.canceled","payment_intent.processing"])
("bound manual %s cannot fall through to generic handling",async type=>{
  event.type=type;
  if(type.startsWith("charge.dispute"))event.data.object={object:"dispute",id:"dp_owned",charge:"ch_owned",payment_intent:"pi_owned",livemode:false};
  else if(type.startsWith("charge."))event.data.object={object:"charge",id:"ch_owned",payment_intent:"pi_owned",livemode:false};
  await expect(run()).rejects.toThrow();expect(mockAccount).not.toHaveBeenCalled();
});
test.each(["disabled processing","foreign mode","connected event","mismatched object mode","lookup failure","missing pin","unbound","unhandled installment"])
("%s cannot enter manual or generic accounting",async issue=>{
  if(issue==="foreign mode")pin.context.mode="live";
  if(issue==="connected event")event.account="acct_other";
  if(issue==="mismatched object mode")event.data.object.livemode=true;
  if(issue==="lookup failure")lookupError={message:"unavailable"};
  if(issue==="missing pin")pin=null;
  if(issue==="unbound")original.bound_at=null;
  if(issue==="unhandled installment")pin.kind="first_installment";
  await expect(run(issue==="disabled processing"?{...env,CREATOR_FULL_SERVER_PAYMENT_WEBHOOK_READY:"false"}:env)).rejects.toThrow();
  expect(mockAccount).not.toHaveBeenCalled();
});
test("manual marker with disabled schema cannot fall through",async()=>{
  event.data.object.metadata.server_payment_protocol=SERVER_PAYMENT_PROTOCOL;
  await expect(run({})).rejects.toThrow();expect(db.ops).toHaveLength(0);
});
test("unknown marked original stays unresolved rather than adopting event metadata",async()=>{
  original=null;event.data.object.metadata.server_payment_protocol=SERVER_PAYMENT_PROTOCOL;
  await expect(run()).rejects.toThrow();
});
test("unrelated legacy event retains its existing handler",async()=>{
  original=null;expect(await run()).toBe(false);expect(mockAccount).not.toHaveBeenCalled();
});
test("Connect account event remains outside payment classification",async()=>{
  event.type="account.updated";event.account="acct_owned";event.data.object={id:"acct_owned",object:"account"};
  expect(await run()).toBe(false);expect(db.ops).toHaveLength(0);
});
test("dispute without a PI resolves the signed charge relationship before rejecting unsupported manual lifecycle",async()=>{
  event.type="charge.dispute.created";event.data.object={id:"dp_owned",object:"dispute",charge:"ch_owned",livemode:false};
  charge.mockResolvedValue({id:"ch_owned",object:"charge",payment_intent:"pi_owned",livemode:false});
  await expect(run()).rejects.toThrow();expect(charge).toHaveBeenCalledWith("ch_owned",{apiVersion:"2025-10-29.clover",maxNetworkRetries:0,timeout:10000});
  expect(db.ops[0].filters).toEqual({payment_intent_id:"pi_owned"});
});
test("failed original accounting keeps the event retryable",async()=>{
  mockAccount.mockRejectedValue(Error("requires reconciliation"));await expect(run()).rejects.toThrow();
});

test.each(["refund.created","refund.updated","refund.failed"])("unmarked owned %s cannot fall through to generic handling",async type=>{
  event.type=type;event.data.object={id:"re_owned",object:"refund",charge:"ch_owned",payment_intent:"pi_owned"};
  await expect(run()).rejects.toThrow();
  expect(db.ops[0].filters).toEqual({payment_intent_id:"pi_owned"});
  expect(mockAccount).not.toHaveBeenCalled();expect(charge).not.toHaveBeenCalled();
});

test("refund without a PI resolves charge ownership without relying on metadata or refund livemode",async()=>{
  event.type="refund.updated";event.data.object={id:"re_owned",object:"refund",charge:{id:"ch_owned"},payment_intent:null};
  charge.mockResolvedValue({id:"ch_owned",object:"charge",payment_intent:{id:"pi_owned"},livemode:false});
  await expect(run()).rejects.toThrow();
  expect(charge).toHaveBeenCalledWith("ch_owned",{apiVersion:"2025-10-29.clover",maxNetworkRetries:0,timeout:10000});
  expect(db.ops[0].filters).toEqual({payment_intent_id:"pi_owned"});expect(mockAccount).not.toHaveBeenCalled();
});

test("unrelated legacy refund retains its existing path after original lookup",async()=>{
  original=null;event.type="refund.updated";
  event.data.object={id:"re_other",object:"refund",charge:"ch_other",payment_intent:"pi_other"};
  expect(await run()).toBe(false);expect(db.ops[0].filters).toEqual({payment_intent_id:"pi_other"});
  expect(mockAccount).not.toHaveBeenCalled();
});

test.each(["foreign mode","foreign charge","connected event","provider error"])("refund charge lookup rejects %s before original lookup",async issue=>{
  event.type="refund.updated";event.data.object={id:"re_owned",object:"refund",charge:"ch_owned"};
  charge.mockResolvedValue({id:issue==="foreign charge"?"ch_other":"ch_owned",object:"charge",payment_intent:"pi_owned",livemode:issue==="foreign mode"});
  if(issue==="connected event")event.account="acct_other";
  if(issue==="provider error")charge.mockRejectedValue(Error("unavailable"));
  await expect(run()).rejects.toThrow();expect(db.ops).toHaveLength(0);expect(mockAccount).not.toHaveBeenCalled();
});
test.each([{amount_refunded:1},{refunded:true},{disputed:true}])("charge.updated financial signal %p cannot be acknowledged as clean success",async patch=>{
  event.type="charge.updated";event.data.object={object:"charge",id:"ch_owned",payment_intent:"pi_owned",livemode:false,...patch};
  await expect(run()).rejects.toThrow();expect(mockAccount).not.toHaveBeenCalled();
});

test("owned charge refund uses original readback before confirming admin markers",async()=>{
  event.type="charge.refunded";event.data.object={object:"charge",id:"ch_owned",payment_intent:"pi_owned",livemode:false,amount_refunded:999999};
  mockRefund.mockResolvedValue({status:"original_refund_applied",amountCents:3333,refundedCents:1000});
  expect(await run()).toBe(true);expect(mockAccount).not.toHaveBeenCalled();
  expect(mockRefund).toHaveBeenCalledWith({buyerId:id(2),attemptId:id(1),attemptKey:id(3),eventId:"evt_owned",env,
    expectedEvent:{paymentIntentId:"pi_owned",chargeId:"ch_owned",livemode:false}});
  expect(mockRefundConfirmation).toHaveBeenCalledWith(db,stripe,{paymentIntentId:"pi_owned",chargeId:"ch_owned",chargeAmountCents:3333,refundedAmountCents:1000},
    {apiVersion:"2025-10-29.clover",maxNetworkRetries:0,timeout:10000});
});
test.each(["early refund","provider failure","confirmation failure"])("%s keeps full refund delivery retryable",async issue=>{
  event.type="charge.refunded";event.data.object={object:"charge",id:"ch_owned",payment_intent:"pi_owned",livemode:false};
  mockRefund.mockResolvedValue({status:issue==="early refund"?"refund_recorded_accounting_review":"original_refund_applied",amountCents:3333,refundedCents:1000});
  if(issue==="provider failure")mockRefund.mockRejectedValue(Error("review"));
  if(issue==="confirmation failure")mockRefundConfirmation.mockRejectedValue(Error("retry marker"));
  await expect(run()).rejects.toThrow();expect(mockAccount).not.toHaveBeenCalled();
  if(issue!=="confirmation failure")expect(mockRefundConfirmation).not.toHaveBeenCalled();
});

test.each(["charge.dispute.created","charge.dispute.updated","charge.dispute.closed","charge.dispute.funds_withdrawn","charge.dispute.funds_reinstated"])
("owned %s uses current dispute observation without generic accounting",async type=>{
  event.type=type;event.created=1700000000;event.data.object={object:"dispute",id:"du_owned",charge:"ch_owned",payment_intent:"pi_owned",livemode:false,amount:999999};
  mockDispute.mockResolvedValue({status:"dispute_observed"});
  expect(await run()).toBe(true);expect(mockAccount).not.toHaveBeenCalled();expect(mockRefund).not.toHaveBeenCalled();
  expect(mockDispute).toHaveBeenCalledWith({buyerId:id(2),attemptId:id(1),attemptKey:id(3),eventId:"evt_owned",disputeId:"du_owned",eventCreated:1700000000,env,
    expectedEvent:{paymentIntentId:"pi_owned",chargeId:"ch_owned",livemode:false}});
});
test.each(["dispute_review_recorded","dispute_recorded_accounting_review","reconciliation_required"])("owned dispute %s is not acknowledged as completed",async status=>{
  event.type="charge.dispute.updated";event.data.object={object:"dispute",id:"du_owned",charge:"ch_owned",payment_intent:"pi_owned",livemode:false};
  mockDispute.mockResolvedValue({status});await expect(run()).rejects.toThrow();
});
test.each(["refund.created","refund.updated","refund.failed"])("owned %s acknowledges durable refund observation without trusting payload status or amount",async type=>{
  event.type=type;event.created=1700000000;event.data.object={id:"re_owned",object:"refund",charge:"ch_owned",payment_intent:"pi_owned",status:"succeeded",amount:999999};
  mockRefundObject.mockResolvedValue({status:"refund_review_recorded",refundStatus:"failed",refundApplied:false});
  expect(await run()).toBe(true);expect(mockAccount).not.toHaveBeenCalled();expect(mockRefundConfirmation).not.toHaveBeenCalled();
  expect(mockRefundObject).toHaveBeenCalledWith({buyerId:id(2),attemptId:id(1),attemptKey:id(3),eventId:"evt_owned",refundId:"re_owned",eventCreated:1700000000,env,
    expectedEvent:{paymentIntentId:"pi_owned",chargeId:"ch_owned",livemode:false}});
});
test("owned successful Refund confirms markers only after original accounting commits",async()=>{
  event.type="refund.updated";event.data.object={id:"re_owned",object:"refund",charge:"ch_owned",payment_intent:"pi_owned"};
  mockRefundObject.mockResolvedValue({status:"refund_observed",refundStatus:"succeeded",refundApplied:true,amountCents:3333,refundedCents:1000});
  expect(await run()).toBe(true);expect(mockRefundConfirmation).toHaveBeenCalledWith(db,stripe,
    {paymentIntentId:"pi_owned",chargeId:"ch_owned",chargeAmountCents:3333,refundedAmountCents:1000},
    {apiVersion:"2025-10-29.clover",maxNetworkRetries:0,timeout:10000});
});
test.each(["refund_recorded_accounting_review","reconciliation_required"])("owned Refund %s is not acknowledged as completed",async status=>{
  event.type="refund.updated";event.data.object={id:"re_owned",object:"refund",charge:"ch_owned",payment_intent:"pi_owned"};
  mockRefundObject.mockResolvedValue({status,refundApplied:false});await expect(run()).rejects.toThrow();expect(mockRefundConfirmation).not.toHaveBeenCalled();
});
test.each(["payment_intent.processing","payment_intent.payment_failed","payment_intent.canceled","payment_intent.requires_action"])
("owned %s records the current original state without trusting event status",async type=>{
  event.type=type;event.created=1700000000;event.data.object.status="untrusted";
  mockLifecycle.mockResolvedValue({status:"original_lifecycle_observed",paymentStatus:"processing",releaseAllowed:false});
  expect(await run()).toBe(true);expect(mockAccount).not.toHaveBeenCalled();expect(mockRefund).not.toHaveBeenCalled();
  expect(mockLifecycle).toHaveBeenCalledWith({buyerId:id(2),attemptId:id(1),attemptKey:id(3),eventId:"evt_owned",eventCreated:1700000000,env,
    expectedEvent:{paymentIntentId:"pi_owned",livemode:false}});
});
test("late processing event can acknowledge original success only through the lifecycle accounting path",async()=>{
  event.type="payment_intent.processing";mockLifecycle.mockResolvedValue({status:"original_capture_accounted",releaseAllowed:false});
  expect(await run()).toBe(true);expect(mockAccount).not.toHaveBeenCalled();
});
test("unresolved lifecycle keeps the shared event retryable",async()=>{
  event.type="payment_intent.canceled";mockLifecycle.mockRejectedValue(Error("phase unresolved"));
  await expect(run()).rejects.toThrow("phase unresolved");expect(mockAccount).not.toHaveBeenCalled();
});
