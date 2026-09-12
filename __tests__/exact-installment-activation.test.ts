import type Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { activateExactInstallmentSandbox, createExactActivationStore, exactActivationDates,
  type ExactActivationStore, type ActivationClaim } from "../lib/installments/activation";
import { installmentMonthBoundary } from "../lib/installments/checkoutPreparation";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";

function fixture() {
  const f = exactInstallmentFixture(); f.paid();
  const dates = exactActivationDates(f.charge.created,3);
  const auth = { agreementId:f.agreement.id,firstPaymentIntentId:f.pi.id,firstPaidAt:f.charge.created,
    paymentMethodId:"pm_fixture",subscriptionItemId:"si_fixture",...dates };
  const sub = f.subscription;
  Object.assign(sub,{ cancel_at_period_end:false,trial_end:f.agreement.createdAt+48*3600,
    cancel_at:installmentMonthBoundary(f.agreement.createdAt+48*3600,2),
    billing_cycle_anchor:f.agreement.createdAt+48*3600,
    pause_collection:{behavior:"keep_as_draft",resumes_at:null} });
  Object.assign(sub.items.data[0],{id:"si_fixture",subscription:sub.id});
  Object.assign(sub.items.data[0].price,{billing_scheme:"per_unit"});
  Object.assign(sub.items.data[0].price.recurring!,{usage_type:"licensed"});
  const pm = { id:"pm_fixture",livemode:false,type:"card",customer:f.customer.id } as Stripe.PaymentMethod;
  const zero = { id:"in_zero",livemode:false,customer:f.customer.id,currency:"usd",total:0,subtotal:0,
    amount_due:0,amount_paid:0,amount_overpaid:0,starting_balance:0,
    parent:{subscription_details:{subscription:sub.id}} } as Stripe.Invoice;
  const invoices = {has_more:false,data:[zero]};
  const events: string[] = [];
  let completed = false;
  const activationStore = {
    claim:jest.fn<Promise<ActivationClaim>,Parameters<ExactActivationStore["claim"]>>(async () => {
      events.push("claim"); return {status:completed ? "complete" : "new",authorization:auth};
    }),
    complete:jest.fn(async () => { events.push("complete"); completed=true; }),
  } satisfies ExactActivationStore;
  const update = jest.fn(async (_id:string, params:Stripe.SubscriptionUpdateParams, options:Stripe.RequestOptions) => {
    expect(options.idempotencyKey).toBe(`exact-cents-held-v1:${f.agreement.id}:activate-first-paid-v1`);
    events.push("update");
    sub.trial_end=params.trial_end as number; sub.billing_cycle_anchor=params.trial_end as number;
    sub.cancel_at=params.cancel_at as number; sub.default_payment_method=params.default_payment_method!;
    sub.metadata={...sub.metadata,...params.metadata as Stripe.Metadata};
    return sub;
  });
  const mocks = { ...f.mocks, subscriptions:{...f.mocks.subscriptions,update},
    paymentMethods:{retrieve:jest.fn(async () => pm)}, invoices:{list:jest.fn(async () => invoices)} };
  const stripe = mocks as unknown as Parameters<typeof activateExactInstallmentSandbox>[0]["stripe"];
  return {...f,auth,sub,pm,zero,invoices,events,activationStore,update,mocks,
    activationArgs:{...f.args,sessionId:f.session.id,activationStore,stripe,now:()=>f.agreement.createdAt+120} };
}
test("configures a held, fixed monthly schedule only after durable activation claim", async () => {
  const f=fixture();
  expect(await activateExactInstallmentSandbox(f.activationArgs)).toEqual({status:"activated_held",...exactActivationDates(f.charge.created,3)});
  expect(f.events).toEqual(["claim","update","complete"]);
  expect(f.update).toHaveBeenCalledWith(f.sub.id,{
    trial_end:f.auth.firstRenewalAt,cancel_at:f.auth.cancelAt,proration_behavior:"none",default_payment_method:"pm_fixture",
    pause_collection:{behavior:"keep_as_draft"},payment_settings:{payment_method_types:["card"],save_default_payment_method:"off"},
    metadata:{installment_activation_version:"first-paid-v1"},
  },{idempotencyKey:`exact-cents-held-v1:${f.agreement.id}:activate-first-paid-v1`});
  expect(f.mocks.customers.create).not.toHaveBeenCalled();
  expect(f.mocks.checkout.sessions.create).not.toHaveBeenCalled();
  expect(f.mocks.subscriptions.create).not.toHaveBeenCalled();
  expect(f.store.recordFirstReceipt).not.toHaveBeenCalled();
  expect(f.sub.pause_collection).toEqual({behavior:"keep_as_draft",resumes_at:null});
  expect(f.mocks.invoices.list).toHaveBeenCalledWith({subscription:f.sub.id,limit:100});
});
test("completed activation replay verifies existing Stripe state without moving dates or updating again",async()=>{
  const f=fixture(); await activateExactInstallmentSandbox(f.activationArgs);
  expect((await activateExactInstallmentSandbox(f.activationArgs)).status).toBe("activated_held");
  expect(f.update).toHaveBeenCalledTimes(1); expect(f.activationStore.complete).toHaveBeenCalledTimes(1);
});

