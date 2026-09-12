import {createBuyerRecoveryController,createBuyerRecoverySource,parseBuyerRecoveryInput,type BuyerRecoveryDependencies} from "../lib/installments/buyerRecovery";
import {PAY_NOW_CONSENT_VERSION,RETRY_CONSENT_VERSION,FUTURE_CARD_CONSENT_VERSION} from "../lib/installments/buyerRecoveryView";
import {exactRetryFixture} from "../test-support/exact-retry-fixture";

async function fixture(){
  const f=await exactRetryFixture(),r=f.record(),now=f.args.now();
  const view={agreementId:r.agreementId,title:f.f.f.terms.title,totalCents:r.authorization.totalCents,paymentCount:3,paymentNumber:2,
    amountCents:r.amountCents,outcome:"payment_method_required",observedAt:new Date(now*1000).toISOString(),setupRequestId:r.setupId,
    setupState:"verified",setupEligible:true,confirmedQuoteId:null as string|null};
  const q={id:r.id,agreement_id:r.agreementId,buyer_id:r.buyerId,setup_request_id:r.setupId,amount_cents:r.amountCents,
    application_fee_cents:r.applicationFeeCents,consent_version:PAY_NOW_CONSENT_VERSION as string,created_at:new Date(now*1000).toISOString(),
    expires_at:r.expiresAt,confirmed_at:null as string|null,authorization_snapshot:r.authorization,stripe_invoice_id:r.authorization.invoiceId,
    original_payment_intent_id:r.originalPaymentIntentId,replacement_payment_method_id:r.replacementPaymentMethodId,setup_intent_id:r.setupIntentId};
  const source={view:jest.fn(async()=>view),invoice:jest.fn(async()=>r.authorization.invoiceId),quote:jest.fn(async()=>q),loadQuote:jest.fn(async()=>q),
    confirm:jest.fn(async()=>{q.confirmed_at=new Date(now*1000).toISOString();view.confirmedQuoteId=q.id;view.setupEligible=false;return {...q};})};
  const env={...f.env,CREATOR_EXACT_INSTALLMENTS_BUYER_RECOVERY_READY:"true",CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_PUBLISH_READY:"true",
    CREATOR_EXACT_INSTALLMENTS_PAYMENT_CONFIRMATION_READY:"true"};
  const deps:BuyerRecoveryDependencies={source,agreementStore:f.args.store,cardStore:f.cardStore,stripe:f.args.stripe,env,now:f.args.now,
    retry:{invoiceStore:f.args.invoiceStore,creditStore:f.args.creditStore,retryStore:f.retryStore}};
  const input={agreementId:r.agreementId,action:"pay_now",quoteId:r.id,accepted:true,consentVersion:PAY_NOW_CONSENT_VERSION} as const;
  return {f,r,view,q,source,env,deps,input,c:createBuyerRecoveryController(deps)};
}

async function bankFixture(){
  const t=await fixture();t.f.setRecord({admittedAt:t.f.args.now()});
  t.q.confirmed_at=new Date(t.f.args.now()*1000).toISOString();t.view.confirmedQuoteId=t.q.id;
  t.view.outcome="action_required";t.view.setupEligible=false;
  t.deps.env.CREATOR_EXACT_INSTALLMENTS_BANK_VERIFICATION_READY="true";t.deps.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_test_SYNTHETIC";
  const bankStore={read:jest.fn(async()=>({authorization:t.r.authorization,paymentIntentId:t.r.originalPaymentIntentId,
    buyerId:t.r.buyerId,paymentMethodId:t.r.replacementPaymentMethodId,admittedAt:t.f.args.now(),retryId:t.r.id}))};
  t.deps.bankStore=bankStore;
  Object.assign(t.f.f.pi,{status:"requires_action",payment_method:t.r.replacementPaymentMethodId,next_action:{type:"use_stripe_sdk"},
    capture_method:"automatic",confirmation_method:"automatic",canceled_at:null,on_behalf_of:null,client_secret:"pi_renewal_secret_SYNTHETIC"});
  return {...t,bankStore,c:createBuyerRecoveryController(t.deps)};
}

