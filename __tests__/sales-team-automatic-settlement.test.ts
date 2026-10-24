/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {sharedCashDatabase,sharedCashReconciliationCandidate} from "@/test-support/sales-team-shared-cash-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {teamCashBalanceFixture} from "@/test-support/sales-team-cash-postgres";
import {inspectTeamReceiptFinancials,reviewTeamRefundResponsibility} from "@/lib/salesTeams/financialChecks";
import {readTeamFinancialSnapshot,type TeamEventSource} from "@/lib/salesTeams/financialReadback";
import {reserveTeamEarnedTransfer} from "@/lib/salesTeams/transferReservations";
import {dispatchTeamEarnedTransfer} from "@/lib/salesTeams/transferExecution";
import {runTeamAutomaticSettlement} from "@/lib/salesTeams/settlement";
import {runTeamAutomaticRecovery} from "@/lib/salesTeams/recovery";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261023190044_sales_team_automatic_settlement.sql";
const predecessors=[sharedCashReconciliationCandidate,"supabase/migrations/20261023042321_sales_team_retained_refund_funding.sql","supabase/migrations/20261023060912_sales_team_automatic_recovery.sql","supabase/migrations/20261023063905_sales_team_worker_refund_recovery.sql","supabase/migrations/20261023174324_sales_team_no_outbound_shared_recovery.sql","supabase/migrations/20261023180144_sales_team_transfer_reservations.sql","supabase/migrations/20261023182527_sales_team_transfer_observations.sql","supabase/migrations/20261023184139_sales_team_transfer_execution.sql"];
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,c:TeamReceiptComposition,receiptId:string,raw:jest.Mock;
let values:Record<string,Record<string,unknown>>,events:Record<string,unknown>[],transport:{loseResponse:boolean;hideEvents:boolean};
let advanceClock:(milliseconds:number)=>Promise<void>;
beforeAll(async()=>{db=createLocalPostgres();advanceClock=await installTeamLocalClock(db);await sharedCashDatabase(db);for(const path of [...predecessors,candidate])await db.exec(readFileSync(path,"utf8"));},30000);
beforeEach(async()=>{await db.exec("begin");});afterEach(async()=>{await db.exec("rollback;reset role");jest.restoreAllMocks();});afterAll(async()=>{await db?.close();});
const denied=async(action:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(action()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
async function fixture(){
 await db.exec("update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true,cash_reservations_enabled=true,settlement_enabled=true,transfer_reservations_enabled=true,transfer_observations_enabled=true,transfer_execution_enabled=true,automatic_settlement_enabled=true");
 f=await seedTeamCapture(db);const stamp=Math.floor(Date.now()/1000);f.base.balance.available_on=stamp;f.base.balance.status="available";receiptId=String((await f.record()).id);await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,transfer_cost_reserve_cents=30,evidence='{\"scope\":\"synthetic autonomous settlement fixture\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1(),retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1(),transfer_contract_sha256=creatornet_team_private.transfer_contract_digest_v1()");
 await db.query("update profiles set stripe_account_id='acct_creator' where id=$1",[id(1)]);await db.query("insert into stripe_connect_account_creations(creator_id,idempotency_key,stripe_account_id) values($1,$2,'acct_creator')",[id(1),id(91)]);
 await f.rpc("reserve_sales_team_recipient_v1",[id(1),f.contract.context,false]);
 values={"/v1/accounts/acct_creator":{object:"account",id:"acct_creator",country:"US",default_currency:"usd",payouts_enabled:true,capabilities:{transfers:"active"},metadata:{creatornet_user_id:id(1),creatornet_creation_id:id(91)}}};
 events=[];transport={loseResponse:false,hideEvents:false};let sequence=0,postCount=0;
 raw=jest.fn(async(method:string,path:string,params:Record<string,unknown>,options:Record<string,unknown>)=>{
  if(method==="POST"){
   const metadata=params.metadata as Record<string,string>;if(path!=="/v1/transfers"||options.idempotencyKey!==`cn-team-v1:${metadata.team_provider_operation_id}`||metadata.team_sale_id!==f.sale||params.source_transaction!=="ch_original")throw Error("Only saved original team transfer is permitted");
   const n=++postCount,stamp=Math.floor(Date.now()/1000),transfer={object:"transfer",id:`tr_settle${n}`,amount:params.amount,currency:"usd",amount_reversed:0,reversed:false,livemode:false,created:stamp,destination:params.destination,destination_payment:`py_settle${n}`,source_transaction:params.source_transaction,source_type:"card",transfer_group:params.transfer_group,metadata,balance_transaction:`txn_settle${n}`,reversals:{object:"list",data:[],has_more:false,total_count:0,url:`/v1/transfers/tr_settle${n}/reversals`}};
   values[`/v1/transfers/tr_settle${n}`]=transfer;values[`/v1/balance_transactions/txn_settle${n}`]={object:"balance_transaction",id:`txn_settle${n}`,source:transfer.id,type:"transfer",reporting_category:"transfer",balance_type:"payments",currency:"usd",exchange_rate:null,amount:-Number(params.amount),fee:0,net:-Number(params.amount),fee_details:[],created:stamp,available_on:stamp,status:"available"};
   events.push({object:"event",id:`evt_settle${n}`,type:"transfer.created",account:null,livemode:false,created:stamp,request:{id:`req_post${n}`,idempotency_key:options.idempotencyKey},data:{object:transfer}});
   if(transport.loseResponse)throw Error("synthetic lost original response");return JSON.parse(JSON.stringify({...transfer,lastResponse:{requestId:`req_post${n}`}}));
  }
  if(method!=="GET")throw Error("Unexpected provider write");
  const value=values[path]??(path==="/v1/balance"?teamCashBalanceFixture:path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/charges/ch_original"?f.base.charge:path==="/v1/balance_transactions/txn_original"?f.base.balance:["/v1/refunds","/v1/disputes"].includes(path)?{object:"list",data:[],has_more:false}:path==="/v1/events"?{object:"list",data:transport.hideEvents?[]:events,has_more:false}:undefined);
  if(!value)throw Error(path);return JSON.parse(JSON.stringify({...value,lastResponse:{requestId:`req_auto${++sequence}`}}));
 });
 const base=teamSupabaseFixture(db),admin={rpc:async(name:string,args:Record<string,unknown>)=>{await db.exec("savepoint auto_rpc");const result=await base.rpc(name,args);if(result.error)await db.exec("rollback to savepoint auto_rpc");await db.exec("release savepoint auto_rpc");return result;}} as unknown as TeamReceiptComposition["admin"];
 c={admin,context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence,stripe:{rawRequest:raw}};
 await inspectTeamReceiptFinancials(c,receiptId,id(29));raw.mockClear();
}
const posts=()=>raw.mock.calls.filter(([method])=>method==="POST");
test("autonomous settlement candidate is independently default off",async()=>{expect((await db.query("select automatic_settlement_enabled from sales_team_controls_v1")).rows).toEqual([{automatic_settlement_enabled:false}]);});
test("one fresh earned share is selected, transferred, accounted and completed through the actual worker",async()=>{
 await fixture();expect(await runTeamAutomaticSettlement(c,{admitNew:true})).toMatchObject({status:"complete",settled:1,held:0});expect(posts()).toHaveLength(1);
 expect((await db.query("select kind from sales_team_settlement_plans_v1")).rows).toEqual([{kind:"earned"}]);expect((await db.query("select held from sales_team_settlement_plan_results_v1")).rows).toEqual([{held:false}]);
 expect((await db.query("select count(*)::int n from sales_team_transfer_completions_v1")).rows).toEqual([{n:1}]);expect((await db.query("select status from sales_team_worker_runs_v1 where kind='settlement'")).rows).toEqual([{status:"complete"}]);
});
test("default worker options cannot create a new transfer or consume a fresh-money slot",async()=>{
 await fixture();expect(await runTeamAutomaticSettlement(c)).toMatchObject({status:"idle",settled:0,held:0});expect(raw).not.toHaveBeenCalled();expect((await db.query("select count(*)::int n from sales_team_worker_runs_v1 where kind='settlement'")).rows).toEqual([{n:0}]);
});
test("a consumed 15-minute slot cannot replay the settled provider operation",async()=>{
 await fixture();await runTeamAutomaticSettlement(c,{admitNew:true});raw.mockClear();expect(await runTeamAutomaticSettlement(c,{admitNew:true})).toMatchObject({status:"slot_consumed",settled:0});expect(raw).not.toHaveBeenCalled();
});
test("stale financial and recipient evidence is refreshed by the actual settlement worker before dispatch",async()=>{
 await fixture();await db.exec("update sales_team_receipts_v1 set observed_at=clock_timestamp(),review_hold=true;update sales_team_recipients_v1 set verified_at=clock_timestamp()-interval '16 minutes'");
 expect(await runTeamAutomaticSettlement(c,{admitNew:true})).toMatchObject({status:"complete",settled:1,held:0});
 expect((await db.query("select count(*)::int n from sales_team_settlement_financial_links_v1")).rows).toEqual([{n:1}]);expect((await db.query("select count(*)::int n from sales_team_settlement_recipient_checks_v1")).rows).toEqual([{n:1}]);
 expect(raw.mock.calls.filter(([,path])=>path==="/v1/accounts/acct_creator")).toHaveLength(2);expect(posts()).toHaveLength(1);
});
test("an admitted unknown original is recovered before new-money work with new admission off",async()=>{
 await fixture();const run=await f.rpc<{runId:string;leaseToken:string}>("claim_sales_team_settlement_run_v1",[id(80),c.context]),q=await reserveTeamEarnedTransfer(c,{...run,taskId:id(82),requestId:id(81),receiptId,beneficiary:"creator"});transport.loseResponse=true;transport.hideEvents=true;
 expect(await dispatchTeamEarnedTransfer(c,{...run,taskId:id(82),requestId:q.id,checkId:id(85)},true)).toMatchObject({status:"reconciliation_required"});
 await db.query("update sales_team_worker_runs_v1 set scheduled_slot=scheduled_slot-interval '15 minutes',lease_until=clock_timestamp()-interval '1 second' where id=$1",[run.runId]);await db.exec("update sales_team_controls_v1 set settlement_enabled=false,transfer_reservations_enabled=false,transfer_execution_enabled=false");transport.hideEvents=false;
 expect(await runTeamAutomaticSettlement(c)).toMatchObject({status:"complete",settled:1,held:0});expect(posts()).toHaveLength(1);expect((await db.query("select kind from sales_team_settlement_plans_v1")).rows).toEqual([{kind:"original"}]);
 expect((await db.query("select original_worker_run_id from sales_team_transfer_requests_v1")).rows).toEqual([{original_worker_run_id:id(80)}]);
});

type AutomaticRun={runId:string;leaseToken:string};
type SelectedPlan={id:string;request_id:string;task_id:string;financial_check_id:string};
const claimAutomatic=(fresh=true)=>f.rpc<AutomaticRun>("claim_sales_team_automatic_settlement_v1",[id(100),c.context,fresh]);
const nextPlan=(run:AutomaticRun,fresh=true)=>f.rpc<SelectedPlan|null>("next_sales_team_settlement_plan_v1",[run.runId,run.leaseToken,c.context,fresh,true]);
const phase=(run:AutomaticRun,plan:SelectedPlan,name:string,payload:object={})=>f.rpc("run_sales_team_settlement_plan_v1",[run.runId,run.leaseToken,c.context,plan.id,name,payload]);

test("the service role can complete the whole selected journey while sidecar writes stay denied",async()=>{
 await fixture();await db.exec("set role service_role");
 for(const table of ["sales_team_automatic_settlement_runs_v1","sales_team_settlement_plans_v1","sales_team_settlement_plan_results_v1","sales_team_settlement_financial_links_v1","sales_team_settlement_recipient_checks_v1"]){
  await denied(()=>db.exec(`insert into public.${table} default values`),/permission denied/i);
 }
 expect(await runTeamAutomaticSettlement(c,{admitNew:true})).toMatchObject({settled:1,held:0});
 await denied(()=>f.rpc("reserve_sales_team_transfer_before_automatic_v1",[id(1),id(2),c.context,id(3),id(4),receiptId,"creator",id(5)]),/permission denied/i);
});

test.each(["anon","authenticated"])("%s cannot select plans, call phases or read private history",async role=>{
 await fixture();await db.exec(`set role ${role}`);
 await denied(()=>claimAutomatic(),/permission denied/i);
 await denied(()=>db.exec("select * from sales_team_settlement_plans_v1"),/permission denied/i);
 await denied(()=>f.rpc("run_sales_team_settlement_plan_v1",[id(1),id(2),c.context,id(3),"recipient",{}]),/permission denied/i);
});

test("current plans require their exact token, context, run and unfinished ownership",async()=>{
 await fixture();const run=await claimAutomatic(),plan=(await nextPlan(run))!;
 await denied(()=>nextPlan({...run,leaseToken:id(101)}),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);
 await denied(()=>f.rpc("next_sales_team_settlement_plan_v1",[run.runId,run.leaseToken,{...c.context,mode:"live"},true,true]),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);
 await denied(()=>phase(run,{...plan,id:id(102)},"begin_financial"),/CURRENT_AUTOMATIC_SETTLEMENT_PLAN_REQUIRED/);
 expect(await nextPlan(run)).toMatchObject({id:plan.id,task_id:plan.task_id,financial_check_id:plan.financial_check_id});
 await f.rpc("finish_sales_team_settlement_plan_v1",[run.runId,run.leaseToken,c.context,plan.id,true]);
 await denied(()=>phase(run,plan,"begin_financial"),/CURRENT_AUTOMATIC_SETTLEMENT_PLAN_REQUIRED/);
 await denied(()=>db.exec("update sales_team_settlement_plans_v1 set source_ready=false"),/IMMUTABLE/i);
});

test.each(["expiry","source"])("%s blocks new phases but preserves outcome-only drain",async change=>{
 await fixture();const run=await claimAutomatic(),plan=(await nextPlan(run))!;
 if(change==="expiry")await db.query("update sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id=$1",[run.runId]);
 else await db.exec("update sales_team_cash_policy_v1 set transfer_contract_sha256=repeat('0',64)");
 await denied(()=>phase(run,plan,"begin_financial"),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);
 await f.rpc("finish_sales_team_automatic_settlement_v1",[run.runId,run.leaseToken,c.context,false]);
 expect((await db.query("select status from sales_team_worker_runs_v1 where id=$1",[run.runId])).rows).toEqual([{status:"review_required"}]);
 expect(posts()).toHaveLength(0);
});

test("a selected plan cannot report success without independent transfer accounting",async()=>{
 await fixture();const run=await claimAutomatic(),plan=(await nextPlan(run))!;
 expect(await f.rpc("finish_sales_team_settlement_plan_v1",[run.runId,run.leaseToken,c.context,plan.id,false])).toEqual({held:true,settled:false});
 await f.rpc("finish_sales_team_automatic_settlement_v1",[run.runId,run.leaseToken,c.context,false]);
 expect((await db.query("select status from sales_team_worker_runs_v1 where id=$1",[run.runId])).rows).toEqual([{status:"review_required"}]);
});

test("a late financial-begin failure rolls back its deferred link and check together",async()=>{
 await fixture();const run=await claimAutomatic(),plan=(await nextPlan(run))!;
 await db.exec("create function public.reject_fixture_settlement_check() returns trigger language plpgsql as $$begin raise exception 'synthetic_late_check_failure';end$$;create trigger reject_fixture_settlement_check before insert on sales_team_financial_checks_v1 for each row execute function public.reject_fixture_settlement_check()");
 await denied(()=>phase(run,plan,"begin_financial"),/synthetic_late_check_failure/);
 expect((await db.query("select count(*)::int n from sales_team_settlement_financial_links_v1")).rows).toEqual([{n:0}]);
 expect((await db.query("select count(*)::int n from sales_team_financial_checks_v1 where id=$1",[plan.financial_check_id])).rows).toEqual([{n:0}]);
 await db.exec("set constraints all immediate");
});

test("F20 recovers an abandoned F27 financial check with its own current proof",async()=>{
 await fixture();const run=await claimAutomatic(),plan=(await nextPlan(run))!;await phase(run,plan,"begin_financial");
 // Advance only this disposable database and supplied mock transport's clock.
 const realNow=Date.now.bind(Date);jest.spyOn(Date,"now").mockImplementation(()=>realNow()+180000);await advanceClock(180000);
 await db.exec("update sales_team_controls_v1 set automatic_recovery_enabled=true;update sales_team_cash_policy_v1 set recovery_contract_sha256=creatornet_team_private.recovery_contract_digest_v1()");
 expect(await runTeamAutomaticRecovery(c)).toMatchObject({held:0});
 expect((await db.query("select original_check_id from sales_team_financial_check_recoveries_v1")).rows).toContainEqual({original_check_id:plan.financial_check_id});
 await db.exec("set constraints all immediate");expect(posts()).toHaveLength(0);
});

test.each([0,100])("a never-journaled reservation whose derived unpaid share becomes %i is canceled",async amount=>{
 await fixture();const original=await f.rpc<AutomaticRun>("claim_sales_team_settlement_run_v1",[id(80),c.context]);
 const q=await reserveTeamEarnedTransfer(c,{...original,taskId:id(82),requestId:id(81),receiptId,beneficiary:"creator"});
 // Synthetic recomputation boundary; real refund economics are covered by the affected F13 chain.
 await db.query("update sales_team_creator_balances_v1 set creator_proceeds_cents=$1 where receipt_id=$2",[amount,receiptId]);
 await db.query("update sales_team_worker_runs_v1 set scheduled_slot=scheduled_slot-interval '15 minutes',lease_until=clock_timestamp()-interval '1 second' where id=$1",[original.runId]);
 await runTeamAutomaticSettlement(c,{admitNew:true});
 expect((await db.query("select request_id from sales_team_transfer_cancellations_v1")).rows).toEqual([{request_id:q.id}]);
 expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1 where id=$1",[q.operation_id])).rows).toEqual([{n:0}]);expect(posts()).toHaveLength(0);
});

async function closerSetup(){
 await db.query("update profiles set stripe_account_id='acct_member2' where id=$1",[id(2)]);
 await db.query("insert into stripe_connect_account_creations(creator_id,idempotency_key,stripe_account_id) values($1,$2,'acct_member2')",[id(2),id(92)]);
 await f.rpc("reserve_sales_team_recipient_v1",[id(2),c.context,false]);
 values["/v1/accounts/acct_member2"]={object:"account",id:"acct_member2",country:"US",default_currency:"usd",payouts_enabled:true,capabilities:{transfers:"active"},metadata:{creatornet_user_id:id(2),creatornet_creation_id:id(92)}};
}
async function advance(milliseconds:number){const realNow=Date.now.bind(Date);jest.spyOn(Date,"now").mockImplementation(()=>realNow()+milliseconds);await advanceClock(milliseconds);}

test("a coherently aged accepted closer hold refreshes current financial and recipient proof before payout",async()=>{
 await fixture();await closerSetup();await runTeamAutomaticSettlement(c,{admitNew:true});raw.mockClear();
 await advance(14*86400000+120000);
 expect(await runTeamAutomaticSettlement(c,{admitNew:true})).toMatchObject({status:"complete",settled:1,held:0});
 expect(posts()).toHaveLength(1);expect(posts()[0][2]).toMatchObject({destination:"acct_member2"});
 expect((await db.query("select beneficiary from sales_team_settlement_plans_v1 order by created_at")).rows).toEqual([{beneficiary:"creator"},{beneficiary:"closer"}]);
 expect((await db.query("select count(*)::int n from sales_team_settlement_financial_links_v1")).rows).toEqual([{n:1}]);
 expect(raw.mock.calls.filter(([,path])=>path==="/v1/accounts/acct_member2")).toHaveLength(2);
 expect((await db.query("select released_cents=earned_cents settled from sales_team_commission_balances_v1")).rows).toEqual([{settled:true}]);
 await db.exec("set constraints all immediate");
});

test("the saved hold boundary blocks a closer immediately before maturity and admits immediately afterward",async()=>{
 await fixture();await closerSetup();await runTeamAutomaticSettlement(c,{admitNew:true});
 const until=Number((await db.query<{ms:number}>("select extract(epoch from hold_until)*1000 ms from sales_team_commission_balances_v1")).rows[0].ms),realNow=Date.now.bind(Date);
 let offset=until-realNow()-1000;await advanceClock(Math.floor(offset));jest.spyOn(Date,"now").mockImplementation(()=>realNow()+offset);
 const run=await claimAutomatic();expect(await nextPlan(run)).toBeNull();
 offset+=2000;await advanceClock(Math.floor(offset));
 expect(await nextPlan(run)).toMatchObject({beneficiary:"closer",source_ready:false});expect(posts()).toHaveLength(1);
});

test("automatic observation-only authority cannot escalate at selector, reservation or admission",async()=>{
 await fixture();const original=await f.rpc<AutomaticRun>("claim_sales_team_settlement_run_v1",[id(80),c.context]);
 const q=await reserveTeamEarnedTransfer(c,{...original,taskId:id(82),requestId:id(81),receiptId,beneficiary:"creator"});
 transport.loseResponse=true;transport.hideEvents=true;await dispatchTeamEarnedTransfer(c,{...original,taskId:id(82),requestId:q.id,checkId:id(85)},true);
 await db.query("update sales_team_worker_runs_v1 set scheduled_slot=scheduled_slot-interval '15 minutes',lease_until=clock_timestamp()-interval '1 second' where id=$1",[original.runId]);
 const run=await claimAutomatic(false),plan=(await nextPlan(run,true))!;expect(plan).toMatchObject({kind:"original"});
 await denied(()=>f.rpc("reserve_sales_team_transfer_v1",[run.runId,run.leaseToken,c.context,plan.task_id,plan.request_id,receiptId,"creator",id(120)]),/AUTOMATIC_EARNED_TRANSFER_PLAN_REQUIRED/);
 expect(await f.rpc("sales_team_transfer_operation_admitted_v1",[q.scope,c.context])).toBe(false);
 await f.rpc("finish_sales_team_settlement_plan_v1",[run.runId,run.leaseToken,c.context,plan.id,true]);expect(await nextPlan(run,true)).toBeNull();expect(posts()).toHaveLength(1);
});

test("a journal appearing after selection can never be canceled as unsent",async()=>{
 await fixture();const original=await f.rpc<AutomaticRun>("claim_sales_team_settlement_run_v1",[id(80),c.context]);
 const q=await reserveTeamEarnedTransfer(c,{...original,taskId:id(82),requestId:id(81),receiptId,beneficiary:"creator"});
 await db.query("update sales_team_worker_runs_v1 set scheduled_slot=scheduled_slot-interval '15 minutes',lease_until=clock_timestamp()-interval '1 second' where id=$1",[original.runId]);
 const run=await claimAutomatic(),plan=(await nextPlan(run))!;
 // The saved provider operation is admitted under the actual selected worker.
 await reserveTeamEarnedTransfer(c,{...run,taskId:plan.task_id,requestId:q.id,receiptId,beneficiary:"creator"});
 await f.rpc("run_sales_team_transfer_execution_v1",[run.runId,run.leaseToken,c.context,plan.task_id,"claim",{operationId:q.operation_id,scope:q.scope,request:q.request}]);
 await db.exec("update sales_team_creator_balances_v1 set creator_proceeds_cents=0");
 await denied(()=>phase(run,plan,"unsent"),/ORIGINAL_TRANSFER_RECOVERY_REQUIRED/);
 expect((await db.query("select count(*)::int n from sales_team_transfer_cancellations_v1")).rows).toEqual([{n:0}]);expect(posts()).toHaveLength(0);
});

test("the SQL selector caps five structural candidates at three plans and rotates attempts within both lanes",async()=>{
 await fixture();const original=await f.rpc<AutomaticRun>("claim_sales_team_settlement_run_v1",[id(80),c.context]);
 const q=await reserveTeamEarnedTransfer(c,{...original,taskId:id(82),requestId:id(81),receiptId,beneficiary:"creator"});
 const admitted=await f.rpc<{operation:{lease_token:string}}>("run_sales_team_transfer_execution_v1",[original.runId,original.leaseToken,c.context,id(82),"claim",{operationId:q.operation_id,scope:q.scope,request:q.request}]);
 await f.rpc("mark_sales_team_provider_unknown_v1",[q.operation_id,admitted.operation.lease_token]);
 // Structural selector fixtures only; no clone is dispatched or credited.
 for(let n=1;n<=4;n++){
  await db.query("insert into sales_team_payment_obligations_v1 select (jsonb_populate_record(null::sales_team_payment_obligations_v1,to_jsonb(o)||jsonb_build_object('id',$1::text,'period_number',$2::int,'intent_operation_id',null))).* from sales_team_payment_obligations_v1 o where id=$3",[id(200+n),n+1,f.contract.obligationId]);
  await db.query("insert into sales_team_receipts_v1 select (jsonb_populate_record(null::sales_team_receipts_v1,to_jsonb(r)||jsonb_build_object('id',$1::text,'obligation_id',$2::text,'payment_intent_id',$3::text,'charge_id',$4::text,'balance_transaction_id',null))).* from sales_team_receipts_v1 r where id=$5",[id(210+n),id(200+n),`pi_lane${n}`,`ch_lane${n}`,receiptId]);
  for(const table of ["sales_team_creator_balances_v1","sales_team_commission_balances_v1"]){await db.query(`insert into ${table} select (jsonb_populate_record(null::${table},to_jsonb(b)||jsonb_build_object('receipt_id',$1::text))).* from ${table} b where receipt_id=$2`,[id(210+n),receiptId]);}
  if(n<=2){
   await db.query("insert into sales_team_transfer_requests_v1 select (jsonb_populate_record(null::sales_team_transfer_requests_v1,to_jsonb(q)||jsonb_build_object('id',$1::text,'receipt_id',$2::text,'operation_id',public.sales_team_transfer_operation_id_v1($1::uuid)))).* from sales_team_transfer_requests_v1 q where id=$3",[id(220+n),id(210+n),q.id]);
   await db.query("insert into sales_team_provider_operations_v1 select (jsonb_populate_record(null::sales_team_provider_operations_v1,to_jsonb(op)||jsonb_build_object('id',public.sales_team_transfer_operation_id_v1($1::uuid),'scope_id',$1::text,'idempotency_key','cn-team-v1:'||public.sales_team_transfer_operation_id_v1($1::uuid)::text))).* from sales_team_provider_operations_v1 op where id=$2",[id(220+n),q.operation_id]);
  }
 }
 await db.query("update sales_team_worker_runs_v1 set scheduled_slot=scheduled_slot-interval '15 minutes',lease_until=clock_timestamp()-interval '1 second' where id=$1",[original.runId]);
 const run=await claimAutomatic(),selected:Record<string,unknown>[]=[];
 for(let n=0;n<3;n++){const p=(await nextPlan(run))!;selected.push(p as unknown as Record<string,unknown>);await f.rpc("finish_sales_team_settlement_plan_v1",[run.runId,run.leaseToken,c.context,p.id,true]);}
 expect(selected.map(p=>p.kind)).toEqual(["original","original","earned"]);expect(new Set(selected.map(p=>p.receipt_id)).size).toBe(3);expect(await nextPlan(run)).toBeNull();
 await f.rpc("finish_sales_team_automatic_settlement_v1",[run.runId,run.leaseToken,c.context,false]);await advance(16*60000);
 const second=await f.rpc<AutomaticRun>("claim_sales_team_automatic_settlement_v1",[id(101),c.context,true]);
 const next=(await nextPlan(second))!;expect(next).toMatchObject({kind:"original"});expect(selected.map(p=>p.request_id)).not.toContain(next.request_id);
 expect(posts()).toHaveLength(0);
});

test.each(["hold_source","late_grant"])("migration %s failure restores prior definitions and grants atomically",async fault=>{
 const isolated=await sharedCashDatabase(createLocalPostgres());try{
  for(const path of predecessors)await isolated.exec(readFileSync(path,"utf8"));
  if(fault==="hold_source"){
   const source=(await isolated.query<{s:string}>("select pg_get_functiondef('creatornet_team_private.transfer_share_v1(uuid,text)'::regprocedure) s")).rows[0].s;
   await isolated.exec(source.replace("b.hold_until is distinct from","b.hold_until <>"));
  }
  const before=(await isolated.query("select pg_get_functiondef('public.reserve_sales_team_transfer_v1(uuid,uuid,jsonb,uuid,uuid,uuid,text,uuid)'::regprocedure) s,has_function_privilege('service_role','public.reserve_sales_team_transfer_v1(uuid,uuid,jsonb,uuid,uuid,uuid,text,uuid)','execute') allowed")).rows;
  const source=readFileSync(candidate,"utf8"),sql=fault==="late_grant"?source.replace("commit;","grant execute on function public.missing_settlement_final_grant() to service_role;commit;"):source;
  await expect(isolated.exec(sql)).rejects.toThrow(fault==="late_grant"?/missing_settlement_final_grant/:/SETTLEMENT_CLOSER_HOLD_DEPENDENCY_DIFFERS/);await isolated.exec("rollback");
  expect((await isolated.query("select to_regclass('public.sales_team_settlement_plans_v1') relation,to_regprocedure('creatornet_team_private.settlement_closer_hold_v1(uuid)') helper")).rows).toEqual([{relation:null,helper:null}]);
  expect((await isolated.query("select pg_get_functiondef('public.reserve_sales_team_transfer_v1(uuid,uuid,jsonb,uuid,uuid,uuid,text,uuid)'::regprocedure) s,has_function_privilege('service_role','public.reserve_sales_team_transfer_v1(uuid,uuid,jsonb,uuid,uuid,uuid,text,uuid)','execute') allowed")).rows).toEqual(before);
 }finally{await isolated.close();}
},30000);

test("an independently observed refund cancels the superseded unsent reservation without another transfer",async()=>{
 await fixture();const original=await f.rpc<AutomaticRun>("claim_sales_team_settlement_run_v1",[id(80),c.context]);
 const q=await reserveTeamEarnedTransfer(c,{...original,taskId:id(82),requestId:id(81),receiptId,beneficiary:"creator"});
 const stamp=Math.floor(Date.now()/1000),refund={id:"re_settlement",object:"refund",charge:"ch_original",payment_intent:"pi_original",amount:1000,currency:"usd",status:"succeeded",created:stamp,metadata:{},balance_transaction:"txn_settlementRefund",failure_balance_transaction:null,transfer_reversal:null,source_transfer_reversal:null};
 values["/v1/refunds"]={object:"list",data:[refund],has_more:false};values["/v1/refunds/re_settlement"]=refund;
 values["/v1/balance_transactions/txn_settlementRefund"]={object:"balance_transaction",id:"txn_settlementRefund",source:refund.id,type:"refund",reporting_category:"refund",balance_type:"payments",currency:"usd",exchange_rate:null,amount:-1000,fee:0,net:-1000,fee_details:[],created:stamp,available_on:stamp,status:"available"};
 f.base.charge.amount_refunded=1000;
 expect(await inspectTeamReceiptFinancials(c,receiptId,id(29))).toMatchObject({held:true});
 const revision=Number((await db.query<{revision:number}>("select observation_revision revision from sales_team_receipts_v1 where id=$1",[receiptId])).rows[0].revision);
 await db.exec("update sales_team_controls_v1 set refund_review_enabled=true");
 await reviewTeamRefundResponsibility(c,{actorId:id(29),receiptId,requestId:id(125),expectedRevision:revision,refundId:refund.id,responsibility:"creator",reasonCode:"creator_discretionary"});
 expect(await inspectTeamReceiptFinancials(c,receiptId,id(29))).toMatchObject({held:false});
 await db.query("update sales_team_worker_runs_v1 set scheduled_slot=scheduled_slot-interval '15 minutes',lease_until=clock_timestamp()-interval '1 second' where id=$1",[original.runId]);raw.mockClear();
 expect(await runTeamAutomaticSettlement(c,{admitNew:true})).toMatchObject({canceled:1,settled:0,held:0});
 expect((await db.query("select request_id from sales_team_transfer_cancellations_v1")).rows).toEqual([{request_id:q.id}]);expect(posts()).toHaveLength(0);
});

test("late financial completion failure rolls back balances, observations, result and cash epoch",async()=>{
 await fixture();const run=await claimAutomatic(),plan=(await nextPlan(run))!,begun=await phase(run,plan,"begin_financial");
 const inspected=await readTeamFinancialSnapshot(c,begun.source as TeamEventSource,{eventId:null,balances:true});
 const state=()=>db.query("select to_jsonb(r) receipt,(select to_jsonb(b) from sales_team_creator_balances_v1 b where b.receipt_id=r.id) balance,(select count(*)::int from sales_team_financial_observations_v1) observations,(select epoch::text from sales_team_cash_epoch_v1) epoch from sales_team_receipts_v1 r where r.id=$1",[receiptId]);
 const before=(await state()).rows;
 await db.exec("create function public.reject_fixture_settlement_result() returns trigger language plpgsql as $$begin raise exception 'synthetic_late_result_failure';end$$;create trigger reject_fixture_settlement_result before insert on sales_team_financial_check_results_v1 for each row execute function public.reject_fixture_settlement_result()");
 await denied(()=>phase(run,plan,"complete_financial",{revision:inspected.revision,snapshot:inspected.snapshot}),/synthetic_late_result_failure/);
 expect((await state()).rows).toEqual(before);expect((await db.query("select count(*)::int n from sales_team_financial_check_results_v1 where check_id=$1",[plan.financial_check_id])).rows).toEqual([{n:0}]);await db.exec("set constraints all immediate");
});

test("capture-anchored hold cannot be shortened or moved beyond its original verification bound",async()=>{
 await fixture();await closerSetup();await advance(15*86400000);
 expect((await db.query("select creatornet_team_private.settlement_closer_hold_v1($1) ready",[receiptId])).rows).toEqual([{ready:true}]);
 await db.exec("savepoint original_hold;update sales_team_commission_balances_v1 b set hold_until=r.paid_at+interval '14 days' from sales_team_receipts_v1 r where r.id=b.receipt_id");
 expect((await db.query("select creatornet_team_private.settlement_closer_hold_v1($1) ready",[receiptId])).rows).toEqual([{ready:false}]);await db.exec("rollback to savepoint original_hold;update sales_team_commission_balances_v1 set hold_until=hold_until+interval '1 second'");
 expect((await db.query("select creatornet_team_private.settlement_closer_hold_v1($1) ready",[receiptId])).rows).toEqual([{ready:false}]);
});

test("low refresh budget selects cheap shrinking cleanup without selecting stale unchanged reservations",async()=>{
 await fixture();const original=await f.rpc<AutomaticRun>("claim_sales_team_settlement_run_v1",[id(80),c.context]);
 await reserveTeamEarnedTransfer(c,{...original,taskId:id(82),requestId:id(81),receiptId,beneficiary:"creator"});await advance(16*60000);
 const run=await claimAutomatic();
 const select=()=>f.rpc<SelectedPlan|null>("next_sales_team_settlement_plan_v1",[run.runId,run.leaseToken,c.context,true,false]);
 expect(await select()).toBeNull();
 await db.exec("update sales_team_creator_balances_v1 set creator_proceeds_cents=0");expect(await select()).toMatchObject({request_id:id(81),source_ready:false});expect(posts()).toHaveLength(0);
});
