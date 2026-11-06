import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
const mockInspect=jest.fn(),mockObserve=jest.fn(),mockReservation=jest.fn(),mockRpc=jest.fn(),mockFrom=jest.fn();
const mockCard=jest.fn(),mockCustomer=jest.fn(),mockSub=jest.fn(),mockUpdate=jest.fn(),mockInvoices=jest.fn();
jest.mock("stripe",()=>({__esModule:true,default:function(){return {paymentMethods:{retrieve:mockCard},customers:{retrieve:mockCustomer},
  subscriptions:{retrieve:mockSub,update:mockUpdate},invoices:{list:mockInvoices}};}}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>({rpc:mockRpc,from:mockFrom})}));
jest.mock("@/lib/installments/contextServer",()=>({exactContextServerConfig:()=>config}));
jest.mock("@/lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve})}));
jest.mock("@/lib/mentorshipInstallmentReceipt",()=>({...jest.requireActual("@/lib/mentorshipInstallmentReceipt"),inspectBuyerMentorshipFirstPayment:(...a:unknown[])=>mockInspect(...a)}));
jest.mock("@/lib/mentorshipInstallmentReservation",()=>({readBuyerMentorshipBootstrapReservation:(...a:unknown[])=>mockReservation(...a)}));
import {inspectBuyerMentorshipFirstCapture} from "../lib/mentorshipInstallmentReceipt";
import {activateBuyerMentorship} from "../lib/mentorshipInstallmentActivationRuntime";
let f:ReturnType<typeof buyerFirstCaptureFixture>,proof:ReturnType<typeof inspectBuyerMentorshipFirstCapture>,config:any,op:any;
const env={CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_ACTIVATION_READY:"true"};
const args=()=>({buyerId:f.reservation.buyerId,requestId:f.reservation.requestId,env});
beforeEach(()=>{
  jest.resetAllMocks();f=buyerFirstCaptureFixture();proof=inspectBuyerMentorshipFirstCapture(f);op=null;
  jest.useFakeTimers({now:f.nowSeconds*1000});
  config={configuredSupabaseUrl:f.contextEvidence.configuredSupabaseUrl,supabaseServiceKey:"synthetic",stripeSecretKey:"sk_test_synthetic"};
  mockInspect.mockResolvedValue(proof);mockObserve.mockResolvedValue({contextEvidence:f.contextEvidence});mockReservation.mockResolvedValue(f.reservation);
  mockCard.mockResolvedValue(f.data.paymentMethod);mockCustomer.mockResolvedValue(f.data.customer);
  (f.data.subscription as any).lastResponse={requestId:"req_readback"};mockSub.mockImplementation(async()=>f.data.subscription);
  mockInvoices.mockResolvedValue({object:"list",has_more:false,data:[]});
  mockUpdate.mockImplementation(async(_id,params)=>{
    Object.assign(f.data.subscription,{...params,billing_cycle_anchor:params.trial_end,metadata:{...f.data.subscription.metadata,...params.metadata}});
    return f.data.subscription;
  });
  mockRpc.mockImplementation(async(name,p)=>{
    if(name==="claim_buyer_mentorship_activation_v1") {
      op??={reservation_id:f.reservation.id,item_id:"si_owned",request:p.p_request,idempotency_key:"cn-buyer-activate-v1:10000000-0000-4000-8000-000000000099",
        lease_token:"10000000-0000-4000-8000-000000000098",first_dispatch_at:new Date().toISOString(),lease_until:new Date(Date.now()+75000).toISOString(),completed_at:null};
      return {error:null,data:{status:op.completed_at?"complete":"dispatch",operation:{...op},dispatchBefore:new Date(Date.now()+30000).toISOString()}};
    }
    op.completed_at=new Date().toISOString();return {error:null,data:{status:"complete",operation:{...op}}};
  });
  mockFrom.mockImplementation(table=>{
    const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>({error:null,data:table==="buyer_mentorship_bootstraps_v1"?
      {reservation_id:f.reservation.id,customer_id:proof.customerId,anchor_seconds:f.dependencies.anchorSeconds}:
      table==="buyer_mentorship_bootstrap_operations_v1"?{reservation_id:f.reservation.id,result_id:"prod_owned",bound_at:new Date().toISOString()}:op})};return q;
  });
});
afterEach(()=>jest.useRealTimers());
test("claims before mutation, updates original key, independently rereads and completes while held",async()=>{
  expect(await activateBuyerMentorship(args())).toEqual({status:"activated_held"});
  expect(mockUpdate).toHaveBeenCalledWith("sub_owned",op.request.params,{idempotencyKey:op.idempotency_key});
  expect(mockUpdate.mock.invocationCallOrder[0]).toBeGreaterThan(mockRpc.mock.invocationCallOrder[0]);
  expect(mockRpc.mock.calls[1][0]).toBe("complete_buyer_mentorship_activation_v1");
  expect(mockRpc.mock.calls[1][1].p_subscription.pause_collection).toEqual({behavior:"keep_as_draft"});
  expect(mockSub).toHaveBeenCalledTimes(3);
});
test("lost successful update response is reconciled without a second update",async()=>{
  const update=mockUpdate.getMockImplementation()!;
  mockUpdate.mockImplementationOnce(async(...a)=>{await update(...a);throw Error("reply lost");});
  await expect(activateBuyerMentorship(args())).rejects.toThrow();const key=op.idempotency_key;
  expect(await activateBuyerMentorship(args())).toEqual({status:"activated_held"});
  expect(mockUpdate).toHaveBeenCalledTimes(1);expect(op.idempotency_key).toBe(key);
});
test("lost completion response recovers by reading complete state",async()=>{
  const rpc=mockRpc.getMockImplementation()!;
  mockRpc.mockImplementation(async(...a)=>{const result=await rpc(...a);if(a[0]==="complete_buyer_mentorship_activation_v1")throw Error("reply lost");return result;});
  await expect(activateBuyerMentorship(args())).rejects.toThrow();
  expect(await activateBuyerMentorship(args())).toEqual({status:"activated_held"});expect(mockUpdate).toHaveBeenCalledTimes(1);
});
test("disabled adapter performs no reads or mutation",async()=>{
  await expect(activateBuyerMentorship({...args(),env:{}})).rejects.toThrow();expect(mockInspect).not.toHaveBeenCalled();expect(mockRpc).not.toHaveBeenCalled();
});
test.each(["busy","review_required"])("%s claim cannot mutate",async status=>{
  mockRpc.mockResolvedValue({error:null,data:{status}});expect(await activateBuyerMentorship(args())).toEqual({status});expect(mockUpdate).not.toHaveBeenCalled();
});
test("nonzero or incomplete invoice preflight blocks activation",async()=>{
  mockInvoices.mockResolvedValue({object:"list",has_more:true,data:[]});await expect(activateBuyerMentorship(args())).rejects.toThrow();
  expect(mockRpc).not.toHaveBeenCalled();expect(mockUpdate).not.toHaveBeenCalled();
});
test("changed saved card country blocks activation",async()=>{
  f.data.paymentMethod.billing_details.address!.country="CA";await expect(activateBuyerMentorship(args())).rejects.toThrow();expect(mockUpdate).not.toHaveBeenCalled();
});
test("provider readback that remains unactivated cannot complete",async()=>{
  mockUpdate.mockResolvedValue({id:"sub_owned"});await expect(activateBuyerMentorship(args())).rejects.toThrow();expect(mockRpc).toHaveBeenCalledTimes(1);
});

