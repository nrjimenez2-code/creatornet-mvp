/** @jest-environment ./test-support/pglite-environment.cjs */
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
import {reserveTeamTransferRecovery,type TeamTransferRecoveryRequest} from "@/lib/salesTeams/transferRecoveryReservations";
import {dispatchTeamTransferRecovery} from "@/lib/salesTeams/transferRecoveryExecution";
import {readTeamOriginalTransferForRecovery} from "@/lib/salesTeams/transferReversalReadback";
import {readTeamCashProof} from "@/lib/salesTeams/cashReadback";
import {observeTeamBoundTransferReversal} from "@/lib/salesTeams/transferReversalObservations";
import {teamOperationId,type TeamOperationScope} from "@/lib/salesTeams/providerOperation";
import type Stripe from "stripe";


import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
import {teamTransferRecoveryExecutionReady} from "@/lib/salesTeams/policy";
declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261024215948_sales_team_transfer_recovery_execution.sql";
const predecessors=[sharedCashReconciliationCandidate,"supabase/migrations/20261023042321_sales_team_retained_refund_funding.sql","supabase/migrations/20261023060912_sales_team_automatic_recovery.sql","supabase/migrations/20261023063905_sales_team_worker_refund_recovery.sql","supabase/migrations/20261023174324_sales_team_no_outbound_shared_recovery.sql","supabase/migrations/20261023180144_sales_team_transfer_reservations.sql","supabase/migrations/20261023182527_sales_team_transfer_observations.sql","supabase/migrations/20261023184139_sales_team_transfer_execution.sql","supabase/migrations/20261023190044_sales_team_automatic_settlement.sql","supabase/migrations/20261024210829_sales_team_transfer_reversal_observations.sql","supabase/migrations/20261024213841_sales_team_transfer_recovery_reservations.sql"];
type Run={runId:string;leaseToken:string};
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,c:TeamReceiptComposition,receiptId:string,q:TeamTransferRequest,p:TeamTransferRecoveryRequest,run:Run,raw:jest.Mock;
let transfer:Record<string,unknown>,reversal:Record<string,unknown>,returned:Record<string,unknown>,values:Record<string,Record<string,unknown>>,advanceClock:(ms:number)=>Promise<void>;
const realNow=Date.now.bind(Date);let clockOffset=0,taskId=id(102);
beforeAll(async()=>{db=createLocalPostgres();advanceClock=await installTeamLocalClock(db);await sharedCashDatabase(db);for(const path of [...predecessors,candidate])await db.exec(readFileSync(path,"utf8"));},30000);
beforeEach(async()=>{clockOffset=0;taskId=id(102);await db.exec("begin");});afterEach(async()=>{await db.exec("rollback;reset role");jest.restoreAllMocks();});afterAll(async()=>{await db?.close();});
async function advanceBy(ms:number){clockOffset+=ms;jest.spyOn(Date,"now").mockImplementation(()=>realNow()+clockOffset);await advanceClock(clockOffset);}
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
async function fixture(beneficiary:"creator"|"closer"="creator"){
 await db.exec("update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true,cash_reservations_enabled=true,settlement_enabled=true,transfer_reservations_enabled=true,transfer_observations_enabled=true,transfer_execution_enabled=true,transfer_reversal_observations_enabled=true,transfer_recovery_reservations_enabled=true,transfer_recovery_execution_enabled=true");
 f=await seedTeamCapture(db);f.base.balance.available_on=Math.floor(Date.now()/1000);f.base.balance.status="available";receiptId=String((await f.record()).id);await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,transfer_cost_reserve_cents=30,transfer_reversal_cost_reserve_cents=30,evidence='{\"scope\":\"synthetic original reversal observer fixture\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1(),retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1(),transfer_contract_sha256=creatornet_team_private.transfer_contract_digest_v1()");
 values={};let sequence=0;
 raw=jest.fn(async(method:string,path:string,params:unknown,options:Record<string,unknown>)=>{
  if(method==="POST"){
   if(path==="/v1/transfers"){if(options.idempotencyKey!==`cn-team-v1:${q.operation_id}`||JSON.stringify(params)!==JSON.stringify(q.request.params))throw Error("Only original fixture transfer is permitted");return JSON.parse(JSON.stringify({...transfer,lastResponse:{requestId:"req_transferPost"}}));}
   if(path!==p.request.path||options.idempotencyKey!==`cn-team-v1:${p.operation_id}`||JSON.stringify(params)!==JSON.stringify(p.request.params))throw Error("Only frozen original recovery POST is permitted");
   transfer.amount_reversed=Number(p.amount_cents);transfer.reversed=Number(p.amount_cents)===Number(q.amount_cents);
   reversal.created=Math.floor(Date.now()/1000);returned.created=reversal.created;if(returned.status==='available')returned.available_on=reversal.created;
   return JSON.parse(JSON.stringify({...reversal,lastResponse:{requestId:"req_recoveryPost"}}));
  }
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
  run=await f.rpc<Run>("claim_sales_team_transfer_recovery_execution_run_v1",[id(100),c.context,true]);
 p=await reserveTeamTransferRecovery(c,{...run,taskId,transferRequestId:q.id});const reverseStamp=Math.floor(Date.now()/1000),amount=Number(p.amount_cents);
 reversal={object:"transfer_reversal",id:"trr_original",transfer:"tr_original",amount,currency:"usd",created:reverseStamp,metadata:p.request.params.metadata,balance_transaction:"txn_return",source_refund:null,destination_payment_refund:"pyr_original",description:"synthetic private reversal description"};
 returned={object:"balance_transaction",id:"txn_return",source:"trr_original",type:"transfer_refund",reporting_category:"transfer_reversal",balance_type:"payments",currency:"usd",exchange_rate:null,amount,fee:12,net:amount-12,fee_details:[{amount:12,currency:"usd",application:null,type:"stripe_fee"}],created:reverseStamp,available_on:reverseStamp,status:"available"};
 values["/v1/transfers/tr_original/reversals/trr_original"]=reversal;values["/v1/balance_transactions/txn_return"]=returned;raw.mockClear();
}
async function refund(amount=1000){
 const stamp=Math.floor(Date.now()/1000),refund={object:"refund",id:"re_original",charge:"ch_original",payment_intent:"pi_original",amount,currency:"usd",status:"succeeded",created:stamp,balance_transaction:"txn_refund",failure_balance_transaction:null,transfer_reversal:null,source_transfer_reversal:null,metadata:{}};
 values["/v1/refunds"]={object:"list",data:[refund],has_more:false};values["/v1/refunds/re_original"]=refund;values["/v1/balance_transactions/txn_refund"]={object:"balance_transaction",id:"txn_refund",source:refund.id,type:"refund",reporting_category:"refund",balance_type:"payments",currency:"usd",exchange_rate:null,amount:-amount,fee:0,net:-amount,fee_details:[],created:stamp,available_on:stamp,status:"available"};f.base.charge.amount_refunded=amount;
 await inspectTeamReceiptFinancials(c,receiptId,id(29));const revision=Number((await db.query<{r:number}>("select observation_revision r from sales_team_receipts_v1")).rows[0].r);await db.exec("update sales_team_controls_v1 set refund_review_enabled=true");await reviewTeamRefundResponsibility(c,{actorId:id(29),receiptId,requestId:id(140),expectedRevision:revision,refundId:refund.id,responsibility:"creator",reasonCode:"creator_discretionary"});await inspectTeamReceiptFinancials(c,receiptId,id(29));
}
const dispatch=(admit=false)=>dispatchTeamTransferRecovery(c,{...run,taskId,requestId:p.id,checkId:id(105)},admit);
const posts=()=>raw.mock.calls.filter(([method])=>method==="POST");
const port=<T=unknown>(phase:string,payload:unknown={})=>f.rpc<T>("run_sales_team_transfer_recovery_execution_v1",[run.runId,run.leaseToken,c.context,taskId,phase,payload]);

test("execution is independently default off",async()=>{expect((await db.query("select transfer_recovery_execution_enabled enabled from sales_team_controls_v1")).rows).toEqual([{enabled:false}]);expect(teamTransferRecoveryExecutionReady({})).toBe(false);});
test("observation default does not dispatch a reserved original",async()=>{await fixture();expect(await dispatch()).toMatchObject({status:"not_dispatched",completed:false});expect(raw).not.toHaveBeenCalled();expect(posts()).toHaveLength(0);});
test.each(["creator","closer"] as const)("one exact %s recovery POST reaches available original-return accounting once",async beneficiary=>{
 await fixture(beneficiary);expect(await dispatch(true)).toMatchObject({status:"accounted",completed:true});expect(posts()).toHaveLength(1);expect(posts()[0][1]).toBe(p.request.path);expect(posts()[0][2]).toEqual(p.request.params);expect(posts()[0][3]).toMatchObject({idempotencyKey:`cn-team-v1:${p.operation_id}`,apiVersion:p.request.apiVersion,maxNetworkRetries:0,timeout:10000});
 expect((await db.query("select worker_run_id from sales_team_transfer_recovery_execution_admissions_v1")).rows).toEqual([{worker_run_id:run.runId}]);expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_execution_assertions_v1")).rows).toEqual([{n:1}]);expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_execution_reads_v1")).rows).toEqual([{n:2}]);expect((await db.query("select fee_cents::int fee from sales_team_transfer_reversal_costs_v1")).rows).toEqual([{fee:12}]);
 const ledger=(await db.query("select entry_kind,amount_cents::int amount from sales_team_financial_ledger_v1 where entry_kind='transfer_reversal'")).rows;expect(ledger).toEqual([{entry_kind:"transfer_reversal",amount:-Number(p.amount_cents)}]);await db.exec("set constraints all immediate");raw.mockClear();expect(await dispatch(true)).toMatchObject({status:"accounted",completed:true});expect(raw).not.toHaveBeenCalled();
});
test("turning execution off holds the original without an admission or provider call",async()=>{
 await fixture();await db.exec("update sales_team_controls_v1 set transfer_recovery_execution_enabled=false");expect(await dispatch(true)).toMatchObject({status:"not_enabled"});expect(raw).not.toHaveBeenCalled();expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_execution_admissions_v1")).rows).toEqual([{n:0}]);
});
test("a lost POST outcome keeps its original key, fee protection and unknown journal",async()=>{
 await fixture();const impl=raw.getMockImplementation()!;raw.mockImplementation(async(...args)=>{const value=await impl(...args);if(args[0]==="POST")throw Error("synthetic lost recovery response");return value;});
 expect(await dispatch(true)).toMatchObject({status:"reconciliation_required",completed:false});expect(posts()).toHaveLength(1);expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(posts()).toHaveLength(1);expect((await db.query("select status,provider_id,idempotency_key from sales_team_provider_operations_v1 where id=$1",[p.operation_id])).rows).toEqual([{status:"unknown",provider_id:null,idempotency_key:`cn-team-v1:${p.operation_id}`}]);expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_completions_v1")).rows).toEqual([{n:0}]);
});
test("a known pending return binds once and accounts later with new-money gates off",async()=>{
 await fixture();returned.status="pending";returned.available_on=Math.floor(Date.now()/1000)+86400;expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(posts()).toHaveLength(1);expect((await db.query("select provider_id from sales_team_provider_operations_v1 where id=$1",[p.operation_id])).rows).toEqual([{provider_id:"trr_original"}]);
 await db.exec("update sales_team_controls_v1 set settlement_enabled=false,transfer_recovery_reservations_enabled=false,transfer_recovery_execution_enabled=false");returned.status="available";returned.available_on=Math.floor(Date.now()/1000);expect(await dispatch()).toMatchObject({status:"accounted",completed:true});expect(posts()).toHaveLength(1);
});
test("an asserted original can bind its outcome after worker expiry without accounting under expired authority",async()=>{
 await fixture();const impl=raw.getMockImplementation()!;raw.mockImplementation(async(...args)=>{const value=await impl(...args);if(args[0]==="POST")await db.query("update sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id=$1",[run.runId]);return value;});
 expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(posts()).toHaveLength(1);expect((await db.query("select provider_id,status from sales_team_provider_operations_v1 where id=$1",[p.operation_id])).rows).toEqual([{provider_id:"trr_original",status:"bound"}]);expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_completions_v1")).rows).toEqual([{n:0}]);
});
test.each(["token","task","context"])("wrong current %s cannot reach provider transport",async change=>{
 await fixture();await denied(()=>dispatchTeamTransferRecovery(change==="context"?{...c,context:{...c.context,mode:"live"}}:c,{...run,leaseToken:change==="token"?id(106):run.leaseToken,taskId:change==="task"?id(106):taskId,requestId:p.id,checkId:id(105)},true),/CURRENT_|ORIGINAL_RECOVERY_EXECUTION_TASK_REQUIRED|requires review/);expect(raw).not.toHaveBeenCalled();
});
test("a later actual dispatcher preserves the frozen reservation's original-worker identity",async()=>{
 await fixture();const firstRun=run.runId;await advanceBy(16*60000);run=await f.rpc<Run>("claim_sales_team_transfer_recovery_execution_run_v1",[id(101),c.context,true]);taskId=id(103);await f.rpc("begin_sales_team_transfer_recovery_v1",[run.runId,run.leaseToken,c.context,taskId,q.id]);
 expect(await dispatch(true)).toMatchObject({status:"accounted"});expect((await db.query("select worker_run_id from sales_team_provider_operations_v1 where id=$1",[p.operation_id])).rows).toEqual([{worker_run_id:firstRun}]);expect((await db.query("select worker_run_id from sales_team_transfer_recovery_execution_admissions_v1")).rows).toEqual([{worker_run_id:run.runId}]);
});

