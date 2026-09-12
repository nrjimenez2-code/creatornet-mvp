import { createBuyerRecoveryController, parseBuyerRecoveryInput, type BuyerRecoverySource, type BuyerRecoveryDependencies } from "../lib/installments/buyerRecovery";
import { prepareExactCardSetupSandbox, readExactCardSetupRedirectSandbox, verifyExactCardSetupSandbox } from "../lib/installments/cardRecovery";
import { exactRenewalFixture } from "../test-support/exact-renewal-fixture";
import { CARD_SETUP_CONSENT_VERSION, RETRY_CONSENT_VERSION } from "../lib/installments/buyerRecoveryView";
jest.mock("../lib/installments/cardRecovery",()=>({...jest.requireActual("../lib/installments/cardRecovery"),
  prepareExactCardSetupSandbox:jest.fn(),readExactCardSetupRedirectSandbox:jest.fn(),verifyExactCardSetupSandbox:jest.fn()}));
const verify=jest.mocked(verifyExactCardSetupSandbox),prepare=jest.mocked(prepareExactCardSetupSandbox),redirect=jest.mocked(readExactCardSetupRedirectSandbox);
const setupId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",quoteId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function fixture(){
  const f=exactRenewalFixture(),now=f.args.now(),agreementId=f.a.planId,buyer=f.f.terms.buyerId;
  const view={agreementId,title:f.f.terms.title,totalCents:f.a.totalCents,paymentCount:3,paymentNumber:2,amountCents:66633,
    outcome:"payment_method_required",observedAt:new Date(now*1000).toISOString(),setupRequestId:setupId,setupState:"verified",setupEligible:true,confirmedQuoteId:null as string|null};
  const q={id:quoteId,agreement_id:agreementId,buyer_id:buyer,setup_request_id:setupId,amount_cents:66633,application_fee_cents:10425,
    consent_version:RETRY_CONSENT_VERSION,created_at:new Date(now*1000).toISOString(),expires_at:now+300,confirmed_at:null as string|null,
    authorization_snapshot:f.a,stripe_invoice_id:f.a.invoiceId,original_payment_intent_id:f.pi.id,replacement_payment_method_id:"pm_replacement",setup_intent_id:"seti_fixture"};
  const source={view:jest.fn(async()=>view),invoice:jest.fn(async()=>f.a.invoiceId),quote:jest.fn(async()=>q),loadQuote:jest.fn(async()=>q),
    confirm:jest.fn(async()=>({...q,confirmed_at:new Date(now*1000).toISOString()}))} satisfies BuyerRecoverySource;
  const cardStore={reserve:jest.fn(),current:jest.fn(),bind:jest.fn(),verify:jest.fn()};
  const env={...f.env,CREATOR_EXACT_INSTALLMENTS_BUYER_RECOVERY_READY:"true",CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_READY:"true",
    CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY:"true",CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY:"true",
    CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_PUBLISH_READY:"true",CREATOR_EXACT_INSTALLMENTS_PAYMENT_CONFIRMATION_READY:"true"};
  const deps:BuyerRecoveryDependencies={source,cardStore,agreementStore:f.f.store,stripe:f.args.stripe as never,env,now:()=>now};
  return {f,view,q,source,cardStore,env,deps,controller:createBuyerRecoveryController(deps),buyer,agreementId};
}
beforeEach(()=>{
  jest.clearAllMocks();verify.mockResolvedValue({status:"card_saved_payment_not_attempted"});
  prepare.mockResolvedValue({status:"prepared_unpublished",sessionId:"cs_test_setup"});redirect.mockResolvedValue("https://checkout.stripe.com/c/setup/cs_test_setup");
});
test("owner-filtered read returns only the public contract and performs no Stripe action",async()=>{
  const f=fixture();Object.assign(f.view,{secret:"SHOULD_NOT_ESCAPE"});
  expect(await f.controller.read(f.agreementId,f.buyer)).toEqual(expect.objectContaining({title:"Synthetic mentorship",canConfirmPayment:true,canSaveCard:false}));
  expect(JSON.stringify(await f.controller.read(f.agreementId,f.buyer))).not.toContain("SHOULD_NOT_ESCAPE");
  expect(verify).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();expect(f.source.quote).not.toHaveBeenCalled();
});
test.each(["wrong owner","production","live key","wrong project","disabled"])("%s fails before private recovery queries",async(problem)=>{
  const f=fixture();
  if(problem==="production") f.env.VERCEL_ENV="production";
  if(problem==="live key") f.env.STRIPE_SECRET_KEY="sk_live_synthetic";
  if(problem==="wrong project") f.env.NEXT_PUBLIC_SUPABASE_URL="https://other.supabase.co";
  if(problem==="disabled") f.env.CREATOR_EXACT_INSTALLMENTS_BUYER_RECOVERY_READY="false";
  await expect(f.controller.read(f.agreementId,problem==="wrong owner"?setupId:f.buyer)).rejects.toThrow();
  expect(f.source.view).not.toHaveBeenCalled();expect(verify).not.toHaveBeenCalled();
});
test.each(["amount","title","state","outcome","payment number"])("invalid persisted %s cannot reach the buyer",async(problem)=>{
  const f=fixture();if(problem==="amount") f.view.amountCents=66634;if(problem==="title") f.view.title="Other";
  if(problem==="state") f.view.setupState="unknown";if(problem==="outcome") f.view.outcome="secret raw Stripe error";
  if(problem==="payment number") f.view.paymentNumber=99;
  await expect(f.controller.read(f.agreementId,f.buyer)).rejects.toThrow();
});
test("card consent resolves the invoice server-side and returns only a verified setup handoff",async()=>{
  const f=fixture();Object.assign(f.view,{setupRequestId:null,setupState:"not_started"});
  expect(await f.controller.act({agreementId:f.agreementId,action:"save_card",requestId:setupId,accepted:true,consentVersion:CARD_SETUP_CONSENT_VERSION},f.buyer))
    .toEqual({status:"card_setup_ready",url:"https://checkout.stripe.com/c/setup/cs_test_setup"});
  expect(f.cardStore.reserve).toHaveBeenCalledWith(setupId,f.agreementId,f.f.a.invoiceId,f.buyer,CARD_SETUP_CONSENT_VERSION);
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({requestId:setupId,buyerId:f.buyer}));expect(f.source.confirm).not.toHaveBeenCalled();
});
test("payment review verifies the existing card and discloses exact cents without payment consent",async()=>{
  const f=fixture();expect(await f.controller.act({agreementId:f.agreementId,action:"review_payment",quoteId},f.buyer)).toEqual({status:"payment_review_ready",
    quote:{id:quoteId,amountCents:66633,paymentNumber:2,paymentCount:3,expiresAt:f.q.expires_at,confirmed:false}});
  expect(verify).toHaveBeenCalledWith(expect.objectContaining({requestId:setupId,buyerId:f.buyer}));
  expect(f.source.confirm).not.toHaveBeenCalled();expect(f.f.api.invoices.pay).not.toHaveBeenCalled();
});
test.each(["wrong amount","wrong fee","wrong agreement","wrong buyer","expired","wrong card setup","unverified Stripe"])
("%s cannot record a payment confirmation",async(problem)=>{
  const f=fixture();if(problem==="wrong amount") f.q.amount_cents++;
  if(problem==="wrong fee") f.q.application_fee_cents++;
  if(problem==="wrong agreement") f.q.agreement_id=setupId;
  if(problem==="wrong buyer") f.q.buyer_id=setupId;
  if(problem==="expired") f.deps.now=()=>f.q.expires_at;
  if(problem==="wrong card setup") f.q.setup_request_id=quoteId;
  if(problem==="unverified Stripe") verify.mockResolvedValue({status:"setup_pending"});
  const c=createBuyerRecoveryController(f.deps);
  await expect(c.act({agreementId:f.agreementId,action:"confirm_payment",quoteId,accepted:true,consentVersion:RETRY_CONSENT_VERSION},f.buyer)).rejects.toThrow();
  expect(f.source.confirm).not.toHaveBeenCalled();expect(f.f.api.invoices.pay).not.toHaveBeenCalled();
});
test("confirmation stores consent once and a replay is only a read of its result",async()=>{
  const f=fixture();const input={agreementId:f.agreementId,action:"confirm_payment",quoteId,accepted:true,consentVersion:RETRY_CONSENT_VERSION} as const;
  const result=await f.controller.act(input,f.buyer);expect(result.status).toBe("payment_confirmation_recorded");
  expect(f.source.confirm).toHaveBeenCalledTimes(1);
  f.view.confirmedQuoteId=quoteId;f.view.setupEligible=false;f.q.confirmed_at=new Date(f.deps.now!()*1000).toISOString();
  verify.mockClear();expect(await f.controller.act(input,f.buyer)).toEqual(result);
  expect(f.source.confirm).toHaveBeenCalledTimes(1);expect(verify).not.toHaveBeenCalled();
  expect(f.f.api.invoices.pay).not.toHaveBeenCalled();expect(f.f.api.paymentIntents.confirm).not.toHaveBeenCalled();expect(f.f.api.subscriptions.update).not.toHaveBeenCalled();
});
test("fresh database rejection after Stripe verification does not turn into a new request",async()=>{
  const f=fixture();f.source.confirm.mockRejectedValueOnce(new Error("stop hold"));
  await expect(f.controller.act({agreementId:f.agreementId,action:"confirm_payment",quoteId,accepted:true,consentVersion:RETRY_CONSENT_VERSION},f.buyer)).rejects.toThrow();
  expect(f.source.confirm).toHaveBeenCalledTimes(1);expect(f.f.api.invoices.pay).not.toHaveBeenCalled();
});
test.each([{buyerId:setupId},{amountCents:1},{url:"https://evil.test"},{paymentMethodId:"pm_forged"},{accepted:false},{consentVersion:"old"}])
("untrusted client fields %j are rejected",extra=>{
  expect(parseBuyerRecoveryInput({agreementId:setupId,action:"confirm_payment",quoteId,accepted:true,consentVersion:RETRY_CONSENT_VERSION,...extra})).toBeNull();
});
