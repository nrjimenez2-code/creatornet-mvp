import {createMockClient} from "./__mocks__/supabaseQueryMock";
import {calculateCreatorFees} from "../lib/money";
import {SERVER_PAYMENT_PROTOCOL} from "../lib/serverPaymentConfirmation";
const mockObserve=jest.fn(),mockPrepare=jest.fn(),mockConfirm=jest.fn(),mockAuthenticate=jest.fn(),mockStop=jest.fn(),mockDestination=jest.fn();
let mockSelection:any,mockConsent:any,mockOrder:any,mockProfile:any,mockContract:any,mockOriginal:any;
const mockDb=createMockClient(op=>{
  const data=op.table==="read_server_payment_source_v1"?mockSelection:op.table==="read_full_server_payment_contract_v1"?mockContract:
    op.table==="read_server_payment_intent_v1"?mockOriginal:op.table==="product_purchase_consents_v1"?mockConsent:
    op.table==="orders"?mockOrder:op.table==="profiles"?mockProfile:undefined;
  if(data!==undefined)return {data,error:null};
  if(op.table==="save_full_server_payment_contract_v1"){
    mockContract=JSON.parse(JSON.stringify((op.payload as any).p_contract));return {data:mockContract,error:null};
  }
  if(op.table==="request_server_payment_stop_v1")return {data:{attemptId:id(1),releaseAllowed:false},error:null};
  throw Error("Unexpected source access");
});
jest.mock("stripe",()=>({__esModule:true,default:function(){return {accounts:{retrieve:mockDestination}};}}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>mockDb}));
jest.mock("../lib/installments/contextServer",()=>({exactContextServerConfig:()=>({approvedContext:context,
  configuredSupabaseUrl:`https://${context.supabaseProjectRef}.supabase.co`,supabaseServiceKey:"fixture",stripeSecretKey:"sk_test_fixture"})}));
