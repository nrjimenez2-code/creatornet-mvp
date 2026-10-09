import { buyerFirstCaptureFixture } from "../test-support/buyer-mentorship-receipt-fixture";
const mockInspect = jest.fn(), mockObserve = jest.fn(), mockRpc = jest.fn();
jest.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: mockRpc }) }));
jest.mock("@/lib/mentorshipInstallmentReceipt", () => ({ inspectBuyerMentorshipFirstPayment: (...a: unknown[]) => mockInspect(...a) }));
jest.mock("@/lib/installments/contextServer", () => ({ exactContextServerConfig: () => ({ configuredSupabaseUrl: "https://fixture.supabase.co", supabaseServiceKey: "synthetic" }) }));
jest.mock("@/lib/installments/contextRuntime", () => ({ createExactContextRuntime: () => ({ observeContext: mockObserve }) }));
import { recordBuyerMentorshipFirstPayment } from "@/lib/mentorshipInstallmentAccounting";
const fixture = buyerFirstCaptureFixture();
const proof = { buyerId: fixture.reservation.buyerId, requestId: fixture.reservation.requestId,
  reservationId: fixture.reservation.id, context: fixture.context,customerId:"cus_owned",
  checkoutSessionId:"cs_test_owned",paymentIntentId:"pi_owned",chargeId:"ch_owned" };
const reply = { recorded: true, reservationId: proof.reservationId, purchaseId: fixture.reservation.attemptId,
  ledgerId: "10000000-0000-4000-8000-000000000099" };
const env = { CREATOR_MENTORSHIP_INSTALLMENT_RECEIPT_SCHEMA_READY: "true", CREATOR_MENTORSHIP_INSTALLMENT_RECEIPT_READY: "true" };
const args = { buyerId: proof.buyerId, requestId: proof.requestId, env };
beforeEach(() => {
  jest.resetAllMocks(); mockInspect.mockResolvedValue(proof);
  mockObserve.mockResolvedValue({ contextEvidence: fixture.contextEvidence });
  mockRpc.mockResolvedValue({ data: reply, error: null });
});
test("reobserves context after capture inspection and submits unchanged proof to atomic RPC", async () => {
  expect(await recordBuyerMentorshipFirstPayment(args)).toEqual(reply);
  expect(mockObserve.mock.invocationCallOrder[0]).toBeGreaterThan(mockInspect.mock.invocationCallOrder[0]);
  expect(mockRpc).toHaveBeenCalledWith("record_buyer_mentorship_first_receipt_v1", {
    p_request_id: proof.requestId,p_buyer_id:proof.buyerId,p_context:proof.context,p_proof:proof,
  });
});
test("disabled gates do no provider or database work", async () => {
  await expect(recordBuyerMentorshipFirstPayment({...args,env:{}})).rejects.toThrow("requires review");
  expect(mockInspect).not.toHaveBeenCalled(); expect(mockRpc).not.toHaveBeenCalled();
});
test("foreign proof cannot be recorded", async () => {
  mockInspect.mockResolvedValue({...proof,buyerId:reply.ledgerId});
  await expect(recordBuyerMentorshipFirstPayment(args)).rejects.toThrow(); expect(mockRpc).not.toHaveBeenCalled();
});
test("changed observed platform blocks accounting", async () => {
  mockObserve.mockResolvedValue({contextEvidence:{...fixture.contextEvidence,observedPlatformAccountId:"acct_other"}});
  await expect(recordBuyerMentorshipFirstPayment(args)).rejects.toThrow(); expect(mockRpc).not.toHaveBeenCalled();
});
test.each([{data:null,error:{message:"private"}}, {data:{...reply,purchaseId:"invalid"},error:null}])("uncertain database reply requires original-operation recovery", async result => {
  mockRpc.mockResolvedValue(result); await expect(recordBuyerMentorshipFirstPayment(args)).rejects.toThrow("Buyer installment receipt accounting requires review");
  expect(mockRpc).toHaveBeenCalledTimes(1);
});
test("duplicate recorded=false remains a valid immutable receipt result", async () => {
  mockRpc.mockResolvedValue({data:{...reply,recorded:false},error:null});
  expect(await recordBuyerMentorshipFirstPayment(args)).toEqual({...reply,recorded:false});
});
const expectedEvent={reservationId:proof.reservationId,customerId:proof.customerId,livemode:false,object:"charge" as const,id:"ch_owned"};
test("signed first-charge identity must match fresh capture proof",async()=>{
  expect(await recordBuyerMentorshipFirstPayment({...args,expectedEvent})).toEqual(reply);
});
test.each([{id:"ch_other"},{customerId:"cus_other"},{livemode:true},{reservationId:reply.ledgerId}])("event mismatch %p cannot credit the original purchase",async change=>{
  await expect(recordBuyerMentorshipFirstPayment({...args,expectedEvent:{...expectedEvent,...change}})).rejects.toThrow();
  expect(mockRpc).not.toHaveBeenCalled();
});
test("manual capture uses the same atomic writer only with its own write gate",async()=>{
  const manual={...proof,checkoutSessionId:null,manualPayment:{attemptId:fixture.reservation.attemptId,confirmationOperationId:fixture.reservation.requestId}};
  mockInspect.mockResolvedValue(manual);
  await expect(recordBuyerMentorshipFirstPayment(args)).rejects.toThrow("requires review");expect(mockRpc).not.toHaveBeenCalled();
  expect(await recordBuyerMentorshipFirstPayment({...args,env:{...env,CREATOR_SERVER_PAYMENT_RECEIPT_READY:"true"},expectedEvent})).toEqual(reply);
  expect(mockRpc).toHaveBeenCalledWith("record_buyer_mentorship_first_receipt_v1",expect.objectContaining({p_proof:manual}));
});
test("a hosted-session event cannot be credited through a manual source",async()=>{
  mockInspect.mockResolvedValue({...proof,checkoutSessionId:null,manualPayment:{attemptId:fixture.reservation.attemptId,confirmationOperationId:fixture.reservation.requestId}});
  await expect(recordBuyerMentorshipFirstPayment({...args,env:{...env,CREATOR_SERVER_PAYMENT_RECEIPT_READY:"true"},
    expectedEvent:{...expectedEvent,object:"checkout.session",id:"cs_test_owned"}})).rejects.toThrow();
  expect(mockRpc).not.toHaveBeenCalled();
});
