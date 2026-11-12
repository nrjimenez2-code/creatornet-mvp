import {observeTeamFinancialState} from "@/lib/salesTeams/financialObservation";
const base={chargeId:"ch_original",subtotalCents:10000,chargeRefundedCents:0,actualProcessingCostCents:320,refunds:[],refundListComplete:true,decisions:[],disputes:[]};
test("verified clean payment has no refund/dispute hold",()=>{expect(observeTeamFinancialState(base)).toMatchObject({refundedCents:0,totalLossCents:0,reviewHold:false,disputeHold:false});});
test("an incomplete refund list cannot restore commission on independently confirmed refunded principal",()=>{
 expect(observeTeamFinancialState({...base,chargeRefundedCents:3000,refundListComplete:false})).toMatchObject({refundedCents:3000,totalLossCents:3000,reviewHold:true});
});
test("refund processing-cost responsibility reuses existing creator/platform policy",()=>{
 const refund={id:"re_original",chargeId:base.chargeId,amountCents:10000,status:"succeeded" as const,created:1};
 const creator=observeTeamFinancialState({...base,chargeRefundedCents:10000,refunds:[refund],decisions:[{refundId:refund.id,chargeId:base.chargeId,responsibility:"creator",reasonCode:"creator_non_delivery"}]});
 expect(creator).toMatchObject({platformFeeReturnedCents:1200,platformProcessingCostCreditCents:0,reviewHold:false});
 const platform=observeTeamFinancialState({...base,chargeRefundedCents:10000,refunds:[refund],decisions:[{refundId:refund.id,chargeId:base.chargeId,responsibility:"platform",reasonCode:"duplicate_charge"}]});
 expect(platform).toMatchObject({platformFeeReturnedCents:1200,platformProcessingCostCreditCents:320,reviewHold:false});
});
test("unknown refund ownership, pending refunds and incomplete provider totals remain held",()=>{
 const refund={id:"re_original",chargeId:base.chargeId,amountCents:1000,status:"succeeded" as const,created:1};
 expect(observeTeamFinancialState({...base,chargeRefundedCents:1000,refunds:[refund]}).alerts).toContain("REFUND_RESPONSIBILITY_UNREVIEWED");
 expect(observeTeamFinancialState({...base,chargeRefundedCents:1000}).alerts).toContain("REFUND_TOTAL_UNRECONCILED");
 expect(observeTeamFinancialState({...base,refunds:[{...refund,status:"pending"}]}).alerts).toContain("REFUND_PENDING");
});
test("a refund and full lost dispute never subtract more than the sale subtotal",()=>{
 const result=observeTeamFinancialState({...base,chargeRefundedCents:3000,refunds:[{id:"re_original",chargeId:base.chargeId,amountCents:3000,status:"succeeded",created:1}],
  decisions:[{refundId:"re_original",chargeId:base.chargeId,responsibility:"creator",reasonCode:"creator_discretionary"}],
  disputes:[{id:"du_original",chargeId:base.chargeId,amountCents:10000,status:"lost"}]});
 expect(result.totalLossCents).toBe(10000);expect(result.platformFeeReturnedCents).toBe(1200);
});
test("ambiguous overlapping partial principal stays held until independent balance evidence resolves it",()=>{
 const input={...base,chargeRefundedCents:3000,refunds:[{id:"re_original",chargeId:base.chargeId,amountCents:3000,status:"succeeded" as const,created:1}],
  decisions:[{refundId:"re_original",chargeId:base.chargeId,responsibility:"creator" as const,reasonCode:"creator_discretionary" as const}],
  disputes:[{id:"du_original",chargeId:base.chargeId,amountCents:4000,status:"lost" as const}]};
 expect(observeTeamFinancialState(input)).toMatchObject({totalLossCents:4000,reviewHold:true});
 expect(observeTeamFinancialState({...input,verifiedCombinedLoss:{subtotalCents:4000,providerEvidenceIds:["txn_principal"]}})).toMatchObject({totalLossCents:4000,reviewHold:false});
});
test("a pending dispute freezes eligibility; a won dispute restores it without another debit",()=>{
 expect(observeTeamFinancialState({...base,disputes:[{id:"du_original",chargeId:base.chargeId,amountCents:10000,status:"under_review"}]}).disputeHold).toBe(true);
 expect(observeTeamFinancialState({...base,disputes:[{id:"du_original",chargeId:base.chargeId,amountCents:10000,status:"won"}]})).toMatchObject({disputeHold:false,totalLossCents:0});
});
