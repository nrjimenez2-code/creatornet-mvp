import {createMockClient} from "./__mocks__/supabaseQueryMock";
import {serverPaymentFixture} from "../test-support/server-payment-fixture";
import {fullServerCaptureFixture} from "../test-support/full-server-capture-fixture";
import {serverPaymentCreateRequest} from "../lib/serverPaymentConfirmation";
const mockObserve=jest.fn(),mockLatest=jest.fn(),mockReadable=jest.fn(),mockRecord=jest.fn();
const mockIntent=jest.fn(),mockCharge=jest.fn(),mockBalance=jest.fn(),mockMethod=jest.fn(),mockToken=jest.fn();
const mockDispute=jest.fn();
const mockRefundObject=jest.fn(),mockRefundList=jest.fn();let mockRefundObjectResult:any;
let mockHeld:any,mockDisputeResult:any;
let mockFinancialResult:any;
let mockSource:any,mockOriginal:any,mockContract:any,mockConsent:any,mockSaved:any,mockReceipt:any,mockAccounted:any,mockRefundResult:any;
const mockDb=createMockClient(op=>{
  if(op.table==="record_full_server_payment_receipt_v1")return mockSaved;
  if(op.table==="read_full_server_payment_receipt_v1")return {data:mockReceipt,error:null};
  if(op.table==="account_full_server_payment_receipt_v1")return mockAccounted;
  if(["apply_full_server_payment_refund_v1","apply_full_server_payment_refund_signal_v1"].includes(op.table))return mockRefundResult;
  if(op.table==="hold_full_server_payment_dispute_v1")return mockHeld;
  if(op.table==="hold_full_server_refund_event_v1")return mockHeld;
  if(op.table==="apply_full_server_payment_refund_object_v1")return mockRefundObjectResult;
  if(["apply_full_server_payment_dispute_v1","apply_full_server_payment_financial_dispute_v1"].includes(op.table))return mockDisputeResult;
  if(op.table==="account_full_server_financial_receipt_v1")return mockFinancialResult;
  if(op.table==="hold_full_server_payment_financial_signal_v1")return {data:{attemptId:mockContract.attemptId,paymentIntentId:"pi_owned",financialHold:true},error:null};
  const data=op.table==="read_server_payment_source_v1"?mockSource:op.table==="read_full_server_payment_contract_v1"?mockContract:
    op.table==="read_server_payment_intent_v1"?mockOriginal:op.table==="product_purchase_consents_v1"?mockConsent:undefined;
  if(data!==undefined)return {data,error:null};throw Error("Unexpected capture write/read");
});
jest.mock("@supabase/supabase-js",()=>({createClient:()=>mockDb}));
jest.mock("stripe",()=>({__esModule:true,default:function(){return {paymentIntents:{retrieve:mockIntent},charges:{retrieve:mockCharge},
  balanceTransactions:{retrieve:mockBalance},paymentMethods:{retrieve:mockMethod},confirmationTokens:{retrieve:mockToken},disputes:{retrieve:mockDispute},
  refunds:{retrieve:mockRefundObject,list:mockRefundList}};}}));
jest.mock("../lib/installments/contextServer",()=>({exactContextServerConfig:()=>({approvedContext:mockContract.context,
  configuredSupabaseUrl:`https://${mockContract.context.supabaseProjectRef}.supabase.co`,supabaseServiceKey:"fixture",stripeSecretKey:"sk_test_fixture"})}));
