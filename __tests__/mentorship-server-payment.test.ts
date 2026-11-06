import {buyerBootstrapFixture} from "../test-support/buyer-mentorship-bootstrap-fixture";
import {createMockClient} from "./__mocks__/supabaseQueryMock";
import {SERVER_PAYMENT_PROTOCOL,serverPaymentCreateRequest} from "../lib/serverPaymentConfirmation";
const mockObserve=jest.fn(),mockRead=jest.fn(),mockBootstrap=jest.fn(),mockPrepare=jest.fn();
const mockConfirm=jest.fn(),mockAuthenticate=jest.fn(),mockCancel=jest.fn();
const mockCustomer=jest.fn(),mockSubscription=jest.fn(),mockDestination=jest.fn();
let mockFixture:ReturnType<typeof buyerBootstrapFixture>,mockPin:any,mockSaved:any,mockOps:any[],mockConfig:any;
const mockDb=createMockClient(op=>{
  if(op.table==="server_payment_protocols_v1")return {data:mockPin,error:null};
  if(op.table==="read_server_payment_intent_v1")return {data:mockSaved,error:null};
  if(op.table==="request_server_payment_stop_v1")return {data:{attemptId:mockFixture.reservation.attemptId,releaseAllowed:false},error:null};
  if(op.table==="buyer_mentorship_bootstraps_v1")return {data:{reservation_id:mockFixture.reservation.id,
    customer_id:mockFixture.customer.id,anchor_seconds:mockFixture.dependencies.anchorSeconds},error:null};
  if(op.table==="buyer_mentorship_bootstrap_operations_v1")return {data:mockOps,error:null};
  throw Error("Unexpected database operation");
});
jest.mock("stripe",()=>({__esModule:true,default:function(){return {customers:{retrieve:mockCustomer},
  subscriptions:{retrieve:mockSubscription},accounts:{retrieve:mockDestination}};}}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>mockDb}));
