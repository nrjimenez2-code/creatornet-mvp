import {NextRequest} from "next/server";
import {createMockClient} from "./__mocks__/supabaseQueryMock";
const mockAuth=jest.fn(),mockRead=jest.fn(),mockPlan=jest.fn(),mockAccept=jest.fn(),mockObserve=jest.fn(),mockFresh=jest.fn();
const mockPrepare=jest.fn(),mockConfirm=jest.fn(),mockAuthenticate=jest.fn(),mockRelease=jest.fn(),mockAccount=jest.fn();
const mockUnreserved=jest.fn();
const mockFind=jest.fn();
let mockProduct:any,mockArchive:any;
const mockDb=createMockClient(op=>({data:op.table==="products"?mockProduct:
  ["product_checkout_releases_v1","read_full_manual_release_v1"].includes(op.table)?mockArchive:{id:id(5),product_id:id(4),creator_id:id(3)},error:null}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>mockDb}));
jest.mock("../lib/supabaseConnectAuth",()=>({getAuthenticatedUser:()=>mockAuth()}));
jest.mock("../lib/installments/contextServer",()=>({exactContextServerConfig:()=>({approvedContext:context,
  configuredSupabaseUrl:`https://${context.supabaseProjectRef}.supabase.co`,supabaseServiceKey:"fixture"})}));
jest.mock("../lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve}),
  assertFreshExactRuntimeContextObservation:(v:unknown)=>mockFresh(v)}));
jest.mock("../lib/fullManualCheckoutRequest",()=>({readFullManualCheckoutRequest:(...a:unknown[])=>mockRead(...a),
  findFullManualCheckoutRequest:(...a:unknown[])=>mockFind(...a),
  releaseUnreservedFullManualCheckout:(...a:unknown[])=>mockUnreserved(...a),
  planFullManualCheckoutRequest:(...a:unknown[])=>mockPlan(...a),acceptSavedFullManualCheckout:(...a:unknown[])=>mockAccept(...a)}));
jest.mock("../lib/fullServerPayment",()=>({prepareFullServerPayment:(...a:unknown[])=>mockPrepare(...a),confirmFullServerPayment:(...a:unknown[])=>mockConfirm(...a),
  authenticateFullServerPayment:(...a:unknown[])=>mockAuthenticate(...a)}));
