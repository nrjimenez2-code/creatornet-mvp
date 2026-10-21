import { allocateSharedCost, commissionAdjustment, cumulativeShare, distribution, withdrawableSurplus } from "@/lib/salesTeams/accounting";
import { approvedTeamInstallments, canClose, canManageMember, commissionTerms, teamRole, teamSalesReady, teamSettlementReady } from "@/lib/salesTeams/policy";

test("new team activity and settlement require their independent default-off gates",()=>{
 expect(teamSalesReady({})).toBe(false);expect(teamSettlementReady({})).toBe(false);
 expect(teamSalesReady({CREATOR_SALES_TEAM_SCHEMA_READY:"true",CREATOR_SALES_TEAM_READY:"true"})).toBe(true);
 expect(teamSettlementReady({CREATOR_SALES_TEAM_SCHEMA_READY:"true",CREATOR_SALES_TEAM_READY:"true"})).toBe(false);
});
test("explicit commission, holding period, and renewal terms remain bounded",()=>{
 expect(()=>commissionTerms({commissionBps:undefined})).toThrow();
 expect(commissionTerms({commissionBps:1000})).toMatchObject({holdDays:14,renewals:"initial_commitment"});
 for(const holdDays of [0,13,91,14.5,"14"])expect(()=>commissionTerms({commissionBps:1000,holdDays})).toThrow();
});
test("manager authority cannot appoint/remove managers and closer routing requires accepted terms",()=>{
 expect(canManageMember("manager","manager")).toBe(false);expect(canManageMember("manager","closer")).toBe(true);
 const member={id:"m",creator_id:"creator",user_id:"closer",role:"closer" as const,is_closer:true,status:"active" as const,commission_revision:2,accepted_commission_revision:1};
 expect(teamRole("other","closer",member)).toBe(null);expect(canClose(member,true)).toBe(false);
 expect(canClose({...member,accepted_commission_revision:2},true)).toBe(true);
 expect(canClose({...member,accepted_commission_revision:2},false)).toBe(false);
 expect(teamRole("creator","closer",{...member,status:"removed"})).toBe(null);
});
test("full-only and fixed-total installment choices remain distinct from monthly service",()=>{
 expect(approvedTeamInstallments([],10001)).toEqual([]);expect(approvedTeamInstallments([2,3],10001)).toEqual([2,3]);
 for(const value of [[3,2],[2,2],[25],[2.5]])expect(()=>approvedTeamInstallments(value,10001)).toThrow();
 expect(()=>approvedTeamInstallments([2],10001,true)).toThrow();
});
test("the handoff example keeps processing and payout costs creator-funded",()=>{
 expect(distribution({subtotalCents:100000,taxCents:0,refundedSubtotalCents:0,commissionBps:1000,processingCostCents:2930,payoutCostReserveCents:50}))
 .toMatchObject({platformFeeCents:12000,commissionCents:10000,creatorProceedsCents:75020,processingCostCents:2930,payoutCostReserveCents:50});
});
test("cumulative commission rounds once across uneven-cent installments",()=>{
 const receipts=[3333,3333,3335];let collected=0,earned=0;const changes=[];
 for(const amount of receipts){collected+=amount;const next=cumulativeShare(collected,1000);changes.push(next-earned);earned=next;}
 expect(changes).toEqual([333,334,333]);expect(earned).toBe(1000);
});
test("refund recovery reduces unpaid liabilities before recovering released commission",()=>{
 expect(commissionAdjustment({collectedSubtotalCents:10001,refundedSubtotalCents:5001,commissionBps:1000,previouslyEarnedCents:1000,releasedCents:800,reversedCents:0}))
 .toEqual({earnedCents:500,adjustmentCents:-500,unpaidCents:0,recoveryCents:300});
 expect(commissionAdjustment({collectedSubtotalCents:10001,refundedSubtotalCents:10001,commissionBps:1000,previouslyEarnedCents:500,releasedCents:800,reversedCents:300}).recoveryCents).toBe(500);
});
test("shared fees allocate exactly once with stable tie resolution and no cross-creator duplication",()=>{
 const activity=[{creatorId:"c",weightCents:1},{creatorId:"a",weightCents:1},{creatorId:"b",weightCents:1},{creatorId:"none",weightCents:0}];
 const amounts=allocateSharedCost(200,activity);expect(amounts.reduce((n,row)=>n+row.amountCents,0)).toBe(200);
 expect(amounts).toEqual([{creatorId:"c",amountCents:66},{creatorId:"a",amountCents:67},{creatorId:"b",amountCents:67},{creatorId:"none",amountCents:0}]);
 expect(()=>allocateSharedCost(1,[])).toThrow();
});
test("tax and deficits stay separate; platform withdrawals protect liabilities and reserves",()=>{
 expect(distribution({subtotalCents:100,taxCents:9,refundedSubtotalCents:0,commissionBps:8800,processingCostCents:40,payoutCostReserveCents:5}))
 .toMatchObject({taxReserveCents:9,creatorProceedsCents:0,creatorDeficitCents:45});
 expect(withdrawableSurplus(10000,7000,2000)).toBe(1000);expect(withdrawableSurplus(100,200,0)).toBe(0);
});
