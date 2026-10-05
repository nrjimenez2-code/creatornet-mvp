import type Stripe from "stripe";
import {createMockClient} from "./__mocks__/supabaseQueryMock";
const mockOwner=jest.fn(),mockFinancial=jest.fn(),mockReceipt=jest.fn(),mockContinuation=jest.fn();
jest.mock("../lib/mentorshipInstallmentWebhook",()=>({readBuyerMentorshipWebhookOwner:(...a:unknown[])=>mockOwner(...a),
  handoffBuyerMentorshipRecordedFinancialEvent:(...a:unknown[])=>mockFinancial(...a)}));
jest.mock("../lib/mentorshipInstallmentReconciliation",()=>({reconcileBuyerMentorshipInvoice:(...a:unknown[])=>mockReceipt(...a)}));
jest.mock("../lib/mentorshipInstallmentPaymentRecovery",()=>({handoffBuyerMentorshipPaidFutureCollection:(...a:unknown[])=>mockContinuation(...a)}));
import {handoffBuyerMentorshipLaterWebhook} from "../lib/mentorshipInstallmentLaterWebhook";
beforeEach(()=>{
  jest.resetAllMocks();
  mockOwner.mockResolvedValue({reservationId:"reservation",buyerId:"buyer",requestId:"request",objectId:"in_due",customerId:"cus_owned"});
  mockFinancial.mockResolvedValue(false);mockReceipt.mockResolvedValue({status:"credited"});mockContinuation.mockResolvedValue("collection_resumed");
});
test.each(["original-card release","duplicate receipt","failed release","unaccounted capture","gate off"])("paid webhook continuation: %s",async kind=>{
  const event={id:"evt_paid",type:"invoice.paid",livemode:false,data:{object:{object:"invoice",id:"in_due",customer:"cus_owned",livemode:false}}} as Stripe.Event;
  const admin=createMockClient(()=>({error:null,data:{reservation_id:"reservation",invoice_id:"in_due",payment_intent_id:"pi_due",payment_number:2}}));
  const env={CREATOR_MENTORSHIP_INSTALLMENT_LATER_WEBHOOK_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_LATER_RECEIPT_SCHEMA_READY:"true",
    CREATOR_MENTORSHIP_INSTALLMENT_CUSTOMER_SCHEMA_READY:"true",CREATOR_MENTORSHIP_INSTALLMENT_SAME_CARD_RECOVERY_READY:kind==="gate off"?"false":"true"};
  if(kind==="duplicate receipt")mockReceipt.mockResolvedValue({status:"already_credited"});
  if(kind==="failed release")mockContinuation.mockResolvedValue("review_required");
  if(kind==="unaccounted capture")mockReceipt.mockResolvedValue({status:"reconciliation_required"});
  const call=handoffBuyerMentorshipLaterWebhook({event,admin:admin as unknown as Parameters<typeof handoffBuyerMentorshipLaterWebhook>[0]["admin"],env});
  if(["failed release","unaccounted capture"].includes(kind))await expect(call).rejects.toThrow("retry or review");
  else expect(await call).toBe(true);
  if(["gate off","unaccounted capture"].includes(kind))expect(mockContinuation).not.toHaveBeenCalled();
  else {
    expect(mockContinuation).toHaveBeenCalledWith({buyerId:"buyer",requestId:"request",invoiceId:"in_due",env});
    expect(mockReceipt.mock.invocationCallOrder[0]).toBeLessThan(mockContinuation.mock.invocationCallOrder[0]);
  }
});
