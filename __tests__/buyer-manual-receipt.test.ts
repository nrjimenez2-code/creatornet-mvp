import {buyerManualFirstCaptureFixture} from "../test-support/buyer-mentorship-receipt-fixture";
import {inspectBuyerMentorshipManualFirstCapture} from "../lib/mentorshipInstallmentReceipt";
test("manual capture reuses exact economics/service period and records a truthful non-hosted source",()=>{
  const f=buyerManualFirstCaptureFixture(),proof=inspectBuyerMentorshipManualFirstCapture(f);
  expect(proof).toMatchObject({checkoutSessionId:null,paymentIntentId:"pi_owned",chargeId:"ch_owned",amountCents:3333,
    manualPayment:{attemptId:f.reservation.attemptId,confirmationOperationId:f.reservation.requestId},
    fees:{platformFeeCents:400,processingFeeCents:127,totalCreatorDeductionCents:527,creatorNetCents:2806},buyerCountry:"US"});
  expect(proof.serviceEndsAt).toBeGreaterThan(proof.nextPaymentAt);expect(JSON.stringify(proof)).not.toContain("cs_test_");
});
test.each(["intent","automatic","amount","metadata","contract","fee","charge","uncaptured","method","country","balance","transfer","subscription","future paid"])
("manual %s mismatch cannot create a receipt",issue=>{
  const f=buyerManualFirstCaptureFixture(),pi=f.data.paymentIntent;
  if(issue==="intent")pi.id="pi_other";
  if(issue==="automatic")pi.confirmation_method="automatic";
  if(issue==="amount")pi.amount++;
  if(issue==="metadata")pi.metadata.operation_kind="checkout.create";
  if(issue==="contract")f.manual.contract={...f.manual.contract,amountCents:3334};
  if(issue==="fee")pi.application_fee_amount!++;
  if(issue==="charge")f.data.charge.payment_intent="pi_other";
  if(issue==="uncaptured")f.data.charge.captured=false;
  if(issue==="method")f.data.paymentMethod.id="pm_other";
  if(issue==="country")f.data.charge.billing_details.address!.country="CA";
  if(issue==="balance")f.data.balance.source="ch_other";
  if(issue==="transfer")delete f.data.charge.transfer;
  if(issue==="subscription")f.data.subscription.customer="cus_other";
  if(issue==="future paid")f.data.charge.created=f.nowSeconds+1;
  expect(()=>inspectBuyerMentorshipManualFirstCapture(f)).toThrow();
});
test("financial inspection retains original manual proof while refusing clean credit for refunded capture",()=>{
  const f=buyerManualFirstCaptureFixture();f.data.charge.amount_refunded=100;
  expect(()=>inspectBuyerMentorshipManualFirstCapture(f)).toThrow();
  expect(inspectBuyerMentorshipManualFirstCapture({...f,financialInspection:"refund"})).toMatchObject({checkoutSessionId:null,paymentIntentId:"pi_owned"});
});
