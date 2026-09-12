import type Stripe from "stripe";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
import { EXACT_CHECKOUT_LINK_GATES, createExactCheckoutLinkStore, handoffExactCheckoutLink,
  issueExactCheckoutLinkSandbox, selectedExactCheckoutBooking, type ExactCheckoutLinkStore } from "../lib/installments/checkoutLink";

let httpDb: ReturnType<typeof createMockClient>;
let httpStripe: Stripe;
jest.mock("@supabase/supabase-js",()=>({createClient:()=>httpDb}));
jest.mock("next/headers",()=>({cookies:async()=>({getAll:()=>[]})}));
jest.mock("@/lib/stripeClient",()=>({getStripe:()=>httpStripe}));
jest.mock("@/lib/supabaseClient",()=>({createServerSupabase:async()=>httpDb}));

const purchaseId="99999999-9999-4999-8999-999999999999";
function fixture() {
  const f=exactInstallmentFixture(), t=f.terms;
  const env:Record<string,string|undefined>={...f.env,...Object.fromEntries(EXACT_CHECKOUT_LINK_GATES.map(k=>[k,"true"])),
    CREATOR_EXACT_INSTALLMENTS_CHECKOUT_BOOKING_IDS:t.bookingId,CREATOR_PROCESSING_FEE_ENABLED:"true",
    STRIPE_PROCESSING_FEE_BPS:"290",STRIPE_PROCESSING_FEE_FIXED_CENTS:"30",STRIPE_PROCESSING_FEE_SCHEDULE_VERSION:"synthetic-card",
    STRIPE_BILLING_FEE_BPS:"70"};
  const payment={id:t.bookingPaymentId,booking_id:t.bookingId,plan_type:"installment",status:"link_sent",
    installment_collection_version:t.version,stripe_checkout_session_id:f.session.id,stripe_subscription_id:f.subscription.id,
    amount_total_cents:t.totalCents,installment_months:3,installment_amount_cents:66633,platform_fee_cents:7996,
    processing_fee_cents:1962,total_creator_deduction_cents:9958,creator_net_cents:56675,fee_schedule_version:"synthetic-card",currency:"usd",
    link_url:"https://checkout.stripe.com/c/pay/cs_test_fixture#synthetic",private_ignored:"never-return"};
  const original=f.mocks.checkout.sessions.create.getMockImplementation()!;
  f.mocks.checkout.sessions.create.mockImplementation(async(p,o)=>{
    await original(p,o);
    Object.assign(f.session,{metadata:p.metadata,automatic_tax:{enabled:false},adaptive_pricing:{enabled:false},allow_promotion_codes:false,
      invoice_creation:{enabled:false},payment_method_types:["card"],subscription:null,after_expiration:null,recovered_from:null,
      consent_collection:p.consent_collection,custom_text:p.custom_text,success_url:p.success_url,cancel_url:p.cancel_url,
      payment_intent:null,url:payment.link_url});
    return f.session;
  });
  const lifecycleStore={seed:jest.fn(async()=>purchaseId),fulfillFirst:jest.fn()};
  let published=false;
  const links={lookup:jest.fn(async()=>f.agreement.id),reserve:jest.fn(async()=>f.agreement.id),
    requestHash:jest.fn(async()=>f.operations.get("checkout")!.hash),
    publish:jest.fn(async()=>{
      const result={url:payment.link_url,payment:{...payment},reused:published}; published=true; return result;
    })} satisfies ExactCheckoutLinkStore;
  const args={...f.args,env,links,lifecycleStore,bookingId:t.bookingId,actorId:t.creatorId,count:3};
  return {f,env,links,lifecycleStore,payment,args,run:()=>issueExactCheckoutLinkSandbox(args)};
}

