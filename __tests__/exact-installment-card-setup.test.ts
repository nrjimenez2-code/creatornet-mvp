import type Stripe from "stripe";
import {exactRenewalFixture} from "../test-support/exact-renewal-fixture";
import {prepareHeldInstallmentInvoice} from "../lib/installments/heldInvoice";
import {CARD_SETUP_CONSENT_TEXT,CARD_SETUP_CONSENT_VERSION,prepareExactCardSetupSandbox,verifyExactCardSetupSandbox,
  createExactCardSetupStore,readExactCardSetupRedirectSandbox,type CardSetup,type ExactCardSetupStore} from "../lib/installments/cardRecovery";

async function fixture() {
  const f=exactRenewalFixture();await prepareHeldInstallmentInvoice(f.args.stripe,f.a);f.setPhase("dispatching");
  Object.assign(f.invoice,{attempted:true,attempt_count:1});Object.assign(f.pi,{amount_capturable:0,payment_method:null});
  Object.assign(f.f.subscription,{ended_at:null,payment_settings:{save_default_payment_method:"off"}});
  const requestId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",buyerId=f.f.terms.buyerId,now=f.args.now();
  let record:CardSetup={id:requestId,buyerId,agreementId:f.a.planId,invoiceId:f.invoice.id,originalPaymentIntentId:f.pi.id,
    authorization:f.a,createdAt:now,expiresAt:now+3600,sessionId:null,setupIntentId:null,paymentMethodId:null};
  const metadata={card_setup_version:CARD_SETUP_CONSENT_VERSION,card_setup_request_id:requestId,installment_plan_id:f.a.planId};
  const session={id:"cs_test_cardsetup",mode:"setup",ui_mode:"hosted",livemode:false,customer:f.a.customerId,client_reference_id:requestId,
    metadata,payment_method_types:["card"],expires_at:record.expiresAt,created:now,payment_intent:null,subscription:null,invoice:null,
    payment_status:"no_payment_required",amount_total:null,status:"open",setup_intent:null} as unknown as Stripe.Checkout.Session;
  const setup={id:"seti_fixture",livemode:false,customer:f.a.customerId,metadata,created:now,usage:"off_session",on_behalf_of:null,
    payment_method_types:["card"],status:"succeeded",payment_method:"pm_replacement"} as unknown as Stripe.SetupIntent;
  const pm={id:"pm_replacement",livemode:false,type:"card",customer:f.a.customerId} as Stripe.PaymentMethod;
  const store={reserve:jest.fn(),current:jest.fn(async()=>record),bind:jest.fn(async(_id:string,_buyer:string,sessionId:string)=>{record={...record,sessionId};}),
    verify:jest.fn(async(_id:string,_buyer:string,_session:string,setupIntentId:string,paymentMethodId:string)=>{record={...record,setupIntentId,paymentMethodId};})} satisfies ExactCardSetupStore;
  const sessions={create:jest.fn(async()=>session),retrieve:jest.fn(async()=>session)};
  const api={...f.api,checkout:{sessions},setupIntents:{retrieve:jest.fn(async()=>setup),create:jest.fn(),confirm:jest.fn()},
    paymentMethods:{...f.api.paymentMethods,retrieve:jest.fn(async()=>pm),attach:jest.fn()}};
  const env={...f.env,CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_READY:"true",CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY:"true",
    CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"true"};
  const args={requestId,buyerId,store,agreementStore:f.f.store,stripe:api as unknown as Stripe,env,now:()=>now};
  const complete=()=>{record={...record,sessionId:session.id};session.status="complete";session.setup_intent=setup.id;};
  f.calls.length=0;jest.clearAllMocks();
  return {f,record:()=>record,setRecord:(change:Partial<CardSetup>)=>{record={...record,...change};},session,setup,pm,store,sessions,api,env,args,complete};
}
function noPayment(f:Awaited<ReturnType<typeof fixture>>) {
  for(const method of [f.api.invoices.pay,f.api.invoices.update,f.api.invoices.finalizeInvoice,f.api.invoices.addLines,
    f.api.paymentIntents.confirm,f.api.subscriptions.update,f.api.setupIntents.confirm,f.api.paymentMethods.attach]) expect(method).not.toHaveBeenCalled();
  expect(f.f.invoiceStore.recordReceipt).not.toHaveBeenCalled();expect(f.f.creditStore.credit).not.toHaveBeenCalled();
}

