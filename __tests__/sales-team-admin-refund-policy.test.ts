import {teamRefundDispatchReady,teamRefundDispatchSchemaReady,type TeamEnvironment} from "@/lib/salesTeams/policy";
const schema:TeamEnvironment={CREATOR_SALES_TEAM_SCHEMA_READY:"true",CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY:"true",CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY:"true",CREATOR_TEAM_PAYMENT_SCHEMA_READY:"true",CREATOR_TEAM_RECEIPT_SCHEMA_READY:"true",CREATOR_TEAM_EVENT_SCHEMA_READY:"true",CREATOR_TEAM_FINANCIAL_SCHEMA_READY:"true",CREATOR_TEAM_REFUND_DISPATCH_SCHEMA_READY:"true"};
test("original refund recovery remains available with new sales and financial execution disabled",()=>{
 expect(teamRefundDispatchSchemaReady(schema)).toBe(true);expect(teamRefundDispatchReady(schema)).toBe(false);expect(teamRefundDispatchSchemaReady({})).toBe(false);
});
test("a missing receipt dependency cannot expose schema-only recovery",()=>{
 expect(teamRefundDispatchSchemaReady({...schema,CREATOR_TEAM_PAYMENT_SCHEMA_READY:"false"})).toBe(false);
});
test("fresh refund dispatch also requires complete financial review execution gates",()=>{
 const enabled={...schema,CREATOR_TEAM_FULFILLMENT_SCHEMA_READY:"true",CREATOR_TEAM_EVENT_RECONCILIATION_READY:"true",CREATOR_TEAM_FINANCIAL_RECONCILIATION_READY:"true",CREATOR_TEAM_REFUND_REVIEW_READY:"true",CREATOR_TEAM_REFUND_DISPATCH_READY:"true",CREATOR_TEAM_CASH_SCHEMA_READY:"true",CREATOR_TEAM_CASH_FUNDING_READY:"true",CREATOR_TEAM_SHARED_CASH_READY:"true"};
 expect(teamRefundDispatchReady({...enabled,CREATOR_TEAM_SHARED_CASH_READY:"false"})).toBe(false);
 expect(teamRefundDispatchReady({...enabled,CREATOR_TEAM_CASH_FUNDING_READY:"false"})).toBe(false);
 expect(teamRefundDispatchReady(enabled)).toBe(true);expect(teamRefundDispatchReady({...enabled,CREATOR_TEAM_REFUND_REVIEW_READY:"false"})).toBe(false);expect(teamRefundDispatchReady({...enabled,CREATOR_TEAM_FINANCIAL_RECONCILIATION_READY:"false"})).toBe(false);
});