test("reserves before Stripe, seeds before publication; returns only the existing public link contract",async()=>{
  const h=fixture(), result=await h.run();
  expect(result).toMatchObject({url:h.payment.link_url,reused:false,payment:{status:"link_sent",installment_amount_cents:66633,
    amount_total_cents:199900,installment_collection_version:"exact-cents-held-v1"}});
  expect(h.links.reserve).toHaveBeenCalledWith(h.f.terms.bookingId,h.f.terms.creatorId,3,h.f.terms.previewOrigin,
    h.f.terms.firstPaymentFeeSchedule,{...h.f.terms.renewalFeeSchedule,version:"synthetic-card+billing-70bps"});
  expect(h.links.reserve.mock.invocationCallOrder[0]).toBeLessThan(h.f.mocks.customers.create.mock.invocationCallOrder[0]);
  expect(h.lifecycleStore.seed.mock.invocationCallOrder[0]).toBeLessThan(h.links.publish.mock.invocationCallOrder[0]);
  expect(h.links.publish).toHaveBeenCalledWith(expect.objectContaining({agreementId:h.f.agreement.id,actorId:h.f.terms.creatorId,
    sessionId:h.f.session.id,purchaseId,expiresAt:h.f.agreement.createdAt+86400}));
  expect(JSON.stringify(result)).not.toMatch(/private_ignored|client_secret|never-return|cus_fixture/);
  expect(h.lifecycleStore.fulfillFirst).not.toHaveBeenCalled();
  expect(h.f.mocks.paymentIntents.retrieve).not.toHaveBeenCalled();
});
test("a repeated request reuses one customer/subscription/checkout and original publication",async()=>{
  const h=fixture(); await h.run(); expect((await h.run()).reused).toBe(true);
  expect(h.f.mocks.customers.create).toHaveBeenCalledTimes(1);
  expect(h.f.mocks.subscriptions.create).toHaveBeenCalledTimes(1);
  expect(h.f.mocks.checkout.sessions.create).toHaveBeenCalledTimes(1);
});
test("a lost publication response resumes the original Checkout without making another",async()=>{
  const h=fixture(); h.links.publish.mockRejectedValueOnce(new Error("lost response"));
  await expect(h.run()).rejects.toThrow(); await h.run();
  expect(h.f.mocks.checkout.sessions.create).toHaveBeenCalledTimes(1);
});
test.each(EXACT_CHECKOUT_LINK_GATES)("missing gate %s prevents reservation/Stripe calls",async(key)=>{
  const h=fixture(); delete h.env[key]; await expect(h.run()).rejects.toThrow();
  expect(h.links.reserve).not.toHaveBeenCalled(); expect(h.f.mocks.customers.create).not.toHaveBeenCalled();
});
test.each(["production","live key","wrong project","empty list","other booking","wildcard","changed count","processing disabled"])(
  "fails closed before reservation for %s",async(reason)=>{
    const h=fixture();
    if(reason==="production")h.env.VERCEL_ENV="production";
    if(reason==="live key")h.env.STRIPE_SECRET_KEY="sk_live_synthetic_not_a_key";
    if(reason==="wrong project")h.env.NEXT_PUBLIC_SUPABASE_URL="https://example.invalid";
    if(reason==="empty list")delete h.env.CREATOR_EXACT_INSTALLMENTS_CHECKOUT_BOOKING_IDS;
    if(reason==="other booking")h.env.CREATOR_EXACT_INSTALLMENTS_CHECKOUT_BOOKING_IDS=h.f.terms.buyerId;
    if(reason==="wildcard")h.env.CREATOR_EXACT_INSTALLMENTS_CHECKOUT_BOOKING_IDS="*";
    if(reason==="changed count")h.args.count=1;
    if(reason==="processing disabled")h.env.CREATOR_PROCESSING_FEE_ENABLED="false";
    await expect(h.run()).rejects.toThrow(); expect(h.links.reserve).not.toHaveBeenCalled();
  });
