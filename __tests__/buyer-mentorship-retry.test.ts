import {buyerFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {calculateInstallmentPlan} from "../lib/installmentPlan";
import {createMockClient} from "./__mocks__/supabaseQueryMock";
const mockOriginal=jest.fn(),mockCurrent=jest.fn(),mockCard=jest.fn(),mockUnpaid=jest.fn(),mockRecover=jest.fn();
jest.mock("../lib/mentorshipInstallmentReconciliation",()=>({readBuyerMentorshipAdmittedPayment:(...a:unknown[])=>mockOriginal(...a)}));
jest.mock("../lib/mentorshipInstallmentPaymentRecovery",()=>({readBuyerMentorshipRecoveryAction:(...a:unknown[])=>mockCurrent(...a),recoverBuyerMentorshipPayment:(...a:unknown[])=>mockRecover(...a)}));
jest.mock("../lib/mentorshipInstallmentCardSetup",()=>({verifyBuyerMentorshipSavedCard:(...a:unknown[])=>mockCard(...a)}));
jest.mock("../lib/installments/cardRecovery",()=>({inspectExactCardSetupUnpaid:(...a:unknown[])=>mockUnpaid(...a)}));
import {executeBuyerMentorshipRetry,reviewBuyerMentorshipRetry,readBuyerMentorshipRetryReview} from "../lib/mentorshipInstallmentRetry";
let o:any,q:any,args:any,admission:any,prior:any,pay:jest.Mock,rpc:jest.Mock,rows:Record<string,any>;
beforeEach(()=>{
  jest.resetAllMocks();jest.useFakeTimers({now:1789976000000});
  const f=buyerFirstCaptureFixture(),r=f.reservation,now=Date.now()/1000;
  const a={protocol:"buyer-mentorship-installments-v1",planId:r.id,buyerReservationId:r.id,buyerRequestId:r.requestId,
    invoiceId:"in_due",subscriptionId:"sub_owned",subscriptionItemId:"si_owned",customerId:"cus_owned",destinationId:r.destinationId,
    currency:"usd",totalCents:10001,paymentCount:3,paymentNumber:2,periodStart:now-100,periodEnd:now+2000,cancelAt:now+4000,feeSchedule:r.terms.renewalFeeSchedule};
  const quoteId="10000000-0000-4000-8000-000000000088",setupId="10000000-0000-4000-8000-000000000099";
  args={buyerId:r.buyerId,requestId:r.requestId,invoiceId:"in_due",setupId,quoteId,
    consent:{accepted:true,consentVersion:"single-invoice-pay-now-v1"},env:{CREATOR_MENTORSHIP_INSTALLMENT_RETRY_SCHEMA_READY:"true",
      CREATOR_MENTORSHIP_INSTALLMENT_RETRY_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_RETRY_RECEIPT_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_RETRY_RECOVERY_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_RECOVERY_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_LATER_RECEIPT_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_RECONCILIATION_READY:"true"}};
  const card={setup_id:setupId,setup_intent_id:"seti_owned",payment_method_id:"pm_replacement",billing_country:"US"};
  q={id:quoteId,setup_id:setupId,reservation_id:r.id,buyer_id:r.buyerId,payment_number:2,invoice_id:"in_due",original_payment_intent_id:"pi_due",
    replacement_payment_method_id:"pm_replacement",setup_intent_id:"seti_owned",amount_cents:3333,consent_version:"single-invoice-pay-now-v1",
    authorization_snapshot:{...a,paymentMethodId:"pm_owned"},created_at:new Date((now-10)*1000).toISOString(),expires_at:now+200,future_card_option:false,future_card_periods:null};
  prior=null;pay=jest.fn();
  admission={quote_id:quoteId,reservation_id:r.id,invoice_id:"in_due",payment_intent_id:"pi_due",payment_method_id:"pm_replacement",
    request:{apiVersion:"2025-10-29.clover",method:"POST",path:"/v1/invoices/in_due/pay",params:{payment_method:"pm_replacement",off_session:false}},
    idempotency_key:`cn-buyer-retry-v1:${quoteId}`,dispatch_before:new Date(Date.now()+25000).toISOString()};
  rows={buyer_mentorship_saved_card_proofs_v1:card,buyer_mentorship_retry_quotes_v1:q};
  const db=createMockClient(op=>({error:null,data:op.table==="buyer_mentorship_retry_admissions_v1"?prior:rows[op.table]}));
  rpc=jest.fn(async(name:string)=>({error:null,data:name==="quote_buyer_mentorship_retry_v1"?{paymentAllowed:false,quote:q}:
    name==="confirm_buyer_mentorship_retry_v1"?{paymentAllowed:false,quote:q,consent:{quote_id:quoteId,future_card_accepted:false}}:
    {status:"dispatch_once",admission}}));
  o={r,a,context:f.context,paymentMethodId:"pm_owned",paymentIntentId:"pi_due",payment:calculateInstallmentPlan(10001,3,a.feeSchedule).payments[1],
    admin:{from:db.from,rpc},stripe:{invoices:{pay}},contract:{},bound:{revision:1},assertFresh:jest.fn()};
  mockOriginal.mockResolvedValue(o);mockCurrent.mockResolvedValue(o);mockCard.mockResolvedValue({status:"card_saved_payment_not_attempted"});
  mockRecover.mockResolvedValue({status:"reconciliation_required"});
});
afterEach(()=>jest.useRealTimers());
test("review uses original exact amount without confirming or dispatching",async()=>{
  expect(await reviewBuyerMentorshipRetry(args)).toMatchObject({status:"payment_review",quote:{amountCents:3333,paymentNumber:2,confirmed:false}});
  expect(rpc).toHaveBeenCalledTimes(1);expect(pay).not.toHaveBeenCalled();
});
test("explicit consent dispatches once with original request then always reconciles",async()=>{
  expect(await executeBuyerMentorshipRetry(args)).toEqual({status:"reconciliation_required"});
  expect(pay).toHaveBeenCalledWith("in_due",{payment_method:"pm_replacement",off_session:false},expect.objectContaining({idempotencyKey:admission.idempotency_key,maxNetworkRetries:0}));
  expect(pay).toHaveBeenCalledTimes(1);expect(mockRecover).toHaveBeenCalledTimes(1);
});
test("existing admission skips all payment preparation even after outcome changes",async()=>{
  prior={quote_id:args.quoteId};await executeBuyerMentorshipRetry(args);
  expect(mockCurrent).not.toHaveBeenCalled();expect(mockCard).not.toHaveBeenCalled();expect(pay).not.toHaveBeenCalled();expect(mockRecover).toHaveBeenCalledTimes(1);
});
test("uncertain provider response reconciles without a second dispatch",async()=>{
  pay.mockRejectedValueOnce(Error("timeout"));await executeBuyerMentorshipRetry(args);
  expect(pay).toHaveBeenCalledTimes(1);expect(mockRecover).toHaveBeenCalledTimes(1);
});
test.each(["no consent","wrong amount","unverified card","expired","changed request"])("%s never dispatches",async scenario=>{
  if(scenario==="no consent")args.consent={accepted:false,consentVersion:"single-invoice-pay-now-v1"};
  if(scenario==="wrong amount")q.amount_cents=1;
  if(scenario==="unverified card")mockCard.mockResolvedValue({status:"setup_pending"});
  if(scenario==="expired")q.expires_at=Date.now()/1000;
  if(scenario==="changed request")admission.request.params.off_session=true;
  await expect(executeBuyerMentorshipRetry(args)).rejects.toThrow("needs confirmation");expect(pay).not.toHaveBeenCalled();
});

test.each(["action_required","payment_method_required","payment_pending","paid_accounted"])("retry records %s through existing recovery",async outcome=>{
  mockRecover.mockResolvedValue({status:"payment_recovery_recorded",outcome});
  expect(await executeBuyerMentorshipRetry(args)).toEqual({status:"payment_recovery_recorded",outcome});
  expect(pay).toHaveBeenCalledTimes(1);expect(mockRecover).toHaveBeenCalledTimes(1);
  expect(mockRecover).toHaveBeenCalledWith(args);
});
test.each(["lost acknowledgement","SQL error"])("%s recovers original invoice without dispatch",async problem=>{
  const original=rpc.getMockImplementation()!;
  rpc.mockImplementation(async(name:string,...rest:unknown[])=>{
    if(name==="admit_buyer_mentorship_retry_v1") {
      if(problem==="lost acknowledgement")throw Error("timeout");
      return {error:{message:"unavailable"},data:null};
    }
    return original(name,...rest);
  });
  await executeBuyerMentorshipRetry(args);
  expect(pay).not.toHaveBeenCalled();expect(mockRecover).toHaveBeenCalledTimes(1);
});
test("recovery failure never redispatches an admitted retry",async()=>{
  mockRecover.mockRejectedValue(Error("read unavailable"));
  await expect(executeBuyerMentorshipRetry(args)).rejects.toThrow("needs confirmation");
  prior={quote_id:args.quoteId};
  await expect(executeBuyerMentorshipRetry(args)).rejects.toThrow("needs confirmation");
  expect(pay).toHaveBeenCalledTimes(1);expect(mockRecover).toHaveBeenCalledTimes(2);
});
test.each(["RETRY_RECOVERY_SCHEMA_READY","RECOVERY_READY","RECOVERY_SCHEMA_READY","LATER_RECEIPT_SCHEMA_READY","RECONCILIATION_READY"])("missing %s blocks payment before admission",async flag=>{
  args.env[`CREATOR_MENTORSHIP_INSTALLMENT_${flag}`]="false";
  await expect(executeBuyerMentorshipRetry(args)).rejects.toThrow("needs confirmation");
  expect(pay).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();
});

test("read-only review recovers the saved quote without provider writes or renewed consent",async()=>{
  const result=await readBuyerMentorshipRetryReview(args);
  expect(result).toMatchObject({admitted:false,quote:{id:args.quoteId,amountCents:3333,confirmed:false}});
  expect(pay).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();expect(mockCurrent).not.toHaveBeenCalled();expect(mockCard).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toMatch(/pm_replacement|pi_due|authorization_snapshot|idempotency/);
});
test("read-only review selects an admitted quote even after its review window expires",async()=>{
  prior={quote_id:args.quoteId,reservation_id:o.r.id,payment_number:2,invoice_id:"in_due",payment_intent_id:"pi_due"};
  rows.buyer_mentorship_retry_consents_v1={quote_id:args.quoteId,confirmed_at:q.created_at,future_card_accepted:false};
  jest.setSystemTime((q.expires_at+100)*1000);
  expect(await readBuyerMentorshipRetryReview(args)).toMatchObject({admitted:true,quote:{id:args.quoteId,confirmed:true}});
  expect(pay).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();
});
test.each(["foreign quote","changed amount","missing consent","different invoice"])("saved review rejects %s",async problem=>{
  prior={quote_id:args.quoteId,reservation_id:o.r.id,payment_number:2,invoice_id:"in_due",payment_intent_id:"pi_due"};
  rows.buyer_mentorship_retry_consents_v1={quote_id:args.quoteId,confirmed_at:q.created_at,future_card_accepted:false};
  if(problem==="foreign quote")q.buyer_id="another";
  if(problem==="changed amount")q.amount_cents=1;
  if(problem==="missing consent")rows.buyer_mentorship_retry_consents_v1=null;
  if(problem==="different invoice")prior.invoice_id="in_other";
  await expect(readBuyerMentorshipRetryReview(args)).rejects.toThrow("requires review");expect(pay).not.toHaveBeenCalled();
});