jest.mock("../lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve})}));
jest.mock("../lib/serverPaymentConfirmationStore",()=>({createServerConfirmationStore:(a:any)=>{
  expect(a.env.CREATOR_SERVER_PAYMENT_CONFIRMATION_READY).toBe("false");
  return {latest:mockLatest,store:{assertReadable:mockReadable,recordObservation:mockRecord,assertDispatch:()=>{throw Error("Unexpected dispatch");}}};
}}));
import {inspectFullServerPayment,recordFullServerPaymentCapture,accountFullServerPayment,reconcileFullServerPaymentRefund,reconcileFullServerPaymentDispute,reconcileFullServerRefundObject} from "../lib/fullServerPaymentReadback";
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
let f:ReturnType<typeof serverPaymentFixture>,capture:ReturnType<typeof fullServerCaptureFixture>;
const flags={CREATOR_FULL_SERVER_PAYMENT_RECEIPT_INSPECTION_READY:"true",CREATOR_FULL_SERVER_PAYMENT_SOURCE_SCHEMA_READY:"true",
  CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY:"true",CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY:"true",
  CREATOR_SERVER_PAYMENT_CONFIRMATION_READY:"false",CREATOR_FULL_SERVER_PAYMENT_SOURCE_READY:"false",CREATOR_SERVER_PAYMENT_INTENT_READY:"false"};
const args=()=>({buyerId:mockContract.buyerId,attemptId:mockContract.attemptId,attemptKey:mockContract.sourceMetadata.checkout_attempt_key,env:{...flags}});
beforeEach(()=>{
  jest.resetAllMocks();mockDb.ops.length=0;f=serverPaymentFixture("full");capture=fullServerCaptureFixture(f);
  jest.useFakeTimers({now:capture.nowSeconds*1000});mockContract=capture.contract;mockConsent=capture.consent;
  mockSaved={data:{attemptId:mockContract.attemptId,paymentIntentId:"pi_owned",recorded:true,accountingRequired:true},error:null};
  mockReceipt=null;mockAccounted={data:{accounted:true,attemptId:mockContract.attemptId,
    purchaseId:mockContract.productId,ledgerId:mockContract.creatorId,purchaseStatus:"paid"},error:null};
  mockRefundResult={data:{status:"original_refund_applied",attemptId:mockContract.attemptId,paymentIntentId:"pi_owned",
    purchaseId:mockContract.productId,ledgerId:mockContract.creatorId,refundedCents:1000},error:null};
  mockHeld={data:{revision:1,disputes:[],refunds:[]},error:null};mockDisputeResult={data:"dispute_observed",error:null};
  mockFinancialResult={data:{status:"original_financial_capture_accounted",attemptId:mockContract.attemptId,paymentIntentId:"pi_owned",
    purchaseId:mockContract.productId,ledgerId:mockContract.creatorId,accounted:true,refundedCents:1000,disputeDisposition:"dispute_observed"},error:null};
  mockDispute.mockImplementation(async()=>({object:"dispute",id:"du_owned",charge:"ch_owned",payment_intent:"pi_owned",
    livemode:false,currency:"usd",amount:1000,created:capture.data.charge.created,status:"needs_response"}));
  mockRefundObject.mockImplementation(async()=>({object:"refund",id:"re_owned",charge:"ch_owned",payment_intent:"pi_owned",
    currency:"usd",amount:1000,created:capture.data.charge.created,status:"pending"}));
  mockRefundObjectResult={data:{status:"refund_observed",disposition:"refund_observed",attemptId:mockContract.attemptId,
    paymentIntentId:"pi_owned",refundStatus:"pending",refundedCents:0,refundApplied:false},error:null};
  mockRefundList.mockImplementation(async()=>({object:"list",has_more:false,data:capture.data.charge.amount_refunded>0?
    [{object:"refund",id:"re_owned",charge:"ch_owned",payment_intent:"pi_owned",currency:"usd",
      amount:capture.data.charge.amount_refunded,created:capture.data.charge.created,status:"succeeded"}]:[]}));
  const c=mockContract;
  mockSource={attempt_id:c.attemptId,buyer_id:c.buyerId,kind:"full",protocol:c.protocol,context:c.context,product_id:c.productId,
    source:{attempt_key:c.sourceMetadata.checkout_attempt_key,creator_id:c.creatorId,terms_fingerprint:c.termsFingerprint,
      order_id:c.sourceMetadata.order_id,purchase_consent_id:c.sourceMetadata.purchase_consent_id}};
  mockOriginal={attempt_id:c.attemptId,bound_at:new Date(capture.binding.firstDispatchAt*1000).toISOString(),contract:c,
    request:serverPaymentCreateRequest(c,capture.contextEvidence),payment_intent_id:capture.binding.paymentIntentId,
    first_dispatch_at:new Date(capture.binding.firstDispatchAt*1000).toISOString()};
  mockObserve.mockResolvedValue({contextEvidence:capture.contextEvidence});
  mockLatest.mockResolvedValue({admission:f.admission});mockReadable.mockResolvedValue(undefined);mockRecord.mockResolvedValue(undefined);
  f.token.payment_intent=f.pi.id;
  mockIntent.mockImplementation(async()=>copy(capture.data.paymentIntent));
  mockCharge.mockImplementation(async()=>copy(capture.data.charge));
  mockBalance.mockImplementation(async()=>copy(capture.data.balance));
  mockMethod.mockImplementation(async()=>copy(capture.data.paymentMethod));mockToken.mockResolvedValue(f.token);
});
afterEach(()=>jest.useRealTimers());

const refundObjectArgs=()=>({...args(),eventId:"evt_object",refundId:"re_owned",eventCreated:capture.nowSeconds,
  expectedEvent:{paymentIntentId:"pi_owned",chargeId:"ch_owned",livemode:false},env:{...flags,
    CREATOR_FULL_SERVER_REFUND_OBJECT_SCHEMA_READY:"true",CREATOR_FULL_SERVER_REFUND_OBJECT_READY:"true",
    CREATOR_FULL_REFUND_EVENT_SCHEMA_READY:"true",
    CREATOR_FULL_SERVER_PAYMENT_REFUND_SCHEMA_READY:"true",CREATOR_FULL_SERVER_PAYMENT_REFUND_READY:"true",
    CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_SCHEMA_READY:"true",CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_READY:"true"}});
test.each(["pending","requires_action","failed","canceled"])("Refund-object %s commits hold before capture reads and persists only normalized observation",async status=>{
  const refund=await mockRefundObject();mockRefundObject.mockResolvedValue({...refund,status});
  mockRefundObjectResult.data.refundStatus=status;
  mockIntent.mockImplementation(async()=>{expect(mockDb.opsFor("hold_full_server_refund_event_v1")).toHaveLength(1);
    expect(mockDb.opsFor("hold_full_server_refund_event_v1")[0].payload).toMatchObject({p_event_created:capture.nowSeconds,p_event_id:"evt_object"});
    return copy(capture.data.paymentIntent);});
  expect(await reconcileFullServerRefundObject(refundObjectArgs())).toMatchObject({refundStatus:status,refundApplied:false});
  expect(mockRefundList).not.toHaveBeenCalled();
  expect(mockDb.opsFor("apply_full_server_payment_refund_object_v1")[0].payload).toMatchObject({p_read:mockHeld.data,p_succeeded_total:null,
    p_observation:{status,refundId:"re_owned",paymentIntentId:"pi_owned"}});
});
test("Refund-object successful reconciliation requires independently enumerated succeeded total",async()=>{
  const refund=await mockRefundObject();mockRefundObject.mockResolvedValue({...refund,status:"succeeded"});capture.data.charge.amount_refunded=1000;
  Object.assign(mockRefundObjectResult.data,{refundStatus:"succeeded",refundedCents:1000,refundApplied:true});
  expect(await reconcileFullServerRefundObject(refundObjectArgs())).toMatchObject({status:"refund_observed",refundApplied:true});
  expect(mockRefundList).toHaveBeenCalledTimes(2);
  expect(mockDb.opsFor("apply_full_server_payment_refund_object_v1")[0].payload).toMatchObject({p_succeeded_total:1000,p_refunded_cents:1000});
});
test("Refund-object early pending money uses original financial accounting only under its gates",async()=>{
  mockRefundObjectResult.data.status="refund_recorded_accounting_review";
  expect(await reconcileFullServerRefundObject(refundObjectArgs())).toMatchObject({status:"refund_recorded_accounting_review"});
  expect(mockDb.opsFor("account_full_server_financial_receipt_v1")).toHaveLength(0);
  mockFinancialResult.data.refundedCents=0;
  expect(await reconcileFullServerRefundObject({...refundObjectArgs(),env:{...refundObjectArgs().env,
    CREATOR_FULL_SERVER_PAYMENT_FINANCIAL_ACCOUNTING_SCHEMA_READY:"true",CREATOR_FULL_SERVER_PAYMENT_FINANCIAL_ACCOUNTING_READY:"true"}}))
    .toMatchObject({status:"refund_observed",refundStatus:"pending",refundApplied:false});
  expect(mockDb.opsFor("account_full_server_financial_receipt_v1")[0].payload).toMatchObject({p_event_id:"evt_object",p_event_kind:"refund_object"});
});
test.each(["provider failure","changed refund","wrong owner","failed hold","malformed result"])("Refund-object %s never grants clean accounting or falls through",async issue=>{
  if(issue==="provider failure")mockRefundObject.mockRejectedValue(Error("offline"));
  if(issue==="changed refund"){
    const first=await mockRefundObject();mockRefundObject.mockResolvedValueOnce(first).mockResolvedValueOnce({...first,status:"failed"});
  }
  if(issue==="wrong owner")mockSource.buyer_id=mockContract.creatorId;
  if(issue==="failed hold")mockHeld={data:null,error:{message:"hold failed"}};
  if(issue==="malformed result")mockRefundObjectResult.data.paymentIntentId="pi_other";
  await expect(reconcileFullServerRefundObject(refundObjectArgs())).rejects.toThrow();
  expect(mockDb.opsFor("account_full_server_payment_receipt_v1")).toHaveLength(0);
  if(issue!=="malformed result")expect(mockDb.opsFor("apply_full_server_payment_refund_object_v1")).toHaveLength(0);
});
test.each(["CREATOR_FULL_SERVER_REFUND_OBJECT_SCHEMA_READY","CREATOR_FULL_SERVER_REFUND_OBJECT_READY",
  "CREATOR_FULL_REFUND_EVENT_SCHEMA_READY",
  "CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_SCHEMA_READY","CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_READY"])
("Refund-object gate %s blocks provider and observation writes",async gate=>{
  await expect(reconcileFullServerRefundObject({...refundObjectArgs(),env:{...refundObjectArgs().env,[gate]:"false"}})).rejects.toThrow();
  expect(mockDb.ops).toHaveLength(0);expect(mockRefundObject).not.toHaveBeenCalled();
});
test("Refund-object stale basis remains unresolved",async()=>{
  mockRefundObjectResult.data={status:"reconciliation_required"};
  expect(await reconcileFullServerRefundObject(refundObjectArgs())).toEqual({status:"reconciliation_required",refundApplied:false});
});

const disputeArgs=()=>({...args(),eventId:"evt_dispute",disputeId:"du_owned",eventCreated:capture.nowSeconds,
  expectedEvent:{paymentIntentId:"pi_owned",chargeId:"ch_owned",livemode:false},
  env:{...flags,CREATOR_FULL_SERVER_PAYMENT_DISPUTE_SCHEMA_READY:"true",CREATOR_FULL_SERVER_PAYMENT_DISPUTE_READY:"true"}});
test("dispute readback establishes a durable hold before provider reads and uses pinned current observations",async()=>{
  capture.data.charge.disputed=true;
  mockIntent.mockImplementation(async()=>{expect(mockDb.opsFor("hold_full_server_payment_dispute_v1")).toHaveLength(1);return copy(capture.data.paymentIntent);});
  expect(await reconcileFullServerPaymentDispute(disputeArgs())).toMatchObject({status:"dispute_observed"});
  expect(mockDispute).toHaveBeenCalledTimes(2);
  expect(mockDispute).toHaveBeenCalledWith("du_owned",{apiVersion:"2025-10-29.clover",maxNetworkRetries:0,timeout:10000});
  expect(mockDb.opsFor("apply_full_server_payment_dispute_v1")[0].payload).toMatchObject({p_read:mockHeld.data,p_disputed_cents:1000,p_status:"needs_response"});
  expect(mockDb.opsFor("account_full_server_payment_receipt_v1")).toHaveLength(0);
});
test("nullable dispute PI uses the independently checked captured charge relationship",async()=>{
  mockDispute.mockResolvedValue({object:"dispute",id:"du_owned",charge:{id:"ch_owned"},payment_intent:null,
    livemode:false,currency:"usd",amount:1000,created:capture.data.charge.created,status:"won"});
  expect(await reconcileFullServerPaymentDispute(disputeArgs())).toMatchObject({status:"dispute_observed"});
});
test.each(["provider failure","foreign charge","foreign PI","foreign mode","foreign currency","changed status","refund signal"])
("dispute %s keeps the prior hold without applying an observation",async issue=>{
  capture.data.charge.disputed=true;
  const observation=await mockDispute();mockDispute.mockClear();
  if(issue==="provider failure")mockDispute.mockRejectedValue(Error("offline"));
  if(issue==="foreign charge")mockDispute.mockResolvedValue({...observation,charge:"ch_other"});
  if(issue==="foreign PI")mockDispute.mockResolvedValue({...observation,payment_intent:"pi_other"});
  if(issue==="foreign mode")mockDispute.mockResolvedValue({...observation,livemode:true});
  if(issue==="foreign currency")mockDispute.mockResolvedValue({...observation,currency:"cad"});
  if(issue==="changed status")mockDispute.mockResolvedValueOnce(observation).mockResolvedValueOnce({...observation,status:"won"});
  if(issue==="refund signal")capture.data.charge.amount_refunded=1;
  await expect(reconcileFullServerPaymentDispute(disputeArgs())).rejects.toThrow();
  expect(mockDb.opsFor("hold_full_server_payment_dispute_v1")).toHaveLength(1);
  expect(mockDb.opsFor("apply_full_server_payment_dispute_v1")).toHaveLength(0);
});
test.each(["schema gate","operation gate","foreign context","invalid event","foreign source"])("dispute %s cannot establish a hold",async issue=>{
  const a=disputeArgs();
  if(issue==="schema gate")a.env.CREATOR_FULL_SERVER_PAYMENT_DISPUTE_SCHEMA_READY="false";
  if(issue==="operation gate")a.env.CREATOR_FULL_SERVER_PAYMENT_DISPUTE_READY="false";
  if(issue==="foreign context")a.expectedEvent.livemode=true;
  if(issue==="invalid event")a.eventId="invalid";
  if(issue==="foreign source")mockSource.source.attempt_key="wrong";
  await expect(reconcileFullServerPaymentDispute(a)).rejects.toThrow();
  expect(mockDb.opsFor("hold_full_server_payment_dispute_v1")).toHaveLength(0);
});
test.each(["dispute_review_recorded","dispute_recorded_accounting_review","reconciliation_required"])("dispute %s remains explicit for the webhook",async status=>{
  mockDisputeResult.data=status;expect(await reconcileFullServerPaymentDispute(disputeArgs())).toMatchObject({status});
});

const refundArgs=()=>({...args(),eventId:"evt_refund",expectedEvent:{paymentIntentId:"pi_owned",chargeId:"ch_owned",livemode:false},
  env:{...flags,CREATOR_FULL_SERVER_PAYMENT_REFUND_SCHEMA_READY:"true",CREATOR_FULL_SERVER_PAYMENT_REFUND_READY:"true",
    CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_SCHEMA_READY:"true"}});
const financialFlags={CREATOR_FULL_SERVER_PAYMENT_FINANCIAL_ACCOUNTING_SCHEMA_READY:"true",CREATOR_FULL_SERVER_PAYMENT_FINANCIAL_ACCOUNTING_READY:"true"};
const combinedFlags={CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_SCHEMA_READY:"true",CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_READY:"true"};
test.each(["pending total","failed total","missing refunds","provider unavailable","changed list"])
("charge refund %s establishes a durable hold instead of reversing unproved money",async issue=>{
  capture.data.charge.amount_refunded=1000;const valid=await mockRefundList();mockRefundList.mockClear();
  if(issue==="pending total"||issue==="failed total")mockRefundList.mockResolvedValue({...valid,data:[{...valid.data[0],status:issue==="pending total"?"pending":"failed"}]});
  if(issue==="missing refunds")mockRefundList.mockResolvedValue({...valid,data:[]});
  if(issue==="provider unavailable")mockRefundList.mockRejectedValue(Error("offline"));
  if(issue==="changed list")mockRefundList.mockResolvedValueOnce(valid).mockResolvedValueOnce({...valid,data:[{...valid.data[0],status:"failed"}]});
  await expect(reconcileFullServerPaymentRefund(refundArgs())).rejects.toThrow("refund total requires review");
  expect(mockDb.opsFor("hold_full_server_payment_financial_signal_v1")).toHaveLength(1);
  expect(mockDb.opsFor("apply_full_server_payment_refund_v1")).toHaveLength(0);
  expect(mockDb.opsFor("apply_full_server_payment_refund_signal_v1")).toHaveLength(0);
  expect(mockDb.opsFor("account_full_server_financial_receipt_v1")).toHaveLength(0);
});
test("verified ordinary partial charge refund preserves existing access policy without adding a new hold",async()=>{
  capture.data.charge.amount_refunded=1000;await reconcileFullServerPaymentRefund(refundArgs());
  expect(mockRefundList).toHaveBeenCalledTimes(2);expect(mockDb.opsFor("hold_full_server_payment_financial_signal_v1")).toHaveLength(0);
});
test("charge refund lost accounting acknowledgement retains the original under a durable hold",async()=>{
  capture.data.charge.amount_refunded=1000;mockRefundResult={data:null,error:{message:"lost acknowledgement"}};
  await expect(reconcileFullServerPaymentRefund(refundArgs())).rejects.toThrow("refund accounting requires review");
  const names=mockDb.ops.map(o=>o.table);
  expect(names.indexOf("hold_full_server_payment_financial_signal_v1")).toBeGreaterThan(names.indexOf("apply_full_server_payment_refund_v1"));
  expect(mockDb.opsFor("hold_full_server_payment_financial_signal_v1")).toHaveLength(1);
  expect(mockDb.opsFor("account_full_server_payment_receipt_v1")).toHaveLength(0);
});
test("charge refund requires the uncertainty-hold schema before provider reads",async()=>{
  const a=refundArgs();a.env.CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_SCHEMA_READY="false";
  await expect(reconcileFullServerPaymentRefund(a)).rejects.toThrow();expect(mockDb.ops).toHaveLength(0);expect(mockIntent).not.toHaveBeenCalled();
});
test.each(["pending total","missing refunds","provider unavailable"])("combined dispute %s retains its pre-read hold without financial application",async issue=>{
  capture.data.charge.disputed=true;capture.data.charge.amount_refunded=1000;
  const valid=await mockRefundList();mockRefundList.mockClear();
  if(issue==="pending total")mockRefundList.mockResolvedValue({...valid,data:[{...valid.data[0],status:"pending"}]});
  if(issue==="missing refunds")mockRefundList.mockResolvedValue({...valid,data:[]});
  if(issue==="provider unavailable")mockRefundList.mockRejectedValue(Error("offline"));
  const a=disputeArgs();Object.assign(a.env,combinedFlags);
  await expect(reconcileFullServerPaymentDispute(a)).rejects.toThrow();
  expect(mockDb.opsFor("hold_full_server_payment_dispute_v1")).toHaveLength(1);
  expect(mockDb.opsFor("apply_full_server_payment_financial_dispute_v1")).toHaveLength(0);
  expect(mockDb.opsFor("account_full_server_financial_receipt_v1")).toHaveLength(0);
});
test("combined dispute readback passes independently read cumulative refunds into the atomic observation",async()=>{
  capture.data.charge.disputed=true;capture.data.charge.amount_refunded=1000;
  const a=disputeArgs();Object.assign(a.env,combinedFlags);
  expect(await reconcileFullServerPaymentDispute(a)).toMatchObject({status:"dispute_observed"});
  expect(mockDb.opsFor("apply_full_server_payment_financial_dispute_v1")[0].payload).toMatchObject({p_refunded_cents:1000,p_status:"needs_response",p_read:mockHeld.data});
  expect(mockDb.opsFor("apply_full_server_payment_dispute_v1")).toHaveLength(0);
});
test("combined refund readback retains an independently observed dispute signal",async()=>{
  capture.data.charge.disputed=true;capture.data.charge.amount_refunded=1000;
  const a=refundArgs();Object.assign(a.env,combinedFlags);
  expect(await reconcileFullServerPaymentRefund(a)).toMatchObject({status:"original_refund_applied"});
  expect(mockDb.opsFor("apply_full_server_payment_refund_signal_v1")[0].payload).toMatchObject({p_refunded_cents:1000,p_disputed:true});
  expect(mockDispute).not.toHaveBeenCalled();
  const names=mockDb.ops.map(o=>o.table);
  expect(names.indexOf("hold_full_server_payment_financial_signal_v1")).toBeLessThan(names.indexOf("apply_full_server_payment_refund_signal_v1"));
});
test("combined refund accounting failure does not bypass the prior durable signal hold",async()=>{
  capture.data.charge.disputed=true;capture.data.charge.amount_refunded=1000;mockRefundResult.error={message:"rollback"};
  const a=refundArgs();Object.assign(a.env,combinedFlags);
  await expect(reconcileFullServerPaymentRefund(a)).rejects.toThrow();
  expect(mockDb.opsFor("hold_full_server_payment_financial_signal_v1")).toHaveLength(1);
});
test("a disappeared dispute flag between reads never suppresses the observed financial hold",async()=>{
  capture.data.charge.amount_refunded=1000;
  mockCharge.mockResolvedValueOnce({...capture.data.charge,disputed:true});
  const a=refundArgs();Object.assign(a.env,combinedFlags);
  await reconcileFullServerPaymentRefund(a);
  expect(mockDb.opsFor("apply_full_server_payment_refund_signal_v1")[0].payload).toMatchObject({p_disputed:true});
});
test.each(["CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_SCHEMA_READY","CREATOR_FULL_SERVER_PAYMENT_COMBINED_FINANCIAL_READY"])
("disabled %s cannot relax combined financial inspection",async gate=>{
  capture.data.charge.disputed=true;capture.data.charge.amount_refunded=1000;
  const a=disputeArgs();Object.assign(a.env,{...combinedFlags,[gate]:"false"});
  await expect(reconcileFullServerPaymentDispute(a)).rejects.toThrow();
  expect(mockDb.opsFor("apply_full_server_payment_financial_dispute_v1")).toHaveLength(0);
});
test("combined early dispute observation precedes original-money accounting",async()=>{
  capture.data.charge.disputed=true;capture.data.charge.amount_refunded=1000;mockDisputeResult.data="dispute_recorded_accounting_review";
  const a=disputeArgs();Object.assign(a.env,combinedFlags,financialFlags);
  expect(await reconcileFullServerPaymentDispute(a)).toMatchObject({status:"dispute_observed"});
  const names=mockDb.ops.map(o=>o.table);
  expect(names.indexOf("apply_full_server_payment_financial_dispute_v1")).toBeLessThan(names.indexOf("account_full_server_financial_receipt_v1"));
});
test("gated early refund completes financial accounting after durable refund observation",async()=>{
  capture.data.charge.amount_refunded=1000;mockRefundResult.data.status="refund_recorded_accounting_review";
  const a=refundArgs();Object.assign(a.env,financialFlags);
  expect(await reconcileFullServerPaymentRefund(a)).toMatchObject({status:"original_refund_applied",refundedCents:1000});
  expect(mockDb.opsFor("account_full_server_financial_receipt_v1")[0].payload).toMatchObject({p_event_id:"evt_refund",p_event_kind:"refund"});
  const names=mockDb.ops.map(o=>o.table);
  expect(names.indexOf("apply_full_server_payment_refund_v1")).toBeLessThan(names.indexOf("account_full_server_financial_receipt_v1"));
});
test.each(["CREATOR_FULL_SERVER_PAYMENT_FINANCIAL_ACCOUNTING_SCHEMA_READY","CREATOR_FULL_SERVER_PAYMENT_FINANCIAL_ACCOUNTING_READY"])
("disabled %s keeps early accounting in review",async gate=>{
  capture.data.charge.amount_refunded=1000;mockRefundResult.data.status="refund_recorded_accounting_review";
  const a=refundArgs();Object.assign(a.env,{...financialFlags,[gate]:"false"});
  expect(await reconcileFullServerPaymentRefund(a)).toMatchObject({status:"refund_recorded_accounting_review"});
  expect(mockDb.opsFor("account_full_server_financial_receipt_v1")).toHaveLength(0);
});
test.each(["database failure","foreign result","wrong status","lower refund","missing accounting flag"])("early financial %s cannot acknowledge completion",async issue=>{
  capture.data.charge.amount_refunded=1000;mockRefundResult.data.status="refund_recorded_accounting_review";
  const a=refundArgs();Object.assign(a.env,financialFlags);
  if(issue==="database failure")mockFinancialResult.error={message:"rollback"};
  if(issue==="foreign result")mockFinancialResult.data.paymentIntentId="pi_other";
  if(issue==="wrong status")mockFinancialResult.data.status="paid";
  if(issue==="lower refund")mockFinancialResult.data.refundedCents=999;
  if(issue==="missing accounting flag")delete mockFinancialResult.data.accounted;
  await expect(reconcileFullServerPaymentRefund(a)).rejects.toThrow();
});
test.each(["dispute_observed","dispute_review_recorded"])("gated early dispute preserves %s after original-money accounting",async disposition=>{
  mockDisputeResult.data="dispute_recorded_accounting_review";mockFinancialResult.data.disputeDisposition=disposition;
  const a=disputeArgs();Object.assign(a.env,financialFlags);
  expect(await reconcileFullServerPaymentDispute(a)).toMatchObject({status:disposition});
  expect(mockDb.opsFor("account_full_server_financial_receipt_v1")[0].payload).toMatchObject({p_event_id:"evt_dispute",p_event_kind:"dispute"});
});
test("full refund independently reads original capture and applies observed cumulative money through one transaction",async()=>{
  capture.data.charge.amount_refunded=1000;
  expect(await reconcileFullServerPaymentRefund(refundArgs())).toMatchObject({status:"original_refund_applied",refundedCents:1000,amountCents:3333});
  expect(mockDb.opsFor("apply_full_server_payment_refund_v1")[0].payload).toMatchObject({p_event_id:"evt_refund",p_refunded_cents:1000,
    p_proof:{paymentIntentId:"pi_owned",chargeId:"ch_owned",amountCents:3333,serviceEndsAt:expect.any(Number)}});
  expect(mockDb.opsFor("account_full_server_payment_receipt_v1")).toHaveLength(0);
  expect(mockDb.opsFor("record_full_server_payment_receipt_v1")).toHaveLength(0);
  await expect(inspectFullServerPayment(args())).rejects.toThrow();
});
test("early full refund returns persisted review status instead of claiming accounting",async()=>{
  capture.data.charge.amount_refunded=1000;mockRefundResult.data.status="refund_recorded_accounting_review";
  expect(await reconcileFullServerPaymentRefund(refundArgs())).toMatchObject({status:"refund_recorded_accounting_review"});
});
test.each(["schema gate","operation gate","foreign event PI","foreign event charge","foreign mode","invalid event","zero refund","excess refund","dispute","declining cumulative read"])
("refund readback rejects %s before financial writes",async issue=>{
  capture.data.charge.amount_refunded=1000;const a=refundArgs();
  if(issue==="schema gate")a.env.CREATOR_FULL_SERVER_PAYMENT_REFUND_SCHEMA_READY="false";
  if(issue==="operation gate")a.env.CREATOR_FULL_SERVER_PAYMENT_REFUND_READY="false";
  if(issue==="foreign event PI")a.expectedEvent.paymentIntentId="pi_other";
  if(issue==="foreign event charge")a.expectedEvent.chargeId="ch_other";
  if(issue==="foreign mode")a.expectedEvent.livemode=true;
  if(issue==="invalid event")a.eventId="invalid";
  if(issue==="zero refund")capture.data.charge.amount_refunded=0;
  if(issue==="excess refund")capture.data.charge.amount_refunded=3334;
  if(issue==="dispute")capture.data.charge.disputed=true;
  if(issue==="declining cumulative read")mockCharge.mockResolvedValueOnce({...capture.data.charge,amount_refunded:2000});
  await expect(reconcileFullServerPaymentRefund(a)).rejects.toThrow();
  expect(mockDb.opsFor("apply_full_server_payment_refund_v1")).toHaveLength(0);
});
test.each(["database error","foreign result","reduced total","invalid status"])("refund %s cannot acknowledge financial application",async issue=>{
  capture.data.charge.amount_refunded=1000;
  if(issue==="database error")mockRefundResult.error={message:"rollback"};
  if(issue==="foreign result")mockRefundResult.data.paymentIntentId="pi_other";
  if(issue==="reduced total")mockRefundResult.data.refundedCents=999;
  if(issue==="invalid status")mockRefundResult.data.status="paid";
  await expect(reconcileFullServerPaymentRefund(refundArgs())).rejects.toThrow();
});
test("reads the owned original, verifies its consumed confirmation token and returns capture evidence with all dispatch gates off",async()=>{
  const proof=await inspectFullServerPayment(args());
  expect(proof).toMatchObject({checkoutSessionId:null,paymentIntentId:"pi_owned",chargeId:"ch_owned",amountCents:3333});
  expect(mockRecord).toHaveBeenCalledWith(f.admission,expect.objectContaining({status:"succeeded",chargeId:"ch_owned"}));
  expect(mockReadable).toHaveBeenCalledTimes(3);expect(mockCharge).toHaveBeenCalledTimes(2);
  expect(mockIntent).toHaveBeenCalledWith("pi_owned",{apiVersion:"2025-10-29.clover",maxNetworkRetries:0,timeout:10000});
  expect(mockDb.ops.every(op=>op.kind!=="update"&&op.kind!=="insert")).toBe(true);
});
test("late capture recovery uses the saved consent after the sale window closes",async()=>{
  jest.setSystemTime((capture.contract.expiresAt+86400)*1000);
  expect((await inspectFullServerPayment(args())).paidAt).toBe(capture.data.charge.created);
});
test.each(["inspection gate","foreign source","different snapshot","unbound intent","changed request","missing consent","missing confirmation","foreign context"])
("%s cannot return receipt evidence",async issue=>{
  const a=args();
  if(issue==="inspection gate")a.env.CREATOR_FULL_SERVER_PAYMENT_RECEIPT_INSPECTION_READY="false";
  if(issue==="foreign source")mockSource.buyer_id=f.c.creatorId;
  if(issue==="different snapshot")mockOriginal.contract={...f.c,amountCents:9999};
  if(issue==="unbound intent")mockOriginal.bound_at=null;
  if(issue==="changed request")mockOriginal.request.params.amount++;
  if(issue==="missing consent")mockConsent=null;
  if(issue==="missing confirmation")mockLatest.mockResolvedValue(null);
  if(issue==="foreign context")mockObserve.mockResolvedValue({contextEvidence:{...capture.contextEvidence,observedPlatformAccountId:"acct_other"}});
  await expect(inspectFullServerPayment(a)).rejects.toThrow("Full payment readback requires review");
  expect(mockCharge).not.toHaveBeenCalled();
});
test("foreign consumed token is not accepted just because the original intent reports success",async()=>{
  f.token.payment_intent="pi_other";
  await expect(inspectFullServerPayment(args())).rejects.toThrow();expect(mockRecord).not.toHaveBeenCalled();
});
test("a refund arriving during provider reads prevents clean capture return",async()=>{
  mockCharge.mockResolvedValueOnce(copy(capture.data.charge)).mockResolvedValueOnce({...capture.data.charge,amount_refunded:1});
  await expect(inspectFullServerPayment(args())).rejects.toThrow();
});
test("missing asynchronous settlement evidence stays review-required",async()=>{
  capture.data.charge.balance_transaction=null;
  await expect(inspectFullServerPayment(args())).rejects.toThrow();expect(mockBalance).not.toHaveBeenCalled();
});
test("a changed durable confirmation before return prevents use of stale capture evidence",async()=>{
  mockReadable.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error("changed phase"));
  await expect(inspectFullServerPayment(args())).rejects.toThrow();
});

