import {teamCaptureFixture} from "@/test-support/sales-team-capture-fixture";
import {inspectTeamReceipt} from "@/lib/salesTeams/receiptPolicy";
test("a verified separate charge records actual costs and no private card/customer response",()=>{
 const proof=inspectTeamReceipt(teamCaptureFixture());expect(proof).toMatchObject({processingCostCents:127,taxCents:0,subtotalCents:3333,paid:true,captured:true});
 expect(JSON.stringify(proof)).not.toMatch(/cus_|pm_|billing_details|last4|client_secret|fee_details/);
});
test("an asynchronous capture without balance evidence retains an explicit processing reserve",()=>{
 const f=teamCaptureFixture();f.charge.balance_transaction=null;expect(inspectTeamReceipt({...f,balance:null})).toMatchObject({processingCostCents:null,balanceTransactionId:null,availableOn:null});
});
test("manual bank authentication can finish after the charge object was first created",()=>{
 const f=teamCaptureFixture();f.confirmation.lastDispatchAt=f.contract.acceptedAt+120;delete f.confirmation.request.params.confirmation_token;
 expect(inspectTeamReceipt({...f,nowSeconds:f.contract.acceptedAt+130}).paid).toBe(true);
});
test.each(["destination","applicationFee","chargeAmount","metadata","issuer","billing","intentBinding","requestOverride","futureCapture","costSource","costTotal","feeMarkup"])("rejects changed %s evidence",fault=>{
 const f=teamCaptureFixture();
 if(fault==="destination")f.paymentIntent.transfer_data={destination:"acct_other"};
 if(fault==="applicationFee")f.charge.application_fee_amount=1;
 if(fault==="chargeAmount")f.charge.amount_captured--;
 if(fault==="metadata")f.paymentIntent.metadata.team_sale_id="different";
 if(fault==="issuer")f.charge.payment_method_details!.card!.country="CA";
 if(fault==="billing")f.charge.billing_details.address!.country="CA";
 if(fault==="intentBinding")f.confirmation.paymentIntentId="pi_foreign";
 if(fault==="requestOverride")f.confirmation.request.params.payment_method="pm_other";
 if(fault==="futureCapture")f.charge.created=f.nowSeconds+30;
 if(fault==="costSource")f.balance.source="ch_foreign";
 if(fault==="costTotal")f.balance.fee_details[0].amount++;
 if(fault==="feeMarkup")f.balance.fee_details[0].application="ca_unknown";
 expect(()=>inspectTeamReceipt(f)).toThrow();
});
test("refund/dispute accounting is held separately from clean delivery proof",()=>{
 const f=teamCaptureFixture();f.charge.amount_refunded=50;f.charge.disputed=true;expect(()=>inspectTeamReceipt(f)).toThrow();
 expect(inspectTeamReceipt({...f,financialInspection:true})).toMatchObject({refundedCents:50,disputed:true});
});
