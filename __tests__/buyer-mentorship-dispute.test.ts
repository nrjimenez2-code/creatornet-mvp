import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {inspectBuyerMentorshipFirstCapture} from "../lib/mentorshipInstallmentReceipt";
const mockObserve=jest.fn(),mockReservation=jest.fn(),mockRpc=jest.fn();
const mockInspectFirst=jest.fn(),mockAdmission=jest.fn();
jest.mock("@/lib/mentorshipInstallmentReceipt",()=>({...jest.requireActual("@/lib/mentorshipInstallmentReceipt"),
  inspectBuyerMentorshipFirstPayment:(...a:unknown[])=>mockInspectFirst(...a)}));
let config:any,api:any,f:ReturnType<typeof buyerFirstCaptureFixture>,saved:any,dispute:any;
jest.mock("stripe",()=>({__esModule:true,default:function(){return api;}}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>({rpc:mockRpc,from:()=>{const q:any={select:()=>q,eq:()=>q,maybeSingle:mockAdmission};return q;}})}));
jest.mock("@/lib/installments/contextServer",()=>({exactContextServerConfig:()=>config}));
jest.mock("@/lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve})}));
jest.mock("@/lib/mentorshipInstallmentReservation",()=>({readBuyerMentorshipBootstrapReservation:(...a:unknown[])=>mockReservation(...a)}));
import {observeBuyerMentorshipDispute} from "../lib/mentorshipInstallmentDispute";
const env={CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_EVENTS_READY:"true"};
const args=()=>({buyerId:f.reservation.buyerId,requestId:f.reservation.requestId,eventId:"evt_dispute",eventCreated:100,disputeId:"du_owned",
  paymentIntentId:"pi_owned",chargeId:"ch_owned",customerId:"cus_owned",livemode:false,env});
beforeEach(()=>{
  jest.resetAllMocks();f=buyerFirstCaptureFixture();
  saved={reservationId:f.reservation.id,purchaseId:"10000000-0000-4000-8000-000000000080",ledgerId:"10000000-0000-4000-8000-000000000081",
    invoiceId:null,proof:inspectBuyerMentorshipFirstCapture(f)};
  f.data.charge.disputed=true;
  mockInspectFirst.mockResolvedValue(saved.proof);mockAdmission.mockResolvedValue({error:null,data:null});
  config={approvedContext:f.context,configuredSupabaseUrl:f.contextEvidence.configuredSupabaseUrl,supabaseServiceKey:"synthetic",stripeSecretKey:"sk_test_synthetic"};
  mockObserve.mockResolvedValue({contextEvidence:f.contextEvidence});mockReservation.mockResolvedValue(f.reservation);
  dispute={object:"dispute",id:"du_owned",livemode:false,currency:"usd",payment_intent:"pi_owned",charge:"ch_owned",amount:1000,status:"under_review"};
  api={disputes:{retrieve:jest.fn(async()=>dispute)},paymentIntents:{retrieve:jest.fn(async()=>f.data.paymentIntent)},
    charges:{retrieve:jest.fn(async()=>f.data.charge)},balanceTransactions:{retrieve:jest.fn(async()=>f.data.balance)}};
  mockRpc.mockImplementation(async(name)=>({error:null,data:name==="read_buyer_mentorship_credited_payment_v1"?saved:
    name==="hold_buyer_mentorship_dispute_v1"?{revision:7,basis:[]}:"dispute_observed"}));
});
test("current dispute observation uses original capture, durable hold and saved revision",async()=>{
  expect((await observeBuyerMentorshipDispute(args())).status).toBe("dispute_observed");
  expect(mockRpc.mock.calls.map(([name])=>name)).toEqual(["read_buyer_mentorship_credited_payment_v1","hold_buyer_mentorship_dispute_v1","apply_buyer_mentorship_dispute_v1"]);
  expect(mockRpc.mock.invocationCallOrder[1]).toBeLessThan(api.disputes.retrieve.mock.invocationCallOrder[0]);
  expect(mockRpc.mock.calls[2][1]).toMatchObject({p_read:{revision:7,basis:[]},p_status:"under_review",p_disputed_cents:1000,p_event_created:100});
});
test.each(["reconciliation_required","dispute_review_recorded"])("database %s is preserved without fabricating resolution",async status=>{
  const original=mockRpc.getMockImplementation()!;
  mockRpc.mockImplementation((name,p)=>name==="apply_buyer_mentorship_dispute_v1"?{error:null,data:status}:original(name,p));
  expect((await observeBuyerMentorshipDispute(args())).status).toBe(status);
});
test("missing receipt stays unresolved rather than adopting a legacy ledger",async()=>{
  saved=null;expect((await observeBuyerMentorshipDispute(args())).status).toBe("reconciliation_required");
  expect(mockRpc).toHaveBeenCalledTimes(1);expect(api.disputes.retrieve).not.toHaveBeenCalled();
});
test.each(["wrong dispute","wrong charge","wrong mode","unknown status","foreign customer","wrong fee","changed balance","provider outage","hold failure"])("%s cannot write dispute audit",async problem=>{
  if(problem==="wrong dispute")dispute.id="du_other";
  if(problem==="wrong charge")dispute.charge="ch_other";
  if(problem==="wrong mode")dispute.livemode=true;
  if(problem==="unknown status")dispute.status="new_unknown";
  if(problem==="foreign customer")f.data.paymentIntent.customer="cus_other";
  if(problem==="wrong fee")f.data.paymentIntent.application_fee_amount=1;
  if(problem==="changed balance")f.data.balance.fee=1;
  if(problem==="provider outage")api.disputes.retrieve.mockRejectedValue(Error("unavailable"));
  if(problem==="hold failure"){const original=mockRpc.getMockImplementation()!;mockRpc.mockImplementation((name,p)=>name==="hold_buyer_mentorship_dispute_v1"?{error:{message:"unavailable"}}:original(name,p));}
  await expect(observeBuyerMentorshipDispute(args())).rejects.toThrow("requires review");
  expect(mockRpc.mock.calls.some(([name])=>name==="apply_buyer_mentorship_dispute_v1")).toBe(false);
});

test("early dispute uses original capture proof and one receipt/audit transaction",async()=>{
  saved=null;
  expect((await observeBuyerMentorshipDispute({...args(),env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_DISPUTE_RECOVERY_READY:"true"}})).status).toBe("dispute_observed");
  expect(mockInspectFirst).toHaveBeenCalledWith(expect.objectContaining({financialInspection:"dispute",buyerId:f.reservation.buyerId}));
  expect(mockRpc.mock.calls.map(([name])=>name)).toEqual(["read_buyer_mentorship_credited_payment_v1","record_buyer_mentorship_disputed_capture_v1"]);
  expect(mockRpc.mock.calls[1][1]).toMatchObject({p_proof:{paymentIntentId:"pi_owned"},p_dispute_id:"du_owned",p_status:"under_review"});
});
