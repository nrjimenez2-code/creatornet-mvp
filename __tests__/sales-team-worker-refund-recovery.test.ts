/** @jest-environment ./test-support/pglite-environment.cjs */
import {installSignedSurplusEventsFixture} from "@/test-support/sales-team-surplus-events-schema";
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {sharedCashDatabase,sharedCashReconciliationCandidate} from "@/test-support/sales-team-shared-cash-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {teamCashBalanceFixture} from "@/test-support/sales-team-cash-postgres";
import {reserveTeamAdminRefund,previewTeamAdminRefund,processTeamAdminRefund} from "@/lib/salesTeams/adminRefunds";
import {runTeamAutomaticRecovery} from "@/lib/salesTeams/recovery";
import {recoverTeamWorkerRefund} from "@/lib/salesTeams/workerRefunds";
import {readTeamFinancialSnapshot} from "@/lib/salesTeams/financialReadback";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";

declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261023063905_sales_team_worker_refund_recovery.sql";
let db:PGlite;
beforeAll(async()=>{
 db=await sharedCashDatabase(createLocalPostgres());
 for(const path of [sharedCashReconciliationCandidate,"supabase/migrations/20261023042321_sales_team_retained_refund_funding.sql","supabase/migrations/20261023060912_sales_team_automatic_recovery.sql",candidate,"supabase/migrations/20261023174324_sales_team_no_outbound_shared_recovery.sql","supabase/migrations/20261023180144_sales_team_transfer_reservations.sql","supabase/migrations/20261023182527_sales_team_transfer_observations.sql","supabase/migrations/20261023184139_sales_team_transfer_execution.sql","supabase/migrations/20261023190044_sales_team_automatic_settlement.sql","supabase/migrations/20261024210829_sales_team_transfer_reversal_observations.sql","supabase/migrations/20261024213841_sales_team_transfer_recovery_reservations.sql","supabase/migrations/20261024215948_sales_team_transfer_recovery_execution.sql","supabase/migrations/20261025184802_sales_team_transfer_reversal_recovery.sql","supabase/migrations/20261025191826_sales_team_combined_settlement.sql","supabase/migrations/20261025195351_sales_team_later_collection.sql","supabase/migrations/20261026185425_sales_team_payment_lifecycle.sql","supabase/migrations/20261026193046_sales_team_expired_collection_retry.sql","supabase/migrations/20261027021620_sales_team_saved_method_authority.sql","supabase/migrations/20261027024721_sales_team_automatic_collection.sql","supabase/migrations/20261027232440_sales_team_protected_daily_surplus.sql","supabase/migrations/20261028000209_sales_team_surplus_execution.sql","supabase/migrations/20261028222238_sales_team_surplus_recovery.sql"])await db.exec(readFileSync(path,"utf8"));
await installSignedSurplusEventsFixture(db);await db.exec(readFileSync("supabase/migrations/20261029171329_sales_team_daily_surplus.sql","utf8"));},30000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec("begin");});
afterEach(async()=>{await db.exec("rollback;reset role");});
let f:Awaited<ReturnType<typeof seedTeamCapture>>,c:TeamReceiptComposition,receiptId:string,raw:jest.Mock,refunds:Record<string,unknown>[],events:Record<string,unknown>[],balances:Record<string,Record<string,unknown>>;
async function fixture(){
 await db.exec("update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,refund_review_enabled=true,refund_dispatch_enabled=true,fulfillment_enabled=true,cash_reservations_enabled=true,automatic_recovery_enabled=true,automatic_refund_recovery_enabled=true,shared_cash_reconciliation_enabled=true");
 f=await seedTeamCapture(db);receiptId=String((await f.record()).id);
 await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await db.exec("alter table sales_team_refund_requests_v1 alter column created_at set default (clock_timestamp()-interval '3 minutes');update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,evidence='{\"scope\":\"synthetic worker refund fixture only\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1(),retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1(),recovery_contract_sha256=creatornet_team_private.recovery_contract_digest_v1()");
 refunds=[];events=[];balances={};let sequence=0;
 raw=jest.fn(async(method:string,path:string)=>{
  if(method!=="GET")throw Error("Worker fixture forbids provider writes");
  const value=path==="/v1/balance"?teamCashBalanceFixture:path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/charges/ch_original"?f.base.charge:path==="/v1/balance_transactions/txn_original"?f.base.balance:
   path==="/v1/refunds"?{object:"list",data:refunds,has_more:false}:path==="/v1/disputes"?{object:"list",data:[],has_more:false}:path==="/v1/events"?{object:"list",data:events,has_more:false}:path.startsWith("/v1/refunds/")?refunds.find(r=>r.id===path.split("/").at(-1)):balances[path.split("/").at(-1)!];
  if(!value)throw Error(path);return JSON.parse(JSON.stringify({...value,lastResponse:{requestId:`req_workerRefund${++sequence}`}}));
 });
 c={admin:teamSupabaseFixture(db),context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence,stripe:{rawRequest:raw}};
}
function transaction(key:string,kind:string,amount:number,fee=0){const now=Math.floor(Date.now()/1000);return {id:key,object:"balance_transaction",source:"re_original",type:kind,reporting_category:kind,amount,fee,net:amount-fee,currency:"usd",exchange_rate:null,created:now,available_on:now-1,status:"available",fee_details:fee?[{amount:fee,currency:"usd",application:null,type:"stripe_fee"}]:[]};}
async function reserve(){
 const preview=await previewTeamAdminRefund(c,id(29),receiptId,1000,"creator","creator_discretionary");
 return reserveTeamAdminRefund(c,{actorId:id(29),requestId:id(25),receiptId,expectedRevision:preview.revision,amountCents:1000,responsibility:"creator",reasonCode:"creator_discretionary"});
}
async function admitted(status="succeeded"){
 await fixture();const q=await reserve(),get=raw.getMockImplementation()!;
 raw.mockImplementation(async(method:string,path:string,params:Record<string,unknown>={},options:{idempotencyKey?:string}={})=>{
  if(method==="GET")return get(method,path);
  expect(method).toBe("POST");expect(path).toBe("/v1/refunds");
  const now=Math.floor(Date.now()/1000);refunds=[{id:"re_original",object:"refund",charge:"ch_original",payment_intent:"pi_original",amount:1000,currency:"usd",status,created:now,metadata:params.metadata,balance_transaction:"txn_debit",failure_balance_transaction:status==="failed"?"txn_return":null,transfer_reversal:null,source_transfer_reversal:null}];
  balances.txn_debit=transaction("txn_debit","refund",-1000,40);if(status==="failed")balances.txn_return=transaction("txn_return","refund_failure",1000,-10);
  f.base.charge.amount_refunded=status==="succeeded"?1000:0;
  events=[{id:"evt_refundOriginal",object:"event",type:"refund.created",created:now,livemode:false,account:null,request:{id:"req_originalpost",idempotency_key:options.idempotencyKey},data:{object:JSON.parse(JSON.stringify(refunds[0]))}}];
  throw Error("Synthetic original POST response lost");
 });
 expect(await processTeamAdminRefund(c,id(29),q.id,true)).toMatchObject({disposition:"reconciliation_required"});
 expect(raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);raw.mockImplementation(get);raw.mockClear();return q;
}
const denied=async(run:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(run()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
async function task(){
 const run=await f.rpc<{runId:string;leaseToken:string}>("claim_sales_team_recovery_run_v1",[id(80),c.context]);
 const task=await f.rpc<{id:string;kind:string;source_id:string}>("next_sales_team_recovery_task_v1",[run.runId,run.leaseToken,c.context,false,true]);
 expect(task.kind).toBe("refund");return {...run,taskId:task.id,requestId:task.source_id};
}
const phase=(s:Awaited<ReturnType<typeof task>>,name:string,payload:unknown={})=>f.rpc("run_sales_team_worker_refund_recovery_v1",[s.runId,s.leaseToken,c.context,s.taskId,name,payload]);

test("the actual worker refund candidate installs with automatic refunds disabled",async()=>{
 expect((await db.query("select automatic_refund_recovery_enabled from sales_team_controls_v1")).rows).toEqual([{automatic_refund_recovery_enabled:false}]);
});
test("the optional refund queue retains four argument invocation and replaces only its exact predecessor",async()=>{
 expect((await db.query("select pronargs,pronargdefaults from pg_proc where oid='public.next_sales_team_recovery_task_v1(uuid,uuid,jsonb,boolean,boolean)'::regprocedure")).rows).toEqual([{pronargs:5,pronargdefaults:2}]);
 expect((await db.query("select to_regprocedure('public.next_sales_team_recovery_task_v1(uuid,uuid,jsonb,boolean)') old")).rows).toEqual([{old:null}]);
});
test("worker refund phases and sidecars are inaccessible to ordinary application roles",async()=>{
 expect((await db.query("select has_function_privilege('authenticated','public.run_sales_team_worker_refund_recovery_v1(uuid,uuid,jsonb,uuid,text,jsonb)','execute') allowed,has_table_privilege('anon','public.sales_team_refund_worker_actions_v1','select') readable")).rows).toEqual([{allowed:false,readable:false}]);
});

test("lost original response recovers by original event/key with an actual worker after admin revocation",async()=>{
 const q=await admitted();await db.query("update profiles set role='creator' where id=$1",[id(29)]);
 const s=await task();await db.exec("set role service_role");
 expect(await recoverTeamWorkerRefund(c,s)).toMatchObject({refundId:"re_original",disposition:"refund_observed",held:false,responsibility:"creator",reasonCode:"creator_discretionary"});
 expect((await db.query("select observed_by,worker_run_id from sales_team_refund_recovery_proofs_v1")).rows).toEqual([{observed_by:null,worker_run_id:s.runId}]);
 expect((await db.query("select reviewed_by,approval_request_id,recorded_by_worker_run_id,responsibility,reason_code from sales_team_refund_reviews_v1")).rows).toEqual([{reviewed_by:id(29),approval_request_id:q.id,recorded_by_worker_run_id:s.runId,responsibility:"creator",reason_code:"creator_discretionary"}]);
 expect((await db.query("select actor_id,worker_run_id from sales_team_financial_checks_v1 where worker_run_id is not null")).rows).toEqual([{actor_id:null,worker_run_id:s.runId}]);
 expect((await db.query("select disposition from sales_team_cash_resolutions_v1")).rows).toEqual([{disposition:"financially_observed"}]);
 expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);await db.exec("set constraints all immediate");
});

test("metadata without the original event idempotency key cannot adopt or recreate an unknown refund",async()=>{
 await admitted();(events[0].request as Record<string,unknown>).idempotency_key="unrelated-original";
 expect(await runTeamAutomaticRecovery(c,{recoverRefunds:true})).toEqual({status:"review_required",observed:0,held:1});
 expect((await db.query("select provider_id from sales_team_provider_operations_v1 where kind='refund'")).rows).toEqual([{provider_id:null}]);
 expect((await db.query("select count(*)::int n from sales_team_refund_recovery_proofs_v1")).rows).toEqual([{n:0}]);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});

test("an actual failed refund return resolves cash and retains original approved responsibility",async()=>{
 await admitted("failed");const s=await task();expect(await recoverTeamWorkerRefund(c,s)).toMatchObject({disposition:"refund_not_completed",held:false});
 expect((await db.query("select financial_adjustment_cost_cents::int cost from sales_team_receipts_v1")).rows).toEqual([{cost:30}]);
 expect((await db.query("select evidence->'balanceIds' ids from sales_team_cash_resolutions_v1")).rows).toEqual([{ids:expect.arrayContaining(["txn_debit","txn_return"])}]);
});

test("unavailable cash evidence keeps the aggregate worker result held after receipt reconciliation",async()=>{
 await admitted();balances.txn_debit.available_on=Math.floor(Date.now()/1000)+86400;
 expect(await runTeamAutomaticRecovery(c,{recoverRefunds:true})).toEqual({status:"review_required",observed:0,held:1});
 expect((await db.query("select review_hold from sales_team_receipts_v1")).rows).toEqual([{review_hold:false}]);expect((await db.query("select count(*)::int n from sales_team_cash_resolutions_v1")).rows).toEqual([{n:0}]);
});

test("refund gates omit tasks without disturbing the original encumbrance",async()=>{
 await admitted();await db.exec("update sales_team_controls_v1 set automatic_refund_recovery_enabled=false");
 expect(await runTeamAutomaticRecovery(c,{recoverRefunds:true})).toMatchObject({observed:0,held:0});expect(raw).not.toHaveBeenCalled();
});

test("unstarted refunds cannot be queued or fabricated as an unsent cancellation",async()=>{
 await fixture();const q=await reserve(),s=await f.rpc<{runId:string;leaseToken:string}>("claim_sales_team_recovery_run_v1",[id(80),c.context]);
 expect(await f.rpc("next_sales_team_recovery_task_v1",[s.runId,s.leaseToken,c.context,false,true])).toBeNull();
 await db.query("insert into sales_team_recovery_tasks_v1(id,run_id,kind,source_id,source) values($1,$2,'refund',$3,'{}')",[id(81),s.runId,q.id]);
 await denied(()=>phase({...s,taskId:id(81),requestId:q.id},"read"),/ADMITTED_ORIGINAL_REFUND_RECOVERY_REQUIRED/);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});

test("worker phases reject wrong token, task, context and foreign financial check without audit writes",async()=>{
 await admitted();const s=await task();
 await denied(()=>phase({...s,leaseToken:id(81)},"read"),/CURRENT_RECOVERY_WORKER_REQUIRED/);
 await denied(()=>phase({...s,taskId:id(81)},"read"),/ADMITTED_ORIGINAL_REFUND_RECOVERY_REQUIRED/);
 await denied(()=>f.rpc("run_sales_team_worker_refund_recovery_v1",[s.runId,s.leaseToken,{...c.context,mode:"live"},s.taskId,"read",{}]),/CURRENT_RECOVERY_WORKER_REQUIRED/);
 await denied(()=>phase(s,"complete_check",{checkId:id(81),revision:1,snapshot:{}}),/ORIGINAL_REFUND_TASK_CHECK_REQUIRED/);
 expect((await db.query("select count(*)::int n from sales_team_refund_worker_actions_v1")).rows).toEqual([{n:0}]);
});

test("a rejected worker financial snapshot rolls back stale-check links and results atomically",async()=>{
 await admitted();await db.query("insert into sales_team_financial_checks_v1(id,receipt_id,context,actor_id,created_at) values($1,$2,$3,$4,clock_timestamp()-interval '4 minutes')",[id(26),receiptId,c.context,id(29)]);
 const s=await task(),begun=await phase(s,"begin_check",{checkId:id(27)}) as unknown as {checkId:string;source:Parameters<typeof readTeamFinancialSnapshot>[1]};
 const proof=await readTeamFinancialSnapshot(c,begun.source,{eventId:null,balances:true});proof.snapshot.proof.context={...c.context,mode:"live"};
 await denied(()=>phase(s,"complete_check",{checkId:begun.checkId,revision:proof.revision,snapshot:proof.snapshot}),/REQUIRED|DIFFERS/);
 expect((await db.query("select count(*)::int n from sales_team_financial_check_recoveries_v1")).rows).toEqual([{n:0}]);expect((await db.query("select count(*)::int n from sales_team_financial_check_results_v1 where check_id in ($1,$2)",[id(26),id(27)])).rows).toEqual([{n:0}]);
});

test.each(["duplicate","request","snapshot"])("unknown-original recovery rejects changed %s event provenance",async kind=>{
 await admitted();if(kind==="duplicate")events.push({...events[0],id:"evt_secondOriginal"});
 if(kind==="request")(events[0].request as Record<string,unknown>).id="metadataOnly";
 if(kind==="snapshot")((events[0].data as {object:Record<string,unknown>}).object).amount=999;
 expect(await runTeamAutomaticRecovery(c,{recoverRefunds:true})).toMatchObject({status:"review_required",observed:0,held:1});
 expect((await db.query("select count(*)::int n from sales_team_refund_recovery_proofs_v1")).rows).toEqual([{n:0}]);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});

test("new-money-off recovery completes the original and excludes settled replay without provider reads",async()=>{
 await admitted();await db.exec("update sales_team_controls_v1 set new_sales_enabled=false,cash_reservations_enabled=false,refund_dispatch_enabled=false,retained_refund_funding_enabled=false");
 expect(await runTeamAutomaticRecovery(c,{recoverRefunds:true})).toEqual({status:"complete",observed:1,held:0});
 raw.mockClear();expect(await runTeamAutomaticRecovery(c,{recoverRefunds:true})).toMatchObject({status:"slot_consumed",observed:0});expect(raw).not.toHaveBeenCalled();
 // A new fixture worker in a distinct synthetic slot still cannot queue the settled original.
 await db.query("insert into sales_team_worker_runs_v1(id,kind,scheduled_slot,lease_until,status) values($1,'reconciliation',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '90 seconds','running')",[id(82)]);
 await db.query("insert into sales_team_recovery_runs_v1(run_id,lease_token,context,contract_sha256) select $1,$2,$3,recovery_contract_sha256 from sales_team_cash_policy_v1",[id(82),id(83),c.context]);
 expect(await f.rpc("next_sales_team_recovery_task_v1",[id(82),id(83),c.context,false,true])).toBeNull();expect(raw).not.toHaveBeenCalled();
});

test("a genuinely audited unsent cancellation can finish without fabricating one",async()=>{
 await fixture();const q=await reserve();await f.rpc("cancel_unsent_sales_team_refund_v1",[id(29),q.id,c.context]);
 await db.query("update profiles set role='creator' where id=$1",[id(29)]);
 expect(await runTeamAutomaticRecovery(c,{recoverRefunds:true})).toEqual({status:"complete",observed:1,held:0});expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
 expect((await db.query("select observed_by,worker_run_id,status from sales_team_refund_request_results_v1")).rows).toEqual([{observed_by:id(29),worker_run_id:null,status:"canceled_before_dispatch"}]);
});

test("refund observation never steals a still-live original provider dispatch",async()=>{
 await admitted();await db.exec("update sales_team_provider_operations_v1 set status='dispatching',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '1 minute' where kind='refund'");
 const run=await f.rpc<{runId:string;leaseToken:string}>("claim_sales_team_recovery_run_v1",[id(80),c.context]);
 expect(await f.rpc("next_sales_team_recovery_task_v1",[run.runId,run.leaseToken,c.context,false,true])).toBeNull();expect(raw).not.toHaveBeenCalled();
});

test("successful worker recovery supersedes only stale checks and preserves initiating actor provenance",async()=>{
 await admitted();await db.query("insert into sales_team_financial_checks_v1(id,receipt_id,context,actor_id,created_at) values($1,$2,$3,$4,clock_timestamp()-interval '4 minutes')",[id(26),receiptId,c.context,id(29)]);
 await db.query("update profiles set role='creator' where id=$1",[id(29)]);
 const s=await task();expect(await recoverTeamWorkerRefund(c,s)).toMatchObject({held:false});
 expect((await db.query("select original.actor_id,result.recovered_by_worker_run_id from sales_team_financial_checks_v1 original join sales_team_financial_check_results_v1 result on result.check_id=original.id where original.id=$1",[id(26)])).rows).toEqual([{actor_id:id(29),recovered_by_worker_run_id:s.runId}]);await db.exec("set constraints all immediate");
});

test("worker authority requires an unfinished exact refund task and immutable audit history",async()=>{
 const q=await admitted(),run=await f.rpc<{runId:string;leaseToken:string}>("claim_sales_team_recovery_run_v1",[id(80),c.context]);
 await denied(()=>f.rpc("record_sales_team_refund_responsibility_worker_v1",[run.runId,q.id]),/CURRENT_REFUND_RECOVERY_WORKER_REQUIRED/);
 const t=await f.rpc<{id:string}>("next_sales_team_recovery_task_v1",[run.runId,run.leaseToken,c.context,false,true]);const s={...run,taskId:t.id,requestId:q.id};
 const begun=await phase(s,"begin_check",{checkId:id(27)}) as unknown as {checkId:string};await denied(()=>db.exec("delete from sales_team_refund_worker_actions_v1"),/immutable/i);
 await f.rpc("finish_sales_team_recovery_task_v1",[run.runId,run.leaseToken,c.context,t.id,true]);
 await denied(()=>phase(s,"read"),/ADMITTED_ORIGINAL_REFUND_RECOVERY_REQUIRED/);await denied(()=>f.rpc("record_sales_team_refund_responsibility_worker_v1",[run.runId,q.id]),/CURRENT_REFUND_RECOVERY_WORKER_REQUIRED/);
 await denied(()=>f.rpc("complete_sales_team_refund_worker_financial_v1",[run.runId,run.leaseToken,c.context,begun.checkId,1,{}]),/ORIGINAL_RECOVERY_CHECK_REQUIRED/);
});
