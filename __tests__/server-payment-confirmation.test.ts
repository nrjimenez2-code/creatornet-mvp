import {serverPaymentFixture} from "../test-support/server-payment-fixture";
import {dispatchServerPaymentConfirmation,inspectServerConfirmationToken,serverPaymentAuthenticationCapability,
  serverPaymentCreateRequest,serverPaymentConfirmationRequest,SERVER_PAYMENT_PROTOCOL} from "../lib/serverPaymentConfirmation";
import {observeServerPaymentConfirmation} from "../lib/serverPaymentConfirmation";
import {operationHash} from "../lib/installments/agreementStore";
import {inspectServerPaymentTerminal} from "../lib/serverPaymentStop";
import {inspectServerPaymentIntent} from "../lib/serverPaymentConfirmation";

test.each(["full","first_installment"] as const)("%s recovers captured original with Stripe-generated transfer group without reconfirming",async kind=>{
  const f=serverPaymentFixture(kind);
  await f.stripe.paymentIntents.confirm();
  f.pi.transfer_group=`group_${f.pi.id}`;
  const observation=await observeServerPaymentConfirmation(f.args);
  expect(observation.status).toBe("succeeded");
  expect(f.store.recordObservation).toHaveBeenCalledTimes(1);
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(1);
});

test.each(["foreign group","custom group","group before capture"])("%s cannot pass original intent inspection",issue=>{
  const f=serverPaymentFixture("full");
  if(issue!=="group before capture")Object.assign(f.pi,{status:"succeeded",amount_received:f.c.amountCents});
  f.pi.transfer_group=issue==="foreign group"?"group_pi_other":issue==="custom group"?"custom":`group_${f.pi.id}`;
  expect(()=>inspectServerPaymentIntent(f.c,f.f.contextEvidence,f.pi,f.args.binding,f.now())).toThrow();
});

test.each(["full","first_installment"] as const)("%s create preserves exact economics and cannot charge or authorize browser confirmation",kind=>{
  const f=serverPaymentFixture(kind),r=serverPaymentCreateRequest(f.c,f.f.contextEvidence);
  expect(r).toMatchObject({apiVersion:"2025-10-29.clover",path:"/v1/payment_intents",params:{amount:3333,currency:"usd",
    confirm:false,confirmation_method:"manual",capture_method:"automatic_async",application_fee_amount:527,
    transfer_data:{destination:f.c.destinationId}}});
  expect(r.params).not.toHaveProperty("payment_method");expect(r.params).not.toHaveProperty("confirmation_token");
  expect(r.params.payment_method_types).toEqual(["card"]);
  expect(r.params).not.toHaveProperty("automatic_payment_methods");
  expect(r.params.setup_future_usage).toBe(kind==="full"?undefined:"off_session");
  expect(r.params.customer).toBe(kind==="full"?undefined:f.c.customerId);
});
test.each(["full","first_installment"] as const)("%s confirms only after fresh provider eligibility and durable admission, then records an observation",async kind=>{
  const f=serverPaymentFixture(kind);const result=await dispatchServerPaymentConfirmation(f.args);
  expect(result).toEqual({dispatched:true,observation:{paymentIntentId:"pi_owned",status:"succeeded",paymentMethodId:"pm_owned",
    chargeId:"ch_owned",observedAt:f.now(),nextActionHash:null}});
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(1);
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledWith("pi_owned",{confirmation_token:"ctoken_owned",
    return_url:expect.stringContaining(f.c.context.siteOrigin),use_stripe_sdk:true},
    {idempotencyKey:`${SERVER_PAYMENT_PROTOCOL}:${f.admission.operationId}`,maxNetworkRetries:0,apiVersion:"2025-10-29.clover",timeout:10000});
  expect(f.stripe.confirmationTokens.retrieve.mock.invocationCallOrder[0]).toBeLessThan(f.stripe.paymentIntents.confirm.mock.invocationCallOrder[0]);
  expect(f.store.assertDispatch).toHaveBeenCalledTimes(2);
  expect(f.store.recordObservation).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("secret");
});
test.each(["foreign country","missing country","missing address","missing state","missing zip","expired token","used token","foreign mode","foreign customer",
  "wrong future usage","bank method","expired card","changed preview","shipping","redirect","payment options"])
