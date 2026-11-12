/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {salesTeamSaleDatabase,enableTeamSalesFixture,approveTeamOffer,draftTeamSale} from "@/test-support/sales-team-sale-postgres";
import {teamFixtureId as id,teamRpc} from "@/test-support/sales-team-postgres";
import {teamOperationId,TEAM_STRIPE_API_VERSION,type TeamOperationScope} from "@/lib/salesTeams/providerOperation";
import {observeTeamFinancialState} from "@/lib/salesTeams/financialObservation";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;let sale:string,context:object,memberId:string;
const rpc=async<T=Record<string,unknown>>(name:string,values:unknown[])=>{
 const r=await db.query<{result:T}>(`select public.${name}(${values.map((_,i)=>`$${i+1}`).join(",")}) result`,values);return r.rows[0].result;
};
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
beforeAll(async()=>{
 db=await salesTeamSaleDatabase(createLocalPostgres());
 for(const name of ["20261021215909_sales_team_provider_journal_and_ledger.sql","20261021220845_sales_team_receipt_accounting.sql"])await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8"));
},30000);
beforeEach(async()=>{
 await db.exec("begin");memberId=await enableTeamSalesFixture(db);const offer=await approveTeamOffer(db,[3]);const draft=await draftTeamSale(db,offer.options.find(o=>o.kind==="installments")!.id);
 await rpc("accept_sales_team_sale_v1",[draft.saleId,id(10),draft.quote.fingerprint,true]);sale=draft.saleId;context=draft.source.financialConfig.context;
});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
function financialProof(receipt:Record<string,unknown>,refund:number,cost:number,disputeHold=false,responsibility:"creator"|"platform"="creator"){
 const observed=observeTeamFinancialState({chargeId:String(receipt.charge_id),subtotalCents:Number(receipt.subtotal_cents),chargeRefundedCents:refund,
  actualProcessingCostCents:cost,refundListComplete:true,refunds:refund?[{id:"re_original",chargeId:String(receipt.charge_id),amountCents:refund,status:"succeeded",created:1}]:[],
  decisions:refund?[{refundId:"re_original",chargeId:String(receipt.charge_id),responsibility,reasonCode:responsibility==="platform"?"duplicate_charge":"creator_non_delivery"}]:[],
  disputes:disputeHold?[{id:"du_original",chargeId:String(receipt.charge_id),amountCents:Number(receipt.subtotal_cents),status:"under_review"}]:[]});
 return {...observed,chargeId:receipt.charge_id,paymentIntentId:receipt.payment_intent_id,context};
}
async function receive(period=1,cost:number|null=127){
 let obligation:Record<string,unknown>;
 if(period===1)obligation=await rpc("initialize_sales_team_payment_v1",[sale,id(10)]);
 else obligation=(await db.query<Record<string,unknown>>("insert into public.sales_team_payment_obligations_v1(id,sale_id,period_number,amount_cents,due_at) values(gen_random_uuid(),$1,$2,$3,now()) returning *",[sale,period,period===3?3335:3333])).rows[0];
 const scope:TeamOperationScope={scopeId:sale,scopeKey:`intent:${obligation.id}`,saleId:sale,creatorId:id(1),actorId:id(10),workerRunId:null,kind:"intent"},opId=teamOperationId(scope);
 const request={apiVersion:TEAM_STRIPE_API_VERSION,method:"POST",path:"/v1/payment_intents",params:{amount:obligation.amount_cents,currency:"usd",confirm:false,metadata:{team_obligation_id:obligation.id,team_sale_id:sale}}};
 await rpc("claim_sales_team_provider_operation_v1",[opId,JSON.stringify(scope),JSON.stringify(context),JSON.stringify(request)]);
 await rpc("bind_sales_team_provider_operation_v1",[opId,`pi_period${period}`,`req_period${period}`,false]);
 await db.query("update public.sales_team_payment_obligations_v1 set intent_operation_id=$1,status='admitted' where id=$2",[opId,obligation.id]);
 const paid=Math.floor(Date.now()/1000),balance=`txn_period${period}`;
 const proof={protocol:"creatornet-team-distribution-v1",context,paymentIntentId:`pi_period${period}`,chargeId:`ch_period${period}`,obligationId:obligation.id,saleId:sale,
  currency:"usd",paid:true,captured:true,subtotalCents:obligation.amount_cents,taxCents:0,paidAt:paid,balanceTransactionId:balance,processingCostCents:cost,availableOn:cost===null?null:paid,
  refundedCents:0,disputed:false,metadataHash:"a".repeat(64),providerRequestId:`req_charge${period}`};
 const args=[obligation.id,proof.paymentIntentId,proof.chargeId,new Date(paid*1000).toISOString(),balance,cost,cost===null?null:new Date(paid*1000).toISOString(),`receipt-event-${period}`,JSON.stringify(proof)];
 const receipt=await rpc("record_sales_team_receipt_v1",args);return {receipt,args,proof,paid};
}
test("only a bound independently verified payment earns commission, with the full 14-day hold",async()=>{
 const {receipt,paid}=await receive();const commission=(await db.query<{earned_cents:number;hold_until:string}>("select earned_cents,hold_until from public.sales_team_commission_balances_v1")).rows[0];
 expect(Number(commission.earned_cents)).toBe(333);expect(Date.parse(commission.hold_until)-paid*1000).toBe(14*86400000);
 const creator=(await db.query<{platform_revenue_cents:number;creator_proceeds_cents:number;actual_processing_cost_cents:number}>("select * from public.sales_team_creator_balances_v1")).rows[0];
 expect(Number(creator.platform_revenue_cents)).toBe(400);expect(Number(creator.creator_proceeds_cents)).toBe(2473);expect(Number(creator.actual_processing_cost_cents)).toBe(127);
 expect(receipt.id).toBeTruthy();
});
test("duplicate receipt callbacks never create duplicate liabilities or ledger rows",async()=>{
 const {args}=await receive();const count=(await db.query("select * from public.sales_team_financial_ledger_v1")).rows.length;
 await rpc("record_sales_team_receipt_v1",args);expect((await db.query("select * from public.sales_team_receipts_v1")).rows).toHaveLength(1);
 expect((await db.query("select * from public.sales_team_financial_ledger_v1")).rows).toHaveLength(count);
});
test("cumulative uneven-cent commission is exact over all three independently paid installments",async()=>{
 await receive(1);await receive(2);await receive(3);
 const result=await db.query<{earned_cents:number}>("select earned_cents from public.sales_team_commission_balances_v1 c join public.sales_team_receipts_v1 r on r.id=c.receipt_id join public.sales_team_payment_obligations_v1 o on o.id=r.obligation_id order by o.period_number");
 expect(result.rows.map(r=>Number(r.earned_cents))).toEqual([333,334,333]);
});
test("removed closers retain existing agreement commission and creator relationship attribution",async()=>{
 await teamRpc(db,1,"remove_member",{membership_id:memberId});await receive();
 expect((await db.query<{membership_id:string}>("select membership_id from public.sales_team_commission_balances_v1")).rows[0].membership_id).toBe(memberId);
});
test("unbilled processing remains a distinct reserve until the actual charge fee is verified",async()=>{
 const {receipt,paid}=await receive(1,null);
 const before=(await db.query<{processing_reserve_cents:number;creator_proceeds_cents:number}>("select * from public.sales_team_creator_balances_v1")).rows[0];expect(Number(before.processing_reserve_cents)).toBe(127);
 const proof=financialProof(receipt,0,100);
 await rpc("reconcile_sales_team_receipt_v1",[receipt.id,1,"cost-actual",0,0,false,false,100,receipt.balance_transaction_id,new Date(paid*1000).toISOString(),JSON.stringify(proof)]);
 const after=(await db.query<{processing_reserve_cents:number;creator_proceeds_cents:number}>("select * from public.sales_team_creator_balances_v1")).rows[0];
 expect(Number(after.processing_reserve_cents)).toBe(0);expect(Number(after.creator_proceeds_cents)-Number(before.creator_proceeds_cents)).toBe(27);
});
test("refund and dispute reconciliation share one loss basis and reject stale competing observations",async()=>{
 const {receipt,paid}=await receive();const proof=financialProof(receipt,1000,127,true);
 await rpc("reconcile_sales_team_receipt_v1",[receipt.id,1,"refund-and-dispute",1000,1000,true,false,127,receipt.balance_transaction_id,new Date(paid*1000).toISOString(),JSON.stringify(proof)]);
 expect(Number((await db.query<{earned_cents:number}>("select earned_cents from public.sales_team_commission_balances_v1")).rows[0].earned_cents)).toBe(233);
 await denied(()=>rpc("reconcile_sales_team_receipt_v1",[receipt.id,1,"stale-observation",0,0,false,false,127,receipt.balance_transaction_id,new Date(paid*1000).toISOString(),JSON.stringify(proof)]),/FINANCIAL_OBSERVATION_STALE/);
});
test("platform-error refunds retain the existing platform-funded nonreturned processing-cost rule",async()=>{
 const {receipt,paid}=await receive();const proof=financialProof(receipt,3333,127,false,"platform");
 await rpc("reconcile_sales_team_receipt_v1",[receipt.id,1,"platform-error-refund",3333,3333,false,false,127,receipt.balance_transaction_id,new Date(paid*1000).toISOString(),JSON.stringify(proof)]);
 const row=(await db.query<{creator_deficit_cents:number;platform_processing_credit_cents:number;platform_revenue_cents:number}>("select * from public.sales_team_creator_balances_v1")).rows[0];
 expect(Number(row.platform_revenue_cents)).toBe(0);expect(Number(row.creator_deficit_cents)).toBe(0);expect(Number(row.platform_processing_credit_cents)).toBe(127);
 expect(Number((await db.query<{earned_cents:number}>("select earned_cents from public.sales_team_commission_balances_v1")).rows[0].earned_cents)).toBe(0);
});
test("creator-responsible full refunds record only the genuine unrecovered processing deficit",async()=>{
 const {receipt,paid}=await receive();const proof=financialProof(receipt,3333,127);
 await rpc("reconcile_sales_team_receipt_v1",[receipt.id,1,"creator-refund",3333,3333,false,false,127,receipt.balance_transaction_id,new Date(paid*1000).toISOString(),JSON.stringify(proof)]);
 const row=(await db.query<{creator_deficit_cents:number;platform_processing_credit_cents:number}>("select * from public.sales_team_creator_balances_v1")).rows[0];
 expect(Number(row.creator_deficit_cents)).toBe(127);expect(Number(row.platform_processing_credit_cents)).toBe(0);
});
test("private card/bank/secret payloads cannot be saved as receipt evidence",async()=>{
 const {args,proof}=await receive();args[8]=JSON.stringify({...proof,client_secret:"forbidden"});await denied(()=>rpc("record_sales_team_receipt_v1",args),/PRIVATE_PROVIDER_DATA_NOT_ALLOWED/);
});