const recordArgs=()=>({...args(),env:{...flags,CREATOR_FULL_SERVER_PAYMENT_RECEIPT_SCHEMA_READY:"true",CREATOR_FULL_SERVER_PAYMENT_RECEIPT_RECORD_READY:"true"}});
test("verified capture recording explicitly leaves accounting pending and sends only inspected proof",async()=>{
  expect(await recordFullServerPaymentCapture(recordArgs())).toEqual({status:"capture_recorded_accounting_pending",
    attemptId:mockContract.attemptId,paymentIntentId:"pi_owned",recorded:true});
  const call=mockDb.opsFor("record_full_server_payment_receipt_v1")[0];
  expect(call.payload).toMatchObject({p_attempt_id:mockContract.attemptId,p_buyer_id:mockContract.buyerId,
    p_proof:{checkoutSessionId:null,paymentIntentId:"pi_owned",amountCents:3333}});
  expect(JSON.stringify(call.payload)).not.toContain("client_secret");
});
test("lost recording reply recovery reports existing evidence without claiming fulfillment",async()=>{
  mockSaved.data.recorded=false;expect(await recordFullServerPaymentCapture(recordArgs())).toMatchObject({recorded:false,status:"capture_recorded_accounting_pending"});
});
test("disabled recording cannot call provider or writer",async()=>{
  await expect(recordFullServerPaymentCapture(args())).rejects.toThrow();expect(mockIntent).not.toHaveBeenCalled();
  expect(mockDb.opsFor("record_full_server_payment_receipt_v1")).toHaveLength(0);
});
test.each(["database error","wrong receipt","missing pending indicator"])("%s cannot be reported as recorded capture",async issue=>{
  if(issue==="database error")mockSaved={data:null,error:{message:"rejected"}};
  if(issue==="wrong receipt")mockSaved.data.paymentIntentId="pi_other";
  if(issue==="missing pending indicator")delete mockSaved.data.accountingRequired;
  await expect(recordFullServerPaymentCapture(recordArgs())).rejects.toThrow();
});