async function futureFixture(){
  const t=await fixture();const q=Object.assign(t.q,{future_card_option:true,future_card_accepted:null as boolean|null,
    future_card_periods:[{paymentNumber:3,amountCents:66634,dueAt:t.r.authorization.periodEnd,periodEnd:t.r.authorization.cancelAt}]});
  t.deps.env.CREATOR_EXACT_INSTALLMENTS_FUTURE_CARD_READY="true";
  const quoteFuture=jest.fn(async()=>q),confirmFuture=jest.fn(async(_id:string,_buyer:string,accepted:boolean)=>{
    await t.source.confirm();q.future_card_accepted=accepted;return {...q};
  });
  t.deps.source.quoteFuture=quoteFuture;t.deps.source.confirmFuture=confirmFuture;
  return {...t,q,quoteFuture,confirmFuture,c:createBuyerRecoveryController(t.deps)};
}
test("future review exposes only remaining original amounts/dates and no authority or card identifiers",async()=>{
  const t=await futureFixture();const result=await t.c.act({agreementId:t.r.agreementId,action:"review_pay_now",quoteId:t.r.id},t.r.buyerId);
  expect(result).toEqual({status:"payment_review_ready",quote:expect.objectContaining({remainingPayments:t.q.future_card_periods,confirmed:false})});
  expect(JSON.stringify(result)).not.toMatch(/pm_|cus_|seti_|futureCardAccepted/);
  expect(t.quoteFuture).toHaveBeenCalledWith(t.r.id,t.r.setupId,t.r.buyerId);expect(t.confirmFuture).not.toHaveBeenCalled();
  expect(t.f.api.invoices.pay).not.toHaveBeenCalled();
});
test.each([true,false])("optional future choice %s is atomically recorded, current invoice still pays once",async(accepted)=>{
  const t=await futureFixture(),input={...t.input,...accepted?{futureCardConsentVersion:FUTURE_CARD_CONSENT_VERSION as typeof FUTURE_CARD_CONSENT_VERSION}:{}};
  const result=await t.c.act(input,t.r.buyerId);
  expect(t.confirmFuture).toHaveBeenCalledWith(t.r.id,t.r.buyerId,accepted);
  expect(result).toMatchObject({status:"payment_attempt_checked",quote:{futureCardAccepted:accepted},outcome:"paid_accounted"});
  expect(t.f.api.invoices.pay).toHaveBeenCalledTimes(1);expect(t.f.f.f.mocks.subscriptions.update).not.toHaveBeenCalled();
  await t.c.act(input,t.r.buyerId);expect(t.confirmFuture).toHaveBeenCalledTimes(1);expect(t.f.api.invoices.pay).toHaveBeenCalledTimes(1);
  await expect(t.c.act({...t.input,...!accepted?{futureCardConsentVersion:FUTURE_CARD_CONSENT_VERSION}:{}},t.r.buyerId)).rejects.toThrow();
});
test("old one-time quote cannot acquire future authority from a new request body",async()=>{
  const t=await fixture();await expect(t.c.act({...t.input,futureCardConsentVersion:FUTURE_CARD_CONSENT_VERSION},t.r.buyerId)).rejects.toThrow();
  expect(t.source.confirm).not.toHaveBeenCalled();expect(t.f.api.invoices.pay).not.toHaveBeenCalled();
});
test.each(["flag off","missing periods","wrong amount","wrong date","wrong count","old mode","wrong owner"])
("future %s fails before confirmation or payment",async(problem)=>{
  const t=await futureFixture();
  if(problem==="flag off")t.deps.env.CREATOR_EXACT_INSTALLMENTS_FUTURE_CARD_READY="false";
  if(problem==="missing periods")t.q.future_card_periods=[];
  if(problem==="wrong amount")t.q.future_card_periods[0].amountCents++;
  if(problem==="wrong date")t.q.future_card_periods[0].dueAt++;
  if(problem==="wrong count")t.q.future_card_periods[0].paymentNumber=2;
  if(problem==="old mode")t.q.consent_version=RETRY_CONSENT_VERSION;
  await expect(t.c.act({...t.input,futureCardConsentVersion:FUTURE_CARD_CONSENT_VERSION},problem==="wrong owner"?t.r.setupId:t.r.buyerId)).rejects.toThrow();
  expect(t.confirmFuture).not.toHaveBeenCalled();expect(t.f.api.invoices.pay).not.toHaveBeenCalled();
});
test("lost future-consent acknowledgement never dispatches a payment on refresh/replay",async()=>{
  const t=await futureFixture();t.confirmFuture.mockImplementationOnce(async()=>{
    await t.source.confirm();t.q.future_card_accepted=true;throw new Error("lost acknowledgement");
  });
  const input={...t.input,futureCardConsentVersion:FUTURE_CARD_CONSENT_VERSION} as const;
  await expect(t.c.act(input,t.r.buyerId)).rejects.toThrow();await t.c.act(input,t.r.buyerId);
  expect(t.f.api.invoices.pay).not.toHaveBeenCalled();expect(t.f.retryStore.admit).not.toHaveBeenCalled();
});
test.each([true,false,null,"wrong-version"])("invalid optional consent payload %s is rejected",async(value)=>{
  const t=await fixture();expect(parseBuyerRecoveryInput({...t.input,futureCardConsentVersion:value})).toBeNull();
  expect(parseBuyerRecoveryInput({...t.input,action:"review_pay_now",futureCardConsentVersion:FUTURE_CARD_CONSENT_VERSION})).toBeNull();
});
test("owner GET never reads or exposes the bank capability; explicit POST checks actual Stripe evidence",async()=>{
  const t=await bankFixture();const view=await t.c.read(t.r.agreementId,t.r.buyerId);
  expect(view.canVerifyBank).toBe(true);expect(view.canCheckBankPayment).toBe(true);expect(JSON.stringify(view)).not.toMatch(/_secret_|pk_test_/);
  expect(t.bankStore.read).not.toHaveBeenCalled();
  expect(await t.c.act({agreementId:t.r.agreementId,action:"verify_bank"},t.r.buyerId)).toEqual(expect.objectContaining({status:"bank_verification_ready",amountCents:66633}));
  expect(t.f.api.invoices.pay).not.toHaveBeenCalled();expect(t.f.api.paymentIntents.confirm).not.toHaveBeenCalled();
});
test("explicit bank receipt check reads Stripe but never releases a capability or dispatches payment",async()=>{
  const t=await bankFixture();const result=await t.c.act({agreementId:t.r.agreementId,action:"check_bank_payment"},t.r.buyerId);
  expect(result).toEqual({status:"bank_payment_checked",outcome:"review_required"});expect(JSON.stringify(result)).not.toContain("_secret_");
  expect(t.f.api.invoices.pay).not.toHaveBeenCalled();expect(t.bankStore.read).toHaveBeenCalledTimes(1);
  expect(t.bankStore.read).toHaveBeenCalledWith(t.r.agreementId,t.r.authorization.invoiceId,t.r.buyerId,false);
});
test.each(["flag off","wrong owner","not action required","missing bank store"])("%s blocks bank capability",async(problem)=>{
  const t=await bankFixture();let buyer=t.r.buyerId;
  if(problem==="flag off")t.deps.env.CREATOR_EXACT_INSTALLMENTS_BANK_VERIFICATION_READY="false";
  if(problem==="wrong owner")buyer=t.r.setupId;
  if(problem==="not action required")t.view.outcome="paid_accounted";
  if(problem==="missing bank store")delete t.deps.bankStore;
  await expect(t.c.act({agreementId:t.r.agreementId,action:"verify_bank"},buyer)).rejects.toThrow();
  expect(t.bankStore.read).not.toHaveBeenCalled();expect(t.f.api.invoices.pay).not.toHaveBeenCalled();
});
test.each([{invoiceId:"in_other"},{paymentIntentId:"pi_other"},{buyerId:"other"},{amountCents:1},{clientSecret:"SECRET"}])
("bank action cannot accept caller-supplied identity or payment fields %j",async(extra)=>{
  const t=await bankFixture();expect(parseBuyerRecoveryInput({agreementId:t.r.agreementId,action:"verify_bank",...extra})).toBeNull();
});

