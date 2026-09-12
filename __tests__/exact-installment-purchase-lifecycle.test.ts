import type { SupabaseClient } from "@supabase/supabase-js";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";
import { confirmExactInstallmentSandbox, createExactPurchaseLifecycleStore, prepareExactPurchaseSandbox } from "../lib/installments/purchaseLifecycle";

const purchaseId="99999999-9999-4999-8999-999999999999";
function fixture() {
  const f=exactInstallmentFixture(); f.paid();
  const a={id:f.agreement.id,terms:f.terms,status:"active",purchase_id:purchaseId,
    purchase_seeded_at:"2026-09-05",first_fulfilled_at:"2026-09-05",stripe_customer_id:"cus_fixture",
    stripe_subscription_id:"sub_fixture",stripe_checkout_session_id:"cs_test_fixture"};
  const p={id:purchaseId,buyer_id:f.terms.buyerId,creator_id:f.terms.creatorId,post_id:f.terms.postId,
    product_id:f.terms.productId,booking_id:f.terms.bookingId,session_id:"cs_test_fixture",subscription_id:"sub_fixture",
    status:"active",access_granted:true,paid_count:1,target_months:3,is_refund:false,is_suspect:false};
  let missing=false,fail=false;
  const db=createMockClient(op=>({data:missing?null:op.table==="exact_installment_agreements"?a:p,
    error:fail?{message:"private detail never exposed"}:null}));
  const env:Record<string,string|undefined>={...f.env,CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY:"true"};
  const run=()=>confirmExactInstallmentSandbox({admin:db as unknown as SupabaseClient,session:f.session,buyerId:f.terms.buyerId,env});
  return {f,a,p,db,env,run,missing:()=>{missing=true;},fail:()=>{fail=true;}};
}
test("success handoff reads a fulfilled first installment without changing its active balance",async()=>{
  const h=fixture();expect(await h.run()).toEqual({httpStatus:200,body:{ok:true,status:"paid",session_id:"cs_test_fixture",
    purchase_id:purchaseId,post_id:h.p.post_id,product_id:h.p.product_id,creator_id:h.p.creator_id}});
  expect(h.p.status).toBe("active");expect(h.p.paid_count).toBe(1);
  expect(h.db.ops.every(op=>op.kind==="select")).toBe(true);
});
test.each(["unpaid","unfulfilled","no access","pending purchase","no seeded purchase"])("%s cannot show paid success",async(reason)=>{
  const h=fixture();
  if(reason==="unpaid")h.f.session.payment_status="unpaid";
  if(reason==="unfulfilled")Object.assign(h.a,{first_fulfilled_at:null});
  if(reason==="no access")h.p.access_granted=false;
  if(reason==="pending purchase")h.p.status="pending";
  if(reason==="no seeded purchase")Object.assign(h.a,{purchase_seeded_at:null});
  expect(await h.run()).toMatchObject({httpStatus:202,body:{status:"pending"}});
  expect(h.db.ops.every(op=>op.kind==="select")).toBe(true);
});
test.each(["refunded","canceled","is_refund","is_suspect","review_required"])("closed %s state cannot reopen through confirmation",async(reason)=>{
  const h=fixture();
  if(reason==="is_refund")h.p.is_refund=true;
  else if(reason==="is_suspect")h.p.is_suspect=true;
  else if(reason==="review_required")h.a.status=reason;
  else h.p.status=reason;
  expect(await h.run()).toMatchObject({httpStatus:409});
});
test.each(["buyer_id","creator_id","post_id","product_id","booking_id","session_id","subscription_id"])("conflicting purchase %s stops confirmation",async(key)=>{
  const h=fixture();Object.assign(h.p,{[key]:"different"});await expect(h.run()).rejects.toThrow("identity mismatch");
});
test("bound Checkout cannot be attached to another buyer via editable metadata",async()=>{
  const h=fixture();Object.assign(h.a,{terms:{...h.a.terms,buyerId:h.a.terms.creatorId}});
  await expect(h.run()).rejects.toThrow("owner or identity mismatch");
});
test.each([0,4,1.5])("invalid paid_count %s cannot show completed access",async(count)=>{
  const h=fixture();h.p.paid_count=count;await expect(h.run()).rejects.toThrow("progress");
});
test("last installment must have matching complete state",async()=>{
  const h=fixture();h.p.paid_count=3;await expect(h.run()).rejects.toThrow("progress");
  h.p.status="complete";h.a.status="complete";expect(await h.run()).toMatchObject({httpStatus:200});
});
test("removing Stripe metadata cannot make a known exact Checkout use old one-time accounting",async()=>{
  const h=fixture();h.f.session.metadata={};expect(await h.run()).toMatchObject({httpStatus:200});
});
test("feature pause still reads exact state, without authorizing payment",async()=>{
  const h=fixture();h.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE="false";
  expect(await h.run()).toMatchObject({httpStatus:200});
});
test("legacy without installed schema does not read any new tables",async()=>{
  const h=fixture();delete h.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY;h.f.session.metadata={};
  expect(await h.run()).toBeNull();expect(h.db.ops).toHaveLength(0);
});
test.each(["no schema","no binding","wrong plan","live","production"])("tagged Checkout fails closed for %s",async(reason)=>{
  const h=fixture();
  if(reason==="no schema")delete h.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY;
  if(reason==="no binding")h.missing();
  if(reason==="wrong plan")h.f.session.metadata!.installment_plan_id="different";
  if(reason==="live")h.f.session.livemode=true;
  if(reason==="production")h.env.VERCEL_ENV="production";
  await expect(h.run()).rejects.toThrow();expect(h.db.ops.every(op=>op.kind==="select")).toBe(true);
});
test("database failures do not expose raw errors or silently fall through",async()=>{
  const h=fixture();h.fail();await expect(h.run()).rejects.toThrow("binding lookup failed");
});
test("preparation seeds only after binding and never exposes a Checkout URL",async()=>{
  const f=exactInstallmentFixture();
  const lifecycleStore={seed:jest.fn(async()=>{
    expect((await f.store.load()).status).toBe("awaiting_first");return purchaseId;
  }),fulfillFirst:jest.fn()};
  expect(await prepareExactPurchaseSandbox({...f.args,lifecycleStore})).toEqual({sessionId:"cs_test_fixture",
    subscriptionId:"sub_fixture",purchaseId,status:"prepared_unpublished"});
  expect(lifecycleStore.fulfillFirst).not.toHaveBeenCalled();
});
test("lost seed response can resume without recreating customer/subscription/Checkout",async()=>{
  const f=exactInstallmentFixture();
  const lifecycleStore={seed:jest.fn().mockRejectedValueOnce(new Error("lost response")).mockResolvedValue(purchaseId),fulfillFirst:jest.fn()};
  await expect(prepareExactPurchaseSandbox({...f.args,lifecycleStore})).rejects.toThrow("lost response");
  await expect(prepareExactPurchaseSandbox({...f.args,lifecycleStore})).resolves.toMatchObject({purchaseId});
  expect(f.mocks.checkout.sessions.create).toHaveBeenCalledTimes(1);expect(f.mocks.subscriptions.create).toHaveBeenCalledTimes(1);
});
test.each(["active","complete","canceled","review_required"] as const)("cannot prepare or reseed a %s agreement",async(status)=>{
  const f=exactInstallmentFixture();f.setAgreement({status});const lifecycleStore={seed:jest.fn(),fulfillFirst:jest.fn()};
  await expect(prepareExactPurchaseSandbox({...f.args,lifecycleStore})).rejects.toThrow("before first payment");
  expect(lifecycleStore.seed).not.toHaveBeenCalled();expect(f.mocks.checkout.sessions.create).not.toHaveBeenCalled();
});
test("production cannot start purchase preparation",async()=>{
  const f=exactInstallmentFixture();f.env.VERCEL_ENV="production";const lifecycleStore={seed:jest.fn(),fulfillFirst:jest.fn()};
  await expect(prepareExactPurchaseSandbox({...f.args,lifecycleStore})).rejects.toThrow();expect(f.store.load).not.toHaveBeenCalled();
});
test("real lifecycle adapter uses narrow RPCs, validates responses and suppresses raw DB errors",async()=>{
  let error:unknown=null;let data:unknown=purchaseId;
  const db=createMockClient(()=>({data,error}));const store=createExactPurchaseLifecycleStore(db as unknown as SupabaseClient);
  const id=exactInstallmentFixture().agreement.id;
  expect(await store.seed(id)).toBe(purchaseId);await store.fulfillFirst(id);
  expect(db.ops.map(op=>[op.table,op.payload])).toEqual([
    ["seed_exact_installment_purchase",{p_agreement_id:id}],["fulfill_exact_installment_first_payment",{p_agreement_id:id}]]);
  data="not an id";await expect(store.seed(id)).rejects.toThrow("identity");
  error={message:"secret raw data"};await expect(store.seed(id)).rejects.toThrow("could not be prepared");
  await expect(store.fulfillFirst(id)).rejects.toThrow("retry or review");
});