async function fresh(checkId:string,readId:string){
 const begun=await port<{readId:string;transfer:TeamTransferRequest}>("begin_check",{checkId});const proof=await readTeamOriginalTransferForRecovery(c,begun.transfer);await port("complete_check",{checkId,proof});
 await f.rpc("begin_sales_team_settlement_cash_v1",[run.runId,run.leaseToken,c.context,readId]);const cash=await readTeamCashProof(c.context,c.observeContext,async timeout=>await c.stripe.rawRequest("GET","/v1/balance",{},{apiVersion:p.request.apiVersion,maxNetworkRetries:0,timeout}) as unknown as Stripe.Response<Stripe.Balance>);
 await f.rpc("complete_sales_team_settlement_cash_v1",[run.runId,run.leaseToken,c.context,readId,cash]);await port("recheck",{checkId,readId});
}
const claim=()=>port<{operation:{lease_token:string}}>("claim",{operationId:p.operation_id,scope:p.scope,request:p.request});
test("claim and assertion require distinct independently read root/cash evidence",async()=>{
 await fixture();await fresh(id(150),id(151));const op=(await claim()).operation;await denied(()=>port("assert",{operationId:p.operation_id,leaseToken:op.lease_token}),/DISTINCT_POSTCLAIM_RECOVERY_RECHECK_REQUIRED/);
 await fresh(id(152),id(153));await port("assert",{operationId:p.operation_id,leaseToken:op.lease_token});await denied(()=>port("assert",{operationId:p.operation_id,leaseToken:op.lease_token}),/SINGLE_CURRENT_RECOVERY_ASSERTION_REQUIRED/);
 for(const name of ["assert_sales_team_provider_dispatch_v1","assert_sales_team_dispatch_before_transfer_v1"]){await denied(()=>f.rpc(name,[p.operation_id,op.lease_token]),/SINGLE_CURRENT_RECOVERY_ASSERTION_REQUIRED/);}
 expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_execution_assertions_v1")).rows).toEqual([{n:1}]);expect(posts()).toHaveLength(0);
});
test("generic claim aliases cannot change a frozen original's bytes, kind or worker",async()=>{
 await fixture();await fresh(id(150),id(151));await claim();for(const name of ["claim_sales_team_provider_operation_v1","claim_sales_team_operation_before_transfer_v1","claim_sales_team_operation_before_refund_v1"]){
  for(const change of ["bytes","kind","worker"]){await denied(()=>f.rpc(name,[p.operation_id,change==="kind"?{...p.scope,kind:"intent"}:change==="worker"?{...p.scope,workerRunId:id(29)}:p.scope,c.context,change==="bytes"?{...p.request,params:{...p.request.params,amount:1}}:p.request]),/ORIGINAL_RECOVERY_EXECUTION_REQUEST_REQUIRED/);}
 }
});
test("neither generic binding alias can adopt an unknown reversal without original event proof",async()=>{
 await fixture();await fresh(id(150),id(151));const op=(await claim()).operation;await fresh(id(152),id(153));await port("assert",{operationId:p.operation_id,leaseToken:op.lease_token});
 await denied(()=>f.rpc("mark_sales_team_provider_unknown_v1",[p.operation_id,op.lease_token]),/ASSERTED_ORIGINAL_RECOVERY_OUTCOME_REQUIRED/);
 for(const name of ["bind_sales_team_provider_operation_v1","bind_sales_team_operation_before_transfer_proof_v1"]){for(const reconciled of [false,true])await denied(()=>f.rpc(name,[p.operation_id,"trr_forged","req_forged",reconciled]),/INDEPENDENT_ORIGINAL_RECOVERY_EVENT_REQUIRED/);}
 expect((await db.query("select provider_id from sales_team_provider_operations_v1 where id=$1",[p.operation_id])).rows).toEqual([{provider_id:null}]);
});

