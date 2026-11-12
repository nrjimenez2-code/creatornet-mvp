import {createMockClient} from "./__mocks__/supabaseQueryMock";
const mockObserve=jest.fn(),mockFresh=jest.fn(),mockStop=jest.fn();
let mockArchive:any,mockContract:any,mockReleased:any,mockError:string;
let mockUnclaimed:any;
const mockDb=createMockClient(op=>{
  if(op.table===mockError)return {data:null,error:{message:"private database detail"}};
  if(op.table==="read_full_manual_release_v1")return {data:mockArchive,error:null};
  if(op.table==="release_unclaimed_full_payment_v1")return {data:mockUnclaimed,error:null};
  if(op.table==="read_full_server_payment_contract_v1")return {data:mockContract,error:null};
  if(op.table==="release_product_checkout_stop_v1")return {data:mockReleased,error:null};
  throw Error("Unexpected release operation");
});
jest.mock("@supabase/supabase-js",()=>({createClient:()=>mockDb}));
jest.mock("../lib/installments/contextServer",()=>({exactContextServerConfig:()=>({approvedContext:context,
  configuredSupabaseUrl:`https://${context.supabaseProjectRef}.supabase.co`,supabaseServiceKey:"fixture"})}));
jest.mock("../lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve}),
  assertFreshExactRuntimeContextObservation:(v:unknown)=>mockFresh(v)}));
jest.mock("../lib/fullServerPayment",()=>({stopFullServerPayment:(...a:unknown[])=>mockStop(...a)}));
import {releaseFullServerPayment} from "../lib/fullServerPaymentRelease";
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1",mode:"test",platformAccountId:"acct_owned",
  supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const now=Date.parse("2026-09-23T05:00:00Z");
const proof={version:"server-payment-intent-terminal-v1",paymentIntentId:"pi_owned",status:"canceled",amountReceived:0,
  amountCapturable:0,canceledAt:now/1000-10,chargeIds:["ch_declined"],observedAt:now/1000};
const args=()=>({buyerId:id(2),attemptId:id(1),attemptKey:id(6),env:{CREATOR_FULL_SERVER_PAYMENT_RELEASE_SCHEMA_READY:"true",
  CREATOR_FULL_SERVER_PAYMENT_RELEASE_READY:"true"}});