test.each(["unseeded","altered hash","hold removed","saved card","changed destination","expired","wrong fee result"])(
  "does not publish when %s",async(reason)=>{
    const h=fixture(); await h.run(); h.links.publish.mockClear();
    if(reason==="unseeded")h.lifecycleStore.seed.mockRejectedValue(new Error("seed unavailable"));
    if(reason==="altered hash")h.links.requestHash.mockResolvedValue("b".repeat(64));
    if(reason==="hold removed")h.f.subscription.pause_collection=null;
    if(reason==="saved card")h.f.customer.invoice_settings.default_payment_method="pm_other";
    if(reason==="changed destination")h.f.subscription.transfer_data!.destination="acct_other";
    if(reason==="expired")h.args.now=()=>h.f.agreement.createdAt+86400;
    if(reason==="wrong fee result")h.payment.processing_fee_cents=1;
    await expect(h.run()).rejects.toThrow();
    if(reason!=="wrong fee result")expect(h.links.publish).not.toHaveBeenCalled();
    expect(h.f.mocks.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });
test.each([
  {livemode:true},{payment_status:"paid"},{status:"complete"},{amount_total:66634},{amount_subtotal:66632},
  {customer:"cus_other"},{currency:"eur"},{payment_method_types:["card","link"]},{automatic_tax:{enabled:true}},
  {adaptive_pricing:{enabled:true}},{allow_promotion_codes:true},{invoice_creation:{enabled:true}},
  {subscription:"sub_other"},{recovered_from:"cs_test_old"},{expires_at:1},
  {url:"https://evil.invalid/c/pay/cs_test_fixture"},{url:"https://checkout.stripe.com/c/pay/cs_test_other"},
  {consent_collection:null},{custom_text:{submit:{message:"changed terms"}}},{metadata:{}},
])("changed current Session %j cannot publish",async(changes)=>{
  const h=fixture();await h.run();h.links.publish.mockClear();Object.assign(h.f.session,changes);
  await expect(h.run()).rejects.toThrow();expect(h.links.publish).not.toHaveBeenCalled();
});
test("an allocated unpaid PaymentIntent is independently checked",async()=>{
  const h=fixture();await h.run(); h.f.session.payment_intent=h.f.pi.id;
  Object.assign(h.f.pi,{status:"requires_payment_method",amount_received:0,amount_capturable:0,latest_charge:null});
  await h.run();expect(h.f.mocks.paymentIntents.retrieve).toHaveBeenCalledWith(h.f.pi.id);
  h.links.publish.mockClear();h.f.pi.application_fee_amount=1;
  await expect(h.run()).rejects.toThrow();expect(h.links.publish).not.toHaveBeenCalled();
});
test.each(["*","bad-id",",",`${exactInstallmentFixture().terms.bookingId},${exactInstallmentFixture().terms.bookingId}`])(
  "allowlist rejects %s",raw=>expect(()=>selectedExactCheckoutBooking({CREATOR_EXACT_INSTALLMENTS_CHECKOUT_BOOKING_IDS:raw},"x")).toThrow());

function routeFixture(known=true) {
  const h=fixture();let fail=false;
  const db=createMockClient(()=>({data:known?{id:h.f.agreement.id}:null,error:fail?{message:"private DB detail"}:null}));
  const stripe=jest.fn(()=>h.f.stripe as Stripe);
  const args={bookingId:h.f.terms.bookingId,actorId:h.f.terms.creatorId,body:{plan_type:"installment",installment_months:3} as unknown,
    origin:h.f.terms.previewOrigin as string|null,admin:db as unknown as SupabaseClient,stripe,env:h.env};
  return {...h,db,args,stripe,fail:()=>{fail=true;},run:()=>handoffExactCheckoutLink(args)};
}
test("default-off handoff does not access new tables or construct Stripe for legacy calls",async()=>{
  const h=routeFixture();h.args.env={};h.args.bookingId="legacy-booking";
  expect(await h.run()).toBeNull();expect(h.db.ops).toHaveLength(0);expect(h.stripe).not.toHaveBeenCalled();
});
test("known paused exact booking cannot fall through to legacy, even for a full-payment request",async()=>{
  const h=routeFixture();h.args.body={plan_type:"full"};h.env.CREATOR_EXACT_INSTALLMENTS_CHECKOUT_PUBLISH_READY="false";
  expect(await h.run()).toMatchObject({status:409,body:{code:"EXACT_CHECKOUT_HELD"}});expect(h.stripe).not.toHaveBeenCalled();
});
test("unselected unbound bookings keep the legacy path",async()=>{
  const h=routeFixture(false);delete h.env.CREATOR_EXACT_INSTALLMENTS_CHECKOUT_BOOKING_IDS;
  expect(await h.run()).toBeNull();expect(h.stripe).not.toHaveBeenCalled();
});
test.each([null,"https://evil.invalid"])("wrong Origin %s cannot create anything",async(origin)=>{
  const h=routeFixture();h.args.origin=origin;expect(await h.run()).toMatchObject({status:403});expect(h.stripe).not.toHaveBeenCalled();
});
test.each([{plan_type:"installment",installment_months:3,amount:1},{plan_type:"installment",installment_months:"3"},
  {plan_type:"full"},null,[],{plan_type:"installment",installment_months:2.5}])("invalid payload %j fails closed",async(body)=>{
    const h=routeFixture();h.args.body=body;expect(await h.run()).toMatchObject({status:400});expect(h.stripe).not.toHaveBeenCalled();
  });
test("lookup failure returns a generic review state without pretending no reservation exists",async()=>{
  const h=routeFixture();h.fail();const r=await h.run();
  expect(r).toMatchObject({status:409,body:{code:"EXACT_CHECKOUT_REVIEW_REQUIRED"}});
  expect(JSON.stringify(r)).not.toContain("private DB detail");expect(h.stripe).not.toHaveBeenCalled();
});
test("service adapters use only narrow private RPCs and validate results",async()=>{
  const h=fixture();let data:unknown=h.f.agreement.id,error:unknown=null;
  const db=createMockClient(()=>({data,error})),links=createExactCheckoutLinkStore(db as unknown as SupabaseClient);
  expect(await links.reserve(h.args.bookingId,h.args.actorId,3,h.f.terms.previewOrigin,
    h.f.terms.firstPaymentFeeSchedule,h.f.terms.renewalFeeSchedule)).toBe(h.f.agreement.id);
  data={request_hash:"a".repeat(64)};
  expect(await links.requestHash(h.f.agreement.id,h.f.session.id)).toBe("a".repeat(64));
  error={message:"private"};await expect(links.requestHash(h.f.agreement.id,h.f.session.id)).rejects.toThrow("reconciliation");
});

describe("real booking HTTP integration",()=>{
  const savedEnv={...process.env};
  afterEach(()=>{process.env={...savedEnv};jest.restoreAllMocks();});
  async function httpFixture() {
    const h=fixture();await h.run(); // Synthetic port fixture already prepared; no network.
    process.env={...savedEnv,...h.env};
    jest.spyOn(Date,"now").mockReturnValue((h.f.agreement.createdAt+10)*1000);
    let owner=h.f.terms.creatorId,missing=false;
    const booking={id:h.args.bookingId,creator_id:owner,buyer_id:h.f.terms.buyerId,post_id:h.f.terms.postId,status:"booked"};
    httpDb=createMockClient(op=>{
      if(op.table==="bookings")return {data:op.columns?.includes("linked_order_id")?[booking]:booking,error:null};
      if(op.table==="exact_installment_agreements")return {data:{id:h.f.agreement.id,terms:h.f.terms,status:"awaiting_first",
        created_at:new Date(h.f.agreement.createdAt*1000).toISOString(),stripe_customer_id:h.f.customer.id,
        stripe_subscription_id:h.f.subscription.id,stripe_checkout_session_id:h.f.session.id},error:null};
      if(op.table==="exact_installment_operations")return {data:{request_hash:h.f.operations.get("checkout")!.hash},error:null};
      if(op.table==="reserve_exact_installment_checkout")return {data:h.f.agreement.id,error:null};
      if(op.table==="seed_exact_installment_purchase")return {data:purchaseId,error:null};
      if(op.table==="publish_exact_installment_checkout")return {data:{url:h.payment.link_url,reused:true,payment:h.payment},error:null};
      if(op.table==="booking_payments")return {data:[{...h.payment,closer_user_id:null}],error:null};
      return {data:[],error:null};
    });
    httpDb.auth.getUser=jest.fn(async()=>({data:{user:missing?null:{id:owner}},error:null}));
    httpStripe=h.f.stripe as Stripe;
    const request=(body:unknown={plan_type:"installment",installment_months:3},auth=true)=>new NextRequest(
      `${h.f.terms.previewOrigin}/api/bookings/${booking.id}/payment-link`,{method:"POST",
        headers:{origin:h.f.terms.previewOrigin,"content-type":"application/json",...(auth?{authorization:"Bearer synthetic-only"}:{})},
        body:JSON.stringify(body)});
    const run=async(req=request())=>(await import("@/app/api/bookings/[bookingId]/payment-link/route")).POST(req,
      {params:Promise.resolve({bookingId:booking.id})});
    return {...h,request,run,foreign:()=>{owner=h.f.terms.buyerId;},signedOut:()=>{missing=true;}};
  }
  test("$1999/3 reaches exact validator before legacy divisibility/percent gates; no duplicate creation",async()=>{
    const h=await httpFixture(),res=await h.run();
    expect(res.status).toBe(200);expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.json()).toMatchObject({url:h.payment.link_url,payment:{amount_total_cents:199900}});
    expect(httpDb.opsFor("reserve_exact_installment_checkout")).toHaveLength(1);
    expect(httpDb.opsFor("products")).toHaveLength(0); // Owned reservation RPC supplies authoritative price.
    expect(h.f.mocks.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });
  test.each(["no token","invalid session","foreign creator"])("%s stops before private lookup or reservation",async(reason)=>{
    const h=await httpFixture();
    if(reason==="invalid session")h.signedOut();if(reason==="foreign creator")h.foreign();
    const res=await h.run(h.request(undefined,reason!=="no token"));
    expect(res.status).toBe(reason==="foreign creator"?403:401);
    expect(httpDb.opsFor("exact_installment_agreements")).toHaveLength(0);
    expect(httpDb.opsFor("reserve_exact_installment_checkout")).toHaveLength(0);
  });
  test.each([true,false])("list endpoint reads additive version only with installed staging schema: %s",async(ready)=>{
    const h=await httpFixture();process.env.CREATOR_EXACT_INSTALLMENTS_CHECKOUT_SCHEMA_READY=String(ready);
    jest.spyOn(console,"log").mockImplementation(()=>undefined);
    const res=await (await import("@/app/api/bookings/list/route")).GET(h.request());
    expect(res.status).toBe(200);
    const columns=httpDb.opsFor("booking_payments")[0].columns!;
    expect(columns.includes("installment_collection_version")).toBe(ready);
  });
});
