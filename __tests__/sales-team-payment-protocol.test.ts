import {teamPaymentFixture} from "@/test-support/sales-team-payment-fixture";
import {inspectTeamConfirmationToken,inspectTeamPaymentIntent,inspectTeamSuccessfulCharge,teamConfirmationRequest,teamIntentRequest} from "@/lib/salesTeams/paymentProtocol";

test("the new protocol creates an unconfirmed platform charge with no destination or application fee",()=>{
 const f=teamPaymentFixture();expect(f.request.params).toMatchObject({confirm:false,confirmation_method:"manual",amount:10001,currency:"usd",allowed_payment_method_types:["card"]});
 expect(f.request.params).not.toHaveProperty("application_fee_amount");expect(f.request.params).not.toHaveProperty("transfer_data");expect(f.request.params).not.toHaveProperty("payment_method_types");
 expect(inspectTeamPaymentIntent(f.contract,f.evidence,f.pi,"pi_original").id).toBe("pi_original");
});
test.each(["destination","application_fee","mode","amount","metadata"])("%s mismatch cannot enter the separate-charge protocol",key=>{
 const f=teamPaymentFixture();const pi={...f.pi};
 if(key==="destination")pi.transfer_data={destination:"acct_foreign"};else if(key==="application_fee")pi.application_fee_amount=1200;
 else if(key==="mode")pi.livemode=true;else if(key==="amount")pi.amount++;else pi.metadata={...pi.metadata,buyer_id:"foreign"};
 expect(()=>inspectTeamPaymentIntent(f.contract,f.evidence,pi,"pi_original")).toThrow();
});
test("fresh independently retrieved US billing/token proof is required before manual confirmation",()=>{
 const f=teamPaymentFixture();const proof=inspectTeamConfirmationToken(f.contract,f.evidence,f.token,"ctoken_original",f.now);
 expect(teamConfirmationRequest(f.contract,f.evidence,"pi_original",proof,f.now).params.confirmation_token).toBe("ctoken_original");
 expect(()=>inspectTeamConfirmationToken(f.contract,f.evidence,{...f.token,payment_intent:"pi_foreign"},"ctoken_original",f.now)).toThrow();
 const changed=structuredClone(f.token);changed.payment_method_preview!.billing_details.address!.country="CA";
 expect(()=>inspectTeamConfirmationToken(f.contract,f.evidence,changed,"ctoken_original",f.now)).toThrow();
 expect(()=>teamConfirmationRequest(f.contract,f.evidence,"pi_original",proof,proof.expiresAt)).toThrow();
});
test("fixed-total installments preserve exact final cents and saved-card authorization",()=>{
 const f=teamPaymentFixture("installments");expect(f.request.params).toMatchObject({amount:3333,setup_future_usage:"off_session"});
 expect(teamIntentRequest({...f.contract,periodNumber:3,amountCents:3335},f.evidence).params.amount).toBe(3335);
 expect(()=>teamIntentRequest({...f.contract,periodNumber:4,amountCents:3333},f.evidence)).toThrow();
});
test("a captured original remains accountable without current mutable billing or closer eligibility",()=>{
 const f=teamPaymentFixture();expect(inspectTeamSuccessfulCharge(f.contract,f.evidence,f.paid,f.charge,"pi_original"))
 .toMatchObject({subtotalCents:10001,taxCents:0,paymentIntentId:"pi_original",chargeId:"ch_original"});
 expect(()=>inspectTeamSuccessfulCharge(f.contract,f.evidence,f.pi,f.charge,"pi_original")).toThrow();
 expect(()=>inspectTeamSuccessfulCharge(f.contract,f.evidence,f.paid,{...f.charge,transfer:"tr_foreign"},"pi_original")).toThrow();
});
test("saved agreement fingerprints prevent commission or price changes from rewriting payment contracts",()=>{
 const f=teamPaymentFixture();const changed={...f.contract,terms:{...f.contract.terms,commission:{...f.contract.terms.commission,commissionBps:2000}}};
 expect(()=>teamIntentRequest(changed,f.evidence)).toThrow();
});