test("scheduled cancellation timestamp returned by Stripe does not block the exact agreed activation",async()=>{
  const f=fixture();f.sub.canceled_at=f.agreement.createdAt;
  expect((await activateExactInstallmentSandbox(f.activationArgs)).status).toBe("activated_held");
  f.sub.canceled_at=f.agreement.createdAt+100;
  expect((await activateExactInstallmentSandbox(f.activationArgs)).status).toBe("activated_held");
  expect(f.update).toHaveBeenCalledTimes(1);
});
test("lost database completion retries the existing configuration instead of resubmitting it",async()=>{
  const f=fixture(); f.activationStore.complete.mockRejectedValueOnce(new Error("completion lost"));
  await expect(activateExactInstallmentSandbox(f.activationArgs)).rejects.toThrow("completion lost");
  await activateExactInstallmentSandbox(f.activationArgs);
  expect(f.update).toHaveBeenCalledTimes(1); expect(f.activationStore.complete).toHaveBeenCalledTimes(2);
});
test("lost Stripe response retries by retrieving the already-updated subscription",async()=>{
  const f=fixture();
  f.update.mockImplementationOnce(async()=>{
    f.sub.trial_end=f.auth.firstRenewalAt;f.sub.billing_cycle_anchor=f.auth.firstRenewalAt;
    f.sub.cancel_at=f.auth.cancelAt;f.sub.default_payment_method="pm_fixture";
    f.sub.metadata.installment_activation_version="first-paid-v1";
    throw new Error("Stripe response lost");
  });
  await expect(activateExactInstallmentSandbox(f.activationArgs)).rejects.toThrow("response lost");
  await activateExactInstallmentSandbox(f.activationArgs);
  expect(f.update).toHaveBeenCalledTimes(1);
});
test.each(["busy","review_required"] as const)("a %s claim never updates Stripe",async(status)=>{
  const f=fixture(); f.activationStore.claim.mockResolvedValueOnce({status});
  await expect(activateExactInstallmentSandbox(f.activationArgs)).rejects.toThrow(status);
  expect(f.update).not.toHaveBeenCalled();expect(f.activationStore.complete).not.toHaveBeenCalled();
});
test.each(["unpaid","refund","dispute","unrelated card","missing card","card owner","live card","production"])
  ("%s stops activation before claiming or mutating",async(change)=>{
    const f=fixture();
    if(change==="unpaid")f.session.payment_status="unpaid";
    if(change==="refund")f.charge.amount_refunded=1;
    if(change==="dispute")f.charge.disputed=true;
    if(change==="unrelated card")f.charge.payment_method="pm_other";
    if(change==="missing card")f.pi.payment_method=null;
    if(change==="card owner")f.pm.customer="cus_other";
    if(change==="live card")f.pm.livemode=true;
    if(change==="production")f.env.VERCEL_ENV="production";
    await expect(activateExactInstallmentSandbox(f.activationArgs)).rejects.toThrow();
    expect(f.activationStore.claim).not.toHaveBeenCalled();expect(f.update).not.toHaveBeenCalled();
  });
test.each(["hold","live","flexible","canceled","default card","destination","amount","interval","quantity","usage","tax","schedule"])
  ("changed subscription %s cannot be repaired by silently overwriting it",async(change)=>{
    const f=fixture();const item=f.sub.items.data[0];
    if(change==="hold")f.sub.pause_collection=null;
    if(change==="live")f.sub.livemode=true;
    if(change==="flexible")f.sub.billing_mode.type="flexible";
    if(change==="canceled")f.sub.cancel_at_period_end=true;
    if(change==="default card")f.sub.default_payment_method="pm_other";
    if(change==="destination")f.sub.transfer_data!.destination="acct_other";
    if(change==="amount")item.price.unit_amount=66634;
    if(change==="interval")item.price.recurring!.interval="year";
    if(change==="quantity")item.quantity=2;
    if(change==="usage")item.price.recurring!.usage_type="metered";
    if(change==="tax")f.sub.automatic_tax.enabled=true;
    if(change==="schedule")f.sub.schedule="sub_sched_other";
    await expect(activateExactInstallmentSandbox(f.activationArgs)).rejects.toThrow();
    expect(f.update).not.toHaveBeenCalled();expect(f.activationStore.complete).not.toHaveBeenCalled();
  });