jest.mock("../lib/installments/contextServer",()=>({exactContextServerConfig:()=>mockConfig}));
jest.mock("../lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve})}));
jest.mock("../lib/mentorshipInstallmentReservation",()=>({readBuyerMentorshipBootstrapReservation:(...args:unknown[])=>mockRead(...args)}));
jest.mock("../lib/mentorshipInstallmentBootstrap",()=>({prepareBuyerMentorshipBootstrap:(...args:unknown[])=>mockBootstrap(...args)}));
jest.mock("../lib/serverPaymentIntent",()=>({prepareServerPaymentIntent:(...args:unknown[])=>mockPrepare(...args)}));
jest.mock("../lib/serverPaymentStop",()=>({stopServerPaymentIntent:(...args:unknown[])=>mockCancel(...args)}));
jest.mock("../lib/serverPaymentConfirmationStore",()=>({runServerPaymentConfirmation:(...args:unknown[])=>mockConfirm(...args),
  getServerPaymentAuthentication:(...args:unknown[])=>mockAuthenticate(...args)}));
import {prepareBuyerMentorshipServerPayment,confirmBuyerMentorshipServerPayment,authenticateBuyerMentorshipServerPayment,stopBuyerMentorshipServerPayment} from "../lib/mentorshipServerPayment";
const env={CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY:"true",CREATOR_SERVER_PAYMENT_INTENT_READY:"true"};
const args=()=>({buyerId:mockFixture.reservation.buyerId,requestId:mockFixture.reservation.requestId,env});
beforeEach(()=>{
  jest.resetAllMocks();mockDb.ops.length=0;mockFixture=buyerBootstrapFixture();mockPin=null;mockSaved=null;
  jest.useFakeTimers({now:mockFixture.nowSeconds*1000});
  mockConfig={approvedContext:mockFixture.context,configuredSupabaseUrl:mockFixture.contextEvidence.configuredSupabaseUrl,
    supabaseServiceKey:"fixture",stripeSecretKey:"sk_test_fixture"};
  mockOps=["product.create","subscription.create","subscription.hold"].map(step=>({step,reservation_id:mockFixture.reservation.id,
    result_id:step==="product.create"?"prod_owned":"sub_owned",bound_at:new Date().toISOString(),lease_until:null}));
  mockRead.mockResolvedValue(mockFixture.reservation);mockObserve.mockResolvedValue({contextEvidence:mockFixture.contextEvidence});
  mockCustomer.mockResolvedValue(mockFixture.customer);mockSubscription.mockResolvedValue(mockFixture.subscription);
  mockDestination.mockResolvedValue({id:"acct_creator",charges_enabled:true,payouts_enabled:true,capabilities:{transfers:"active"}});
  mockBootstrap.mockResolvedValue({status:"held_unpublished",subscriptionId:"sub_owned"});
  mockPrepare.mockImplementation(async a=>{await a.assertProviderSource();return {status:"bound_unpublished",paymentIntentId:"pi_owned"};});
});
afterEach(()=>{jest.useRealTimers();});
function pin(){const r=mockFixture.reservation;mockPin={attempt_id:r.attemptId,buyer_id:r.buyerId,product_id:r.productId,reservation_id:r.id,
  kind:"first_installment",protocol:SERVER_PAYMENT_PROTOCOL,context:mockFixture.context};}
test("composition derives first-payment terms from saved acceptance, rechecks held provider state, and delegates exact original intent",async()=>{
  expect(await prepareBuyerMentorshipServerPayment(args())).toEqual({status:"bound_unpublished",paymentIntentId:"pi_owned"});
  expect(mockBootstrap).toHaveBeenCalledWith({...args(),serverControlledFirstPayment:true});
  const c=mockPrepare.mock.calls[0][0].contract;
  expect(c).toMatchObject({kind:"first_installment",amountCents:3333,customerId:"cus_owned",destinationId:"acct_creator",
    expiresAt:mockFixture.dependencies.anchorSeconds+86400-1860,termsFingerprint:mockFixture.reservation.fingerprint,
    sourceMetadata:{operation_kind:"payment_intent.create",installment_subscription_id:"sub_owned",installment_number:"1"}});
  expect(serverPaymentCreateRequest(c,mockFixture.contextEvidence).params.confirm).toBe(false);
  expect(mockDb.opsFor("server_payment_protocols_v1")[0].filters).toEqual({attempt_id:mockFixture.reservation.attemptId,buyer_id:args().buyerId});
  expect(mockCustomer).toHaveBeenCalledWith("cus_owned");expect(mockSubscription).toHaveBeenCalledWith("sub_owned");
  expect(mockDestination).toHaveBeenCalledWith("acct_creator");
});
test("bound recovery uses the saved contract and skips new bootstrap/source preparation after expiry",async()=>{
  await prepareBuyerMentorshipServerPayment(args());const c=mockPrepare.mock.calls[0][0].contract;
  mockBootstrap.mockClear();mockCustomer.mockClear();mockSaved={contract:c};pin();jest.setSystemTime((c.expiresAt+3600)*1000);
  mockPrepare.mockImplementation(async a=>{expect(a.contract).toEqual(c);return {status:"bound_unpublished",paymentIntentId:"pi_owned"};});
  expect(await prepareBuyerMentorshipServerPayment({...args(),env:{...env,CREATOR_SERVER_PAYMENT_INTENT_READY:"false"}}))
    .toMatchObject({status:"bound_unpublished"});
  expect(mockBootstrap).not.toHaveBeenCalled();expect(mockCustomer).not.toHaveBeenCalled();
});
test.each(["schema","creation"])("disabled %s gate creates nothing",async gate=>{
  expect(await prepareBuyerMentorshipServerPayment({...args(),env:{...env,
    [gate==="schema"?"CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY":"CREATOR_SERVER_PAYMENT_INTENT_READY"]:"false"}})).toEqual({status:"not_enabled"});
  expect(mockBootstrap).not.toHaveBeenCalled();expect(mockPrepare).not.toHaveBeenCalled();
});
test.each(["busy","partial_preparation","review_required"])("bootstrap %s does not become intent creation",async status=>{
  mockBootstrap.mockResolvedValue({status});expect(await prepareBuyerMentorshipServerPayment(args())).toEqual({status});
  expect(mockPrepare).not.toHaveBeenCalled();
});
test.each(["foreign pin","hosted bootstrap","unknown checkout","active hold","changed subscription","missing hold","foreign saved contract",
  "unheld subscription","wrong customer","disabled destination","released acceptance"])("%s refuses preparation",async issue=>{
  if(issue==="foreign pin"){pin();mockPin.buyer_id=mockFixture.reservation.terms.creatorId;}
  if(issue==="hosted bootstrap")mockBootstrap.mockResolvedValue({status:"checkout_unpublished",sessionId:"cs_test_old"});
  if(issue==="unknown checkout")mockOps.push({step:"checkout.create",result_id:null});
  if(issue==="active hold")mockOps[2].lease_until=new Date(Date.now()+10000).toISOString();
  if(issue==="changed subscription")mockOps[2].result_id="sub_other";
  if(issue==="missing hold")mockOps.pop();
  if(issue==="foreign saved contract"){pin();mockSaved={contract:{buyerId:mockFixture.reservation.terms.creatorId}};}
  if(issue==="unheld subscription")mockFixture.subscription.pause_collection=null;
  if(issue==="wrong customer")mockFixture.customer.id="cus_other";
  if(issue==="disabled destination")mockDestination.mockResolvedValue({id:"acct_creator",charges_enabled:false});
  if(issue==="released acceptance")mockRead.mockResolvedValueOnce(mockFixture.reservation).mockResolvedValueOnce(null);
  await expect(prepareBuyerMentorshipServerPayment(args())).rejects.toThrow("Mentorship server payment requires review");
});
test("confirmation composition loads the existing bound original and reuses fresh provider source validation",async()=>{
  await prepareBuyerMentorshipServerPayment(args());const c=mockPrepare.mock.calls[0][0].contract;pin();
  mockSaved={contract:c,bound_at:new Date().toISOString(),payment_intent_id:"pi_owned",first_dispatch_at:new Date().toISOString()};
  mockBootstrap.mockClear();mockPrepare.mockClear();
  mockConfirm.mockImplementation(async a=>{await a.assertProviderSource();return {status:"observed",observation:{status:"requires_action"}};});
  const action={kind:"token" as const,tokenId:"ctoken_owned"};
  expect(await confirmBuyerMentorshipServerPayment({...args(),action,env:{...env,CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY:"true"}}))
    .toMatchObject({status:"observed",observation:{status:"requires_action"}});
  expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({contract:c,action,binding:{paymentIntentId:"pi_owned",firstDispatchAt:mockFixture.nowSeconds}}));
  expect(mockBootstrap).not.toHaveBeenCalled();expect(mockPrepare).not.toHaveBeenCalled();
});
test("confirmation cannot manufacture missing intent preparation",async()=>{
  await expect(confirmBuyerMentorshipServerPayment({...args(),action:{kind:"token",tokenId:"ctoken_owned"},
    env:{...env,CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY:"true"}})).rejects.toThrow("requires review");
  expect(mockBootstrap).not.toHaveBeenCalled();expect(mockPrepare).not.toHaveBeenCalled();expect(mockConfirm).not.toHaveBeenCalled();
});