jest.mock("../lib/fullServerPaymentRelease",()=>({releaseFullServerPayment:(...a:unknown[])=>mockRelease(...a)}));
jest.mock("../lib/fullServerPaymentReadback",()=>({accountFullServerPayment:(...a:unknown[])=>mockAccount(...a)}));
import {POST,GET} from "../app/api/checkout/manual/route";
import {POST as ACTION} from "../app/api/checkout/manual/[requestId]/route";
import {productPurchaseTerms} from "../lib/purchaseConsent";
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1",mode:"test",platformAccountId:"acct_owned",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const product={id:id(4),creator_id:id(3),type:"mentorship",title:"Mentorship",amount_cents:10001,currency:"usd",active:true};
const quote=productPurchaseTerms(product,id(2),id(5));
const saved=()=>({requestId:id(1),buyerId:id(2),productId:id(4),postId:id(5),attemptId:id(10),attemptKey:id(11),orderId:id(12),terms:quote.terms,fingerprint:quote.fingerprint});
const body=()=>({request_id:id(1),product_id:id(4),post_id:id(5),acceptance:{accepted:true,version:quote.terms.version,fingerprint:quote.fingerprint}});
const request=(b:unknown,path="",origin=context.siteOrigin)=>new NextRequest(context.siteOrigin+"/api/checkout/manual"+path,{method:"POST",headers:{"Content-Type":"application/json",Origin:origin},body:JSON.stringify(b)});
const action=(b:unknown,path="")=>ACTION(request(b,path),{params:Promise.resolve({requestId:id(1)})});
const original={buyerId:id(2),attemptId:id(10),attemptKey:id(11)};
let oldEnv:NodeJS.ProcessEnv;
beforeEach(()=>{
  oldEnv={...process.env};jest.resetAllMocks();mockDb.ops.length=0;mockProduct={...product};mockArchive=null;
  delete process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED;
  process.env.CREATOR_FULL_SERVER_PAYMENT_RELEASE_SCHEMA_READY="false";
  for(const name of ["CREATOR_FULL_MANUAL_CHECKOUT_REQUESTS_SCHEMA_READY","CREATOR_FULL_MANUAL_CHECKOUT_ACCEPTANCE_READY","CREATOR_FULL_MANUAL_CHECKOUT_ACTIONS_READY",
    "CREATOR_FULL_SERVER_PAYMENT_ACCEPTANCE_READY","CREATOR_SERVER_PAYMENT_PROTOCOL_SCHEMA_READY","CREATOR_FULL_SERVER_PAYMENT_SOURCE_SCHEMA_READY",
    "CREATOR_SERVER_PAYMENT_AUTHENTICATION_ACTIONS_READY",
    "CREATOR_PROCESSING_FEE_ENABLED","CREATOR_PURCHASE_CONSENT_SCHEMA_READY","CREATOR_PURCHASE_POLICIES_READY","CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED"])
    process.env[name]="true";
  process.env.STRIPE_PROCESSING_FEE_BPS="290";process.env.STRIPE_PROCESSING_FEE_FIXED_CENTS="30";process.env.STRIPE_PROCESSING_FEE_SCHEDULE_VERSION="fees-v1";
  mockAuth.mockResolvedValue({id:id(2)});mockObserve.mockResolvedValue({contextEvidence:{}});
  mockRead.mockResolvedValue(saved());mockPlan.mockResolvedValue(saved());mockAccept.mockResolvedValue(saved());
  mockPrepare.mockResolvedValue({status:"bound_unpublished",paymentIntentId:"pi_private"});
  mockConfirm.mockResolvedValue({status:"observed",operationId:id(20),observation:{status:"processing",paymentIntentId:"pi_private"}});
  mockAccount.mockResolvedValue({status:"original_capture_accounted",purchaseId:id(30)});
  mockAuthenticate.mockResolvedValue({status:"authentication_required",operationId:id(20),paymentIntentId:"pi_owned",clientSecret:"pi_owned_secret_test"});
  mockRelease.mockResolvedValue({status:"released",releasedAt:"2026-09-23T00:00:00Z"});
});
afterEach(()=>{process.env=oldEnv;});
test.each([{kind:"prepare"},{kind:"card",paymentMethodId:"pm_new"},
  {kind:"card_replacement",paymentMethodId:"pm_next",previousOperationId:id(20)},
  {kind:"token",tokenId:"ctoken_new"},{kind:"replacement",tokenId:"ctoken_next",previousOperationId:id(20)}])(
  "maintenance pauses $kind before context, saved selection, or provider work",async a=>{
    process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED="true";
    const r=await action(a);expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({status:"admission_paused",canSwitchPaymentMode:false,accessGranted:false});
    for(const mock of [mockObserve,mockRead,mockAccept,mockPrepare,mockConfirm,mockAuthenticate,mockRelease,mockAccount])
      expect(mock).not.toHaveBeenCalled();
  });
test("explicitly unpaused admission preserves existing preparation",async()=>{
  process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED="false";
  expect((await action({kind:"prepare"})).status).toBe(200);expect(mockPrepare).toHaveBeenCalledWith(original);
});
test.each([{kind:"observe"},{kind:"after_authentication",previousOperationId:id(20)}])(
  "maintenance keeps $kind bound to the authenticated owner's original",async a=>{
    process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED="true";
    expect((await action(a)).status).toBe(200);expect(mockConfirm).toHaveBeenCalledWith({...original,action:a});
    expect(mockAccept).not.toHaveBeenCalled();expect(mockPrepare).not.toHaveBeenCalled();
  });