test.each(["nonzero invoice","pagination","wrong invoice customer","changed snapshot","expired","wrong returned anchor"])
  ("%s blocks completion and keeps the case for reconciliation",async(change)=>{
    const f=fixture();
    if(change==="nonzero invoice")f.zero.total=1;
    if(change==="pagination")f.invoices.has_more=true;
    if(change==="wrong invoice customer")f.zero.customer="cus_other";
    if(change==="changed snapshot")f.auth.cancelAt++;
    if(change==="expired")f.activationArgs.now=()=>f.agreement.createdAt+48*3600;
    if(change==="wrong returned anchor")f.update.mockImplementationOnce(async()=>{
      f.sub.trial_end=f.auth.firstRenewalAt;f.sub.cancel_at=f.auth.cancelAt;
      f.sub.default_payment_method="pm_fixture";f.sub.metadata.installment_activation_version="first-paid-v1";
      return f.sub; // Wrong unchanged billing_cycle_anchor must be rejected.
    });
    await expect(activateExactInstallmentSandbox(f.activationArgs)).rejects.toThrow();
    expect(f.activationStore.complete).not.toHaveBeenCalled();
    if(change!=="wrong returned anchor")expect(f.update).not.toHaveBeenCalled();
  });
test("a new nonzero invoice after Stripe update prevents local activation",async()=>{
  const f=fixture(); f.mocks.invoices.list.mockResolvedValueOnce({has_more:false,data:[]});f.zero.total=1;
  await expect(activateExactInstallmentSandbox(f.activationArgs)).rejects.toThrow("bootstrap invoice");
  expect(f.update).toHaveBeenCalledTimes(1);expect(f.activationStore.complete).not.toHaveBeenCalled();
});
test.each([
  ["2027-01-31T23:45:06Z",3,"2027-02-28T23:45:06.000Z","2027-04-28T23:45:06.000Z"],
  ["2028-01-31T03:04:05Z",2,"2028-02-29T03:04:05.000Z","2028-03-29T03:04:05.000Z"],
  ["2027-12-15T00:00:00Z",6,"2028-01-15T00:00:00.000Z","2028-06-15T00:00:00.000Z"],
] as const)("%s schedules from the first actual renewal anchor",(date,count,renewal,end)=>{
  const result=exactActivationDates(Date.parse(date)/1000,count);
  expect(new Date(result.firstRenewalAt*1000).toISOString()).toBe(renewal);
  expect(new Date(result.cancelAt*1000).toISOString()).toBe(end);
});

function adapterFixture() {
  let result:unknown;let code=200;
  const calls:{path:string;body:unknown}[]=[];
  const localFetch=jest.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    calls.push({path:new URL(String(input)).pathname,body:init?.body?JSON.parse(String(init.body)):null});
    return new Response(JSON.stringify(result??null),{status:code,headers:{"content-type":"application/json"}});
  });
  const admin=createClient("https://fixture.invalid","synthetic-not-a-key",{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:localFetch},
  });
  return {adapter:createExactActivationStore(admin),calls,response:(r:unknown,c=200)=>{result=r;code=c;}};
}
test("Supabase adapter preserves explicit claim representation and sends no client-provided dates",async()=>{
  const f=fixture(),a=adapterFixture();a.response({status:"new",authorization:f.auth});
  expect(await a.adapter.claim(f.agreement.id,"pm_fixture","si_fixture",f.terms.buyerId)).toEqual({status:"new",authorization:f.auth});
  expect(a.calls[0]).toEqual({path:"/rest/v1/rpc/claim_exact_installment_activation",body:{p_agreement_id:f.agreement.id,
    p_payment_method_id:"pm_fixture",p_subscription_item_id:"si_fixture",p_claim_token:f.terms.buyerId}});
  await a.adapter.complete(f.agreement.id,f.terms.buyerId);
  expect(a.calls[1].path).toBe("/rest/v1/rpc/complete_exact_installment_activation");
});
test.each([null,[],{},true,{status:"new"},{status:"new",authorization:{}},{status:"new",authorization:[]},
  {status:"unexpected"}])("malformed activation claim %# is not success",async(response)=>{
  const f=fixture(),a=adapterFixture();a.response(response);
  await expect(a.adapter.claim(f.agreement.id,"pm_fixture","si_fixture",f.terms.buyerId)).rejects.toThrow();
});
test("activation database errors expose no raw connection or customer details",async()=>{
  const f=fixture(),a=adapterFixture();a.response({message:"synthetic-private-details"},403);
  await expect(a.adapter.claim(f.agreement.id,"pm_fixture","si_fixture",f.terms.buyerId)).rejects.toThrow("activation claim failed");
  await expect(a.adapter.complete(f.agreement.id,f.terms.buyerId)).rejects.toThrow("activation completion failed");
});
