/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {sharedCashDatabase,sharedCashReconciliationCandidate} from "@/test-support/sales-team-shared-cash-postgres";
import {sharedCashOriginalFixture} from "@/test-support/sales-team-shared-cash-readback";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {runTeamAutomaticRecovery} from "@/lib/salesTeams/recovery";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
import type {SharedCashOriginal} from "@/lib/salesTeams/sharedCashReadback";
import {readTeamFinancialSnapshot} from "@/lib/salesTeams/financialReadback";
import {inspectTeamReceiptFinancials} from "@/lib/salesTeams/financialChecks";

declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261023060912_sales_team_automatic_recovery.sql";
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,c:TeamReceiptComposition,receiptId:string,raw:jest.Mock,values:Record<string,unknown>;
beforeAll(async()=>{db=await sharedCashDatabase(createLocalPostgres());for(const name of [sharedCashReconciliationCandidate,"supabase/migrations/20261023042321_sales_team_retained_refund_funding.sql",candidate])await db.exec(readFileSync(name,"utf8"));},30000);
beforeEach(async()=>{
 await db.exec("begin;update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true,automatic_recovery_enabled=true,shared_cash_reconciliation_enabled=true");
 f=await seedTeamCapture(db);receiptId=String((await f.record()).id);await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,evidence='{\"scope\":\"synthetic automatic recovery fixture only\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1(),retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1(),recovery_contract_sha256=creatornet_team_private.recovery_contract_digest_v1()");
 values={"/v1/payment_intents/pi_original":f.base.paymentIntent,"/v1/charges/ch_original":f.base.charge,"/v1/balance_transactions/txn_original":f.base.balance,"/v1/refunds":{object:"list",data:[],has_more:false},"/v1/disputes":{object:"list",data:[],has_more:false}};
 let seq=0;raw=jest.fn(async(method:string,path:string)=>{if(method!=="GET"||!values[path])throw Error("Recovery fixture permits owned GETs only");return JSON.parse(JSON.stringify({...values[path] as object,lastResponse:{requestId:`req_auto${++seq}`}}));});
 c={admin:teamSupabaseFixture(db),context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence,stripe:{rawRequest:raw}};
});
afterEach(async()=>{await db.exec("rollback");await db.exec("reset role");});afterAll(async()=>{await db.close();});
const denied=async(run:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(run()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
const claim=()=>f.rpc<{status:string;runId:string;leaseToken:string}>("claim_sales_team_recovery_run_v1",[id(80),c.context]);
async function staleCheck(minutes=3){await db.query("insert into sales_team_financial_checks_v1(id,receipt_id,context,actor_id,created_at) values($1,$2,$3,$4,clock_timestamp()-make_interval(mins=>$5))",[id(25),receiptId,c.context,id(29),minutes]);await db.query("update sales_team_receipts_v1 set review_hold=true where id=$1",[receiptId]);}

test("stale checks complete under the actual worker while preserving their original initiator",async()=>{
 await staleCheck();expect(await runTeamAutomaticRecovery(c)).toEqual({status:"complete",observed:1,held:0});
 const records=await db.query<{actor_id:string;worker:string;original_check_id:string}>("select original.actor_id,recovered.recovered_by_worker_run_id worker,link.original_check_id from sales_team_financial_check_recoveries_v1 link join sales_team_financial_checks_v1 original on original.id=link.original_check_id join sales_team_financial_check_results_v1 recovered on recovered.check_id=original.id");
 expect(records.rows).toEqual([{actor_id:id(29),worker:expect.any(String),original_check_id:id(25)}]);expect((await db.query("select review_hold from sales_team_receipts_v1")).rows).toEqual([{review_hold:false}]);
 await db.exec("set constraints all immediate");expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});

test("ordinary current admin inspection retains its authority and unchanged financial proof validation",async()=>{
 expect(await inspectTeamReceiptFinancials(c,receiptId,id(29),id(26))).toMatchObject({held:false,completed:true});expect((await db.query("select recovered_by_worker_run_id,recovery_check_id from sales_team_financial_check_results_v1")).rows).toEqual([{recovered_by_worker_run_id:null,recovery_check_id:null}]);
});

test("enabled fulfillment recovery delivers an already verified receipt once through the existing shared Library contract",async()=>{
 expect(await runTeamAutomaticRecovery(c,{fulfill:true})).toEqual({status:"complete",observed:1,held:0});
 expect((await db.query("select receipt_id from sales_team_shared_receipts_v1")).rows).toEqual([{receipt_id:receiptId}]);expect(raw).not.toHaveBeenCalled();
 expect((await db.query("select count(*)::int n from purchases where sales_team_sale_id=$1",[f.sale])).rows).toEqual([{n:1}]);await db.exec("set constraints all immediate");
});

test("a terminal shared workflow with an unknown original stays held without metadata adoption or provider calls",async()=>{
 await db.query("insert into payment_fee_ledger(id,creator_id,stripe_payment_intent_id,stripe_charge_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,creator_net_cents,currency,fee_schedule_version) values($1,$2,'pi_legacy','ch_legacy',10000,1200,320,1520,8480,'usd','fixture')",[id(90),id(1)]);
 await f.rpc("create_refund_operation",[id(91),id(90),1000,"creator_discretionary","creator",null,"fixture-unknown-original",id(29),"ch_legacy","fee_legacy",0,0,320]);await db.exec("update refund_operations set status='failed'");
 expect(await runTeamAutomaticRecovery(c)).toEqual({status:"review_required",observed:0,held:1});expect(raw).not.toHaveBeenCalled();expect((await db.query("select count(*)::int n from sales_team_shared_cash_resolutions_v1")).rows).toEqual([{n:0}]);expect((await db.query("select holdReason from (select proof->>'holdReason' holdReason from sales_team_shared_cash_check_results_v1) holds")).rows).toEqual([{holdreason:"original_provider_identity_required"}]);
});

test("a recent pending check stays with its original reader",async()=>{
 await staleCheck(0);expect(await runTeamAutomaticRecovery(c)).toEqual({status:"complete",observed:0,held:0});expect(raw).not.toHaveBeenCalled();expect((await db.query("select count(*)::int n from sales_team_financial_check_results_v1 where check_id=$1",[id(25)])).rows).toEqual([{n:0}]);
});

test("a failed independent read retains both old and new pending checks without a fake result",async()=>{
 await staleCheck();raw.mockRejectedValue(Error("synthetic provider failure with private details"));expect(await runTeamAutomaticRecovery(c)).toEqual({status:"review_required",observed:0,held:1});
 expect((await db.query("select count(*)::int n from sales_team_financial_check_results_v1")).rows).toEqual([{n:0}]);expect((await db.query("select count(*)::int n from sales_team_financial_check_recoveries_v1")).rows).toEqual([{n:0}]);
 expect(JSON.stringify((await db.query("select * from sales_team_recovery_task_results_v1")).rows)).not.toContain("private details");
 expect((await db.query("select code,status from sales_team_financial_alerts_v1 where code='TEAM_AUTOMATIC_RECOVERY_REVIEW'")).rows).toEqual([{code:"TEAM_AUTOMATIC_RECOVERY_REVIEW",status:"open"}]);
});

test("a rejected financial proof rolls back every stale-check supersession and result",async()=>{
 await staleCheck();const run=await claim(),task=await f.rpc<{id:string}>("next_sales_team_recovery_task_v1",[run.runId,run.leaseToken,c.context]);
 const begun=await f.rpc<{checkId:string;source:Parameters<typeof readTeamFinancialSnapshot>[1]}>("begin_sales_team_recovery_financial_v1",[run.runId,run.leaseToken,c.context,task.id]);
 const proof=await readTeamFinancialSnapshot(c,begun.source,{eventId:null,balances:true});proof.snapshot.proof.context={...c.context,mode:"live"};
 await denied(()=>f.rpc("complete_sales_team_recovery_financial_v1",[run.runId,run.leaseToken,c.context,begun.checkId,proof.revision,proof.snapshot]),/REQUIRED|DIFFERS/);
 expect((await db.query("select count(*)::int n from sales_team_financial_check_recoveries_v1")).rows).toEqual([{n:0}]);expect((await db.query("select count(*)::int n from sales_team_financial_check_results_v1")).rows).toEqual([{n:0}]);
});

test("a worker cannot claim success for an uninspected task or rewrite a recorded result",async()=>{
 await staleCheck();const run=await claim(),task=await f.rpc<{id:string}>("next_sales_team_recovery_task_v1",[run.runId,run.leaseToken,c.context]);
 await denied(()=>f.rpc("finish_sales_team_recovery_task_v1",[run.runId,run.leaseToken,c.context,task.id,false]),/COMPLETE_RECOVERY_TASK_PROOF_REQUIRED/);
 await f.rpc("finish_sales_team_recovery_task_v1",[run.runId,run.leaseToken,c.context,task.id,true]);await denied(()=>f.rpc("finish_sales_team_recovery_task_v1",[run.runId,run.leaseToken,c.context,task.id,false]),/ORIGINAL_RECOVERY_RESULT_CHANGED/);
});

test("a run claims at most three distinct original tasks",async()=>{
 for(let i=0;i<4;i++)await f.rpc("begin_sales_team_payment_event_v1",[`evt_batch${i}`,"payment_intent.succeeded",Math.floor(Date.now()/1000),"pi_original","pi_original","ch_original",c.context]);
 const run=await claim(),tasks=[];for(let i=0;i<3;i++)tasks.push(await f.rpc<{id:string}>("next_sales_team_recovery_task_v1",[run.runId,run.leaseToken,c.context]));
 expect(new Set(tasks.map(t=>t.id)).size).toBe(3);expect(await f.rpc("next_sales_team_recovery_task_v1",[run.runId,run.leaseToken,c.context])).toBeNull();
});

test("the durable signed-event handoff completes using its existing original source",async()=>{
 await f.rpc("begin_sales_team_payment_event_v1",["evt_autoOriginal","payment_intent.succeeded",Math.floor(Date.now()/1000),"pi_original","pi_original","ch_original",c.context]);
 expect(await runTeamAutomaticRecovery(c)).toEqual({status:"complete",observed:1,held:0});expect((await db.query("select event_id from sales_team_payment_event_results_v1")).rows).toEqual([{event_id:"evt_autoOriginal"}]);
});

test("known shared originals resolve with new-money gates off and keep worker provenance",async()=>{
 await db.query("insert into payment_fee_ledger(id,creator_id,stripe_payment_intent_id,stripe_charge_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,creator_net_cents,currency,fee_schedule_version) values($1,$2,'pi_legacy','ch_legacy',10000,1200,320,1520,8480,'usd','fixture')",[id(90),id(1)]);
 await f.rpc("create_refund_operation",[id(91),id(90),1000,"creator_discretionary","creator",null,"fixture-auto-original",id(29),"ch_legacy","fee_legacy",0,0,320]);
 await db.exec("update refund_operations set status='completed',stripe_refund_id='re_legacy',stripe_application_fee_refund_id='fr_legacy',stripe_application_fee_refund_amount_cents=application_fee_refund_amount_cents");
 const source=(await db.query<{r:SharedCashOriginal}>("select creatornet_team_private.shared_cash_original_v1('legacy_refund',$1,$2) r",[id(91),c.context])).rows[0].r;Object.assign(values,sharedCashOriginalFixture(source).values);
 await db.exec("update sales_team_controls_v1 set new_sales_enabled=false,cash_reservations_enabled=false,retained_refund_funding_enabled=false,refund_dispatch_enabled=false");
 expect(await runTeamAutomaticRecovery(c)).toEqual({status:"complete",observed:1,held:0});expect((await db.query("select observed_by,worker_run_id is not null worker from sales_team_shared_cash_check_results_v1")).rows).toEqual([{observed_by:null,worker:true}]);
});

async function recipient(){
 await db.query("insert into stripe_connect_account_creations(creator_id,idempotency_key,stripe_account_id) values($1,$2,'acct_creator')",[id(1),id(92)]);
 await db.query("insert into sales_team_recipient_setups_v1(user_id,api,account_id,legacy_creation_key,context) values($1,'v1','acct_creator',$2,$3)",[id(1),id(92),c.context]);
 await db.query("update sales_team_recipients_v1 set verified_at=clock_timestamp()-interval '11 minutes' where user_id=$1",[id(1)]);
 values["/v1/accounts/acct_creator"]={object:"account",id:"acct_creator",country:"US",default_currency:"usd",payouts_enabled:true,capabilities:{transfers:"active"},metadata:{creatornet_user_id:id(1),creatornet_creation_id:id(92)}};
}
test("recipient refresh verifies the bound original twice and never creates an account or onboarding link",async()=>{
 await recipient();expect(await runTeamAutomaticRecovery(c)).toEqual({status:"complete",observed:1,held:0});expect(raw.mock.calls).toHaveLength(2);expect((await db.query("select ownership_verified from sales_team_recipients_v1 where user_id=$1",[id(1)])).rows).toEqual([{ownership_verified:true}]);
 expect(JSON.stringify((await db.query("select source from sales_team_recovery_tasks_v1")).rows)).not.toContain("contact_email");
});
test("failed current recipient proof invalidates cached readiness without replacing its original account",async()=>{
 await recipient();Object.assign(values["/v1/accounts/acct_creator"] as object,{metadata:{creatornet_user_id:id(2)}});expect(await runTeamAutomaticRecovery(c)).toEqual({status:"review_required",observed:0,held:1});
 expect((await db.query("select account_id,ownership_verified,transfers_active,payouts_ready from sales_team_recipients_v1 where user_id=$1",[id(1)])).rows).toEqual([{account_id:"acct_creator",ownership_verified:false,transfers_active:false,payouts_ready:false}]);
});

test("default-off automatic recovery claims no run or provider request",async()=>{
 await staleCheck();await db.exec("update sales_team_controls_v1 set automatic_recovery_enabled=false");expect(await runTeamAutomaticRecovery(c)).toMatchObject({status:"held"});expect(raw).not.toHaveBeenCalled();
});
test("duplicate invocations cannot overlap or reuse a consumed slot",async()=>{
 const run=await claim();expect(run.status).toBe("claimed");expect(await claim()).toMatchObject({status:"busy"});await f.rpc("finish_sales_team_recovery_run_v1",[run.runId,run.leaseToken,c.context,false]);expect(await claim()).toMatchObject({status:"slot_consumed"});
});
test("wrong lease tokens, contexts and expired workers cannot claim or complete tasks",async()=>{
 const run=await claim();await denied(()=>f.rpc("next_sales_team_recovery_task_v1",[run.runId,id(81),c.context]),/CURRENT_RECOVERY_WORKER_REQUIRED/);
 await denied(()=>f.rpc("next_sales_team_recovery_task_v1",[run.runId,run.leaseToken,{...c.context,mode:"live"}]),/CURRENT_RECOVERY_WORKER_REQUIRED/);
 await db.query("update sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id=$1",[run.runId]);await denied(()=>f.rpc("next_sales_team_recovery_task_v1",[run.runId,run.leaseToken,c.context]),/CURRENT_RECOVERY_WORKER_REQUIRED/);
});
test("missing reviewed recovery contract refuses automatic execution",async()=>{
 await db.exec("update sales_team_cash_policy_v1 set recovery_contract_sha256=null");await denied(()=>runTeamAutomaticRecovery(c),/RECOVERY_CONTRACT_REVIEW_REQUIRED/);expect(raw).not.toHaveBeenCalled();
});
test("recovery history and functions remain private and immutable",async()=>{
 await claim();await denied(()=>db.exec("delete from sales_team_recovery_runs_v1"),/immutable/i);await db.exec("set role authenticated");await denied(claim,/permission denied/i);await denied(()=>db.exec("select * from sales_team_recovery_tasks_v1"),/permission denied/i);
});
test("service-role execution completes independent recovery without superuser grants",async()=>{
 await staleCheck();await db.exec("set role service_role");expect(await runTeamAutomaticRecovery(c)).toMatchObject({observed:1,held:0});await db.exec("set constraints all immediate");
});
test("the full candidate rolls back its final grant and financial-check source patch",async()=>{
 const isolated=await sharedCashDatabase(createLocalPostgres());try{
  await isolated.exec(readFileSync(sharedCashReconciliationCandidate,"utf8"));await isolated.exec(readFileSync("supabase/migrations/20261023042321_sales_team_retained_refund_funding.sql","utf8"));
  const original=(await isolated.query("select pg_get_functiondef('public.complete_sales_team_financial_check_v1(uuid,integer,jsonb)'::regprocedure) source")).rows;
  const sql=readFileSync(candidate,"utf8"),fault=sql.replace("commit;","grant execute on function public.missing_recovery_final_grant() to service_role;commit;");await expect(isolated.exec(fault)).rejects.toThrow(/missing_recovery_final_grant/);await isolated.exec("rollback");
  expect((await isolated.query("select to_regclass('sales_team_recovery_runs_v1') runs")).rows).toEqual([{runs:null}]);expect((await isolated.query("select pg_get_functiondef('public.complete_sales_team_financial_check_v1(uuid,integer,jsonb)'::regprocedure) source")).rows).toEqual(original);
 }finally{await isolated.close();}
},30000);
