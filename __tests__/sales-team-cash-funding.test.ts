import type Stripe from "stripe";
import {inspectTeamCashBalance} from "@/lib/salesTeams/cashFunding";
import {teamCashBalanceFixture} from "@/test-support/sales-team-cash-postgres";
const balance=(patch:Record<string,unknown>={})=>({...structuredClone(teamCashBalanceFixture),...patch}) as unknown as Stripe.Balance;
test("only available USD card funds support the refund; pending and instant money are ignored",()=>{
 expect(inspectTeamCashBalance(balance({available:[{currency:"usd",amount:500,source_types:{card:1000,bank_account:-500}}],pending:[{currency:"usd",amount:999999}],instant_available:[{currency:"usd",amount:999999}]}),false)).toBe(500);
 expect(inspectTeamCashBalance(balance({available:[{currency:"usd",amount:2000,source_types:{card:1000}}]}),false)).toBe(1000);
});
test.each([
 {livemode:true},
 {available:[]},
 {available:[{currency:"usd",amount:1000}]},
 {available:[{currency:"usd",amount:1.5,source_types:{card:1000}}]},
 {available:[{currency:"usd",amount:1000,source_types:{card:0.5}}]},
 {available:[{currency:"usd",amount:1000,source_types:{card:1000}},{currency:"usd",amount:1000,source_types:{card:1000}}]},
])("ambiguous, unsupported or mode-mismatched balances stay held: %o",patch=>{
 expect(()=>inspectTeamCashBalance(balance(patch),false)).toThrow(/funds require review/);
});