test("pay-now review is owner-bound, explicit, and still cannot attempt payment",async()=>{
  const t=await fixture();expect((await t.c.read(t.r.agreementId,t.r.buyerId)).canAttemptPayment).toBe(true);
  const result=await t.c.act({agreementId:t.r.agreementId,action:"review_pay_now",quoteId:t.r.id},t.r.buyerId);
  expect(result).toEqual({status:"payment_review_ready",quote:expect.objectContaining({consentVersion:PAY_NOW_CONSENT_VERSION,confirmed:false,amountCents:66633})});
  expect(t.source.quote).toHaveBeenCalledWith(t.r.id,t.r.setupId,t.r.buyerId,PAY_NOW_CONSENT_VERSION);
  expect(t.source.confirm).not.toHaveBeenCalled();expect(t.f.api.invoices.pay).not.toHaveBeenCalled();expect(t.f.retryStore.admit).not.toHaveBeenCalled();
});
test("explicit pay-now consent reaches the real once-only executor, then a replay cannot pay again",async()=>{
  const t=await fixture();const result=await t.c.act(t.input,t.r.buyerId);
  expect(result).toEqual({status:"payment_attempt_checked",quote:expect.objectContaining({confirmed:true,consentVersion:PAY_NOW_CONSENT_VERSION}),outcome:"paid_accounted"});
  expect(t.source.confirm).toHaveBeenCalledWith(t.r.id,t.r.buyerId,PAY_NOW_CONSENT_VERSION);
  expect(t.f.api.invoices.pay).toHaveBeenCalledTimes(1);expect(t.f.retryStore.admit).toHaveBeenCalledTimes(1);
  t.view.outcome="paid_accounted";expect(await t.c.act(t.input,t.r.buyerId)).toEqual(result);
  expect(t.f.api.invoices.pay).toHaveBeenCalledTimes(1);expect(t.source.confirm).toHaveBeenCalledTimes(1);
});
test.each(["decline","bank verification","lost payment response"])("%s never produces a paid claim or second request",async(problem)=>{
  const t=await fixture();t.f.api.invoices.pay.mockImplementationOnce(async()=>{
    if(problem==="bank verification") Object.assign(t.f.f.pi,{payment_method:t.r.replacementPaymentMethodId,status:"requires_action",next_action:{type:"use_stripe_sdk"}});
    throw new Error("SECRET provider error");
  });
  const result=await t.c.act(t.input,t.r.buyerId);expect(result.status).toBe("payment_attempt_checked");
  expect(result).toEqual(expect.objectContaining({outcome:"review_required"}));expect(JSON.stringify(result)).not.toContain("SECRET");
  await t.c.act(t.input,t.r.buyerId);expect(t.f.api.invoices.pay).toHaveBeenCalledTimes(1);expect(t.f.retryStore.recordReceipt).not.toHaveBeenCalled();
});
test("a lost confirmation acknowledgement cannot dispatch, even on a later replay",async()=>{
  const t=await fixture();t.source.confirm.mockImplementationOnce(async()=>{t.q.confirmed_at=new Date(t.f.args.now()*1000).toISOString();
    t.view.confirmedQuoteId=t.q.id;t.view.setupEligible=false;throw new Error("lost acknowledgement");});
  await expect(t.c.act(t.input,t.r.buyerId)).rejects.toThrow();expect(t.f.api.invoices.pay).not.toHaveBeenCalled();
  expect(await t.c.act(t.input,t.r.buyerId)).toEqual(expect.objectContaining({outcome:"review_required"}));
  expect(t.f.retryStore.admit).not.toHaveBeenCalled();expect(t.f.api.invoices.pay).not.toHaveBeenCalled();
});
test.each(["record-only quote","old confirm action","wrong owner","expired","retry gate off","pay gate off","missing dependencies"])
("%s cannot submit a debit",async(problem)=>{
  const t=await fixture();let input=t.input as Parameters<typeof t.c.act>[0],buyer=t.r.buyerId;
  if(problem==="record-only quote")t.q.consent_version=RETRY_CONSENT_VERSION;
  if(problem==="old confirm action")input={...t.input,action:"confirm_payment",consentVersion:RETRY_CONSENT_VERSION};
  if(problem==="wrong owner")buyer=t.r.setupId;
  if(problem==="expired")t.deps.now=()=>t.q.expires_at;
  if(problem==="retry gate off")t.env.CREATOR_EXACT_INSTALLMENTS_RETRY_READY="false";
  if(problem==="pay gate off")t.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_BUYER_RETRY="false";
  if(problem==="missing dependencies")delete t.deps.retry;
  await expect(createBuyerRecoveryController(t.deps).act(input,buyer)).rejects.toThrow();
  expect(t.source.confirm).not.toHaveBeenCalled();expect(t.f.retryStore.admit).not.toHaveBeenCalled();expect(t.f.api.invoices.pay).not.toHaveBeenCalled();
});
test("an already recorded old confirmation cannot be upgraded after a flag changes",async()=>{
  const t=await fixture();t.q.consent_version=RETRY_CONSENT_VERSION;t.q.confirmed_at=new Date(t.f.args.now()*1000).toISOString();t.view.confirmedQuoteId=t.q.id;
  await expect(t.c.act(t.input,t.r.buyerId)).rejects.toThrow();expect(t.f.api.invoices.pay).not.toHaveBeenCalled();expect(t.source.confirm).not.toHaveBeenCalled();
});
test.each([{action:"pay_now",consentVersion:RETRY_CONSENT_VERSION},{action:"confirm_payment",consentVersion:PAY_NOW_CONSENT_VERSION},
  {amountCents:1},{invoiceId:"in_forged"},{paymentMethodId:"pm_forged"},{buyerId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},{accepted:false}])