test("enabled initial hold release reuses verified activation without another provider mutation",async()=>{
  const rpc=mockRpc.getMockImplementation()!;
  mockRpc.mockImplementation(async(name,p)=>name==="enable_buyer_mentorship_collection_v1"?
    {data:{status:"collection_enabled",reservationId:f.reservation.id,enabledAt:new Date().toISOString()}}:rpc(name,p));
  const enabled={...args(),env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_CONTROLS_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_ENABLE_READY:"true"}};
  expect(await activateBuyerMentorship(enabled)).toEqual({status:"collection_enabled"});
  expect(mockRpc.mock.calls.map(([name])=>name)).toEqual(["claim_buyer_mentorship_activation_v1","complete_buyer_mentorship_activation_v1","enable_buyer_mentorship_collection_v1"]);
  expect(mockRpc.mock.calls[2][1].p_subscription.pause_collection).toEqual({behavior:"keep_as_draft"});
  expect(await activateBuyerMentorship(enabled)).toEqual({status:"collection_enabled"});expect(mockUpdate).toHaveBeenCalledTimes(1);
});
test("changed card before initial hold release leaves collection held",async()=>{
  const rpc=mockRpc.getMockImplementation()!;
  mockRpc.mockImplementation(async(name,p)=>{const reply=await rpc(name,p);
    if(name==="complete_buyer_mentorship_activation_v1")f.data.paymentMethod.billing_details.address!.country="CA";return reply;});
  await expect(activateBuyerMentorship({...args(),env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_CONTROLS_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_COLLECTION_ENABLE_READY:"true"}})).rejects.toThrow();
  expect(mockRpc.mock.calls.some(([name])=>name==="enable_buyer_mentorship_collection_v1")).toBe(false);
});