test.each(["matching","foreign intent","foreign customer","foreign mode","dispatch action"])("signed lifecycle %s stays bound to the original",async issue=>{
  await prepareBuyerMentorshipServerPayment(args());const c=mockPrepare.mock.calls[0][0].contract;pin();
  mockSaved={contract:c,bound_at:new Date().toISOString(),payment_intent_id:"pi_owned",first_dispatch_at:new Date().toISOString()};
  mockBootstrap.mockClear();mockPrepare.mockClear();
  const expectedEvent={paymentIntentId:issue==="foreign intent"?"pi_other":"pi_owned",customerId:issue==="foreign customer"?"cus_other":c.customerId,livemode:issue==="foreign mode"};
  const action=issue==="dispatch action"?{kind:"token" as const,tokenId:"ctoken_owned"}:{kind:"observe" as const};
  mockConfirm.mockResolvedValue({status:"observed"});
  const run=confirmBuyerMentorshipServerPayment({...args(),action,expectedEvent,env:{...env,CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY:"true"}});
  if(issue==="matching"){expect(await run).toMatchObject({status:"observed"});expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({action:{kind:"observe"}}));}
  else {await expect(run).rejects.toThrow();expect(mockConfirm).not.toHaveBeenCalled();}
  expect(mockBootstrap).not.toHaveBeenCalled();expect(mockPrepare).not.toHaveBeenCalled();expect(mockAuthenticate).not.toHaveBeenCalled();expect(mockCancel).not.toHaveBeenCalled();
});

