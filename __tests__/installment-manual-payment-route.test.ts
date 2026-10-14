import {NextRequest} from "next/server";
const mockAuth=jest.fn(),mockRead=jest.fn(),mockObserve=jest.fn(),mockFresh=jest.fn(),mockPrepare=jest.fn(),mockConfirm=jest.fn();
const mockAuthenticate=jest.fn(),mockReceipt=jest.fn(),mockActivate=jest.fn(),mockUnprepared=jest.fn(),mockStop=jest.fn();
jest.mock("@supabase/supabase-js",()=>({createClient:()=>({})}));
jest.mock("../lib/supabaseConnectAuth",()=>({getAuthenticatedUser:()=>mockAuth()}));
jest.mock("../lib/installments/contextServer",()=>({exactContextServerConfig:()=>({approvedContext:context,
  configuredSupabaseUrl:"https://fixture.invalid",supabaseServiceKey:"fixture"})}));
jest.mock("../lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve}),assertFreshExactRuntimeContextObservation:()=>mockFresh()}));
jest.mock("../lib/mentorshipInstallmentReservation",()=>({readBuyerMentorshipInstallmentReservation:(...a:unknown[])=>mockRead(...a)}));
jest.mock("../lib/mentorshipServerPayment",()=>({prepareBuyerMentorshipServerPayment:(...a:unknown[])=>mockPrepare(...a),
  confirmBuyerMentorshipServerPayment:(...a:unknown[])=>mockConfirm(...a),authenticateBuyerMentorshipServerPayment:(...a:unknown[])=>mockAuthenticate(...a)}));
jest.mock("../lib/mentorshipInstallmentAccounting",()=>({recordBuyerMentorshipFirstPayment:(...a:unknown[])=>mockReceipt(...a)}));
jest.mock("../lib/mentorshipInstallmentActivationRuntime",()=>({activateBuyerMentorship:(...a:unknown[])=>mockActivate(...a)}));
jest.mock("../lib/mentorshipInstallmentBootstrap",()=>({releaseBuyerMentorshipUnpreparedSelection:(...a:unknown[])=>mockUnprepared(...a)}));
jest.mock("../lib/mentorshipInstallmentAbandonment",()=>({stopBuyerMentorshipUnpaidCheckout:(...a:unknown[])=>mockStop(...a)}));
import {POST} from "../app/api/installments/reservations/[requestId]/payment/route";
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={siteOrigin:"https://fixture.vercel.app"};
const saved=()=>({requestId:id(1),releasedAt:null,terms:{payments:[{number:1,amountCents:3333},{number:2,amountCents:3333},{number:3,amountCents:3335}]}});
const original={buyerId:id(2),requestId:id(1)};
const request=(body:unknown,origin=context.siteOrigin,path="",contentType="application/json")=>new NextRequest(context.siteOrigin+"/api/installments/reservations/"+id(1)+"/payment"+path,
  {method:"POST",headers:{Origin:origin,"Content-Type":contentType},body:JSON.stringify(body)});
const call=(body:unknown)=>POST(request(body),{params:Promise.resolve({requestId:id(1)})});
let oldEnv:NodeJS.ProcessEnv;
beforeEach(()=>{
  oldEnv={...process.env};jest.resetAllMocks();
  delete process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED;
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_RESERVATIONS_SCHEMA_READY="true";
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_ACTIONS_READY="true";
  process.env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_ACTIONS_READY="true";
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_READY="false";
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_READY="false";
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_NONPAYABLE_RELEASE_READY="false";
  mockAuth.mockResolvedValue({id:id(2)});mockRead.mockResolvedValue(saved());mockObserve.mockResolvedValue({contextEvidence:{}});
  mockPrepare.mockResolvedValue({status:"bound_unpublished",paymentIntentId:"pi_private"});
  mockConfirm.mockResolvedValue({status:"observed",operationId:id(3),observation:{status:"processing",paymentIntentId:"pi_private"}});
  mockAuthenticate.mockResolvedValue({status:"authentication_required",operationId:id(3),paymentIntentId:"pi_owned",clientSecret:"pi_owned_secret_fixture"});
  mockReceipt.mockResolvedValue({purchaseId:id(4),ledgerId:id(5),recorded:true});
  mockActivate.mockResolvedValue({status:"activated_held"});mockUnprepared.mockResolvedValue({status:"prepared_or_uncertain"});
  mockStop.mockResolvedValue({status:"reconciliation_required"});
});
afterEach(()=>{process.env=oldEnv;});
test.each([{kind:"prepare"},{kind:"card",paymentMethodId:"pm_new"},
  {kind:"card_replacement",paymentMethodId:"pm_next",previousOperationId:id(3)},
  {kind:"token",tokenId:"ctoken_new"},{kind:"replacement",tokenId:"ctoken_next",previousOperationId:id(3)}])(
  "maintenance pauses $kind before context, saved selection, or provider work",async a=>{
    process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED="true";
    const r=await call(a);expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({status:"admission_paused",canSwitchPaymentMode:false,accessGranted:false});
    for(const mock of [mockObserve,mockRead,mockPrepare,mockConfirm,mockAuthenticate,mockUnprepared,mockStop,mockReceipt,mockActivate])
      expect(mock).not.toHaveBeenCalled();
  });
test("explicitly unpaused admission preserves existing preparation",async()=>{
  process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED="false";
  expect((await call({kind:"prepare"})).status).toBe(200);expect(mockPrepare).toHaveBeenCalledWith(original);
});
test.each([{kind:"observe"},{kind:"after_authentication",previousOperationId:id(3)}])(
  "maintenance keeps $kind bound to the authenticated owner's original",async a=>{
    process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED="true";
    expect((await call(a)).status).toBe(200);expect(mockConfirm).toHaveBeenCalledWith({...original,action:a});
    expect(mockPrepare).not.toHaveBeenCalled();
  });
test("maintenance preserves original bank verification and verified Stop",async()=>{
  process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED="true";
  const r=await call({kind:"authenticate",operationId:id(3)});expect(r.status).toBe(200);
  expect(mockAuthenticate).toHaveBeenCalledWith({...original,operationId:id(3)});
  expect(await r.json()).toMatchObject({operationId:id(3),paymentIntentId:"pi_owned",clientSecret:"pi_owned_secret_fixture"});
  mockStop.mockResolvedValue({status:"released",releasedAt:"2026-09-23T00:00:00Z"});
  expect((await (await call({kind:"stop"})).json()).canSwitchPaymentMode).toBe(true);
  expect(mockStop).toHaveBeenCalledWith({...original,requestStop:true});expect(mockPrepare).not.toHaveBeenCalled();
});
test("maintenance observes and accounts a prior capture before enabled activation",async()=>{
  process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED="true";
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_READY="true";
  mockConfirm.mockResolvedValue({status:"observed",operationId:id(3),observation:{status:"succeeded"}});
  expect(await (await call({kind:"observe"})).json()).toMatchObject({status:"payment_accounted",purchaseId:id(4),activationStatus:"activated_held"});
  expect(mockReceipt).toHaveBeenCalledWith(original);expect(mockActivate).toHaveBeenCalledWith(original);
  expect(mockReceipt.mock.invocationCallOrder[0]).toBeLessThan(mockActivate.mock.invocationCallOrder[0]);
  expect(mockPrepare).not.toHaveBeenCalled();
});
test.each(["true","false"])("replacement availability respects maintenance pause %s",async paused=>{
  process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED=paused;
  mockConfirm.mockResolvedValue({status:"observed",operationId:id(3),observation:{status:"requires_payment_method",failure:{chargeId:"ch_failed"}}});
  expect((await (await call({kind:"observe"})).json()).replacementAllowed).toBe(paused!=="true");
});
test.each(["signed out","disabled","missing","origin","stale","invalid action"])(
  "maintenance does not bypass %s recovery validation",async issue=>{
    process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED="true";
    if(issue==="signed out")mockAuth.mockResolvedValue(null);
    if(issue==="disabled")process.env.CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_ACTIONS_READY="false";
    if(issue==="missing")mockRead.mockResolvedValue(null);
    if(issue==="stale")mockFresh.mockImplementation(()=>{throw Error();});
    const a={kind:"observe",...(issue==="invalid action"?{buyerId:id(99)}:{})};
    const r=await POST(request(a,issue==="origin"?"https://other.example":context.siteOrigin),{params:Promise.resolve({requestId:id(1)})});
    expect(r.status).toBeGreaterThanOrEqual(400);
    for(const mock of [mockPrepare,mockConfirm,mockAuthenticate,mockStop,mockReceipt,mockActivate])expect(mock).not.toHaveBeenCalled();
  });
test("maintenance retains the bank-verification gate and rejects a mismatched capability",async()=>{
  process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED="true";
  process.env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_ACTIONS_READY="false";
  expect((await call({kind:"authenticate",operationId:id(3)})).status).toBe(409);expect(mockAuthenticate).not.toHaveBeenCalled();
  process.env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_ACTIONS_READY="true";
  mockAuthenticate.mockResolvedValue({status:"authentication_required",operationId:id(99),paymentIntentId:"pi_wrong",clientSecret:"private_wrong"});
  const r=await call({kind:"authenticate",operationId:id(3)});expect(r.status).toBe(409);
  expect(JSON.stringify(await r.json())).not.toContain("private_wrong");
});
test("prepare uses owner reservation and exposes only its first payment amount",async()=>{
  const r=await call({kind:"prepare"});expect(r.status).toBe(200);expect(mockPrepare).toHaveBeenCalledWith(original);
  expect(mockRead.mock.calls[0][0]).toMatchObject(original);
  expect(await r.json()).toEqual({requestId:id(1),status:"payment_prepared",amountCents:3333,currency:"usd",canSwitchPaymentMode:false,accessGranted:false});
});
test.each(["not_enabled","checkout_unpublished","busy","reconciliation_required"])("preparation %s cannot be published",async status=>{
  mockPrepare.mockResolvedValue({status});expect((await call({kind:"prepare"})).status).toBe(409);
});
test.each([{kind:"token",tokenId:"ctoken_original"},{kind:"replacement",tokenId:"ctoken_next",previousOperationId:id(3)},
  {kind:"after_authentication",previousOperationId:id(3)},{kind:"observe"}])("$kind retains original identity and delegates confirmation",async action=>{
  const r=await call(action);expect(r.status).toBe(200);expect(mockConfirm).toHaveBeenCalledWith({...original,action});
  expect(mockPrepare).not.toHaveBeenCalled();expect(mockReceipt).not.toHaveBeenCalled();expect(mockActivate).not.toHaveBeenCalled();
  expect((await r.json()).paymentIntentId).toBeUndefined();
});
test("succeeded observations account the original first payment before optional activation",async()=>{
  mockConfirm.mockResolvedValue({status:"observed",operationId:id(3),observation:{status:"succeeded"}});
  let r=await call({kind:"observe"});expect(await r.json()).toMatchObject({status:"payment_accounted",activationStatus:"pending"});
  expect(mockReceipt).toHaveBeenCalledWith(original);expect(mockActivate).not.toHaveBeenCalled();
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_READY="true";
  r=await call({kind:"observe"});expect(await r.json()).toMatchObject({status:"payment_accounted",activationStatus:"activated_held"});
  expect(mockActivate).toHaveBeenCalledWith(original);expect(mockReceipt.mock.invocationCallOrder[1]).toBeLessThan(mockActivate.mock.invocationCallOrder[0]);
});
test.each(["receipt","activation"])("uncertain %s stays review without automatic payment retry",async stage=>{
  mockConfirm.mockResolvedValue({status:"observed",operationId:id(3),observation:{status:"succeeded"}});
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_READY="true";
  if(stage==="receipt")mockReceipt.mockRejectedValue(Error("private"));else mockActivate.mockResolvedValue({status:"review_required"});
  const r=await call({kind:"observe"});expect(r.status).toBe(409);expect(JSON.stringify(await r.json())).not.toContain("private");
  expect(mockPrepare).not.toHaveBeenCalled();expect(mockConfirm).toHaveBeenCalledTimes(1);
  if(stage==="receipt")expect(mockActivate).not.toHaveBeenCalled();
});
test.each([true,false])("independent failure evidence determines replacement availability: %s",async proved=>{
  mockConfirm.mockResolvedValue({status:"observed",operationId:id(3),observation:{status:"requires_payment_method",...(proved?{failure:{chargeId:"ch_failed"}}:{})}});
  const b=await (await call({kind:"observe"})).json();expect(b.replacementAllowed).toBe(proved);expect(b.canSwitchPaymentMode).toBe(false);
});
test("bank challenge capability remains behind its specific publication gate",async()=>{
  let r=await call({kind:"authenticate",operationId:id(3)});expect(r.status).toBe(200);expect(mockAuthenticate).toHaveBeenCalledWith({...original,operationId:id(3)});
  expect(r.headers.get("cache-control")).toBe("private, no-store");expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  process.env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_ACTIONS_READY="false";mockAuthenticate.mockClear();
  r=await call({kind:"authenticate",operationId:id(3)});expect(r.status).toBe(409);expect(mockAuthenticate).not.toHaveBeenCalled();
});
test("unprepared stop reuses nonpayable release and never creates provider preparation",async()=>{
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_READY="true";
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_NONPAYABLE_RELEASE_READY="true";
  mockUnprepared.mockResolvedValue({status:"released",releasedAt:"2026-09-23T00:00:00Z"});
  expect((await (await call({kind:"stop"})).json()).canSwitchPaymentMode).toBe(true);
  expect(mockUnprepared).toHaveBeenCalledWith({...original,includeNonpayablePreparation:true});
  expect(mockStop).not.toHaveBeenCalled();expect(mockPrepare).not.toHaveBeenCalled();
});
test("uncertain preparation proceeds only to original terminal stop, never to replacement",async()=>{
  process.env.CREATOR_MENTORSHIP_INSTALLMENT_UNPREPARED_RELEASE_READY="true";
  let r=await call({kind:"stop"});expect(r.status).toBe(409);expect((await r.json()).canSwitchPaymentMode).toBe(false);
  expect(mockStop).toHaveBeenCalledWith({...original,requestStop:true});
  mockStop.mockResolvedValue({status:"released",releasedAt:"2026-09-23T00:00:00Z",proof:{private:true}});
  r=await call({kind:"stop"});const b=await r.json();expect(b.canSwitchPaymentMode).toBe(true);expect(b.proof).toBeUndefined();
});
test.each(["prepare","stop","observe"])("archived selection handles %s without touching provider or newer selection",async kind=>{
  mockRead.mockResolvedValue({...saved(),releasedAt:"2026-09-23T00:00:00Z"});
  const r=await call({kind});expect(r.status).toBe(kind==="stop"?200:409);expect((await r.json()).status).toBe("released");
  expect(mockPrepare).not.toHaveBeenCalled();expect(mockConfirm).not.toHaveBeenCalled();expect(mockStop).not.toHaveBeenCalled();
});
test.each([{kind:"token",tokenId:"pm_wrong"},{kind:"prepare",buyerId:id(9)},{kind:"prepare",invoiceId:"in_wrong"},
  {kind:"replacement",tokenId:"ctoken_next"},{kind:"authenticate",operationId:"bad"},{kind:"pay_later"},null,[]])("invalid %j never resolves or dispatches",async body=>{
  expect((await call(body)).status).toBe(400);expect(mockRead).not.toHaveBeenCalled();expect(mockPrepare).not.toHaveBeenCalled();expect(mockConfirm).not.toHaveBeenCalled();
});
test.each(["signed out","disabled","missing","origin","query","content type","stale"])("%s prevents all provider actions",async issue=>{
  if(issue==="signed out")mockAuth.mockResolvedValue(null);
  if(issue==="disabled")process.env.CREATOR_MENTORSHIP_INSTALLMENT_MANUAL_ACTIONS_READY="false";
  if(issue==="missing")mockRead.mockResolvedValue(null);
  if(issue==="stale")mockFresh.mockImplementation(()=>{throw Error();});
  const r=await POST(request({kind:"prepare"},issue==="origin"?"https://other.example":context.siteOrigin,issue==="query"?"?buyer=other":"",
    issue==="content type"?"text/plain":"application/json"),{params:Promise.resolve({requestId:id(1)})});
  expect(r.status).toBeGreaterThanOrEqual(400);expect(mockPrepare).not.toHaveBeenCalled();expect(mockConfirm).not.toHaveBeenCalled();
});
