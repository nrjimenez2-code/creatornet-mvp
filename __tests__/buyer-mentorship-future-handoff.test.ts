import {createMockClient} from "./__mocks__/supabaseQueryMock";
const mockOriginal=jest.fn(),mockResume=jest.fn(),mockSame=jest.fn();
jest.mock("../lib/mentorshipInstallmentReconciliation",()=>({readBuyerMentorshipAdmittedPayment:(...a:unknown[])=>mockOriginal(...a)}));
jest.mock("../lib/mentorshipInstallmentFutureCard",()=>({resumeBuyerMentorshipFutureCollection:(...a:unknown[])=>mockResume(...a)}));
jest.mock("../lib/mentorshipInstallmentSameCard",()=>({resumeBuyerMentorshipSameCard:(...a:unknown[])=>mockSame(...a)}));
import {handoffBuyerMentorshipPaidFutureCollection} from "../lib/mentorshipInstallmentPaymentRecovery";
let args:any,rows:Record<string,any>;
beforeEach(()=>{
  jest.resetAllMocks();
  args={buyerId:"buyer",requestId:"request",invoiceId:"in_due",env:{
    CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_RESUME_HANDOFF_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_RETRY_SCHEMA_READY:"true"}};
  rows={buyer_mentorship_retry_admissions_v1:{quote_id:"quote",reservation_id:"reservation",payment_number:2,invoice_id:"in_due",payment_intent_id:"pi_due"},
    buyer_mentorship_retry_consents_v1:{quote_id:"quote",future_card_accepted:true}};
  const db=createMockClient(op=>({error:null,data:rows[op.table]??null}));
  mockOriginal.mockResolvedValue({admin:db,r:{id:"reservation"},a:{paymentNumber:2,invoiceId:"in_due"},paymentIntentId:"pi_due"});
  mockResume.mockResolvedValue({status:"collection_resumed"});
});
test("uses the saved admitted quote for the existing receipt-backed release",async()=>{
  expect(await handoffBuyerMentorshipPaidFutureCollection(args)).toBe("collection_resumed");
  expect(mockResume).toHaveBeenCalledWith({...args,quoteId:"quote"});
});
test.each(["disabled","schema","no_retry","declined_consent","missing_consent","foreign_consent","foreign_invoice","foreign_reservation","foreign_period","foreign_intent"])("does not resume for %s",async(kind)=>{
  if(kind==="disabled")args.env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_RESUME_HANDOFF_READY="false";
  if(kind==="schema")args.env.CREATOR_MENTORSHIP_INSTALLMENT_RETRY_SCHEMA_READY="false";
  if(kind==="no_retry")delete rows.buyer_mentorship_retry_admissions_v1;
  if(kind==="declined_consent")rows.buyer_mentorship_retry_consents_v1.future_card_accepted=false;
  if(kind==="missing_consent")delete rows.buyer_mentorship_retry_consents_v1;
  if(kind==="foreign_consent")rows.buyer_mentorship_retry_consents_v1.quote_id="other";
  const fields:Record<string,string>={foreign_invoice:"invoice_id",foreign_reservation:"reservation_id",foreign_period:"payment_number",foreign_intent:"payment_intent_id"};
  if(fields[kind])rows.buyer_mentorship_retry_admissions_v1[fields[kind]]="other";
  const result=await handoffBuyerMentorshipPaidFutureCollection(args);
  expect(result).toBe(kind==="disabled"?"disabled":["no_retry","declined_consent"].includes(kind)?"not_requested":"review_required");
  expect(mockResume).not.toHaveBeenCalled();
});
test("a failed or uncertain release remains reviewable without another payment",async()=>{
  mockResume.mockRejectedValue(Error("lost release acknowledgement"));
  expect(await handoffBuyerMentorshipPaidFutureCollection(args)).toBe("review_required");
  expect(mockResume).toHaveBeenCalledTimes(1);
});


test.each(["resumed","lost reply","complete"])("original-card handoff: %s",async kind=>{
  delete rows.buyer_mentorship_retry_admissions_v1;
  args.env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_RESUME_HANDOFF_READY="false";
  args.env.CREATOR_MENTORSHIP_INSTALLMENT_SAME_CARD_RECOVERY_READY="true";
  if(kind==="lost reply")mockSame.mockRejectedValue(Error("lost reply"));
  else mockSame.mockResolvedValue(kind==="complete"?"complete":"collection_resumed");
  expect(await handoffBuyerMentorshipPaidFutureCollection(args)).toBe(kind==="lost reply"?"review_required":kind==="complete"?"complete":"collection_resumed");
  expect(mockSame).toHaveBeenCalledWith(args);expect(mockResume).not.toHaveBeenCalled();
});
test("replacement attempt cannot enter same-card path when future-consent release is disabled",async()=>{
  args.env.CREATOR_MENTORSHIP_INSTALLMENT_FUTURE_RESUME_HANDOFF_READY="false";
  args.env.CREATOR_MENTORSHIP_INSTALLMENT_SAME_CARD_RECOVERY_READY="true";
  expect(await handoffBuyerMentorshipPaidFutureCollection(args)).toBe("review_required");
  expect(mockSame).not.toHaveBeenCalled();expect(mockResume).not.toHaveBeenCalled();
});