test("setup-only Checkout uses immutable customer/consent and creates neither payment nor subscription",async()=>{
  const f=await fixture();expect(await prepareExactCardSetupSandbox(f.args)).toEqual({status:"prepared_unpublished",sessionId:f.session.id});
  const [params,options]=f.sessions.create.mock.calls[0] as unknown as [Stripe.Checkout.SessionCreateParams,Stripe.RequestOptions];
  expect(params).toEqual({mode:"setup",ui_mode:"hosted",customer:f.f.a.customerId,client_reference_id:f.args.requestId,
    payment_method_types:["card"],expires_at:f.record().expiresAt,success_url:`${f.env.NEXT_PUBLIC_SITE_URL}/payments/recovery/${f.f.a.planId}`,
    cancel_url:`${f.env.NEXT_PUBLIC_SITE_URL}/payments/recovery/${f.f.a.planId}`,metadata:f.session.metadata,
    setup_intent_data:{metadata:f.session.metadata},custom_text:{submit:{message:CARD_SETUP_CONSENT_TEXT}}});
  expect(options).toEqual({idempotencyKey:`exact-card-setup:${f.args.requestId}:v1`,maxNetworkRetries:0});
  expect(f.store.current.mock.invocationCallOrder[1]).toBeLessThan(f.sessions.create.mock.invocationCallOrder[0]);
  noPayment(f);
});

test("repeated preparation retrieves the same persisted setup; no duplicate creation or charge",async()=>{
  const f=await fixture();await prepareExactCardSetupSandbox(f.args);await prepareExactCardSetupSandbox(f.args);
  expect(f.sessions.create).toHaveBeenCalledTimes(1);expect(f.sessions.retrieve).toHaveBeenCalledWith(f.session.id);noPayment(f);
});

test("uncertain setup creation does not bind a guessed session and retains its original idempotency key",async()=>{
  const f=await fixture();f.sessions.create.mockRejectedValueOnce(new Error("secret https://stripe/private"));
  await expect(prepareExactCardSetupSandbox(f.args)).rejects.toThrow("keep the original request");expect(f.store.bind).not.toHaveBeenCalled();
  await prepareExactCardSetupSandbox(f.args);
  expect(f.sessions.create.mock.calls[0]).toEqual(f.sessions.create.mock.calls[1]);noPayment(f);
});

test.each(["different buyer","paid invoice","pending PI","received money","capturable money","wrong fee","wrong destination","extra payment",
  "subscription resumed","default replaced","expired","creation window","extra hold"])("%s blocks setup creation",async(problem)=>{
  const f=await fixture();
  if(problem==="different buyer") f.args.buyerId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  if(problem==="paid invoice") f.f.markPaid();
  if(problem==="pending PI") f.f.pi.status="processing";
  if(problem==="received money") f.f.pi.amount_received=1;
  if(problem==="capturable money") f.f.pi.amount_capturable=1;
  if(problem==="wrong fee") f.f.pi.application_fee_amount=1;
  if(problem==="wrong destination") f.f.pi.transfer_data!.destination="acct_other";
  if(problem==="extra payment") f.api.invoicePayments.list.mockResolvedValueOnce({has_more:false,data:[f.f.link,f.f.link]});
  if(problem==="subscription resumed") f.f.f.subscription.pause_collection=null;
  if(problem==="default replaced") f.f.f.subscription.default_payment_method="pm_other";
  if(problem==="expired") f.args.now=()=>f.record().expiresAt;
  if(problem==="creation window") f.args.now=()=>f.record().expiresAt-1800;
  if(problem==="extra hold") f.store.current.mockRejectedValueOnce(new Error("hold"));
  await expect(prepareExactCardSetupSandbox(f.args)).rejects.toThrow("Installment card setup unavailable");
  expect(f.sessions.create).not.toHaveBeenCalled();expect(f.store.bind).not.toHaveBeenCalled();noPayment(f);
});

test.each(["live","payment mode","wrong customer","wrong metadata","extra method","payment created","invoice created","expired session"])
("unexpected %s Checkout cannot bind",async(problem)=>{
  const f=await fixture();
  if(problem==="live") f.session.livemode=true;
  if(problem==="payment mode") f.session.mode="payment";
  if(problem==="wrong customer") f.session.customer="cus_other";
  if(problem==="wrong metadata") f.session.metadata={};
  if(problem==="extra method") f.session.payment_method_types.push("link");
  if(problem==="payment created") f.session.payment_intent="pi_unexpected";
  if(problem==="invoice created") f.session.invoice="in_unexpected";
  if(problem==="expired session") f.session.status="expired";
  await expect(prepareExactCardSetupSandbox(f.args)).rejects.toThrow();expect(f.store.bind).not.toHaveBeenCalled();noPayment(f);
});

test("verified Checkout/SetupIntent/customer card persists only setup evidence and never authorizes payment",async()=>{
  const f=await fixture();f.complete();
  for(let observation=0;observation<2;observation++) expect(await verifyExactCardSetupSandbox(f.args)).toEqual({status:"card_saved_payment_not_attempted"});
  expect(f.store.verify).toHaveBeenCalledWith(f.args.requestId,f.args.buyerId,f.session.id,f.setup.id,f.pm.id);
  expect(f.record().authorization.paymentMethodId).toBe("pm_fixture");expect(f.f.f.subscription.default_payment_method).toBe("pm_fixture");
  expect(f.sessions.create).not.toHaveBeenCalled();noPayment(f);
});