jest.mock("../lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve})}));
jest.mock("../lib/serverPaymentIntent",()=>({prepareServerPaymentIntent:(...a:unknown[])=>mockPrepare(...a)}));
jest.mock("../lib/serverPaymentConfirmationStore",()=>({runServerPaymentConfirmation:(...a:unknown[])=>mockConfirm(...a),
  getServerPaymentAuthentication:(...a:unknown[])=>mockAuthenticate(...a)}));
jest.mock("../lib/serverPaymentStop",()=>({stopServerPaymentIntent:(...a:unknown[])=>mockStop(...a)}));
import {prepareFullServerPayment,confirmFullServerPayment,authenticateFullServerPayment,stopFullServerPayment} from "../lib/fullServerPayment";
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1",mode:"test",platformAccountId:"acct_owned",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const schedule={enabled:true,basisPoints:290,fixedCents:30,version:"accepted-fees-v1"};
const fees=calculateCreatorFees(10001,schedule),now=Date.parse("2026-09-23T00:00:00Z");
const flags={CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY:"true",CREATOR_SERVER_PAYMENT_INTENT_READY:"true",
  CREATOR_FULL_SERVER_PAYMENT_SOURCE_SCHEMA_READY:"true",CREATOR_FULL_SERVER_PAYMENT_SOURCE_READY:"true",
  CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY:"true",CREATOR_SERVER_PAYMENT_CANCELLATION_READY:"true"};
const args=()=>({buyerId:id(2),attemptId:id(1),attemptKey:id(6),env:{...flags}});
beforeEach(()=>{
  jest.resetAllMocks();jest.useFakeTimers({now});mockDb.ops.length=0;mockContract=null;mockOriginal=null;
  mockSelection={attempt_id:id(1),buyer_id:id(2),product_id:id(4),kind:"full",protocol:SERVER_PAYMENT_PROTOCOL,context,
    created_at:new Date(now-1000).toISOString(),source:{id:id(1),buyer_id:id(2),creator_id:id(3),product_id:id(4),post_id:id(5),
      attempt_key:id(6),order_id:id(7),terms_fingerprint:"a".repeat(64),purchase_consent_id:id(8)}};
  mockConsent={id:id(8),accepted_at:new Date(now-2000).toISOString(),terms:{kind:"one_time",version:"accepted-policy",buyerId:id(2),
    creatorId:id(3),productId:id(4),postId:id(5),amountCents:10001,currency:"usd",serviceMonths:10,serviceVersion:"fixed-service-months-v1"}};
  mockOrder={id:id(7),buyer_id:id(2),creator_id:id(3),post_id:id(5),status:"created",currency:"usd",amount_cents:10001,gross_amount:10001,
    platform_fee:fees.platformFeeCents,processing_fee:fees.processingFeeCents,total_creator_deduction:fees.totalCreatorDeductionCents,
    creator_amount:fees.creatorNetCents,fee_schedule_version:fees.feeScheduleVersion,stripe_checkout_session_id:null,stripe_payment_intent_id:null};
  mockProfile={id:id(3),stripe_account_id:"acct_creator",stripe_onboarding_complete:true};
  mockObserve.mockResolvedValue({contextEvidence:{approvedContext:context,vercelEnvironment:"preview",stripeSecretKeyMode:"test",
    stripePublishableKeyMode:"test",observedPlatformAccountId:context.platformAccountId,observedSupabaseProjectRef:context.supabaseProjectRef,
    configuredSupabaseUrl:`https://${context.supabaseProjectRef}.supabase.co`,configuredSiteOrigin:context.siteOrigin}});
  mockDestination.mockResolvedValue({id:"acct_creator",charges_enabled:true,payouts_enabled:true,capabilities:{transfers:"active"}});
  mockPrepare.mockImplementation(async a=>{await a.assertProviderSource();return {status:"bound_unpublished",paymentIntentId:"pi_owned"};});
  mockConfirm.mockImplementation(async a=>{if(a.action.kind!=="observe")await a.assertProviderSource();return {status:"observed"};});
  mockAuthenticate.mockImplementation(async a=>{await a.assertProviderSource();return {status:"authentication_required"};});
  mockStop.mockResolvedValue({status:"intent_canceled_unreleased",releaseAllowed:false});
});
afterEach(()=>jest.useRealTimers());
async function bound(){
  await prepareFullServerPayment({...args(),initialProcessingFees:schedule});
  mockOriginal={contract:mockContract,payment_intent_id:"pi_owned",bound_at:new Date(now).toISOString(),first_dispatch_at:new Date(now).toISOString()};
  mockDb.ops.length=0;mockPrepare.mockClear();
}
test("full source freezes accepted fee/order/consent before delegating the existing unconfirmed intent adapter",async()=>{
  expect(await prepareFullServerPayment({...args(),initialProcessingFees:schedule})).toMatchObject({status:"bound_unpublished"});
  expect(mockContract).toMatchObject({kind:"full",amountCents:10001,customerId:null,destinationId:"acct_creator",processingFees:schedule,
    sourceMetadata:{order_id:id(7),purchase_consent_id:id(8),fixed_service_version:"fixed-service-months-v1"}});
  expect(mockDb.opsFor("save_full_server_payment_contract_v1")).toHaveLength(1);
  expect(mockDb.ops.some(op=>op.kind==="insert"||op.kind==="update")).toBe(false);
  expect(mockDestination).toHaveBeenCalledWith("acct_creator");
});
test("saved-source recovery ignores new pricing input after expiry and gate rollback without consulting current order/profile",async()=>{
  await bound();jest.setSystemTime(now+3*86400000);mockOrder=null;mockProfile=null;mockConsent=null;
  mockPrepare.mockImplementation(async a=>{expect(a.contract).toEqual(mockContract);return {status:"bound_unpublished"};});
  expect(await prepareFullServerPayment({...args(),initialProcessingFees:{...schedule,fixedCents:999},env:{...flags,
    CREATOR_SERVER_PAYMENT_INTENT_READY:"false",CREATOR_FULL_SERVER_PAYMENT_SOURCE_READY:"false"}})).toMatchObject({status:"bound_unpublished"});
  expect(mockDb.opsFor("orders")).toHaveLength(0);expect(mockDb.opsFor("save_full_server_payment_contract_v1")).toHaveLength(0);
});
test("an uncertain original keeps its saved contract and never saves replacement pricing",async()=>{
  mockPrepare.mockResolvedValue({status:"original_reply_unknown"});
  await prepareFullServerPayment({...args(),initialProcessingFees:schedule});
  mockOriginal={contract:mockContract,bound_at:null};mockDb.ops.length=0;
  expect(await prepareFullServerPayment({...args(),initialProcessingFees:{...schedule,version:"new",fixedCents:999}}))
    .toEqual({status:"original_reply_unknown"});
  expect(mockPrepare.mock.calls[1][0].contract.processingFees).toEqual(schedule);
  expect(mockDb.opsFor("save_full_server_payment_contract_v1")).toHaveLength(0);
});
test("original observation remains readable after financial state changes without authorizing new payment",async()=>{
  await bound();mockOrder.status="refunded";mockProfile=null;
  expect(await confirmFullServerPayment({...args(),action:{kind:"observe"}})).toEqual({status:"observed"});
  expect(mockDb.opsFor("orders")).toHaveLength(0);expect(mockPrepare).not.toHaveBeenCalled();
});
test("a different saved intent contract cannot be attached to the full selection",async()=>{
  await bound();mockOriginal.contract={...mockContract,amountCents:999};
  await expect(confirmFullServerPayment({...args(),action:{kind:"observe"}})).rejects.toThrow("requires review");
  expect(mockConfirm).not.toHaveBeenCalled();
});
test.each(["missing order","wrong amount","wrong fee","wrong consent","wrong owner","wrong key","hosted order","paid order","destination disabled","missing schedule"])
("full initial %s cannot dispatch a payment",async issue=>{
  if(issue==="missing order")mockOrder=null;if(issue==="wrong amount")mockOrder.amount_cents++;
  if(issue==="wrong fee")mockOrder.processing_fee++;if(issue==="wrong consent")mockConsent.terms.productId=id(9);
  if(issue==="wrong owner")mockSelection.buyer_id=id(9);if(issue==="wrong key")mockSelection.source.attempt_key=id(9);
  if(issue==="hosted order")mockOrder.stripe_checkout_session_id="cs_other";if(issue==="paid order")mockOrder.status="paid";
  if(issue==="destination disabled")mockDestination.mockResolvedValue({id:"acct_creator",charges_enabled:false});
  await expect(prepareFullServerPayment({...args(),...(issue==="missing schedule"?{}:{initialProcessingFees:schedule})})).rejects.toThrow("requires review");
});
test.each(["token","replacement","after_authentication","observe"] as const)("full %s delegates the bound original without preparing another",async kind=>{
  await bound();const action=kind==="token"?{kind,tokenId:"ctoken_owned"}:kind==="replacement"?
    {kind,tokenId:"ctoken_owned",previousOperationId:id(10)}:kind==="after_authentication"?{kind,previousOperationId:id(10)}:{kind};
  expect(await confirmFullServerPayment({...args(),action})).toEqual({status:"observed"});
  expect(mockConfirm.mock.calls[0][0].binding.paymentIntentId).toBe("pi_owned");expect(mockPrepare).not.toHaveBeenCalled();
});
test("full authentication reuses the original source and operation capability",async()=>{
  await bound();expect(await authenticateFullServerPayment({...args(),operationId:id(10)})).toEqual({status:"authentication_required"});
  expect(mockAuthenticate.mock.calls[0][0].operationId).toBe(id(10));expect(mockPrepare).not.toHaveBeenCalled();
});
test.each(["no snapshot","unbound"])("full stop with %s persists stop and never reconstructs a charge",async issue=>{
  if(issue==="unbound"){await bound();mockOriginal.bound_at=null;}
  expect(await stopFullServerPayment(args())).toEqual({status:"reconciliation_required",releaseAllowed:false});
  expect(mockDb.opsFor("request_server_payment_stop_v1")).toHaveLength(1);expect(mockPrepare).not.toHaveBeenCalled();expect(mockStop).not.toHaveBeenCalled();
});
test("full bound stop delegates the original terminal inspector and cannot release a selection",async()=>{
  await bound();expect(await stopFullServerPayment(args())).toEqual({status:"intent_canceled_unreleased",releaseAllowed:false});
  expect(mockStop.mock.calls[0][0].binding.paymentIntentId).toBe("pi_owned");expect(mockPrepare).not.toHaveBeenCalled();
});
test.each(["CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY","CREATOR_FULL_SERVER_PAYMENT_SOURCE_SCHEMA_READY","CREATOR_FULL_SERVER_PAYMENT_SOURCE_READY"])
("disabled %s admits no full source",async flag=>{
  expect(await prepareFullServerPayment({...args(),initialProcessingFees:schedule,env:{...flags,[flag]:"false"}})).toEqual({status:"not_enabled"});
  expect(mockDb.opsFor("save_full_server_payment_contract_v1")).toHaveLength(0);expect(mockPrepare).not.toHaveBeenCalled();
});
test.each(["foreign intent","foreign mode","unbound","invalid intent"])("signed original %s is rejected before observing or preparing payment",async issue=>{
  await bound();const expectedEvent={paymentIntentId:issue==="foreign intent"?"pi_other":issue==="invalid intent"?"bad":"pi_owned",livemode:issue==="foreign mode"};
  if(issue==="unbound")mockOriginal.bound_at=null;
  await expect(confirmFullServerPayment({...args(),expectedEvent,action:{kind:"observe"}})).rejects.toThrow();
  expect(mockConfirm).not.toHaveBeenCalled();expect(mockPrepare).not.toHaveBeenCalled();expect(mockStop).not.toHaveBeenCalled();
  expect(mockDb.opsFor("save_full_server_payment_contract_v1")).toHaveLength(0);
});
test("signed original observation uses saved pricing after catalog changes and dispatch rollback",async()=>{
  await bound();mockOrder=null;mockProfile=null;mockConsent=null;
  await confirmFullServerPayment({...args(),expectedEvent:{paymentIntentId:"pi_owned",livemode:false},action:{kind:"observe"},
    env:{...flags,CREATOR_FULL_SERVER_PAYMENT_SOURCE_READY:"false",CREATOR_SERVER_PAYMENT_INTENT_READY:"false",CREATOR_SERVER_PAYMENT_CONFIRMATION_READY:"false"}});
  expect(mockConfirm.mock.calls[0][0]).toMatchObject({action:{kind:"observe"},contract:mockContract,binding:{paymentIntentId:"pi_owned"}});
  expect(mockDb.opsFor("orders")).toHaveLength(0);expect(mockPrepare).not.toHaveBeenCalled();
});