test("reservation-only workers cannot acquire execution authority through the dispatcher",async()=>{
 await fixture();await advanceBy(16*60000);run=await f.rpc<Run>("claim_sales_team_transfer_recovery_run_v1",[id(101),c.context,true]);taskId=id(103);await f.rpc("begin_sales_team_transfer_recovery_v1",[run.runId,run.leaseToken,c.context,taskId,q.id]);
 await denied(()=>dispatch(true),/CURRENT_TRANSFER_RECOVERY_EXECUTION_WORKER_REQUIRED/);expect(posts()).toHaveLength(0);expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_execution_runs_v1 where run_id=$1",[run.runId])).rows).toEqual([{n:0}]);
});
test.each(["observer","disabled_at_claim"])("%s execution authority remains frozen when gates later enable",async change=>{
 await fixture();await advanceBy(16*60000);if(change==="disabled_at_claim")await db.exec("update sales_team_controls_v1 set transfer_recovery_execution_enabled=false");run=await f.rpc<Run>("claim_sales_team_transfer_recovery_execution_run_v1",[id(101),c.context,change!=="observer"]);taskId=id(103);await f.rpc("begin_sales_team_transfer_recovery_v1",[run.runId,run.leaseToken,c.context,taskId,q.id]);await db.exec("update sales_team_controls_v1 set transfer_recovery_execution_enabled=true");raw.mockClear();
 expect(await dispatch(true)).toMatchObject({status:"not_enabled"});expect(raw).not.toHaveBeenCalled();expect((await db.query("select allow_new from sales_team_transfer_recovery_execution_runs_v1 where run_id=$1",[run.runId])).rows).toEqual([{allow_new:false}]);
});
test.each(["anon","authenticated"])("%s cannot read or enter execution",async role=>{
 await fixture();await db.exec(`set role ${role}`);await denied(()=>dispatch(true),/permission denied/i);await denied(()=>f.rpc("claim_sales_team_transfer_recovery_execution_run_v1",[id(101),c.context,true]),/permission denied/i);await denied(()=>db.exec("select * from sales_team_transfer_recovery_execution_admissions_v1"),/permission denied/i);
});
test("service can execute the admitted flow but cannot invent sidecar authority or call the private root clone",async()=>{
 await fixture();await db.exec("set role service_role");expect(await dispatch(true)).toMatchObject({status:"accounted"});
 for(const table of ["runs","reads","roots","rechecks","admissions","actions","assertions"]){await denied(()=>db.exec(`insert into public.sales_team_transfer_recovery_execution_${table}_v1 default values`),/permission denied/i);await denied(()=>db.exec(`delete from public.sales_team_transfer_recovery_execution_${table}_v1`),/permission denied/i);}
 await denied(()=>db.query("select creatornet_team_private.run_transfer_recovery_execution_root_v1($1,$2,$3,$4,$5,'begin_root','{}')",[run.runId,run.leaseToken,c.context,taskId,id(150)]),/permission denied/i);
});
test.each(["lease","digest","financial_policy"])("changed %s cannot admit new original recovery",async change=>{
 await fixture();if(change==="lease")await db.query("update sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id=$1",[run.runId]);if(change==="digest")await db.exec("update sales_team_cash_policy_v1 set transfer_contract_sha256=repeat('0',64)");if(change==="financial_policy")await db.exec("update sales_team_financial_config_v1 set actual_pricing_verified=false");
 if(change==="financial_policy")expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});else await denied(()=>dispatch(true),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);expect(posts()).toHaveLength(0);expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_execution_admissions_v1")).rows).toEqual([{n:0}]);
});
test("unaccounted provider aggregate creates a hold before admission",async()=>{
 await fixture();transfer.amount_reversed=1;expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(posts()).toHaveLength(0);expect((await db.query("select status from sales_team_financial_alerts_v1 where source_identity=$1",[`transfer-reversals:${q.id}`])).rows).toEqual([{status:"open"}]);
});
test("cash insufficient for the shared protection and saved fee never creates a journal",async()=>{
 await fixture();const impl=raw.getMockImplementation()!;raw.mockImplementation(async(...args)=>{const value=await impl(...args);if(args[1]==="/v1/balance")value.available=[{amount:1,currency:"usd",source_types:{card:1}}];return value;});expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(posts()).toHaveLength(0);expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1 where id=$1",[p.operation_id])).rows).toEqual([{n:0}]);
});
test("cash epoch change after reads invalidates original admission",async()=>{
 await fixture();const base=c.admin;c={...c,admin:{rpc:async(name:string,args:Record<string,unknown>)=>{if(name==="run_sales_team_transfer_recovery_execution_v1"&&args.p_phase==="claim")await db.exec("update sales_team_cash_epoch_v1 set epoch=epoch+1");return base.rpc(name,args);}} as unknown as TeamReceiptComposition["admin"]};
 expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(posts()).toHaveLength(0);expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_execution_admissions_v1")).rows).toEqual([{n:0}]);
});
test("a stale source/cash proof cannot claim an original",async()=>{
 await fixture();await fresh(id(150),id(151));await advanceBy(26000);await denied(claim,/FRESH_RECOVERY_EXECUTION_SOURCE_CASH_REQUIRED/);expect(posts()).toHaveLength(0);
});
test("a provider lease cannot be renewed by obtaining later source proof",async()=>{
 await fixture();await fresh(id(150),id(151));const op=(await claim()).operation;await advanceBy(31000);await fresh(id(152),id(153));await denied(()=>port("assert",{operationId:p.operation_id,leaseToken:op.lease_token}),/PROVIDER_DISPATCH_NO_LONGER_ADMITTED/);expect(posts()).toHaveLength(0);expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_execution_assertions_v1")).rows).toEqual([{n:0}]);
});
test("a task cannot exceed two immutable dispatch rechecks",async()=>{
 await fixture();await fresh(id(150),id(151));await fresh(id(152),id(153));await denied(()=>port("begin_check",{checkId:id(154)}),/RECOVERY_EXECUTION_RECHECK_LIMIT_REQUIRED/);expect(posts()).toHaveLength(0);
});
test.each(["amount","transfer","currency","metadata","source_refund","created","balance","duplicate_get_request","changed_get"])("invalid %s response keeps the exact original unknown without accounting",async change=>{
 await fixture();const impl=raw.getMockImplementation()!;raw.mockImplementation(async(...args)=>{const value=await impl(...args);
  if(args[0]==="POST"){
   if(change==="amount")value.amount++;if(change==="transfer")value.transfer="tr_foreign";if(change==="currency")value.currency="eur";if(change==="metadata")value.metadata={};if(change==="source_refund")value.source_refund="re_foreign";if(change==="created")value.created-=100;if(change==="balance")value.balance_transaction="foreign";
  }
  if(args[1]===`${p.request.path}/trr_original`){if(change==="duplicate_get_request")value.lastResponse.requestId="req_recoveryPost";if(change==="changed_get")value.amount++;}return value;
 });
 expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(posts()).toHaveLength(1);expect((await db.query("select status,provider_id from sales_team_provider_operations_v1 where id=$1",[p.operation_id])).rows).toEqual([{status:"unknown",provider_id:null}]);expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_completions_v1")).rows).toEqual([{n:0}]);
});
test("missing immediate balance details may bind identity but never release principal",async()=>{
 await fixture();reversal.balance_transaction=null;expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(posts()).toHaveLength(1);expect((await db.query("select provider_id from sales_team_provider_operations_v1 where id=$1",[p.operation_id])).rows).toEqual([{provider_id:"trr_original"}]);expect((await db.query("select count(*)::int n from sales_team_transfer_reversal_completions_v1")).rows).toEqual([{n:0}]);
});
test("context drift after the original POST drains an unknown outcome without more provider reads",async()=>{
 await fixture();let current=c.context;const initial=c.context;c={...c,observeContext:async()=>current};const impl=raw.getMockImplementation()!;raw.mockImplementation(async(...args)=>{const value=await impl(...args);if(args[0]==="POST")current={...initial,mode:"live"};return value;});
 expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(posts()).toHaveLength(1);const postAt=raw.mock.calls.findIndex(([method])=>method==="POST");expect(raw.mock.calls.slice(postAt+1)).toEqual([]);expect((await db.query("select status from sales_team_provider_operations_v1 where id=$1",[p.operation_id])).rows).toEqual([{status:"unknown"}]);
});
test("a late first GET stops at the total observation budget without starting another",async()=>{
 await fixture();const impl=raw.getMockImplementation()!;raw.mockImplementation(async(...args)=>{const value=await impl(...args);await advanceBy(65000);return value;});expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(raw).toHaveBeenCalledTimes(1);expect(posts()).toHaveLength(0);
});
test.each(["admission","journal","assertion"])("authority expiring during %s creation rolls back the admitted mutation",async kind=>{
 await fixture();const table=kind==="admission"?"sales_team_transfer_recovery_execution_admissions_v1":kind==="journal"?"sales_team_provider_operations_v1":"sales_team_transfer_recovery_execution_assertions_v1";
 await db.exec(`create function public.expire_fixture_recovery_execution() returns trigger language plpgsql as $$begin update public.sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id='${run.runId}';return new;end$$;create trigger expire_fixture_recovery_execution before insert on ${table} for each row execute function public.expire_fixture_recovery_execution()`);
 expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(posts()).toHaveLength(0);expect((await db.query(`select count(*)::int n from ${table} ${kind==="journal"?"where kind='reversal'":""}`)).rows).toEqual([{n:0}]);
});
test("fee overrun is actual creator cost against the saved allowance after real local dispatch",async()=>{
 await fixture();returned.fee=31;returned.net=Number(p.amount_cents)-31;returned.fee_details=[{amount:31,currency:"usd",application:null,type:"stripe_fee"}];await db.exec("update sales_team_cash_policy_v1 set transfer_reversal_cost_reserve_cents=50");
 expect(await dispatch(true)).toMatchObject({status:"accounted",held:true});expect(posts()).toHaveLength(1);expect((await db.query("select evidence->>'reservedCostCents' reserve from sales_team_financial_alerts_v1 where source_identity=$1",[`transfer-reversal-cost:${p.operation_id}`])).rows).toEqual([{reserve:"30"}]);expect((await db.query("select actual_transfer_cost_cents::int fee from sales_team_creator_balances_v1")).rows).toEqual([{fee:31}]);
 const statement=await f.rpc<{bankPayoutStatus:string}>("read_sales_team_statement_v1",[id(1),id(1),null,20]);expect(statement.bankPayoutStatus).toBe("not_recorded");
});
test("named execution assertion authority is included in all four reviewed contract digests",async()=>{
 await fixture();const hashes=()=>db.query("select creatornet_team_private.transfer_contract_digest_v1() transfer,creatornet_team_private.shared_cash_contract_digest_v1() shared,creatornet_team_private.retained_cash_contract_digest_v1() retained,creatornet_team_private.recovery_contract_digest_v1() recovery");const before=(await hashes()).rows[0] as Record<string,string>;
 const source=(await db.query<{s:string}>("select pg_get_functiondef('creatornet_team_private.consume_transfer_recovery_assertion_v1(uuid,uuid)'::regprocedure) s")).rows[0].s;await db.exec(source.replaceAll("SINGLE_CURRENT_RECOVERY_ASSERTION_REQUIRED","synthetic_changed_recovery_assertion"));const after=(await hashes()).rows[0] as Record<string,string>;for(const key of ["transfer","shared","retained","recovery"])expect(after[key]).not.toBe(before[key]);await denied(()=>dispatch(true),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);expect(posts()).toHaveLength(0);
});
test.each(["dependency","late_grant"])("migration %s failure rolls back authority, guards, tables and grants",async change=>{
 const isolated=await sharedCashDatabase(createLocalPostgres());try{
  for(const path of predecessors)await isolated.exec(readFileSync(path,"utf8"));
  if(change==="dependency"){const source=(await isolated.query<{s:string}>("select pg_get_functiondef('public.run_sales_team_transfer_recovery_v1(uuid,uuid,jsonb,uuid,text,jsonb)'::regprocedure) s")).rows[0].s;await isolated.exec(source.replace("declare task ","declare /* sales_team_transfer_recovery_root_reads_v1 */ task "));}
  const state=()=>isolated.query("select pg_get_functiondef('public.sales_team_operation_admitted_v1(jsonb,jsonb)'::regprocedure) admitted,pg_get_functiondef('public.claim_sales_team_operation_before_refund_v1(uuid,jsonb,jsonb,jsonb)'::regprocedure) claim,pg_get_functiondef('public.bind_sales_team_operation_before_transfer_proof_v1(uuid,text,text,boolean)'::regprocedure) binding,has_function_privilege('service_role','public.claim_sales_team_operation_before_refund_v1(uuid,jsonb,jsonb,jsonb)','execute') allowed");const before=(await state()).rows;
  const source=readFileSync(candidate,"utf8"),sql=change==="late_grant"?source.replace("commit;","grant execute on function public.missing_recovery_execution_final_grant() to service_role;commit;"):source;await expect(isolated.exec(sql)).rejects.toThrow(change==="dependency"?/RECOVERY_EXECUTION_ROOT_DEPENDENCY_DIFFERS/:/missing_recovery_execution_final_grant/);await isolated.exec("rollback");expect((await state()).rows).toEqual(before);expect((await isolated.query("select to_regclass('public.sales_team_transfer_recovery_execution_admissions_v1') relation,to_regprocedure('creatornet_team_private.consume_transfer_recovery_assertion_v1(uuid,uuid)') helper")).rows).toEqual([{relation:null,helper:null}]);
 }finally{await isolated.close();}
},30000);
test("departure and a new mutable recipient never redirect the accepted original recovery",async()=>{
 await fixture("closer");const destination=q.destination_id;await db.exec("update sales_team_memberships_v1 set status='removed'");await db.query("update sales_team_recipients_v1 set account_id='acct_newCloser' where user_id=$1",[q.beneficiary_user_id]);
 expect(await dispatch(true)).toMatchObject({status:"accounted",completed:true});expect(posts()).toHaveLength(1);expect(posts()[0][1]).toBe("/v1/transfers/tr_original/reversals");expect(transfer.destination).toBe(destination);expect((await db.query("select creator_id from sales_team_transfer_reversal_costs_v1 where operation_id=$1",[p.operation_id])).rows).toEqual([{creator_id:q.creator_id}]);
});
test("an independently verified prior return can cancel the now-shrinking never-journaled reservation",async()=>{
 await fixture();const scope:TeamOperationScope={scopeId:id(200),scopeKey:"recovery:v1",kind:"reversal",saleId:q.sale_id,creatorId:q.creator_id,actorId:null,workerRunId:q.original_worker_run_id},operationId=teamOperationId(scope),stamp=Math.floor(Date.now()/1000);
 const request={apiVersion:p.request.apiVersion,method:"POST",path:p.request.path,params:{amount:1,metadata:{...(p.request.params.metadata as Record<string,string>),team_recovery_request_id:scope.scopeId,team_provider_operation_id:operationId}}};
 // Structural already-admitted original, consumed through the real F29
 // independent-return path. It is not an additional F31 POST/admission proof.
 await db.query("insert into sales_team_provider_operations_v1(id,scope_id,scope_key,kind,sale_id,creator_id,worker_run_id,context,request,idempotency_key,status,first_dispatch_at,provider_id,provider_request_id,bound_at) values($1,$2,'recovery:v1','reversal',$3,$4,$5,$6,$7,$8,'bound',clock_timestamp(),'trr_prior','req_prior',clock_timestamp())",[operationId,scope.scopeId,q.sale_id,q.creator_id,scope.workerRunId,c.context,request,`cn-team-v1:${operationId}`]);
 values[`${p.request.path}/trr_prior`]={...reversal,id:"trr_prior",amount:1,metadata:request.params.metadata,created:stamp,balance_transaction:"txn_prior"};values["/v1/balance_transactions/txn_prior"]={...returned,id:"txn_prior",source:"trr_prior",amount:1,fee:0,net:1,fee_details:[],created:stamp,available_on:stamp};transfer.amount_reversed=1;
 expect(await observeTeamBoundTransferReversal(c,{...run,taskId:id(201),operationId,checkId:id(202)})).toMatchObject({recorded:true,returnedPrincipalCents:1});raw.mockClear();
 expect(await dispatch(true)).toMatchObject({status:"canceled",completed:false,held:false});expect(posts()).toHaveLength(0);expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_cancellations_v1 where request_id=$1",[p.id])).rows).toEqual([{n:1}]);expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1 where id=$1",[p.operation_id])).rows).toEqual([{n:0}]);
});