test("an unfinished hosted setup is pending, not a verified card",async()=>{
  const f=await fixture();f.setRecord({sessionId:f.session.id});
  expect(await verifyExactCardSetupSandbox(f.args)).toEqual({status:"setup_pending"});
  expect(f.api.setupIntents.retrieve).not.toHaveBeenCalled();expect(f.store.verify).not.toHaveBeenCalled();noPayment(f);
});

test.each(["requires_action","requires_payment_method","processing","canceled","wrong setup customer","wrong setup metadata","old setup",
  "future setup","wrong card customer","live card","another account","racing stop"])("%s is not verified as a reusable replacement",async(problem)=>{
  const f=await fixture();f.complete();
  if(["requires_action","requires_payment_method","processing","canceled"].includes(problem)) f.setup.status=problem as Stripe.SetupIntent.Status;
  if(problem==="wrong setup customer") f.setup.customer="cus_other";
  if(problem==="wrong setup metadata") f.setup.metadata={};
  if(problem==="old setup") f.setup.created=f.record().createdAt-1;
  if(problem==="future setup") f.setup.created=f.args.now()+1;
  if(problem==="wrong card customer") f.pm.customer="cus_other";
  if(problem==="live card") f.pm.livemode=true;
  if(problem==="another account") f.setup.on_behalf_of="acct_other";
  if(problem==="racing stop") f.store.current.mockResolvedValueOnce(f.record()).mockRejectedValueOnce(new Error("stop"));
  await expect(verifyExactCardSetupSandbox(f.args)).rejects.toThrow("payment recovery remains on hold");
  expect(f.store.verify).not.toHaveBeenCalled();noPayment(f);
});

test.each([{VERCEL_ENV:"production"},{STRIPE_SECRET_KEY:"sk_live_synthetic"},{CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_READY:"false"}])
("unsafe environment %j stops before persistence/provider access",async(override)=>{
  const f=await fixture();Object.assign(f.env,override);
  await expect(prepareExactCardSetupSandbox(f.args)).rejects.toThrow();
  expect(f.store.current).not.toHaveBeenCalled();expect(f.sessions.create).not.toHaveBeenCalled();noPayment(f);
});

test("service adapter validates persisted identity and redacts database errors",async()=>{
  const f=await fixture(),r=f.record();
  const row={id:r.id,buyer_id:r.buyerId,agreement_id:r.agreementId,stripe_invoice_id:r.invoiceId,original_payment_intent_id:r.originalPaymentIntentId,
    authorization_snapshot:r.authorization,created_at:new Date(r.createdAt*1000).toISOString(),expires_at:r.expiresAt,consent_version:CARD_SETUP_CONSENT_VERSION,
    stripe_checkout_session_id:null,stripe_setup_intent_id:null,replacement_payment_method_id:null,verified_at:null};
  const single=jest.fn().mockResolvedValue({data:row,error:null}),rpc=jest.fn(()=>({single}));
  const adapter=createExactCardSetupStore({rpc} as never);expect(await adapter.current(r.id,r.buyerId)).toEqual(r);
  single.mockResolvedValueOnce({data:{...row,buyer_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},error:null});
  await expect(adapter.current(r.id,r.buyerId)).rejects.toThrow("buyer binding differs");
  single.mockResolvedValueOnce({data:null,error:{message:"SECRET"}});
  await expect(adapter.current(r.id,r.buyerId)).rejects.toThrow("state unavailable");
});

test.each(["allowed","disabled","wrong host","wrong session","credentials","payment route","wrong return","completed","racing hold"])
("setup redirect: %s never publishes an unbound or payable destination",async(problem)=>{
  const f=await fixture();f.setRecord({sessionId:f.session.id});
  const env={...f.env,CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_PUBLISH_READY:"true"};
  const url=`https://checkout.stripe.com/c/setup/${f.session.id}`;
  Object.assign(f.session,{url,success_url:`${f.env.NEXT_PUBLIC_SITE_URL}/payments/recovery/${f.f.a.planId}`,
    cancel_url:`${f.env.NEXT_PUBLIC_SITE_URL}/payments/recovery/${f.f.a.planId}`});
  if(problem==="disabled") env.CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_PUBLISH_READY="false";
  if(problem==="wrong host") f.session.url=`https://checkout.stripe.com.evil.test/c/setup/${f.session.id}`;
  if(problem==="wrong session") f.session.url="https://checkout.stripe.com/c/setup/cs_test_other";
  if(problem==="credentials") f.session.url=`https://user@checkout.stripe.com/c/setup/${f.session.id}`;
  if(problem==="payment route") f.session.mode="payment";
  if(problem==="wrong return") f.session.success_url="https://www.creatornet.net/library";
  if(problem==="completed") f.session.status="complete";
  if(problem==="racing hold") f.store.current.mockResolvedValueOnce(f.record()).mockRejectedValueOnce(new Error("SECRET"));
  if(problem==="allowed") expect(await readExactCardSetupRedirectSandbox({...f.args,env})).toBe(url);
  else await expect(readExactCardSetupRedirectSandbox({...f.args,env})).rejects.toThrow("secure card setup is unavailable");
  expect(f.sessions.create).not.toHaveBeenCalled();noPayment(f);
});