test("maintenance preserves original bank verification and verified Stop",async()=>{
  process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED="true";
  const r=await action({kind:"authenticate",operationId:id(20)});expect(r.status).toBe(200);
  expect(mockAuthenticate).toHaveBeenCalledWith({...original,operationId:id(20)});
  expect(await r.json()).toMatchObject({operationId:id(20),paymentIntentId:"pi_owned",clientSecret:"pi_owned_secret_test"});
  expect((await (await action({kind:"stop"})).json()).canSwitchPaymentMode).toBe(true);
  expect(mockRelease).toHaveBeenCalledWith(original);expect(mockPrepare).not.toHaveBeenCalled();
});
test("maintenance observes and accounts a prior capture without new preparation",async()=>{
  process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED="true";
  mockConfirm.mockResolvedValue({status:"observed",operationId:id(20),observation:{status:"succeeded"}});
  expect(await (await action({kind:"observe"})).json()).toMatchObject({status:"payment_accounted",purchaseId:id(30)});
  expect(mockAccount).toHaveBeenCalledWith(original);expect(mockPrepare).not.toHaveBeenCalled();
});
test.each(["true","false"])("replacement availability respects maintenance pause %s",async paused=>{
  process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED=paused;
  mockConfirm.mockResolvedValue({status:"observed",operationId:id(20),observation:{status:"requires_payment_method",failure:{chargeId:"ch_failed"}}});
  expect((await (await action({kind:"observe"})).json()).replacementAllowed).toBe(paused!=="true");
});
test.each(["signed out","wrong origin","actions disabled","missing owner request","stale context","invalid action"])(
  "maintenance does not bypass %s recovery validation",async issue=>{
    process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED="true";
    if(issue==="signed out")mockAuth.mockResolvedValue(null);
    if(issue==="actions disabled")process.env.CREATOR_FULL_MANUAL_CHECKOUT_ACTIONS_READY="false";
    if(issue==="missing owner request")mockRead.mockResolvedValue(null);
    if(issue==="stale context")mockFresh.mockImplementation(()=>{throw Error();});
    const a={kind:"observe",...(issue==="invalid action"?{buyerId:id(99)}:{})};
    const r=await ACTION(request(a,"",issue==="wrong origin"?"https://other.example":context.siteOrigin),{params:Promise.resolve({requestId:id(1)})});
    expect(r.status).toBeGreaterThanOrEqual(400);
    for(const mock of [mockPrepare,mockConfirm,mockAuthenticate,mockRelease,mockAccount])expect(mock).not.toHaveBeenCalled();
  });
