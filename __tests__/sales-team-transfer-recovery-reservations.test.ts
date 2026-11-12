/** @jest-environment ./test-support/pglite-environment.cjs */
import {installSignedSurplusEventsFixture} from "@/test-support/sales-team-surplus-events-schema";
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {sharedCashDatabase,sharedCashReconciliationCandidate} from "@/test-support/sales-team-shared-cash-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {teamCashBalanceFixture} from "@/test-support/sales-team-cash-postgres";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import {inspectTeamReceiptFinancials,reviewTeamRefundResponsibility} from "@/lib/salesTeams/financialChecks";
import {reserveTeamEarnedTransfer,type TeamTransferRequest} from "@/lib/salesTeams/transferReservations";
import {dispatchTeamEarnedTransfer} from "@/lib/salesTeams/transferExecution";
import {reserveTeamTransferRecovery} from "@/lib/salesTeams/transferRecoveryReservations";
import {readTeamOriginalTransferForRecovery} from "@/lib/salesTeams/transferReversalReadback";
import {observeTeamBoundTransferReversal} from "@/lib/salesTeams/transferReversalObservations";
import {teamOperationId,type TeamOperationScope} from "@/lib/salesTeams/providerOperation";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
import {teamTransferRecoveryReservationsReady} from "@/lib/salesTeams/policy";
declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261024213841_sales_team_transfer_recovery_reservations.sql";
const predecessors=[sharedCashReconciliationCandidate,"supabase/migrations/20261023042321_sales_team_retained_refund_funding.sql","supabase/migrations/20261023060912_sales_team_automatic_recovery.sql","supabase/migrations/20261023063905_sales_team_worker_refund_recovery.sql","supabase/migrations/20261023174324_sales_team_no_outbound_shared_recovery.sql","supabase/migrations/20261023180144_sales_team_transfer_reservations.sql","supabase/migrations/20261023182527_sales_team_transfer_observations.sql","supabase/migrations/20261023184139_sales_team_transfer_execution.sql","supabase/migrations/20261023190044_sales_team_automatic_settlement.sql","supabase/migrations/20261024210829_sales_team_transfer_reversal_observations.sql"];
type Run={runId:string;leaseToken:string};
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,c:TeamReceiptComposition,receiptId:string,q:TeamTransferRequest,run:Run,raw:jest.Mock;
let transfer:Record<string,unknown>,values:Record<string,Record<string,unknown>>,advanceClock:(ms:number)=>Promise<void>;
const realNow=Date.now.bind(Date);let clockOffset=0,taskId=id(102);
beforeAll(async()=>{db=createLocalPostgres();advanceClock=await installTeamLocalClock(db);await sharedCashDatabase(db);for(const path of [...predecessors,candidate,"supabase/migrations/20261024215948_sales_team_transfer_recovery_execution.sql","supabase/migrations/20261025184802_sales_team_transfer_reversal_recovery.sql","supabase/migrations/20261025191826_sales_team_combined_settlement.sql","supabase/migrations/20261025195351_sales_team_later_collection.sql","supabase/migrations/20261026185425_sales_team_payment_lifecycle.sql","supabase/migrations/20261026193046_sales_team_expired_collection_retry.sql","supabase/migrations/20261027021620_sales_team_saved_method_authority.sql","supabase/migrations/20261027024721_sales_team_automatic_collection.sql","supabase/migrations/20261027232440_sales_team_protected_daily_surplus.sql","supabase/migrations/20261028000209_sales_team_surplus_execution.sql","supabase/migrations/20261028222238_sales_team_surplus_recovery.sql"])await db.exec(readFileSync(path,"utf8"));await installSignedSurplusEventsFixture(db);await db.exec(readFileSync("supabase/migrations/20261029171329_sales_team_daily_surplus.sql","utf8"));},30000);
beforeEach(async()=>{clockOffset=0;taskId=id(102);await db.exec("begin");});afterEach(async()=>{await db.exec("rollback;reset role");jest.restoreAllMocks();});afterAll(async()=>{await db?.close();});
async function advanceBy(ms:number){clockOffset+=ms;jest.spyOn(Date,"now").mockImplementation(()=>realNow()+clockOffset);await advanceClock(clockOffset);}
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
async function fixture(beneficiary:"creator"|"closer"="creator"){
 await db.exec("update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true,cash_reservations_enabled=true,settlement_enabled=true,transfer_reservations_enabled=true,transfer_observations_enabled=true,transfer_execution_enabled=true,transfer_reversal_observations_enabled=true,transfer_recovery_reservations_enabled=true");
 f=await seedTeamCapture(db);f.base.balance.available_on=Math.floor(Date.now()/1000);f.base.balance.status="available";receiptId=String((await f.record()).id);await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,transfer_cost_reserve_cents=30,transfer_reversal_cost_reserve_cents=30,evidence='{\"scope\":\"synthetic original reversal observer fixture\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1(),retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1(),transfer_contract_sha256=creatornet_team_private.transfer_contract_digest_v1()");
 values={};let sequence=0;
 raw=jest.fn(async(method:string,path:string,params:unknown,options:Record<string,unknown>)=>{
  if(method==="POST"){if(path!=="/v1/transfers"||options.idempotencyKey!==`cn-team-v1:${q.operation_id}`||JSON.stringify(params)!==JSON.stringify(q.request.params))throw Error("Only original fixture transfer is allowed");return JSON.parse(JSON.stringify({...transfer,lastResponse:{requestId:"req_transferPost"}}));}
  if(method!=="GET")throw Error("Original reversal observation permits GET only");
  const value=values[path]??(path==="/v1/balance"?teamCashBalanceFixture:path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/charges/ch_original"?f.base.charge:path==="/v1/balance_transactions/txn_original"?f.base.balance:["/v1/refunds","/v1/disputes"].includes(path)?{object:"list",data:[],has_more:false}:null);
  if(!value)throw Error(path);return JSON.parse(JSON.stringify({...value,lastResponse:{requestId:`req_return${++sequence}`}}));
 });
 const base=teamSupabaseFixture(db),admin={rpc:async(name:string,args:Record<string,unknown>)=>{await db.exec("savepoint reversal_rpc");const result=await base.rpc(name,args);if(result.error)await db.exec("rollback to savepoint reversal_rpc");await db.exec("release savepoint reversal_rpc");return result;}} as unknown as TeamReceiptComposition["admin"];
 c={admin,context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence,stripe:{rawRequest:raw}};
 if(beneficiary==="closer"){await advanceBy(15*86400000);await db.exec("update sales_team_recipients_v1 set verified_at=clock_timestamp()");}
 await inspectTeamReceiptFinancials(c,receiptId,id(29));const original=await f.rpc<Run>("claim_sales_team_settlement_run_v1",[id(80),c.context]);
 q=await reserveTeamEarnedTransfer(c,{...original,taskId:id(82),requestId:id(81),receiptId,beneficiary});const stamp=Math.floor(Date.now()/1000);
 transfer={object:"transfer",id:"tr_original",amount:Number(q.amount_cents),currency:"usd",amount_reversed:0,reversed:false,livemode:false,created:stamp,destination:q.destination_id,destination_payment:"py_original",source_transaction:q.chargeId,source_type:"card",transfer_group:`cn_team_${q.sale_id}`,metadata:q.request.params.metadata,balance_transaction:"txn_transfer",reversals:{object:"list",data:[],has_more:false,total_count:0,url:"/v1/transfers/tr_original/reversals"}};
 values["/v1/transfers/tr_original"]=transfer;values["/v1/balance_transactions/txn_transfer"]={object:"balance_transaction",id:"txn_transfer",source:"tr_original",type:"transfer",reporting_category:"transfer",balance_type:"payments",currency:"usd",exchange_rate:null,amount:-Number(q.amount_cents),fee:0,net:-Number(q.amount_cents),fee_details:[],created:stamp,available_on:stamp,status:"available"};
 expect(await dispatchTeamEarnedTransfer(c,{...original,taskId:id(82),requestId:q.id,checkId:id(85)},true)).toMatchObject({completed:true});
 await db.query("update sales_team_worker_runs_v1 set scheduled_slot=scheduled_slot-interval '15 minutes',lease_until=clock_timestamp()-interval '1 second' where id=$1",[original.runId]);
 await refund();
 run=await f.rpc<Run>("claim_sales_team_transfer_recovery_run_v1",[id(100),c.context,true]);raw.mockClear();
}
async function refund(amount=1000){
 const stamp=Math.floor(Date.now()/1000),refund={object:"refund",id:"re_original",charge:"ch_original",payment_intent:"pi_original",amount,currency:"usd",status:"succeeded",created:stamp,balance_transaction:"txn_refund",failure_balance_transaction:null,transfer_reversal:null,source_transfer_reversal:null,metadata:{}};
 values["/v1/refunds"]={object:"list",data:[refund],has_more:false};values["/v1/refunds/re_original"]=refund;values["/v1/balance_transactions/txn_refund"]={object:"balance_transaction",id:"txn_refund",source:refund.id,type:"refund",reporting_category:"refund",balance_type:"payments",currency:"usd",exchange_rate:null,amount:-amount,fee:0,net:-amount,fee_details:[],created:stamp,available_on:stamp,status:"available"};f.base.charge.amount_refunded=amount;
 await inspectTeamReceiptFinancials(c,receiptId,id(29));const revision=Number((await db.query<{r:number}>("select observation_revision r from sales_team_receipts_v1")).rows[0].r);await db.exec("update sales_team_controls_v1 set refund_review_enabled=true");await reviewTeamRefundResponsibility(c,{actorId:id(29),receiptId,requestId:id(140),expectedRevision:revision,refundId:refund.id,responsibility:"creator",reasonCode:"creator_discretionary"});await inspectTeamReceiptFinancials(c,receiptId,id(29));
}
const reserve=()=>reserveTeamTransferRecovery(c,{...run,taskId,transferRequestId:q.id});
const begin=()=>f.rpc<{request_id:string;financial_check_id:string;root_read_id:string;transfer:TeamTransferRequest}>("begin_sales_team_transfer_recovery_v1",[run.runId,run.leaseToken,c.context,taskId,q.id]);
const phase=(name:string,payload:unknown={})=>f.rpc("run_sales_team_transfer_recovery_v1",[run.runId,run.leaseToken,c.context,taskId,name,payload]);
const cancel=()=>f.rpc("cancel_unsent_sales_team_transfer_recovery_v1",[run.runId,run.leaseToken,c.context,taskId]);

test("the foundation is independently default off",async()=>{
 expect((await db.query("select transfer_recovery_reservations_enabled enabled from sales_team_controls_v1")).rows).toEqual([{enabled:false}]);expect(teamTransferRecoveryReservationsReady({})).toBe(false);
});
test.each(["creator","closer"] as const)("verified %s debt freezes one owned original and protects only explicit fee cost",async beneficiary=>{
 await fixture(beneficiary);const before=Number((await db.query<{n:string}>("select creatornet_team_private.cash_encumbered_v1()::text n")).rows[0].n),p=await reserve();
 const debt=Number((await db.query<{n:string}>("select creatornet_team_private.transfer_recovery_amount_v1($1,$2)::text n",[q.id,p.id])).rows[0].n);
 expect(p).toMatchObject({transfer_request_id:q.id,original_worker_run_id:run.runId,amount_cents:debt,cost_reserve_cents:30,operation:null,canceled:false,completed:false});expect(Number(p.amount_cents)).toBeGreaterThan(0);expect(Number(p.amount_cents)).toBeLessThanOrEqual(Number(q.amount_cents));
 expect(p.request.path).toBe("/v1/transfers/tr_original/reversals");expect(p.request.params.amount).toBe(debt);expect(p.scope).toMatchObject({kind:"reversal",workerRunId:run.runId,creatorId:q.creator_id});expect(p.operation_id).toBe(teamOperationId(p.scope));
 expect(Number((await db.query<{n:string}>("select creatornet_team_private.cash_encumbered_v1()::text n")).rows[0].n)).toBe(before+30);expect(raw.mock.calls.map(([m])=>m)).toEqual(["GET","GET","GET","GET"]);
 expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1 where kind='reversal'")).rows).toEqual([{n:0}]);await db.exec("set constraints all immediate");
});
test("a cold source refresh uses the actual bounded worker without a human admin",async()=>{
 await fixture();await advanceBy(16*60000);run=await f.rpc<Run>("claim_sales_team_transfer_recovery_run_v1",[id(101),c.context,true]);await db.exec("update profiles set role=null");
 const p=await reserve();expect(Number(p.amount_cents)).toBeGreaterThan(0);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
 expect((await db.query("select actor_id,event_id,worker_run_id from sales_team_financial_checks_v1 where id=(select financial_check_id from sales_team_transfer_recovery_tasks_v1)")).rows).toEqual([{actor_id:null,event_id:null,worker_run_id:run.runId}]);
});
test("service role can reserve but cannot fabricate immutable recovery facts",async()=>{
 await fixture();await db.exec("set role service_role");expect(Number((await reserve()).amount_cents)).toBeGreaterThan(0);
 for(const table of ["sales_team_transfer_recovery_runs_v1","sales_team_transfer_recovery_tasks_v1","sales_team_transfer_recovery_requests_v1","sales_team_transfer_recovery_cancellations_v1","sales_team_transfer_recovery_financial_links_v1","sales_team_transfer_recovery_root_reads_v1","sales_team_transfer_recovery_roots_v1"]){await denied(()=>db.exec(`insert into ${table} default values`),/permission denied/i);await denied(()=>db.exec(`delete from ${table}`),/permission denied/i);}
});
test.each(["anon","authenticated"])("%s cannot read source or claim/reserve",async role=>{
 await fixture();await db.exec(`set role ${role}`);await denied(()=>reserve(),/permission denied/i);await denied(()=>db.exec("select * from sales_team_transfer_recovery_requests_v1"),/permission denied/i);await denied(()=>f.rpc("claim_sales_team_transfer_recovery_run_v1",[id(101),c.context,true]),/permission denied/i);
});
test.each(["token","context","expiry","digest","disabled"])("changed %s holds the task before any provider reads",async change=>{
 await fixture();if(change==="token")run.leaseToken=id(109);if(change==="context")c.context={...c.context,mode:"live"};if(change==="expiry")await db.exec("update sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second'");if(change==="digest")await db.exec("update sales_team_cash_policy_v1 set transfer_contract_sha256=repeat('0',64)");if(change==="disabled")await db.exec("update sales_team_controls_v1 set transfer_recovery_reservations_enabled=false");
 await expect(reserve()).rejects.toThrow(/CURRENT_.*REQUIRED|context changed/);expect(raw).not.toHaveBeenCalled();expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_requests_v1")).rows).toEqual([{n:0}]);
});
test("observation-only authority is frozen at claim and cannot be upgraded",async()=>{
 await fixture();const p=await reserve();await db.exec("update sales_team_worker_runs_v1 set scheduled_slot=scheduled_slot-interval '15 minutes',lease_until=clock_timestamp()-interval '1 second'");
 taskId=id(103);run=await f.rpc<Run>("claim_sales_team_transfer_recovery_run_v1",[id(101),c.context,false]);expect((await begin()).request_id).toBe(p.id);await denied(()=>phase("begin_root"),/CURRENT_TRANSFER_RECOVERY_WORKER_REQUIRED/);
 await db.exec("update sales_team_controls_v1 set settlement_enabled=true,transfer_recovery_reservations_enabled=true");await denied(()=>reserve(),/CURRENT_TRANSFER_RECOVERY_WORKER_REQUIRED/);
 expect((await db.query("select allow_new from sales_team_transfer_recovery_runs_v1 where run_id=$1",[run.runId])).rows).toEqual([{allow_new:false}]);
});
test("no caller can provide a new amount or substitute the completed transfer",async()=>{
 await fixture();await begin();await denied(()=>f.rpc("begin_sales_team_transfer_recovery_v1",[run.runId,run.leaseToken,c.context,id(102),id(999)]),/COMPLETED_OWNED_RECOVERY_TRANSFER_REQUIRED/);await denied(()=>phase("begin_root",{amount:1}),/REQUIRED|DIFFERS|UNEXPECTED/);
});
test("a fresh root with unaccounted reversed principal holds and does not reserve",async()=>{
 await fixture();transfer.amount_reversed=1;await expect(reserve()).rejects.toThrow(/Unaccounted original transfer return/);expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_requests_v1")).rows).toEqual([{n:0}]);expect((await db.query("select status from sales_team_financial_alerts_v1 where code='TRANSFER_REVERSAL_REVIEW_REQUIRED'")).rows).toEqual([{status:"open"}]);
});
test.each(["foreign","aggregate","requests","revision","stale","private"])("invalid %s root cannot enable reservation",async change=>{
 await fixture();await begin();await phase("begin_root");const p=await readTeamOriginalTransferForRecovery(c,(await begin()).transfer);
 if(change==="foreign")p.transfer.destinationId="acct_foreign";if(change==="aggregate")p.transfer.amountReversedCents=Number(q.amount_cents)+1;if(change==="requests")p.transferReadRequestIds[1]=p.transferReadRequestIds[0];if(change==="revision")await db.exec("update sales_team_receipts_v1 set observation_revision=observation_revision+1");if(change==="stale")p.readStartedAt-=30000;if(change==="private")(p as unknown as Record<string,unknown>).private="synthetic";
 await denied(()=>phase("complete_root",p),/REQUIRED|DIFFERS|PRIVATE_PROVIDER_DATA/);expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_roots_v1")).rows).toEqual([{n:0}]);
});
test.each(["missing_reserve","insufficient","cash_drift"])("%s cannot reserve another beneficiary's protected cash",async change=>{
 await fixture();if(change==="missing_reserve")await db.exec("update sales_team_cash_policy_v1 set transfer_reversal_cost_reserve_cents=null");
 if(change==="insufficient"){const impl=raw.getMockImplementation()!;raw.mockImplementation(async(...args)=>{const v=await impl(...args);if(args[1]==="/v1/balance"){v.available=[{amount:1,currency:"usd",source_types:{card:1}}];}return v;});}
 if(change==="cash_drift"){const impl=raw.getMockImplementation()!;raw.mockImplementation(async(...args)=>{const v=await impl(...args);if(args[1]==="/v1/balance")await db.exec("update sales_team_cash_epoch_v1 set epoch=epoch+1");return v;});}
 await expect(reserve()).rejects.toThrow(/RESERVE_REQUIRED|INSUFFICIENT|FRESH_SETTLEMENT_CASH_REQUIRED/);expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_requests_v1")).rows).toEqual([{n:0}]);
});
test("pending originals retain the exact request, key, worker and fee allowance across runs",async()=>{
 await fixture();const p=await reserve();await db.exec("update sales_team_cash_policy_v1 set transfer_reversal_cost_reserve_cents=50;update sales_team_worker_runs_v1 set scheduled_slot=scheduled_slot-interval '15 minutes',lease_until=clock_timestamp()-interval '1 second'");
 taskId=id(103);run=await f.rpc<Run>("claim_sales_team_transfer_recovery_run_v1",[id(101),c.context,true]);const again=await reserve();expect(again).toEqual(p);expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_requests_v1")).rows).toEqual([{n:1}]);
});
test("an unknown original cannot be replaced or canceled after its outcome is uncertain",async()=>{
 await fixture();const p=await reserve();await db.query("insert into sales_team_provider_operations_v1(id,scope_id,scope_key,kind,sale_id,creator_id,worker_run_id,context,request,idempotency_key,status,first_dispatch_at) values($1,$2,'recovery:v1','reversal',$3,$4,$5,$6,$7,$8,'unknown',clock_timestamp())",[p.operation_id,p.id,q.sale_id,q.creator_id,p.original_worker_run_id,c.context,p.request,`cn-team-v1:${p.operation_id}`]);
 await denied(()=>cancel(),/ORIGINAL_TRANSFER_RECOVERY_RECONCILIATION_REQUIRED/);await expect(reserve()).rejects.toThrow(/requires reconciliation/);expect((await begin()).request_id).toBe(p.id);expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_requests_v1")).rows).toEqual([{n:1}]);
});
test("a never-journaled original can cancel only after fresh verified debt shrinks",async()=>{
 await fixture();const p=await reserve();await denied(()=>cancel(),/RECOVERY_DEBT_HAS_NOT_SHRUNK/);
 // Structural accounting change models an independently reconciled recovery of
 // released principal. Financial inspection reestablishes current exact proof.
 await db.query("update sales_team_creator_balances_v1 set creator_reversed_cents=creator_reversed_cents+1 where receipt_id=$1",[receiptId]);await inspectTeamReceiptFinancials(c,receiptId,id(29));
 const before=(await db.query("select epoch from sales_team_cash_epoch_v1")).rows;expect(await cancel()).toEqual({canceled:true,requestId:p.id});const after=(await db.query("select epoch from sales_team_cash_epoch_v1")).rows;expect(after).not.toEqual(before);expect(await cancel()).toEqual({canceled:true,requestId:p.id});expect((await db.query("select epoch from sales_team_cash_epoch_v1")).rows).toEqual(after);expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_requests_v1")).rows).toEqual([{n:1}]);
});
test("new-money-off preserves original inspection/cancellation but blocks new recovery phases",async()=>{
 await fixture();await reserve();await db.exec("update sales_team_controls_v1 set settlement_enabled=false,transfer_recovery_reservations_enabled=false");expect((await begin()).request_id).toBeTruthy();await denied(()=>phase("begin_root"),/CURRENT_TRANSFER_RECOVERY_WORKER_REQUIRED/);
 for(const kind of ["transfer","reversal","withdrawal","intent"]){expect(await f.rpc("sales_team_operation_admitted_v1",[{scopeId:id(164),scopeKey:"recovery:v1",kind,saleId:q.sale_id,creatorId:q.creator_id,actorId:null,workerRunId:run.runId},c.context])).toBe(false);}
});
test("finish records unfinished reservations as review_required, never a completed bank payout",async()=>{
 await fixture();await reserve();await f.rpc("finish_sales_team_reversal_observation_run_v1",[run.runId,run.leaseToken,c.context,false]);expect((await db.query("select status from sales_team_worker_runs_v1 where id=$1",[run.runId])).rows).toEqual([{status:"review_required"}]);
});

test("actual return releases only its saved allowance and compares real cost against that original",async()=>{
 await fixture();const p=await reserve(),amount=Number(p.amount_cents),stamp=Math.floor(Date.now()/1000);
 // Structural already-admitted journal fixture; this foundation has no POST
 // admission. F29 still independently verifies and accounts the real return.
 await db.query("insert into sales_team_provider_operations_v1(id,scope_id,scope_key,kind,sale_id,creator_id,worker_run_id,context,request,idempotency_key,status,first_dispatch_at,provider_id,provider_request_id,bound_at) values($1,$2,'recovery:v1','reversal',$3,$4,$5,$6,$7,$8,'bound',clock_timestamp(),'trr_original','req_reversalPost',clock_timestamp())",[p.operation_id,p.id,q.sale_id,q.creator_id,p.original_worker_run_id,c.context,p.request,`cn-team-v1:${p.operation_id}`]);
 transfer.amount_reversed=amount;transfer.reversed=amount===Number(q.amount_cents);
 values["/v1/transfers/tr_original/reversals/trr_original"]={object:"transfer_reversal",id:"trr_original",transfer:"tr_original",amount,currency:"usd",created:stamp,metadata:p.request.params.metadata,balance_transaction:"txn_return",source_refund:null,destination_payment_refund:null};
 values["/v1/balance_transactions/txn_return"]={object:"balance_transaction",id:"txn_return",source:"trr_original",type:"transfer_refund",reporting_category:"transfer_reversal",balance_type:"payments",currency:"usd",exchange_rate:null,amount,fee:31,net:amount-31,fee_details:[{amount:31,currency:"usd",application:null,type:"stripe_fee"}],created:stamp,available_on:stamp,status:"available"};
 await db.exec("update sales_team_cash_policy_v1 set transfer_reversal_cost_reserve_cents=50");const before=Number((await db.query<{n:string}>("select creatornet_team_private.cash_encumbered_v1()::text n")).rows[0].n);
 expect(await observeTeamBoundTransferReversal(c,{...run,taskId,operationId:p.operation_id,checkId:id(105)})).toMatchObject({recorded:true,held:true,actualTransferReversalCostCents:31});
 expect(Number((await db.query<{n:string}>("select creatornet_team_private.cash_encumbered_v1()::text n")).rows[0].n)).toBe(before-30);
 expect((await db.query("select evidence->>'reservedCostCents' reserve from sales_team_financial_alerts_v1 where source_identity=$1",[`transfer-reversal-cost:${p.operation_id}`])).rows).toEqual([{reserve:"30"}]);
});

async function structuralOriginal(n:number){
 const scope:TeamOperationScope={scopeId:id(200+n),scopeKey:"recovery:v1",kind:"reversal",saleId:q.sale_id,creatorId:q.creator_id,actorId:null,workerRunId:q.original_worker_run_id},operationId=teamOperationId(scope);
 const request={apiVersion:q.request.apiVersion,method:"POST",path:"/v1/transfers/tr_original/reversals",params:{amount:1,metadata:{team_protocol:"creatornet-team-recovery-v1",team_sale_id:q.sale_id,team_receipt_id:q.receipt_id,team_transfer_request_id:q.id,team_recovery_request_id:scope.scopeId,team_provider_operation_id:operationId,team_beneficiary:q.beneficiary}}};
 await db.query("insert into sales_team_provider_operations_v1(id,scope_id,scope_key,kind,sale_id,creator_id,worker_run_id,context,request,idempotency_key,status,first_dispatch_at,provider_id,provider_request_id,bound_at) values($1,$2,'recovery:v1','reversal',$3,$4,$5,$6,$7,$8,'bound',clock_timestamp(),$9,$10,clock_timestamp())",[operationId,scope.scopeId,q.sale_id,q.creator_id,scope.workerRunId,c.context,request,`cn-team-v1:${operationId}`,`trr_extra${n}`,`req_post${n}`]);
 return ()=>f.rpc("begin_sales_team_reversal_check_v1",[run.runId,run.leaseToken,c.context,id(260+n),operationId,id(250+n)]);
}
test.each([false,true])("three combined tasks bound observer and reservation work, recovery first=%s",async first=>{
 await fixture();if(first)await begin();
 for(let n=1;n<=(first?2:3);n++)await(await structuralOriginal(n))();
 if(first){const fourth=await structuralOriginal(4);await denied(fourth,/REVERSAL_TASK_LIMIT_REQUIRED/);}else await denied(()=>begin(),/REVERSAL_TASK_LIMIT_REQUIRED/);
 expect((await db.query("select creatornet_team_private.transfer_recovery_task_count_v1($1)::int n",[run.runId])).rows).toEqual([{n:3}]);
});
test.each(["task","root","reservation"])("authority expiring during %s creation rolls back that mutation",async kind=>{
 await fixture();const table=kind==="task"?"sales_team_transfer_recovery_tasks_v1":kind==="root"?"sales_team_transfer_recovery_roots_v1":"sales_team_transfer_recovery_requests_v1";
 await db.exec(`create function public.expire_fixture_recovery() returns trigger language plpgsql as $$begin update public.sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id='${run.runId}';return new;end$$;create trigger expire_fixture_recovery before insert on ${table} for each row execute function public.expire_fixture_recovery()`);
 await expect(reserve()).rejects.toThrow(/CURRENT_SETTLEMENT_WORKER_REQUIRED/);expect((await db.query(`select count(*)::int n from ${table}`)).rows).toEqual([{n:0}]);
});
test("stale financial proof cannot release a saved allowance by canceling a shrinking original",async()=>{
 await fixture();await reserve();await advanceBy(16*60000);taskId=id(103);run=await f.rpc<Run>("claim_sales_team_transfer_recovery_run_v1",[id(101),c.context,false]);await begin();await denied(()=>cancel(),/CURRENT_VERIFIED_RECOVERY_DEBT_REQUIRED/);
});
test("late failure restores request, protected cash and epoch atomically",async()=>{
 await fixture();const state=()=>db.query("select (select count(*)::int from sales_team_transfer_recovery_requests_v1) requests,(select epoch::text from sales_team_cash_epoch_v1) epoch,creatornet_team_private.cash_encumbered_v1()::text encumbered");const before=(await state()).rows;
 await db.exec("create function public.reject_fixture_recovery_epoch() returns trigger language plpgsql as $$begin if exists(select 1 from public.sales_team_transfer_recovery_requests_v1) then raise exception 'synthetic_recovery_late_failure';end if;return new;end$$;create trigger reject_fixture_recovery_epoch before update on sales_team_cash_epoch_v1 for each row execute function public.reject_fixture_recovery_epoch()");
 await expect(reserve()).rejects.toThrow(/synthetic_recovery_late_failure/);expect((await state()).rows).toEqual(before);
});
test("all protected-cash contract digests include the saved encumbrance implementation",async()=>{
 await fixture();const hashes=()=>db.query("select creatornet_team_private.transfer_contract_digest_v1() transfer,creatornet_team_private.shared_cash_contract_digest_v1() shared,creatornet_team_private.retained_cash_contract_digest_v1() retained,creatornet_team_private.recovery_contract_digest_v1() recovery");const before=(await hashes()).rows[0] as Record<string,string>;
 const source=(await db.query<{s:string}>("select pg_get_functiondef('creatornet_team_private.cash_encumbered_before_transfer_recovery_v1()'::regprocedure) s")).rows[0].s;
 await db.exec(source.replace("coalesce((select sum", "0+coalesce((select sum"));const after=(await hashes()).rows[0] as Record<string,string>;for(const key of ["transfer","shared","retained","recovery"])expect(after[key]).not.toBe(before[key]);await denied(()=>begin(),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);
});
test.each(["dependency","late_grant"])("migration %s failure restores all previous functions/grants and creates no foundation",async change=>{
 const isolated=await sharedCashDatabase(createLocalPostgres());try{
  for(const path of predecessors)await isolated.exec(readFileSync(path,"utf8"));
  if(change==="dependency"){const source=(await isolated.query<{s:string}>("select pg_get_functiondef('creatornet_team_private.cash_protection_v1(jsonb)'::regprocedure) s")).rows[0].s;await isolated.exec(source.replace("'transferCostReserveCents'","'changedTransferCostReserveCents'"));}
  const state=()=>isolated.query("select pg_get_functiondef('creatornet_team_private.cash_encumbered_v1()'::regprocedure) encumbered,pg_get_functiondef('creatornet_team_private.settlement_financial_authorized_v1(uuid,uuid,uuid)'::regprocedure) financial,has_function_privilege('service_role','public.begin_sales_team_reversal_check_v1(uuid,uuid,jsonb,uuid,uuid,uuid)','execute') allowed");const before=(await state()).rows;
  const source=readFileSync(candidate,"utf8"),sql=change==="late_grant"?source.replace("commit;","grant execute on function public.missing_transfer_recovery_final_grant() to service_role;commit;"):source;
  await expect(isolated.exec(sql)).rejects.toThrow(change==="dependency"?/RECOVERY_CASH_POLICY_DEPENDENCY_DIFFERS/:/missing_transfer_recovery_final_grant/);await isolated.exec("rollback");expect((await state()).rows).toEqual(before);
  expect((await isolated.query("select to_regclass('public.sales_team_transfer_recovery_requests_v1') relation,to_regprocedure('creatornet_team_private.cash_encumbered_before_transfer_recovery_v1()') helper")).rows).toEqual([{relation:null,helper:null}]);
 }finally{await isolated.close();}
},30000);

test("a retry in the same worker reuses its fresh immutable root and reserves cost only once",async()=>{
 await fixture();const p=await reserve(),epoch=(await db.query("select epoch from sales_team_cash_epoch_v1")).rows;raw.mockClear();expect(await reserve()).toEqual(p);expect(raw.mock.calls.map(([method,path])=>[method,path])).toEqual([["GET","/v1/balance"],["GET","/v1/balance"]]);expect((await db.query("select epoch from sales_team_cash_epoch_v1")).rows).toEqual(epoch);
});
test("a cached root cannot outlive its freshness window",async()=>{
 await fixture();await reserve();await advanceBy(26000);await expect(reserve()).rejects.toThrow(/FRESH_RECOVERY_ROOT_REQUIRED/);expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_requests_v1")).rows).toEqual([{n:1}]);
});
test("authority expiring during cancellation restores its allowance and epoch",async()=>{
 await fixture();await reserve();await db.query("update sales_team_creator_balances_v1 set creator_reversed_cents=creator_reversed_cents+1 where receipt_id=$1",[receiptId]);await inspectTeamReceiptFinancials(c,receiptId,id(29));
 const state=()=>db.query("select (select count(*)::int from sales_team_transfer_recovery_cancellations_v1) canceled,(select epoch::text from sales_team_cash_epoch_v1) epoch,creatornet_team_private.cash_encumbered_v1()::text encumbered");const before=(await state()).rows;
 await db.exec(`create function public.expire_fixture_recovery_cancel() returns trigger language plpgsql as $$begin update public.sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id='${run.runId}';return new;end$$;create trigger expire_fixture_recovery_cancel before insert on sales_team_transfer_recovery_cancellations_v1 for each row execute function public.expire_fixture_recovery_cancel()`);
 await denied(()=>cancel(),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);expect((await state()).rows).toEqual(before);
});
test.each(["amount","worker","canceled"])("an F30 %s mismatch cannot masquerade as its frozen original in F29",async change=>{
 await fixture();const p=await reserve(),request=JSON.parse(JSON.stringify(p.request));if(change==="amount")request.params.amount--;
 if(change==="canceled")await db.query("insert into sales_team_transfer_recovery_cancellations_v1(request_id,worker_run_id,reason) values($1,$2,'not_dispatched')",[p.id,run.runId]);
 // Deliberately inconsistent structural history simulates an old admission
 // defect. Current observation must refuse this identity before provider reads.
 await db.query("insert into sales_team_provider_operations_v1(id,scope_id,scope_key,kind,sale_id,creator_id,worker_run_id,context,request,idempotency_key,status,first_dispatch_at,provider_id,provider_request_id,bound_at) values($1,$2,'recovery:v1','reversal',$3,$4,$5,$6,$7,$8,'bound',clock_timestamp(),'trr_original','req_reversalPost',clock_timestamp())",[p.operation_id,p.id,q.sale_id,q.creator_id,change==="worker"?q.original_worker_run_id:p.original_worker_run_id,c.context,request,`cn-team-v1:${p.operation_id}`]);
 raw.mockClear();await denied(()=>f.rpc("begin_sales_team_reversal_check_v1",[run.runId,run.leaseToken,c.context,taskId,p.operation_id,id(105)]),/FROZEN_ORIGINAL_TRANSFER_RECOVERY_REQUIRED/);expect(raw).not.toHaveBeenCalled();expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_checks_v1")).rows).toEqual([{n:0}]);
});