("token %s blocks confirmation before any provider write",async issue=>{
  const f=serverPaymentFixture(),t=f.token,p=t.payment_method_preview!;
  if(issue==="foreign country")p.billing_details.address!.country="CA";
  if(issue==="missing country")p.billing_details.address!.country=null;
  if(issue==="missing address")p.billing_details.address=null;
  if(issue==="missing state")p.billing_details.address!.state=null;
  if(issue==="missing zip")p.billing_details.address!.postal_code=null;
  if(issue==="expired token")t.expires_at=f.now();
  if(issue==="used token")t.payment_intent="pi_other";
  if(issue==="foreign mode")t.livemode=true;
  if(issue==="foreign customer")p.customer="cus_other";
  if(issue==="wrong future usage")t.setup_future_usage=null;
  if(issue==="bank method")p.type="us_bank_account";
  if(issue==="expired card")p.card!.exp_year=2020;
  if(issue==="changed preview")p.card!.last4="9999";
  if(issue==="shipping")t.shipping={name:"Other",phone:null,address:p.billing_details.address!};
  if(issue==="redirect")t.return_url="https://other.example/";
  if(issue==="payment options")t.payment_method_options={card:{cvc_token:null,installments:{plan:{type:"fixed_count",count:3,interval:"month"}}}};
  await expect(dispatchServerPaymentConfirmation(f.args)).rejects.toThrow("Server payment requires review");
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();expect(f.store.recordObservation).not.toHaveBeenCalled();
});
test.each(["automatic confirmation","wrong amount","wrong fee","wrong destination","foreign customer","wrong currency","manual capture",
  "foreign metadata","foreign mode","extra method","future created","capturable","prior failed charge"])