test("maintenance retains the bank-verification gate and rejects a mismatched capability",async()=>{
  process.env.CREATOR_MANUAL_PAYMENT_ADMISSION_PAUSED="true";
  process.env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_ACTIONS_READY="false";
  expect((await action({kind:"authenticate",operationId:id(20)})).status).toBe(409);expect(mockAuthenticate).not.toHaveBeenCalled();
  process.env.CREATOR_SERVER_PAYMENT_AUTHENTICATION_ACTIONS_READY="true";
  mockAuthenticate.mockResolvedValue({status:"authentication_required",operationId:id(99),paymentIntentId:"pi_wrong",clientSecret:"private_wrong"});
  const r=await action({kind:"authenticate",operationId:id(20)});expect(r.status).toBe(409);
  expect(JSON.stringify(await r.json())).not.toContain("private_wrong");
});
test("saved acceptance precedes catalog reads and retains original owner identities",async()=>{
  mockProduct=null;const r=await POST(request(body()));expect(r.status).toBe(200);
  expect(mockDb.ops).toHaveLength(0);expect(mockPlan).not.toHaveBeenCalled();
  expect(mockAccept.mock.calls[0][0]).toMatchObject({buyerId:id(2),requestId:id(1)});
  const b=await r.json();expect(b).toMatchObject({requestId:id(1),providerOperationsAllowed:false});
  expect(b.attemptKey).toBeUndefined();expect(b.orderId).toBeUndefined();expect(r.headers.get("cache-control")).toBe("private, no-store");
});
test("fresh acceptance loads authoritative product and plans once before acceptance",async()=>{
  mockRead.mockResolvedValue(null);const r=await POST(request(body()));expect(r.status).toBe(200);
  expect(mockPlan).toHaveBeenCalledTimes(1);expect(mockPlan.mock.calls[0][0]).toMatchObject({buyerId:id(2),product,postId:id(5),acceptance:body().acceptance});
  expect(mockPlan.mock.invocationCallOrder[0]).toBeLessThan(mockAccept.mock.invocationCallOrder[0]);
});
test("owner GET returns saved terms after new acceptance gates roll back",async()=>{
  process.env.CREATOR_FULL_MANUAL_CHECKOUT_ACCEPTANCE_READY="false";mockProduct=null;
  const r=await GET(new NextRequest(context.siteOrigin+"/api/checkout/manual?request_id="+id(1)));
  expect(r.status).toBe(200);expect(mockDb.ops).toHaveLength(0);expect(mockAccept).not.toHaveBeenCalled();
});
test("lost stop response recovers original release without reaccepting or touching newer selections",async()=>{
  process.env.CREATOR_FULL_SERVER_PAYMENT_RELEASE_SCHEMA_READY="true";
  mockArchive={attempt_id:id(10),buyer_id:id(2),attempt_key:id(11),product_id:id(4),released_at:"2026-09-23T00:00:00Z"};
  const r=await GET(new NextRequest(context.siteOrigin+"/api/checkout/manual?request_id="+id(1)));
  expect(r.status).toBe(200);expect(await r.json()).toMatchObject({status:"released",canSwitchPaymentMode:true,providerOperationsAllowed:false});
  expect(dbScope()).toEqual({attempt_id:id(10),buyer_id:id(2),attempt_key:id(11)});
  expect((await POST(request(body()))).status).toBe(200);expect(mockAccept).not.toHaveBeenCalled();expect(mockRelease).not.toHaveBeenCalled();
});
function dbScope(){return mockDb.opsFor("product_checkout_releases_v1")[0].filters;}
test("product discovery survives new-sales rollback without catalog or provider operations",async()=>{
  process.env.CREATOR_FULL_MANUAL_DISCOVERY_SCHEMA_READY="true";process.env.CREATOR_FULL_MANUAL_CHECKOUT_ACCEPTANCE_READY="false";
  mockFind.mockResolvedValue(saved());mockProduct=null;
  const r=await GET(new NextRequest(context.siteOrigin+"/api/checkout/manual?product_id="+id(4)));
  expect(r.status).toBe(200);expect(await r.json()).toMatchObject({requestId:id(1),productId:id(4),providerOperationsAllowed:false});
  expect(mockFind.mock.calls[0][0]).toMatchObject({buyerId:id(2),productId:id(4)});expect(mockDb.ops).toHaveLength(0);
  expect(mockPlan).not.toHaveBeenCalled();expect(mockPrepare).not.toHaveBeenCalled();expect(mockAccept).not.toHaveBeenCalled();
});
test.each(["disabled","absent","ambiguous"])("%s discovery cannot fabricate a new request",async issue=>{
  process.env.CREATOR_FULL_MANUAL_DISCOVERY_SCHEMA_READY=issue==="disabled"?"false":"true";
  if(issue==="ambiguous")mockFind.mockRejectedValue(Error("private"));else mockFind.mockResolvedValue(null);
  expect((await GET(new NextRequest(context.siteOrigin+"/api/checkout/manual?product_id="+id(4)))).status).toBe(issue==="absent"?404:409);
  expect(mockPlan).not.toHaveBeenCalled();expect(mockAccept).not.toHaveBeenCalled();
});
test.each(["product_id="+id(4)+"&request_id="+id(1),"product_id="+id(4)+"&product_id="+id(4),"buyer_id="+id(2)])("invalid discovery query %s is refused",async q=>{
  expect((await GET(new NextRequest(context.siteOrigin+"/api/checkout/manual?"+q))).status).toBe(400);expect(mockFind).not.toHaveBeenCalled();
});
test("unreserved release bypasses provider stop and saved marker recovers after rollback",async()=>{
  const releasedAt="2026-09-23T00:00:00Z";
  mockUnreserved.mockResolvedValue({...saved(),releasedAt});
  expect(await (await action({kind:"stop"})).json()).toMatchObject({status:"released",releasedAt,canSwitchPaymentMode:true});
  expect(mockRelease).not.toHaveBeenCalled();expect(mockUnreserved.mock.calls[0][0]).toMatchObject({buyerId:id(2),requestId:id(1)});
  mockRead.mockResolvedValue({...saved(),releasedAt});
  expect(await (await GET(new NextRequest(context.siteOrigin+"/api/checkout/manual?request_id="+id(1)))).json()).toMatchObject({status:"released",canSwitchPaymentMode:true});
  expect(await (await POST(request(body()))).json()).toMatchObject({status:"released"});
  expect((await action({kind:"prepare"})).status).toBe(409);
  expect((await action({kind:"token",tokenId:"ctoken_stale"})).status).toBe(409);
  expect(mockAccept).not.toHaveBeenCalled();expect(mockPrepare).not.toHaveBeenCalled();expect(mockConfirm).not.toHaveBeenCalled();
});
test("uncertain no-dispatch release does not fall through to provider stop",async()=>{
  mockUnreserved.mockRejectedValue(Error("lost reply"));expect((await action({kind:"stop"})).status).toBe(409);
  expect(mockRelease).not.toHaveBeenCalled();
});
test("foreign archived result does not permit switching",async()=>{
  process.env.CREATOR_FULL_SERVER_PAYMENT_RELEASE_SCHEMA_READY="true";
  mockArchive={attempt_id:id(99),product_id:id(4),released_at:"2026-09-23T00:00:00Z"};
  expect((await GET(new NextRequest(context.siteOrigin+"/api/checkout/manual?request_id="+id(1)))).status).toBe(409);
});
test.each(["buyer_id","attemptId","orderId","amountCents","processingFees","paymentIntentId"])("acceptance rejects injected %s",async field=>{
  expect((await POST(request({...body(),[field]:id(99)}))).status).toBe(400);expect(mockRead).not.toHaveBeenCalled();
});
test.each(["fingerprint","productId","postId"])("saved %s mismatch never accepts or plans anew",async field=>{
  mockRead.mockResolvedValue({...saved(),[field]:"other"});expect((await POST(request(body()))).status).toBe(409);
  expect(mockAccept).not.toHaveBeenCalled();expect(mockPlan).not.toHaveBeenCalled();
});
test("prepare resolves saved identities and does not expose provider secret/identity",async()=>{
  const r=await action({kind:"prepare"});expect(r.status).toBe(200);expect(mockPrepare).toHaveBeenCalledWith(original);
  expect(await r.json()).toEqual({requestId:id(1),status:"payment_prepared",amountCents:10001,currency:"usd",canSwitchPaymentMode:false,accessGranted:false});
});
test.each([{kind:"token",tokenId:"ctoken_one"},{kind:"replacement",tokenId:"ctoken_next",previousOperationId:id(20)},
  {kind:"after_authentication",previousOperationId:id(20)},{kind:"observe"}])("$kind delegates only the owned original",async a=>{
  const r=await action(a);expect(r.status).toBe(200);expect(mockConfirm).toHaveBeenCalledWith({...original,action:a});
  expect(mockPrepare).not.toHaveBeenCalled();expect(mockAccount).not.toHaveBeenCalled();
  expect((await r.json()).paymentIntentId).toBeUndefined();
});
test("success requires independent original accounting before a paid projection",async()=>{
  mockConfirm.mockResolvedValue({status:"observed",operationId:id(20),observation:{status:"succeeded"}});
  expect((await action({kind:"observe"})).status).toBe(200);expect(mockAccount).toHaveBeenCalledWith(original);
  mockAccount.mockRejectedValue(Error("private"));const r=await action({kind:"observe"});expect(r.status).toBe(409);
  expect(JSON.stringify(await r.json())).not.toContain("private");
});
test("authentication exposes only the requested owner's current challenge capability",async()=>{
  const r=await action({kind:"authenticate",operationId:id(20)});expect(r.status).toBe(200);
  expect(mockAuthenticate).toHaveBeenCalledWith({...original,operationId:id(20)});expect(r.headers.get("referrer-policy")).toBe("no-referrer");
});
test("stop permits switching only after verified terminal release",async()=>{
  expect((await (await action({kind:"stop"})).json()).canSwitchPaymentMode).toBe(true);expect(mockRelease).toHaveBeenCalledWith(original);
  mockRelease.mockResolvedValue({status:"reconciliation_required"});const r=await action({kind:"stop"});expect(r.status).toBe(409);
  expect((await r.json()).canSwitchPaymentMode).toBe(false);
});
test.each([{kind:"token",tokenId:"pm_not_token"},{kind:"token",tokenId:"ctoken_one",buyerId:id(9)},{kind:"prepare",attemptId:id(9)},
  {kind:"replacement",tokenId:"ctoken_one"},{kind:"authenticate",operationId:"bad"},{kind:"unexpected"},null,[]])("invalid action %j dispatches nothing",async b=>{
  expect((await action(b)).status).toBe(400);expect(mockRead).not.toHaveBeenCalled();expect(mockPrepare).not.toHaveBeenCalled();expect(mockConfirm).not.toHaveBeenCalled();
});
test.each(["signed out","wrong origin","actions disabled","missing owner request","stale context"])("%s blocks all payment dispatch",async issue=>{
  if(issue==="signed out")mockAuth.mockResolvedValue(null);
  if(issue==="actions disabled")process.env.CREATOR_FULL_MANUAL_CHECKOUT_ACTIONS_READY="false";
  if(issue==="missing owner request")mockRead.mockResolvedValue(null);
  if(issue==="stale context")mockFresh.mockImplementation(()=>{throw Error();});
  const r=await ACTION(request({kind:"prepare"},"",issue==="wrong origin"?"https://other.example":context.siteOrigin),{params:Promise.resolve({requestId:id(1)})});
  expect(r.status).toBeGreaterThanOrEqual(400);expect(mockPrepare).not.toHaveBeenCalled();expect(mockConfirm).not.toHaveBeenCalled();
});