const accountArgs=()=>({...recordArgs(),env:{...recordArgs().env,CREATOR_FULL_SERVER_PAYMENT_ACCOUNTING_SCHEMA_READY:"true",CREATOR_FULL_SERVER_PAYMENT_ACCOUNTING_READY:"true"}});
test("first accounting observes and records the original before invoking atomic existing-engine accounting",async()=>{
  expect(await accountFullServerPayment(accountArgs())).toMatchObject({status:"original_capture_accounted",purchaseStatus:"paid",accounted:true});
  const order=mockDb.ops.map(o=>o.table);expect(order.indexOf("record_full_server_payment_receipt_v1")).toBeLessThan(order.indexOf("account_full_server_payment_receipt_v1"));
});
test("already accounted recovery after reversal does not re-read clean provider state or re-record a receipt",async()=>{
  mockReceipt={attempt_id:mockContract.attemptId,accounted_at:new Date().toISOString(),proof:{buyerId:mockContract.buyerId}};
  mockAccounted.data={...mockAccounted.data,accounted:false,purchaseStatus:"refunded"};
  expect(await accountFullServerPayment({...args(),env:{CREATOR_FULL_SERVER_PAYMENT_ACCOUNTING_SCHEMA_READY:"true"}}))
    .toMatchObject({purchaseStatus:"refunded",accounted:false});
  expect(mockIntent).not.toHaveBeenCalled();expect(mockDb.opsFor("record_full_server_payment_receipt_v1")).toHaveLength(0);
});
test("accounting gate rollback blocks first credit",async()=>{
  await expect(accountFullServerPayment({...accountArgs(),env:{...accountArgs().env,CREATOR_FULL_SERVER_PAYMENT_ACCOUNTING_READY:"false"}})).rejects.toThrow();
  expect(mockDb.opsFor("account_full_server_payment_receipt_v1")).toHaveLength(0);expect(mockIntent).not.toHaveBeenCalled();
});
test("atomic accounting failure remains an error after the original receipt was saved",async()=>{
  mockAccounted={data:null,error:{message:"financial reconciliation"}};
  await expect(accountFullServerPayment(accountArgs())).rejects.toThrow("Full payment accounting requires review");
  expect(mockDb.opsFor("record_full_server_payment_receipt_v1")).toHaveLength(1);
});
test("recording replay reports existing completed accounting without claiming pending work",async()=>{
  mockSaved.data.recorded=false;mockSaved.data.accountingRequired=false;
  expect(await recordFullServerPaymentCapture(recordArgs())).toMatchObject({status:"capture_already_accounted",recorded:false});
});