("client payment identity/consent tampering %j fails parsing",async(extra)=>{
  const t=await fixture();expect(parseBuyerRecoveryInput({...t.input,...extra})).toBeNull();
});
test("database adapter binds the selected consent version without changing old calls",async()=>{
  const rpc=jest.fn(()=>({single:async()=>({data:{},error:null})}));const source=createBuyerRecoverySource({rpc} as never);
  await source.quote("q","s","b");await source.quote("q","s","b",PAY_NOW_CONSENT_VERSION);
  await source.confirm("q","b");await source.confirm("q","b",PAY_NOW_CONSENT_VERSION);
  expect(rpc.mock.calls).toEqual([
    ["quote_exact_installment_retry",{p_id:"q",p_setup_id:"s",p_buyer_id:"b"}],
    ["quote_exact_installment_retry",{p_id:"q",p_setup_id:"s",p_buyer_id:"b",p_consent_version:PAY_NOW_CONSENT_VERSION}],
    ["confirm_exact_installment_retry",{p_id:"q",p_buyer_id:"b",p_consent_version:RETRY_CONSENT_VERSION}],
    ["confirm_exact_installment_retry",{p_id:"q",p_buyer_id:"b",p_consent_version:PAY_NOW_CONSENT_VERSION}],
  ]);
});
