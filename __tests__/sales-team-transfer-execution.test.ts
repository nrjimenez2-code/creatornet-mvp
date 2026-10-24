/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {sharedCashDatabase,sharedCashReconciliationCandidate} from "@/test-support/sales-team-shared-cash-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {teamCashBalanceFixture} from "@/test-support/sales-team-cash-postgres";
import {inspectTeamReceiptFinancials} from "@/lib/salesTeams/financialChecks";
import {reserveTeamEarnedTransfer,type TeamTransferRequest} from "@/lib/salesTeams/transferReservations";
import {dispatchTeamEarnedTransfer} from "@/lib/salesTeams/transferExecution";
import {teamTransferExecutionReady,teamTransferObservationsReady} from "@/lib/salesTeams/policy";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261023184139_sales_team_transfer_execution.sql";
const predecessors=[sharedCashReconciliationCandidate,"supabase/migrations/20261023042321_sales_team_retained_refund_funding.sql","supabase/migrations/20261023060912_sales_team_automatic_recovery.sql","supabase/migrations/20261023063905_sales_team_worker_refund_recovery.sql","supabase/migrations/20261023174324_sales_team_no_outbound_shared_recovery.sql","supabase/migrations/20261023180144_sales_team_transfer_reservations.sql","supabase/migrations/20261023182527_sales_team_transfer_observations.sql"];
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,c:TeamReceiptComposition,receiptId:string,raw:jest.Mock,q:TeamTransferRequest,run:{runId:string;leaseToken:string};
let transfer:Record<string,unknown>,balance:Record<string,unknown>,events:Record<string,unknown>[];
beforeAll(async()=>{db=await sharedCashDatabase(createLocalPostgres());for(const path of [...predecessors,candidate,"supabase/migrations/20261023190044_sales_team_automatic_settlement.sql","supabase/migrations/20261024210829_sales_team_transfer_reversal_observations.sql"])await db.exec(readFileSync(path,"utf8"));},30000);
beforeEach(async()=>{await db.exec("begin");});afterEach(async()=>{await db.exec("rollback;reset role");jest.restoreAllMocks();});afterAll(async()=>{await db?.close();});
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
async function fixture(fee=0){
 await db.exec("update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true,cash_reservations_enabled=true,settlement_enabled=true,transfer_reservations_enabled=true,transfer_observations_enabled=true,transfer_execution_enabled=true");
 f=await seedTeamCapture(db);const stamp=Math.floor(Date.now()/1000);f.base.balance.available_on=stamp;f.base.balance.status="available";receiptId=String((await f.record()).id);await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,transfer_cost_reserve_cents=30,evidence='{\"scope\":\"synthetic transfer execution fixture\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1(),retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1(),transfer_contract_sha256=creatornet_team_private.transfer_contract_digest_v1()");
 events=[];let sequence=0;raw=jest.fn(async(method:string,path:string,params:unknown,options:Record<string,unknown>)=>{
  if(method==="POST"){
   if(path!=="/v1/transfers"||JSON.stringify(params)!==JSON.stringify(q.request.params)||options.idempotencyKey!==`cn-team-v1:${q.operation_id}`)throw Error("Only frozen original transfer POST is permitted");
   events=[{id:"evt_original",object:"event",type:"transfer.created",account:null,livemode:false,created:stamp,request:{id:"req_originalPost",idempotency_key:options.idempotencyKey},data:{object:transfer}}];
   return JSON.parse(JSON.stringify({...transfer,lastResponse:{requestId:"req_originalPost"}}));
  }
  if(method!=="GET")throw Error("Only original GETs and the frozen transfer POST are permitted");
  const value=path==="/v1/balance"?teamCashBalanceFixture:path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/charges/ch_original"?f.base.charge:path==="/v1/balance_transactions/txn_original"?f.base.balance:["/v1/refunds","/v1/disputes"].includes(path)?{object:"list",data:[],has_more:false}:path==="/v1/transfers/tr_original"?transfer:path==="/v1/balance_transactions/txn_transfer"?balance:path==="/v1/events"?{object:"list",data:events,has_more:false}:null;
  if(!value)throw Error(path);return JSON.parse(JSON.stringify({...value,lastResponse:{requestId:`req_execution${++sequence}`}}));});
 // Supabase RPC failures roll back their own transaction. Match that boundary
 // inside this suite's outer structural fixture transaction, including errors
 // deliberately handled by the runtime after an admitted POST drains.
 const baseAdmin=teamSupabaseFixture(db),admin={rpc:async(name:string,args:Record<string,unknown>)=>{
  await db.exec("savepoint transfer_rpc");const result=await baseAdmin.rpc(name,args);
  if(result.error)await db.exec("rollback to savepoint transfer_rpc");await db.exec("release savepoint transfer_rpc");return result;
 }} as unknown as TeamReceiptComposition["admin"];
 c={admin,context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence,stripe:{rawRequest:raw}};
 await inspectTeamReceiptFinancials(c,receiptId,id(29));run=await f.rpc("claim_sales_team_settlement_run_v1",[id(80),c.context]);q=await reserveTeamEarnedTransfer(c,{...run,taskId:id(82),requestId:id(81),receiptId,beneficiary:"creator"});
 transfer={id:"tr_original",object:"transfer",amount:Number(q.amount_cents),amount_reversed:0,balance_transaction:"txn_transfer",created:stamp,currency:"usd",destination:q.destination_id,destination_payment:"py_destination",livemode:false,metadata:q.request.params.metadata,reversed:false,reversals:{object:"list",data:[],has_more:false,total_count:0,url:"/v1/transfers/tr_original/reversals"},source_transaction:"ch_original",source_type:"card",transfer_group:`cn_team_${q.sale_id}`};
 balance={id:"txn_transfer",object:"balance_transaction",source:"tr_original",type:"transfer",reporting_category:"transfer",balance_type:"payments",currency:"usd",amount:-Number(q.amount_cents),fee,net:-Number(q.amount_cents)-fee,exchange_rate:null,created:stamp,available_on:stamp,status:"available",fee_details:fee?[{amount:fee,currency:"usd",application:null,type:"stripe_fee"}]:[]};raw.mockClear();
}
const dispatch=(admit=false)=>dispatchTeamEarnedTransfer(c,{...run,taskId:id(82),requestId:q.id,checkId:id(85)},admit);
const posts=()=>raw.mock.calls.filter(([method])=>method==="POST");
test("execution is independently default off",async()=>{expect((await db.query("select transfer_execution_enabled from sales_team_controls_v1")).rows).toEqual([{transfer_execution_enabled:false}]);});
test("a reserved original does not dispatch by default",async()=>{await fixture();expect(await dispatch()).toMatchObject({status:"not_dispatched",completed:false,held:true});expect(raw).not.toHaveBeenCalled();expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1 where kind='transfer'")).rows).toEqual([{n:0}]);});
test("one exact original POST reaches independently verified accounting and never repeats on replay",async()=>{
 await fixture();expect(await dispatch(true)).toMatchObject({status:"accounted",completed:true,held:false});expect(posts()).toHaveLength(1);expect(posts()[0][3]).toMatchObject({idempotencyKey:`cn-team-v1:${q.operation_id}`,maxNetworkRetries:0,timeout:10000});
 await db.exec("set constraints all immediate");
 expect((await db.query("select worker_run_id from sales_team_transfer_execution_admissions_v1")).rows).toEqual([{worker_run_id:run.runId}]);
 raw.mockClear();expect(await dispatch(true)).toMatchObject({status:"accounted",completed:true,held:false});expect(raw).not.toHaveBeenCalled();
 expect((await db.query("select count(*)::int n from sales_team_transfer_completions_v1")).rows).toEqual([{n:1}]);
});
test("a lost POST response recovers its original event and debit without a second POST",async()=>{
 await fixture();const original=raw.getMockImplementation()!;raw.mockImplementation(async(...args)=>{const v=await original(...args);if(args[0]==="POST")throw Error("synthetic lost original response");return v;});
 expect(await dispatch(true)).toMatchObject({status:"accounted",completed:true});expect(posts()).toHaveLength(1);
 expect((await db.query("select count(*)::int n from sales_team_transfer_recovery_proofs_v1")).rows).toEqual([{n:1}]);
});
test("execution-off preserves the reservation without creating an admission or journal",async()=>{
 await fixture();await db.exec("update sales_team_controls_v1 set transfer_execution_enabled=false");expect(await dispatch(true)).toMatchObject({status:"not_enabled",held:true});expect(posts()).toHaveLength(0);
 expect((await db.query("select count(*)::int n from sales_team_transfer_execution_admissions_v1")).rows).toEqual([{n:0}]);
});
test("a known original whose debit is pending binds once and is later accounted with new-money-off",async()=>{
 await fixture();balance.status="pending";balance.available_on=Math.floor(Date.now()/1000)+86400;
 expect(await dispatch(true)).toMatchObject({status:"reconciliation_required",completed:false});expect(posts()).toHaveLength(1);
 expect((await db.query("select provider_id from sales_team_provider_operations_v1 where kind='transfer'")).rows).toEqual([{provider_id:"tr_original"}]);
 await db.exec("update sales_team_controls_v1 set settlement_enabled=false,transfer_reservations_enabled=false,transfer_execution_enabled=false");balance.status="available";balance.available_on=Math.floor(Date.now()/1000);
 expect(await dispatch()).toMatchObject({status:"accounted",completed:true});expect(posts()).toHaveLength(1);
});
test("a complete direct transfer response can bind its identity while balance details are unavailable",async()=>{
 await fixture();const rawOriginal=raw.getMockImplementation()!;raw.mockImplementation(async(...args)=>{const value=await rawOriginal(...args);if(args[1]==="/v1/transfers"||args[1]==="/v1/transfers/tr_original")value.balance_transaction=null;return value;});
 expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(posts()).toHaveLength(1);
 expect((await db.query("select provider_id from sales_team_provider_operations_v1 where kind='transfer'")).rows).toEqual([{provider_id:"tr_original"}]);
 expect((await db.query("select count(*)::int n from sales_team_transfer_completions_v1")).rows).toEqual([{n:0}]);
});
test("metadata-only uncertain results stay held and never create a replacement transfer",async()=>{
 await fixture();const rawOriginal=raw.getMockImplementation()!;raw.mockImplementation(async(...args)=>{const value=await rawOriginal(...args);if(args[0]==="POST"){(events[0].request as Record<string,unknown>).idempotency_key="foreign";throw Error("synthetic lost response");}return value;});
 expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(posts()).toHaveLength(1);
 expect((await db.query("select provider_id from sales_team_provider_operations_v1 where kind='transfer'")).rows).toEqual([{provider_id:null}]);
 expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:30}]);
});
test("a later actual worker dispatches an unsent original without replacing its original-worker scope",async()=>{
 await fixture();await db.query("update sales_team_worker_runs_v1 set scheduled_slot=scheduled_slot-interval '15 minutes',lease_until=clock_timestamp()-interval '1 second' where id=$1",[run.runId]);
 run=await f.rpc("claim_sales_team_settlement_run_v1",[id(86),c.context]);await reserveTeamEarnedTransfer(c,{...run,taskId:id(87),requestId:q.id,receiptId,beneficiary:"creator"});
 expect(await dispatchTeamEarnedTransfer(c,{...run,taskId:id(87),requestId:q.id,checkId:id(88)},true)).toMatchObject({status:"accounted",completed:true});
 expect((await db.query("select worker_run_id from sales_team_provider_operations_v1 where kind='transfer'")).rows).toEqual([{worker_run_id:id(80)}]);
 expect((await db.query("select worker_run_id from sales_team_transfer_execution_admissions_v1")).rows).toEqual([{worker_run_id:id(86)}]);
 expect((await db.query("select worker_run_id from sales_team_transfer_completions_v1")).rows).toEqual([{worker_run_id:id(86)}]);expect(posts()).toHaveLength(1);
});
test("an admitted response drains and binds after worker expiry without gaining permission for another POST",async()=>{
 await fixture();const rawOriginal=raw.getMockImplementation()!;raw.mockImplementation(async(...args)=>{const value=await rawOriginal(...args);if(args[0]==="POST")await db.query("update sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id=$1",[run.runId]);return value;});
 expect(await dispatch(true)).toMatchObject({status:"reconciliation_required",held:true});expect(posts()).toHaveLength(1);
 expect((await db.query("select provider_id,status from sales_team_provider_operations_v1 where kind='transfer'")).rows).toEqual([{provider_id:"tr_original",status:"bound"}]);
 expect((await db.query("select phase from sales_team_transfer_execution_actions_v1 where phase='bind'")).rows).toEqual([{phase:"bind"}]);
});
test("wrong current tokens or tasks cannot reach the transport",async()=>{
 await fixture();await denied(()=>dispatchTeamEarnedTransfer(c,{...run,leaseToken:id(86),taskId:id(82),requestId:q.id,checkId:id(85)},true),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);
 await denied(()=>dispatchTeamEarnedTransfer(c,{...run,taskId:id(86),requestId:q.id,checkId:id(85)},true),/ORIGINAL_TRANSFER_EXECUTION_TASK_REQUIRED/);expect(raw).not.toHaveBeenCalled();
});
test("changed scope or POST bytes cannot enter an execution admission",async()=>{
 await fixture();await denied(()=>f.rpc("run_sales_team_transfer_execution_v1",[run.runId,run.leaseToken,c.context,id(82),"claim",{operationId:q.operation_id,scope:q.scope,request:{...q.request,params:{...q.request.params,amount:1}}}]),/ORIGINAL_TRANSFER_EXECUTION_REQUEST_REQUIRED/);
 expect((await db.query("select count(*)::int n from sales_team_transfer_execution_admissions_v1")).rows).toEqual([{n:0}]);expect(posts()).toHaveLength(0);
});
test("ordinary roles cannot call execution and service callers cannot invent admissions or actions",async()=>{
 await fixture();await db.exec("set role service_role");await denied(()=>db.exec("insert into sales_team_transfer_execution_actions_v1(request_id,task_id,worker_run_id,phase,provider_lease_token) values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'assert',gen_random_uuid())"),/permission denied/i);
 expect(await dispatch(true)).toMatchObject({status:"accounted",completed:true});await db.exec("set role authenticated");await denied(dispatch,/permission denied/i);
});
test("source readiness needs independent execution and observation gates",()=>{
 const base={CREATOR_SALES_TEAM_SCHEMA_READY:"true",CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY:"true",CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY:"true",CREATOR_TEAM_PAYMENT_SCHEMA_READY:"true",CREATOR_TEAM_RECEIPT_SCHEMA_READY:"true",CREATOR_TEAM_EVENT_SCHEMA_READY:"true",CREATOR_TEAM_FINANCIAL_SCHEMA_READY:"true",CREATOR_TEAM_REFUND_DISPATCH_SCHEMA_READY:"true",CREATOR_TEAM_CASH_SCHEMA_READY:"true",CREATOR_TEAM_TRANSFER_RESERVATIONS_SCHEMA_READY:"true",CREATOR_TEAM_TRANSFER_RESERVATIONS_READY:"true",CREATOR_TEAM_SETTLEMENT_READY:"true",CREATOR_TEAM_TRANSFER_OBSERVATIONS_SCHEMA_READY:"true",CREATOR_TEAM_TRANSFER_OBSERVATIONS_READY:"true"};
 expect(teamTransferObservationsReady(base)).toBe(true);expect(teamTransferExecutionReady(base)).toBe(false);const enabled={...base,CREATOR_TEAM_TRANSFER_EXECUTION_SCHEMA_READY:"true",CREATOR_TEAM_TRANSFER_EXECUTION_READY:"true"};
 expect(teamTransferExecutionReady(enabled)).toBe(true);expect(teamTransferExecutionReady({...enabled,CREATOR_TEAM_TRANSFER_OBSERVATIONS_READY:"false"})).toBe(false);expect(teamTransferExecutionReady({...enabled,CREATOR_TEAM_TRANSFER_RESERVATIONS_READY:"false"})).toBe(false);
});
test("actual transfer fees are accounted to the creator without repeating the original request",async()=>{
 await fixture(12);expect(await dispatch(true)).toMatchObject({status:"accounted",completed:true,held:true});expect(posts()).toHaveLength(1);
 expect((await db.query("select actual_transfer_cost_cents::int fee from sales_team_creator_balances_v1")).rows).toEqual([{fee:12}]);
 raw.mockClear();expect(await dispatch()).toMatchObject({status:"accounted",completed:true,held:true});expect(raw).not.toHaveBeenCalled();
});
test("a live admitted original is busy and cannot be stolen into another POST",async()=>{
 await fixture();await f.rpc("run_sales_team_transfer_execution_v1",[run.runId,run.leaseToken,c.context,id(82),"claim",{operationId:q.operation_id,scope:q.scope,request:q.request}]);
 expect(await dispatch(true)).toMatchObject({status:"busy",completed:false});expect(raw).not.toHaveBeenCalled();
});
test("a source or recipient changed after reservation cannot admit a POST",async()=>{
 await fixture();await db.exec("update sales_team_recipients_v1 set ownership_verified=false where account_id='acct_creator'");
 expect(await dispatch(true)).toMatchObject({status:"reconciliation_required",held:true});expect(posts()).toHaveLength(0);
 expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1 where kind='transfer'")).rows).toEqual([{n:0}]);
});
test("execution turned off between claim and final assert never reaches the provider",async()=>{
 await fixture();const baseAdmin=c.admin;c={...c,admin:{rpc:async(name:string,args:Record<string,unknown>)=>{
  if(name==="run_sales_team_transfer_execution_v1"&&args.p_phase==="assert")await db.exec("update sales_team_controls_v1 set transfer_execution_enabled=false");
  return baseAdmin.rpc(name,args);
 }} as unknown as TeamReceiptComposition["admin"]};
 expect(await dispatch(true)).toMatchObject({status:"reconciliation_required",held:true});expect(posts()).toHaveLength(0);
 expect((await db.query("select count(*)::int n from sales_team_transfer_completions_v1")).rows).toEqual([{n:0}]);
});
test("context drift before first dispatch leaves the original unsent",async()=>{
 await fixture();c={...c,observeEvidence:async()=>({...f.evidence,observedPlatformAccountId:"acct_other"})};expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(raw).not.toHaveBeenCalled();
});
test("the execution budget never admits a POST after the observation window expires",async()=>{
 await fixture();const start=Date.now(),base=raw.getMockImplementation()!;raw.mockImplementation(async(...args)=>{const value=await base(...args);jest.spyOn(Date,"now").mockReturnValue(start+65001);return value;});
 expect(await dispatch(true)).toMatchObject({status:"reconciliation_required"});expect(posts()).toHaveLength(0);
});
test("an unknown binding cannot use the dispatch outcome port as original-event recovery",async()=>{
 await fixture();const result=await f.rpc<{operation:{lease_token:string}}>("run_sales_team_transfer_execution_v1",[run.runId,run.leaseToken,c.context,id(82),"claim",{operationId:q.operation_id,scope:q.scope,request:q.request}]);
 const payload={operationId:q.operation_id,leaseToken:result.operation.lease_token};await f.rpc("run_sales_team_transfer_execution_v1",[run.runId,run.leaseToken,c.context,id(82),"assert",payload]);
 await denied(()=>f.rpc("run_sales_team_transfer_execution_v1",[run.runId,run.leaseToken,c.context,id(82),"bind",{...payload,providerId:"tr_original",providerRequestId:"req_originalPost",reconciled:true}]),/INDEPENDENT_TRANSFER_RECOVERY_REQUIRED/);
});
test("a late migration grant failure restores the old admission function and leaves no execution tables",async()=>{
 const isolated=await sharedCashDatabase(createLocalPostgres());try{
  for(const path of predecessors)await isolated.exec(readFileSync(path,"utf8"));
  const before=(await isolated.query("select pg_get_functiondef('public.sales_team_transfer_operation_admitted_v1(jsonb,jsonb)'::regprocedure) source")).rows;
  const source=readFileSync(candidate,"utf8");expect(source.match(/commit;/g)).toHaveLength(1);await expect(isolated.exec(source.replace("commit;","grant execute on function public.missing_transfer_execution_grant() to service_role;commit;"))).rejects.toThrow(/missing_transfer_execution_grant/);await isolated.exec("rollback");
  expect((await isolated.query("select to_regclass('public.sales_team_transfer_execution_admissions_v1') relation")).rows).toEqual([{relation:null}]);
  expect((await isolated.query("select pg_get_functiondef('public.sales_team_transfer_operation_admitted_v1(jsonb,jsonb)'::regprocedure) source")).rows).toEqual(before);
 }finally{await isolated.close();}
},30000);