test.each(["intent","charge","mode"])("event %s mismatch is rejected before receipt/accounting writes",async issue=>{
  const expectedEvent={paymentIntentId:issue==="intent"?"pi_other":"pi_owned",chargeId:issue==="charge"?"ch_other":"ch_owned",livemode:issue==="mode"};
  await expect(accountFullServerPayment({...accountArgs(),expectedEvent})).rejects.toThrow();
  expect(mockDb.opsFor("record_full_server_payment_receipt_v1")).toHaveLength(0);expect(mockDb.opsFor("account_full_server_payment_receipt_v1")).toHaveLength(0);
});
test("accounted replay still binds the signed event to the saved original charge",async()=>{
  mockReceipt={attempt_id:mockContract.attemptId,accounted_at:new Date().toISOString(),proof:{buyerId:mockContract.buyerId,
    paymentIntentId:"pi_owned",chargeId:"ch_owned",context:mockContract.context}};
  await expect(accountFullServerPayment({...accountArgs(),expectedEvent:{paymentIntentId:"pi_owned",chargeId:"ch_other",livemode:false}})).rejects.toThrow();
  expect(mockDb.opsFor("account_full_server_payment_receipt_v1")).toHaveLength(0);expect(mockIntent).not.toHaveBeenCalled();
});