test("authentication composition uses only the buyer's bound intent and fresh original source",async()=>{
  await prepareBuyerMentorshipServerPayment(args());const c=mockPrepare.mock.calls[0][0].contract;pin();
  mockSaved={contract:c,bound_at:new Date().toISOString(),payment_intent_id:"pi_owned",first_dispatch_at:new Date().toISOString()};
  mockBootstrap.mockClear();mockPrepare.mockClear();
  mockAuthenticate.mockImplementation(async a=>{await a.assertProviderSource();return {status:"authentication_required",operationId:a.operationId,clientSecret:"synthetic"};});
  const operationId=mockFixture.reservation.requestId;
  expect(await authenticateBuyerMentorshipServerPayment({...args(),operationId,env:{...env,CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY:"true"}}))
    .toMatchObject({status:"authentication_required",operationId});
  expect(mockAuthenticate).toHaveBeenCalledWith(expect.objectContaining({contract:c,operationId,binding:{paymentIntentId:"pi_owned",firstDispatchAt:mockFixture.nowSeconds}}));
  expect(mockBootstrap).not.toHaveBeenCalled();expect(mockPrepare).not.toHaveBeenCalled();expect(mockConfirm).not.toHaveBeenCalled();
});
test("authentication cannot bootstrap a missing original",async()=>{
  await expect(authenticateBuyerMentorshipServerPayment({...args(),operationId:mockFixture.reservation.requestId,
    env:{...env,CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY:"true"}})).rejects.toThrow();
  expect(mockBootstrap).not.toHaveBeenCalled();expect(mockPrepare).not.toHaveBeenCalled();expect(mockAuthenticate).not.toHaveBeenCalled();
});

test.each(["absent","unbound","bound"])("manual stop persists admission hold for %s original without preparing anything",async state=>{
  await prepareBuyerMentorshipServerPayment(args());const c=mockPrepare.mock.calls[0][0].contract;pin();
  mockSaved=state==="absent"?null:{contract:c,bound_at:state==="bound"?new Date().toISOString():null,
    payment_intent_id:state==="bound"?"pi_owned":null,first_dispatch_at:new Date().toISOString()};
  mockBootstrap.mockClear();mockPrepare.mockClear();mockCustomer.mockClear();
  mockCancel.mockResolvedValue({status:"intent_canceled_unreleased",releaseAllowed:false});
  expect(await stopBuyerMentorshipServerPayment({...args(),env:{...env,CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY:"true",
    CREATOR_SERVER_PAYMENT_CANCELLATION_READY:"true"}})).toMatchObject({status:state==="bound"?"intent_canceled_unreleased":"reconciliation_required",releaseAllowed:false});
  expect(mockDb.opsFor("request_server_payment_stop_v1")).toHaveLength(1);
  expect(mockCancel).toHaveBeenCalledTimes(state==="bound"?1:0);
  expect(mockBootstrap).not.toHaveBeenCalled();expect(mockPrepare).not.toHaveBeenCalled();expect(mockCustomer).not.toHaveBeenCalled();
});