beforeEach(()=>{
  jest.resetAllMocks();jest.useFakeTimers({now});mockDb.ops.length=0;mockArchive=null;mockError="";
  mockUnclaimed=null;
  mockReleased={attempt_id:id(1),product_id:id(4),released_at:new Date(now).toISOString()};
  mockContract={attemptId:id(1),buyerId:id(2),productId:id(4),kind:"full",amountCents:10001,context,
    sourceMetadata:{checkout_attempt_key:id(6)}};
  mockObserve.mockResolvedValue({contextEvidence:{approvedContext:context,vercelEnvironment:"preview",stripeSecretKeyMode:"test",
    stripePublishableKeyMode:"test",observedPlatformAccountId:context.platformAccountId,observedSupabaseProjectRef:context.supabaseProjectRef,
    configuredSupabaseUrl:`https://${context.supabaseProjectRef}.supabase.co`,configuredSiteOrigin:context.siteOrigin}});
  mockStop.mockResolvedValue({status:"intent_canceled_unreleased",releaseAllowed:false,proof});
});
afterEach(()=>jest.useRealTimers());
test("verified unclaimed release never calls the provider stop engine",async()=>{
  mockUnclaimed=mockReleased;
  const a={...args(),env:{...args().env,CREATOR_FULL_UNCLAIMED_RELEASE_READY:"true"}};
  expect(await releaseFullServerPayment(a)).toMatchObject({status:"released",attemptId:id(1)});
  expect(mockStop).not.toHaveBeenCalled();expect(mockDb.opsFor("release_unclaimed_full_payment_v1")[0].payload)
    .toEqual({p_attempt_id:id(1),p_buyer_id:id(2),p_attempt_key:id(6),p_context:context});
});
test("existing claim falls through to original provider reconciliation",async()=>{
  const a={...args(),env:{...args().env,CREATOR_FULL_UNCLAIMED_RELEASE_READY:"true"}};
  expect(await releaseFullServerPayment(a)).toMatchObject({status:"released"});expect(mockStop).toHaveBeenCalledWith(a);
});
test("uncertain unclaimed release does not fall through or retry",async()=>{
  mockError="release_unclaimed_full_payment_v1";
  await expect(releaseFullServerPayment({...args(),env:{...args().env,CREATOR_FULL_UNCLAIMED_RELEASE_READY:"true"}})).rejects.toThrow();
  expect(mockStop).not.toHaveBeenCalled();expect(mockDb.opsFor(mockError)).toHaveLength(1);
});
test("shared stop supplies complete original terminal proof to the existing archive transaction",async()=>{
  expect(await releaseFullServerPayment(args())).toMatchObject({status:"released",attemptId:id(1),productId:id(4),releaseAllowed:true});
  expect(mockStop).toHaveBeenCalledWith(args());
  expect(mockDb.opsFor("release_product_checkout_stop_v1")[0].payload).toEqual({p_attempt_id:id(1),p_buyer_id:id(2),p_attempt_key:id(6),p_context:context,
    p_proof:{version:"full-manual-payment-stop-v1",manualPayment:proof,amountCents:10001,currency:"usd",
      paymentIntent:{id:"pi_owned",status:"canceled",amountReceived:0,amountCapturable:0},observedAt:proof.observedAt}});
  expect(mockDb.ops.some(o=>o.kind==="insert"||o.kind==="update"||o.kind==="delete")).toBe(false);
});
test("lost release reply reads only its archive even after the runtime gate rolls back",async()=>{
  mockArchive=mockReleased;const a=args();a.env.CREATOR_FULL_SERVER_PAYMENT_RELEASE_READY="false";
  expect(await releaseFullServerPayment(a)).toMatchObject({status:"released"});
  expect(mockStop).not.toHaveBeenCalled();expect(mockDb.ops).toHaveLength(1);
});
test("schema gate prevents every read and mutation",async()=>{
  const a=args();a.env.CREATOR_FULL_SERVER_PAYMENT_RELEASE_SCHEMA_READY="false";
  expect(await releaseFullServerPayment(a)).toEqual({status:"not_enabled"});expect(mockDb.ops).toHaveLength(0);expect(mockStop).not.toHaveBeenCalled();
});
test("runtime gate only allows historical readback",async()=>{
  const a=args();a.env.CREATOR_FULL_SERVER_PAYMENT_RELEASE_READY="false";
  expect(await releaseFullServerPayment(a)).toEqual({status:"not_enabled"});expect(mockDb.ops).toHaveLength(1);expect(mockStop).not.toHaveBeenCalled();
});
test.each(["not_enabled","busy","reconciliation_required","observed"])("%s cannot release a selection",async status=>{
  mockStop.mockResolvedValue({status});expect(await releaseFullServerPayment(args())).toEqual({status:"reconciliation_required",releaseAllowed:false});
  expect(mockDb.opsFor("release_product_checkout_stop_v1")).toHaveLength(0);
});
test.each(["read_full_manual_release_v1","read_full_server_payment_contract_v1","release_product_checkout_stop_v1"])
("uncertain %s never retries with a new identity",async name=>{
  mockError=name;await expect(releaseFullServerPayment(args())).rejects.toThrow("Original full manual release requires review");
  expect(mockDb.opsFor(name)).toHaveLength(1);
});
test.each(["owner","key","kind","amount","context","product","archive owner","archive date","stale context"])
("mismatched %s remains unresolved",async issue=>{
  if(issue==="owner")mockContract.buyerId=id(9);
  if(issue==="key")mockContract.sourceMetadata.checkout_attempt_key=id(9);
  if(issue==="kind")mockContract.kind="first_installment";
  if(issue==="amount")mockContract.amountCents=0;
  if(issue==="context")mockContract.context={...context,mode:"live"};
  if(issue==="product")mockReleased.product_id=id(9);
  if(issue==="archive owner")mockArchive={...mockReleased,attempt_id:id(9)};
  if(issue==="archive date")mockArchive={...mockReleased,released_at:new Date(now+60000).toISOString()};
  if(issue==="stale context")mockFresh.mockImplementation(()=>{throw Error("stale");});
  await expect(releaseFullServerPayment(args())).rejects.toThrow("requires review");
});