("intent %s cannot be confirmed",async issue=>{
  const f=serverPaymentFixture(),p=f.pi;
  if(issue==="automatic confirmation")p.confirmation_method="automatic";
  if(issue==="wrong amount")p.amount++;
  if(issue==="wrong fee")p.application_fee_amount!++;
  if(issue==="wrong destination")p.transfer_data!.destination="acct_other";
  if(issue==="foreign customer")p.customer="cus_other";
  if(issue==="wrong currency")p.currency="cad";
  if(issue==="manual capture")p.capture_method="manual";
  if(issue==="foreign metadata")p.metadata.buyer_id=f.c.creatorId;
  if(issue==="foreign mode")p.livemode=true;
  if(issue==="extra method")p.payment_method_types.push("us_bank_account");
  if(issue==="future created")p.created=f.now()+10;
  if(issue==="capturable")p.amount_capturable=3333;
  if(issue==="prior failed charge")p.latest_charge="ch_failed";
  await expect(dispatchServerPaymentConfirmation(f.args)).rejects.toThrow();expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
test.each(["changed request","new key","expired lease","aged admission","late stop","context changed","intent changed"])
("%s cannot dispatch",async issue=>{
  const f=serverPaymentFixture();
  if(issue==="changed request")f.admission.request.params.payment_method="pm_other";
  if(issue==="new key")(f.admission as any).idempotencyKey="new-key";
  if(issue==="expired lease")(f.admission as any).dispatchBefore=f.now();
  if(issue==="aged admission")(f.admission as any).firstDispatchAt=f.now()-86400;
  if(issue==="late stop")f.store.assertDispatch.mockResolvedValueOnce().mockRejectedValueOnce(Error("stop"));
  if(issue==="context changed")f.args.contextEvidence.mockResolvedValueOnce(f.f.contextEvidence)
    .mockResolvedValue({...f.f.contextEvidence,observedPlatformAccountId:"acct_other"});
  if(issue==="intent changed")f.stripe.paymentIntents.retrieve.mockResolvedValueOnce(structuredClone(f.pi))
    .mockResolvedValue({...f.pi,payment_method:"pm_other"});
  await expect(dispatchServerPaymentConfirmation(f.args)).rejects.toThrow("Server payment requires review");
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
test("lost confirmation reply reads the original intent and original token, never creates/reconfirms",async()=>{
  const f=serverPaymentFixture(),confirm=f.stripe.paymentIntents.confirm.getMockImplementation()!;
  f.stripe.paymentIntents.confirm.mockImplementation(async()=>{await confirm();throw Error("private provider error");});
  expect((await dispatchServerPaymentConfirmation(f.args)).observation.status).toBe("succeeded");
  expect((await dispatchServerPaymentConfirmation(f.args)).dispatched).toBe(false);
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(1);
});
test("unsettled network error records an unresolved original state and exposes no payment success",async()=>{
  const f=serverPaymentFixture();f.stripe.paymentIntents.confirm.mockRejectedValue(Error("private provider error"));
  expect(await dispatchServerPaymentConfirmation(f.args)).toMatchObject({dispatched:true,observation:{status:"requires_payment_method"}});
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledTimes(1);
});

function failedCard(f:ReturnType<typeof serverPaymentFixture>){
  const charge={id:"ch_failed",object:"charge",payment_intent:f.pi.id,customer:f.c.customerId,livemode:false,status:"failed",
    paid:false,captured:false,amount:f.c.amountCents,currency:"usd",amount_captured:0,amount_refunded:0,balance_transaction:null,
    refunded:false,disputed:false,payment_method:"pm_owned",failure_code:"card_declined",payment_method_details:{type:"card"},created:f.now()};
  Object.assign(f.pi,{status:"requires_payment_method",payment_method:null,latest_charge:charge.id,
    last_payment_error:{code:"card_declined",charge:charge.id,payment_method:{id:"pm_owned"}}});
  f.token.payment_intent=f.pi.id;f.stripe.charges.retrieve.mockResolvedValue(charge);return charge;
}
test("decline observation requires independent failed charge proof and persists no provider error text",async()=>{
  const f=serverPaymentFixture();failedCard(f);
  const result=await observeServerPaymentConfirmation(f.args);
  expect(result).toMatchObject({status:"requires_payment_method",failure:{chargeId:"ch_failed",paymentMethodId:"pm_owned",code:"card_declined"}});
  expect(f.stripe.charges.retrieve).toHaveBeenCalledWith("ch_failed",expect.objectContaining({apiVersion:"2025-10-29.clover",maxNetworkRetries:0}));
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
test.each(["foreign charge","paid","captured","processing","balance","wrong amount","foreign customer","foreign mode","foreign method","wrong code","foreign intent","used by another intent"])
("failure evidence refuses %s",async issue=>{
  const f=serverPaymentFixture(),ch:any=failedCard(f);
  if(issue==="foreign charge")ch.id="ch_other";if(issue==="paid")ch.paid=true;if(issue==="captured")ch.captured=true;
  if(issue==="processing")ch.status="pending";if(issue==="balance")ch.balance_transaction="txn_other";
  if(issue==="wrong amount")ch.amount++;if(issue==="foreign customer")ch.customer="cus_other";
  if(issue==="foreign mode")ch.livemode=true;if(issue==="foreign method")ch.payment_method="pm_other";
  if(issue==="wrong code")ch.failure_code="other";if(issue==="foreign intent")ch.payment_intent="pi_other";
  if(issue==="used by another intent")f.token.payment_intent="pi_other";
  await expect(observeServerPaymentConfirmation(f.args)).rejects.toThrow();expect(f.store.recordObservation).not.toHaveBeenCalled();
});
test("consumed token with null expiry reuses only its saved originally validated proof",async()=>{
  const f=serverPaymentFixture();await f.stripe.paymentIntents.confirm();f.token.expires_at=null;
  expect((await observeServerPaymentConfirmation(f.args)).status).toBe("succeeded");
  f.token.payment_method_preview!.card!.last4="9999";
  await expect(observeServerPaymentConfirmation(f.args)).rejects.toThrow();
});
test("unused null-expiry token cannot be admitted",()=>{
  const f=serverPaymentFixture();f.token.expires_at=null;
  expect(()=>inspectServerConfirmationToken(f.c,f.f.contextEvidence,f.token,f.token.id,f.now())).toThrow();
});
test("a captured original with a token bound to another payment cannot be recorded as this phase",async()=>{
  const f=serverPaymentFixture();await f.stripe.paymentIntents.confirm();f.token.payment_intent="pi_foreign";
  f.stripe.paymentIntents.confirm.mockClear();await expect(dispatchServerPaymentConfirmation(f.args)).rejects.toThrow();
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();expect(f.store.recordObservation).not.toHaveBeenCalled();
});
function afterAuth(f:ReturnType<typeof serverPaymentFixture>) {
  Object.assign(f.pi,{status:"requires_confirmation",payment_method:f.pm.id,next_action:null});
  const basis={kind:"after_authentication" as const,paymentMethodId:f.pm.id,previousOperationId:f.f.reservation.id};
  (f.admission as any).basis=basis;(f.admission as any).request=serverPaymentConfirmationRequest(f.c,f.pi.id,basis);
}
test("bank-authentication completion revalidates the exact saved US method before server reconfirmation",async()=>{
  const f=serverPaymentFixture();afterAuth(f);
  expect((await dispatchServerPaymentConfirmation(f.args)).observation.status).toBe("succeeded");
  expect(f.stripe.paymentMethods.retrieve).toHaveBeenCalledWith("pm_owned",{apiVersion:"2025-10-29.clover",maxNetworkRetries:0,timeout:10000});
  expect(f.stripe.paymentIntents.confirm).toHaveBeenCalledWith("pi_owned",{
    return_url:expect.stringContaining(f.c.context.siteOrigin),use_stripe_sdk:true},expect.anything());
});
test.each(["non-US card","different card","foreign owner","automatic intent"])("after authentication %s cannot bypass server checks",async issue=>{
  const f=serverPaymentFixture();afterAuth(f);
  if(issue==="non-US card")f.pm.billing_details.address!.country="CA";
  if(issue==="different card")f.pi.payment_method="pm_other";
  if(issue==="foreign owner")f.pm.customer="cus_other";
  if(issue==="automatic intent")f.pi.confirmation_method="automatic";
  await expect(dispatchServerPaymentConfirmation(f.args)).rejects.toThrow();expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
test("authentication capability is issued only for a freshly recorded manual challenge",()=>{
  const f=serverPaymentFixture();Object.assign(f.pi,{status:"requires_action",payment_method:f.pm.id,next_action:{type:"use_stripe_sdk",use_stripe_sdk:{}}});
  const observation={paymentIntentId:f.pi.id,status:"requires_action" as const,paymentMethodId:f.pm.id,chargeId:null,
    observedAt:f.now(),nextActionHash:operationHash(f.pi.next_action)};
  const read=()=>serverPaymentAuthenticationCapability(f.c,f.f.contextEvidence,f.pi,f.args.binding,observation,f.now());
  expect(read()).toEqual({clientSecret:"pi_owned_secret_synthetic",paymentIntentId:"pi_owned"});
  f.pi.confirmation_method="automatic";expect(read).toThrow();
  f.pi.confirmation_method="manual";observation.observedAt-=31;expect(read).toThrow();
});
test("token proof retains only identity, times and a hash, never address/name/card digits",()=>{
  const f=serverPaymentFixture();const proof=inspectServerConfirmationToken(f.c,f.f.contextEvidence,f.token,f.token.id,f.now());
  expect(Object.keys(proof).sort()).toEqual(["country","createdAt","expiresAt","previewHash","tokenId"]);
  expect(JSON.stringify(proof)).not.toMatch(/Fixture Way|4242|Test buyer/);
});
test("original captured intent can be recovered after expiry without new admission or provider writes",async()=>{
  const f=serverPaymentFixture();await f.stripe.paymentIntents.confirm();f.stripe.paymentIntents.confirm.mockClear();
  f.args.now=()=>f.c.expiresAt+86400;
  expect(await observeServerPaymentConfirmation(f.args)).toMatchObject({status:"succeeded",paymentIntentId:"pi_owned"});
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();expect(f.store.assertDispatch).not.toHaveBeenCalled();
  expect(f.store.assertReadable).toHaveBeenCalledTimes(2);
  f.args.now=()=>Math.floor(Date.UTC(2040,0,1)/1000);
  expect(await observeServerPaymentConfirmation(f.args)).toMatchObject({status:"succeeded",paymentIntentId:"pi_owned"});
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
test("lost owner scope refuses read recovery and cannot become a fresh payment",async()=>{
  const f=serverPaymentFixture();f.store.assertReadable.mockRejectedValue(Error("other owner"));
  await expect(observeServerPaymentConfirmation(f.args)).rejects.toThrow();
  expect(f.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
test("late provider or persistence failures during recovery cannot leak their details",async()=>{
  const f=serverPaymentFixture();await f.stripe.paymentIntents.confirm();
  f.stripe.confirmationTokens.retrieve.mockRejectedValueOnce(Error("private provider response"));
  await expect(observeServerPaymentConfirmation(f.args)).rejects.toThrow("Server payment requires review");
  f.store.recordObservation.mockRejectedValueOnce(Error("private database response"));
  await expect(observeServerPaymentConfirmation(f.args)).rejects.toThrow("Server payment requires review");
});

function terminalFixture(){
  const f=serverPaymentFixture();const charge=failedCard(f);
  Object.assign(f.pi,{status:"canceled",canceled_at:f.now(),next_action:null});
  const list=jest.fn(async()=>({object:"list",data:[charge],has_more:false}));
  const args={...f.args,admin:{rpc:jest.fn()},stripe:{...f.stripe,charges:{...f.stripe.charges,list}} as unknown as Parameters<typeof inspectServerPaymentTerminal>[0]["stripe"]};
  return {...f,charge,list,args};
}
test("terminal history paginates and retains every original failed charge ID in canonical order",async()=>{
  const f=terminalFixture();const earlier={...f.charge,id:"ch_earlier"};
  f.list.mockResolvedValueOnce({object:"list",data:[f.charge],has_more:true}).mockResolvedValueOnce({object:"list",data:[earlier],has_more:false});
  expect(await inspectServerPaymentTerminal(f.args,f.pi)).toMatchObject({status:"canceled",chargeIds:["ch_earlier","ch_failed"]});
  expect(f.list).toHaveBeenNthCalledWith(2,{payment_intent:"pi_owned",limit:100,starting_after:"ch_failed"},
    {apiVersion:"2025-10-29.clover",maxNetworkRetries:0,timeout:10000});
});
test.each(["captured","paid","refunded","disputed","transfer","fee","balance","foreign intent","foreign customer","foreign mode","amount","pending","future charge",
  "missing latest","duplicate","empty more","list failure","missing cancellation time","future cancellation","active challenge"])
("terminal evidence rejects %s",async issue=>{
  const f=terminalFixture(),ch:any=f.charge;
  if(issue==="captured")ch.amount_captured=ch.amount;
  if(issue==="paid")ch.paid=true;if(issue==="refunded")ch.refunded=true;if(issue==="disputed")ch.disputed=true;
  if(issue==="transfer")ch.transfer="tr_owned";if(issue==="fee")ch.application_fee="fee_owned";
  if(issue==="balance")ch.balance_transaction="txn_owned";if(issue==="foreign intent")ch.payment_intent="pi_other";
  if(issue==="foreign customer")ch.customer="cus_other";if(issue==="foreign mode")ch.livemode=true;
  if(issue==="amount")ch.amount++;if(issue==="pending")ch.status="pending";if(issue==="future charge")ch.created=f.now()+1;
  if(issue==="missing latest")f.pi.latest_charge="ch_missing";
  if(issue==="duplicate")f.list.mockResolvedValue({object:"list",data:[ch,ch],has_more:false});
  if(issue==="empty more")f.list.mockResolvedValue({object:"list",data:[],has_more:true});
  if(issue==="list failure")f.list.mockRejectedValue(Error("private provider error"));
  if(issue==="missing cancellation time")f.pi.canceled_at=null;if(issue==="future cancellation")f.pi.canceled_at=f.now()+1;
  if(issue==="active challenge")f.pi.next_action={type:"use_stripe_sdk",use_stripe_sdk:{}};
  await expect(inspectServerPaymentTerminal(f.args,f.pi)).rejects.toThrow();
  expect(f.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
