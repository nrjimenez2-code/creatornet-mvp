import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {inspectBuyerMentorshipFirstCapture} from "../lib/mentorshipInstallmentReceipt";
const mockObserve=jest.fn(),mockReservation=jest.fn(),mockRpc=jest.fn(),mockConfirm=jest.fn();
const mockInspectFirst=jest.fn();
const mockInspectLater=jest.fn(),mockAdmission=jest.fn();
jest.mock("@/lib/mentorshipInstallmentReconciliation",()=>({inspectBuyerMentorshipAdmittedCapture:(...a:unknown[])=>mockInspectLater(...a)}));
jest.mock("@/lib/mentorshipInstallmentReceipt",()=>({...jest.requireActual("@/lib/mentorshipInstallmentReceipt"),
  inspectBuyerMentorshipFirstPayment:(...a:unknown[])=>mockInspectFirst(...a)}));
let config:any,api:any,f:ReturnType<typeof buyerFirstCaptureFixture>,saved:any,refunds:any;
jest.mock("stripe",()=>({__esModule:true,default:function(){return api;}}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>({rpc:mockRpc,from:()=>{const q:any={select:()=>q,eq:()=>q,maybeSingle:mockAdmission};return q;}})}));
jest.mock("@/lib/installments/contextServer",()=>({exactContextServerConfig:()=>config}));
jest.mock("@/lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve})}));
jest.mock("@/lib/mentorshipInstallmentReservation",()=>({readBuyerMentorshipBootstrapReservation:(...a:unknown[])=>mockReservation(...a)}));
jest.mock("@/lib/paymentRefunds",()=>({confirmAdminRefundWebhookDelivery:(...a:unknown[])=>mockConfirm(...a)}));
import {reconcileBuyerMentorshipRefund} from "../lib/mentorshipInstallmentRefund";
const env={CREATOR_MENTORSHIP_INSTALLMENT_REFUND_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_REFUND_EVENTS_READY:"true"};
const args=()=>({buyerId:f.reservation.buyerId,requestId:f.reservation.requestId,eventId:"evt_refund",paymentIntentId:"pi_owned",
  chargeId:"ch_owned",customerId:"cus_owned",livemode:false,env});
beforeEach(()=>{
  jest.resetAllMocks();f=buyerFirstCaptureFixture();
  saved={reservationId:f.reservation.id,purchaseId:"10000000-0000-4000-8000-000000000080",ledgerId:"10000000-0000-4000-8000-000000000081",
    invoiceId:null,proof:inspectBuyerMentorshipFirstCapture(f)};
  mockInspectFirst.mockResolvedValue(saved.proof);
  mockAdmission.mockResolvedValue({error:null,data:null});
  f.data.charge.amount_refunded=1000;
  config={approvedContext:f.context,configuredSupabaseUrl:f.contextEvidence.configuredSupabaseUrl,supabaseServiceKey:"synthetic",stripeSecretKey:"sk_test_synthetic"};
  mockObserve.mockResolvedValue({contextEvidence:f.contextEvidence});mockReservation.mockResolvedValue(f.reservation);
  refunds={data:[{id:"re_owned",charge:"ch_owned",payment_intent:"pi_owned",amount:1000,currency:"usd",status:"succeeded"}],has_more:false};
  api={paymentIntents:{retrieve:jest.fn(async()=>f.data.paymentIntent)},charges:{retrieve:jest.fn(async()=>f.data.charge)},
    balanceTransactions:{retrieve:jest.fn(async()=>f.data.balance)},refunds:{list:jest.fn(async()=>refunds),create:jest.fn()}};
  mockRpc.mockImplementation(async(name)=>({error:null,data:name==="read_buyer_mentorship_credited_payment_v1"?saved:
    name==="hold_buyer_mentorship_refund_v1"?f.reservation.id:{reservationId:f.reservation.id,cumulativeRefundedCents:1000,reversedCents:842}}));
});
afterEach(()=>expect(api.refunds.create).not.toHaveBeenCalled());
test("uses original receipt and shared provider evidence before existing cumulative reversal",async()=>{
  expect(await reconcileBuyerMentorshipRefund(args())).toMatchObject({status:"refund_reconciled",paymentNumber:1,cumulativeRefundedCents:1000});
  expect(mockRpc.mock.calls.map(([name])=>name)).toEqual(["read_buyer_mentorship_credited_payment_v1","hold_buyer_mentorship_refund_v1","apply_buyer_mentorship_refund_v1"]);
  expect(mockRpc.mock.invocationCallOrder[1]).toBeLessThan(api.paymentIntents.retrieve.mock.invocationCallOrder[0]);
  expect(mockConfirm.mock.invocationCallOrder[0]).toBeGreaterThan(mockRpc.mock.invocationCallOrder[2]);
});
test("lost apply reply retries same original payment without creating a refund",async()=>{
  const rpc=mockRpc.getMockImplementation()!;let first=true;
  mockRpc.mockImplementation(async(name,p)=>{if(name==="apply_buyer_mentorship_refund_v1" && first){first=false;throw Error("lost reply");}return rpc(name,p);});
  await expect(reconcileBuyerMentorshipRefund(args())).rejects.toThrow("requires review");
  expect((await reconcileBuyerMentorshipRefund(args())).status).toBe("refund_reconciled");
  const calls=mockRpc.mock.calls.filter(([name])=>name==="apply_buyer_mentorship_refund_v1");expect(calls[1]).toEqual(calls[0]);
});

test("refund preceding first receipt uses original capture inspection and one atomic accounting call",async()=>{
  saved=null;
  expect((await reconcileBuyerMentorshipRefund({...args(),env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_REFUND_RECOVERY_READY:"true"}})).status).toBe("refund_reconciled");
  expect(mockInspectFirst).toHaveBeenCalledWith(expect.objectContaining({buyerId:f.reservation.buyerId,requestId:f.reservation.requestId,financialInspection:"refund"}));
  expect(mockRpc.mock.calls.map(([name])=>name)).toEqual(["read_buyer_mentorship_credited_payment_v1","record_buyer_mentorship_refunded_capture_v1"]);
  expect(mockRpc.mock.calls[1][1]).toMatchObject({p_event_id:"evt_refund",p_refunded_cents:1000,p_proof:{paymentIntentId:"pi_owned",chargeId:"ch_owned"}});
  expect(api.refunds.list.mock.invocationCallOrder[0]).toBeLessThan(mockRpc.mock.invocationCallOrder[1]);
});
test("refund preceding later receipt resolves only its original admission",async()=>{
  const proof={...saved.proof,version:"buyer-mentorship-later-capture-v1",paymentNumber:2,invoiceId:"in_owned"};
  mockInspectLater.mockResolvedValue({status:"captured",proof});
  mockAdmission.mockResolvedValue({error:null,data:{reservation_id:f.reservation.id,invoice_id:"in_owned",payment_intent_id:"pi_owned"}});
  saved=null;
  expect((await reconcileBuyerMentorshipRefund({...args(),env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_REFUND_RECOVERY_READY:"true"}})).status).toBe("refund_reconciled");
  expect(mockInspectFirst).not.toHaveBeenCalled();
  expect(mockInspectLater).toHaveBeenCalledWith(expect.objectContaining({invoiceId:"in_owned",financialInspection:"refund"}));
  expect(mockRpc.mock.calls[1][0]).toBe("hold_buyer_mentorship_refund_v1");
  expect(mockRpc.mock.calls[2][1]).toMatchObject({p_proof:{paymentNumber:2,invoiceId:"in_owned"}});
});
test.each(["foreign original capture","pending refund","provider unavailable"])("early refund %s cannot write a receipt",async problem=>{
  if(problem==="foreign original capture")mockInspectFirst.mockResolvedValue({...saved.proof,paymentIntentId:"pi_other"});
  saved=null;
  if(problem==="pending refund")refunds.data[0].status="pending";
  if(problem==="provider unavailable")api.charges.retrieve.mockRejectedValue(Error("unavailable"));
  const result=reconcileBuyerMentorshipRefund({...args(),env:{...env,CREATOR_MENTORSHIP_INSTALLMENT_REFUND_RECOVERY_READY:"true"}});
  if(problem==="pending refund")expect((await result).status).toBe("reconciliation_required");
  else await expect(result).rejects.toThrow("requires review");
  expect(mockRpc.mock.calls.map(([name])=>name)).toEqual(["read_buyer_mentorship_credited_payment_v1"]);
});
test.each(["pending refund","sum mismatch","missing receipt"])("%s remains unresolved and cannot apply accounting",async problem=>{
  if(problem==="pending refund")refunds.data[0].status="pending";
  if(problem==="sum mismatch")refunds.data[0].amount=999;
  if(problem==="missing receipt")saved=null;
  expect((await reconcileBuyerMentorshipRefund(args())).status).toBe("reconciliation_required");
  expect(mockRpc.mock.calls.some(([name])=>name==="apply_buyer_mentorship_refund_v1")).toBe(false);expect(mockConfirm).not.toHaveBeenCalled();
});
test.each(["disabled","foreign customer","wrong fee","wrong capture","changed balance","foreign refund","provider unavailable","hold failure"])("%s cannot reverse earnings",async problem=>{
  if(problem==="foreign customer")f.data.paymentIntent.customer="cus_other";
  if(problem==="wrong fee")f.data.paymentIntent.application_fee_amount=1;
  if(problem==="wrong capture")f.data.charge.captured=false;
  if(problem==="changed balance")f.data.balance.fee=1;
  if(problem==="foreign refund")refunds.data[0].payment_intent="pi_other";
  if(problem==="provider unavailable")api.paymentIntents.retrieve.mockRejectedValue(Error("unavailable"));
  if(problem==="hold failure"){const rpc=mockRpc.getMockImplementation()!;mockRpc.mockImplementation((name,p)=>name==="hold_buyer_mentorship_refund_v1"?{error:{message:"unavailable"}}:rpc(name,p));}
  await expect(reconcileBuyerMentorshipRefund({...args(),...(problem==="disabled"?{env:{}}:{})})).rejects.toThrow("requires review");
  expect(mockRpc.mock.calls.some(([name])=>name==="apply_buyer_mentorship_refund_v1")).toBe(false);
  if(problem==="hold failure")expect(api.paymentIntents.retrieve).not.toHaveBeenCalled();
});
