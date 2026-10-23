/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {sharedCashDatabase,sharedCashReconciliationCandidate} from "@/test-support/sales-team-shared-cash-postgres";
import {sharedCashOriginalFixture} from "@/test-support/sales-team-shared-cash-readback";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {inspectSharedCashOriginal} from "@/lib/salesTeams/sharedCashChecks";
import {readSharedCashOriginal,type SharedCashOriginal,type SharedCashObservation} from "@/lib/salesTeams/sharedCashReadback";

declare const createLocalPostgres:()=>PGlite;
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>;
beforeAll(async()=>{db=await sharedCashDatabase(createLocalPostgres());await db.exec(readFileSync(sharedCashReconciliationCandidate,"utf8"));
 for(const name of ["20261023042321_sales_team_retained_refund_funding.sql","20261023060912_sales_team_automatic_recovery.sql","20261023063905_sales_team_worker_refund_recovery.sql","20261023174324_sales_team_no_outbound_shared_recovery.sql","20261023180144_sales_team_transfer_reservations.sql","20261023182527_sales_team_transfer_observations.sql"])await db.exec(readFileSync(`supabase/migrations/${name}`,"utf8"));
},30000);
beforeEach(async()=>{
 await db.exec("begin;update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true,shared_cash_reconciliation_enabled=true");
 f=await seedTeamCapture(db);await f.record();await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1()");
});
afterEach(async()=>{await db.exec("rollback");await db.exec("reset role");});afterAll(async()=>{await db.close();});
const denied=async(run:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(run()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
async function legacy(closed=true){
 await db.query("insert into payment_fee_ledger(id,creator_id,stripe_payment_intent_id,stripe_charge_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,creator_net_cents,currency,fee_schedule_version) values($1,$2,'pi_legacy','ch_legacy',10000,1200,320,1520,8480,'usd','fixture')",[id(90),id(1)]);
 await f.rpc("create_refund_operation",[id(91),id(90),1000,"creator_discretionary","creator",null,"fixture-legacy-original",id(29),"ch_legacy","fee_legacy",0,0,320]);
 if(closed)await db.query("update refund_operations set status='completed',stripe_refund_status='succeeded',stripe_refund_id='re_legacy',stripe_application_fee_refund_id='fr_legacy',stripe_application_fee_refund_amount_cents=application_fee_refund_amount_cents where id=$1",[id(91)]);
}
const begin=(checkId=id(96),actor:string|null=id(29),worker:string|null=null,sourceId=id(91))=>f.rpc<{checkId:string;completed:boolean;held:boolean;source:SharedCashOriginal}>("begin_sales_team_shared_cash_check_v1",[checkId,"legacy_refund",sourceId,actor,worker,f.contract.context]);
const complete=(proof:SharedCashObservation,checkId=id(96),actor:string|null=id(29),worker:string|null=null)=>f.rpc("complete_sales_team_shared_cash_check_v1",[checkId,actor,worker,proof]);
const liability=async()=>Number((await db.query<{r:{protectedCents:number}}>("select creatornet_team_private.shared_platform_cash_liabilities_v1($1) r",[f.contract.context])).rows[0].r.protectedCents);
async function observation(){const begun=await begin(),fixture=sharedCashOriginalFixture(begun.source),c={admin:teamSupabaseFixture(db),context:f.contract.context,observeContext:async()=>f.contract.context,stripe:{rawRequest:fixture.raw}};return {begun,fixture,c,proof:await readSharedCashOriginal(c,begun.source)};}

test("installed resolution bridge retires only independently proven original cash and replays without GETs",async()=>{
 await legacy();expect(await liability()).toBeGreaterThan(1000);const {c,fixture}=await observation();
 const before=(await db.query("select epoch from sales_team_cash_epoch_v1")).rows;
 expect(await inspectSharedCashOriginal(c,{kind:"legacy_refund",id:id(91),actorId:id(29),checkId:id(96)})).toMatchObject({completed:true,held:false});
 await db.exec("set constraints all immediate");
 expect(await liability()).toBe(0);const resolved=(await db.query("select epoch from sales_team_cash_epoch_v1")).rows;expect(resolved).not.toEqual(before);
 fixture.raw.mockClear();await db.exec("update sales_team_controls_v1 set shared_cash_reconciliation_enabled=false,cash_reservations_enabled=false");
 expect(await inspectSharedCashOriginal(c,{kind:"legacy_refund",id:id(91),actorId:id(29),checkId:id(96)})).toMatchObject({completed:true,held:false});expect(fixture.raw).not.toHaveBeenCalled();
 expect((await db.query("select epoch from sales_team_cash_epoch_v1")).rows).toEqual(resolved);expect((await db.query("select count(*)::int n from sales_team_shared_cash_resolutions_v1")).rows).toEqual([{n:1}]);
});

test("unfinished originals remain held and store only sanitized hold evidence",async()=>{
 await legacy(false);const {c,fixture}=await observation();fixture.raw.mockClear();
 expect(await inspectSharedCashOriginal(c,{kind:"legacy_refund",id:id(91),actorId:id(29),checkId:id(96)})).toMatchObject({completed:true,held:true});expect(fixture.raw).not.toHaveBeenCalled();expect(await liability()).toBeGreaterThan(1000);
 expect((await db.query<{proof:object}>("select proof from sales_team_shared_cash_check_results_v1")).rows[0].proof).toMatchObject({holdReason:"original_workflow_unfinished"});
});

test("source changes during read retain the original commitment and a stale result",async()=>{
 await legacy();const {proof}=await observation();await db.query("update refund_operations set status='failed' where id=$1",[id(91)]);
 // A terminal status alone does not change this proof's closed flag; economics do.
 await db.query("update refund_operations set stripe_application_fee_refund_amount_cents=1 where id=$1",[id(91)]);
 expect(await complete(proof)).toMatchObject({held:true});expect(await liability()).toBeGreaterThan(1000);
 expect((await db.query<{proof:{holdReason:string}}>("select proof from sales_team_shared_cash_check_results_v1")).rows[0].proof.holdReason).toBe("source_changed");
});

test.each(["source","currency","fee","reads","fingerprint","parent","extra","duplicateRequest","duplicateBalance","fractionalFee","staleTime","pendingBalance"])("SQL independently refuses forged %s proof and rolls back all release writes",async(change)=>{
 await legacy();const {proof}=await observation();
 if(change==="source")proof.balances[0].sourceId="re_foreign";
 if(change==="currency")Object.assign(proof.balances[0],{currency:"eur"});
 if(change==="fee")proof.balances[0].feeCents++;
 if(change==="reads")proof.reads=proof.reads.filter(read=>!read.path.startsWith("/v1/refunds/"));
 if(change==="fingerprint")proof.fingerprint="f".repeat(64);
 if(change==="parent")(proof.objects.applicationFee as {chargeId:string}).chargeId="ch_foreign";
 if(change==="extra")Object.assign(proof.objects,{customer:{private:"unwanted"}});
 if(change==="duplicateRequest")proof.reads[proof.reads.length-1].requestId=proof.reads[0].requestId;
 if(change==="duplicateBalance")proof.balances.push(structuredClone(proof.balances[0]));
 if(change==="fractionalFee")proof.balances[0].feeCents=0.5;
 if(change==="staleTime")proof.readStartedAt-=60000;
 if(change==="pendingBalance")Object.assign(proof.balances[0],{status:"pending"});
 await denied(()=>complete(proof),/REQUIRED|CHANGED/);expect((await db.query("select count(*)::int n from sales_team_shared_cash_resolutions_v1")).rows).toEqual([{n:0}]);expect(await liability()).toBeGreaterThan(1000);
});

test("a second check resolves the same original once without a second epoch increment",async()=>{
 await legacy();const first=await observation();await complete(first.proof);
 const epoch=(await db.query("select epoch from sales_team_cash_epoch_v1")).rows;
 const second=await begin(id(97)),transport=sharedCashOriginalFixture(second.source);
 const proof=await readSharedCashOriginal({...first.c,stripe:{rawRequest:transport.raw}},second.source);
 expect(await complete(proof,id(97))).toMatchObject({held:false});await db.exec("set constraints all immediate");
 expect((await db.query("select epoch from sales_team_cash_epoch_v1")).rows).toEqual(epoch);expect((await db.query("select count(*)::int n from sales_team_shared_cash_resolutions_v1")).rows).toEqual([{n:1}]);
});

test("an already consumed balance identity cannot release a different original",async()=>{
 await legacy();const first=await observation();await complete(first.proof);
 await f.rpc("create_refund_operation",[id(92),id(90),1000,"creator_discretionary","creator",null,"fixture-other-original",id(29),"ch_legacy","fee_legacy",1000,152,320]);
 await db.query("update refund_operations set status='completed',stripe_refund_status='succeeded',stripe_refund_id='re_other',stripe_application_fee_refund_id='fr_other',stripe_application_fee_refund_amount_cents=application_fee_refund_amount_cents where id=$1",[id(92)]);
 const second=await begin(id(97),id(29),null,id(92)),transport=sharedCashOriginalFixture(second.source),proof=await readSharedCashOriginal({...first.c,stripe:{rawRequest:transport.raw}},second.source);
 await denied(()=>complete(proof,id(97)),/ORIGINAL_SHARED_CASH_BALANCE_CHANGED/);expect(await liability()).toBeGreaterThan(1000);
});

test("cash already resolved cannot authorize reopening the same legacy outgoing original",async()=>{
 await legacy();const {proof}=await observation();await complete(proof);
 expect(await f.rpc("sales_team_shared_cash_admitted_v1",["legacy_refund",id(91)])).toBe(false);
 expect(await f.rpc("claim_refund_operation",[id(91),id(97),300])).toBe("completed");
 await db.query("update refund_operations set status='pending' where id=$1",[id(91)]);
 await denied(()=>f.rpc("claim_refund_operation",[id(91),id(97),300]),/SHARED_REFUND_CASH_ADMISSION_REQUIRED/);
 await db.query("update refund_operations set stripe_refund_id='re_replacement' where id=$1",[id(91)]);
 await denied(()=>begin(id(97)),/ORIGINAL_SHARED_PROVIDER_IDENTITY_CHANGED/);
});

test("changed high-water source version cannot release its older commitment",async()=>{
 await legacy();const {proof}=await observation();
 await db.query("update refund_operations set application_fee_refund_amount_cents=application_fee_refund_amount_cents+1,application_fee_refund_target_cents=application_fee_refund_target_cents+1,creator_balance_impact_cents=creator_balance_impact_cents-1 where id=$1",[id(91)]);
 expect(await complete(proof)).toMatchObject({held:true});expect(await liability()).toBeGreaterThan(1000);
});

test("replay and completion retain the initiating reader identity",async()=>{
 await legacy();const {proof}=await observation();await db.query("update profiles set role='admin' where id=$1",[id(1)]);
 await denied(()=>begin(id(96),id(1)),/ORIGINAL_SHARED_CASH_READER_CHANGED/);await denied(()=>complete(proof,id(96),id(1)),/ORIGINAL_SHARED_CASH_READER_CHANGED/);
});

test("a current reconciliation worker completes under its own identity and expires independently",async()=>{
 await legacy();await db.query("insert into sales_team_worker_runs_v1(id,kind,scheduled_slot,lease_until,status) values($1,'reconciliation',now(),now()+interval '5 minutes','running')",[id(94)]);
 const begun=await begin(id(96),null,id(94)),transport=sharedCashOriginalFixture(begun.source),c={context:f.contract.context,observeContext:async()=>f.contract.context,stripe:{rawRequest:transport.raw}};
 const proof=await readSharedCashOriginal(c,begun.source);expect(await complete(proof,id(96),null,id(94))).toMatchObject({held:false});
 expect((await db.query("select observed_by,worker_run_id from sales_team_shared_cash_check_results_v1")).rows).toEqual([{observed_by:null,worker_run_id:id(94)}]);
 await db.query("update sales_team_worker_runs_v1 set lease_until=now()-interval '1 second' where id=$1",[id(94)]);await denied(()=>complete(proof,id(96),null,id(94)),/READER_REQUIRED/);
});

test("policy review changes hold a pending inspection without releasing money",async()=>{
 await legacy();const {proof}=await observation();await db.exec("update sales_team_cash_policy_v1 set shared_contract_sha256=null");await denied(()=>complete(proof),/CONTRACT_REVIEW_REQUIRED/);
 await denied(()=>begin(id(97)),/CONTRACT_REVIEW_REQUIRED/);
});

test("a known original cannot be replaced while its first inspection is pending",async()=>{
 await legacy();await begin();await db.query("update refund_operations set stripe_refund_id='re_replacement' where id=$1",[id(91)]);
 await denied(()=>begin(id(97)),/ORIGINAL_SHARED_PROVIDER_IDENTITY_CHANGED/);
});

test("an earlier missing identity stays held while a newly bound original receives its own check",async()=>{
 await legacy(false);const early=await observation();expect(await complete(early.proof)).toMatchObject({held:true});
 await db.query("update refund_operations set status='completed',stripe_refund_id='re_legacy',stripe_application_fee_refund_id='fr_legacy',stripe_application_fee_refund_amount_cents=application_fee_refund_amount_cents where id=$1",[id(91)]);
 const bound=await begin(id(97)),transport=sharedCashOriginalFixture(bound.source),proof=await readSharedCashOriginal({...early.c,stripe:{rawRequest:transport.raw}},bound.source);
 expect(await complete(proof,id(97))).toMatchObject({held:false});expect(await liability()).toBe(0);
});

test("service-role execution uses named grants, private history and invoker authority",async()=>{
 await legacy();await db.exec("set role service_role");const {proof}=await observation();expect(await complete(proof)).toMatchObject({held:false});await db.exec("set constraints all immediate");
 await denied(()=>db.exec("update sales_team_shared_cash_checks_v1 set source='{}'"),/permission denied|immutable/i);
 const functions=await db.query<{definer:boolean}>("select prosecdef definer from pg_proc where oid='public.complete_sales_team_shared_cash_check_v1(uuid,uuid,uuid,jsonb)'::regprocedure");expect(functions.rows).toEqual([{definer:false}]);
});

test("known tip restoration releases only its observed platform transfer debit",async()=>{
 await db.query("insert into tips(id,creator_id,stripe_destination_account_id,currency) values($1,$2,'acct_legacy','usd')",[id(92),id(1)]);
 await f.rpc("record_tip_dispute_with_cash_v1",["dp_legacy",id(92),"pi_legacy","ch_legacy","tr_legacy",500,1000,500,"under_review"]);
 await db.exec("update tips set dispute_status='won';update tip_dispute_recoveries set restoration_status='succeeded',restoration_transfer_id='tr_restored'");
 const begun=await f.rpc<{source:SharedCashOriginal}>("begin_sales_team_shared_cash_check_v1",[id(96),"tip_restoration","dp_legacy",id(29),null,f.contract.context]),transport=sharedCashOriginalFixture(begun.source);
 const proof=await readSharedCashOriginal({context:f.contract.context,observeContext:async()=>f.contract.context,stripe:{rawRequest:transport.raw}},begun.source);
 expect(await complete(proof)).toMatchObject({held:false});expect(await liability()).toBe(0);await db.exec("set constraints all immediate");expect(proof).not.toHaveProperty("bankPayoutStatus");
});

test("non-admin readers and expired or wrong-kind workers cannot begin",async()=>{
 await legacy();await denied(()=>begin(id(96),id(1)),/READER_REQUIRED/);
 await db.query("insert into sales_team_worker_runs_v1(id,kind,scheduled_slot,lease_until,status) values($1,'settlement',now(),now()+interval '5 minutes','running')",[id(94)]);
 await denied(()=>begin(id(96),null,id(94)),/READER_REQUIRED/);
 await db.query("update sales_team_worker_runs_v1 set kind='reconciliation',lease_until=now()-interval '1 second' where id=$1",[id(94)]);await denied(()=>begin(id(96),null,id(94)),/READER_REQUIRED/);
});

test("private check history refuses authenticated access and mutation",async()=>{
 await legacy();await begin();await denied(()=>db.exec("delete from sales_team_shared_cash_checks_v1"),/immutable/i);
 await db.exec("set role authenticated");await denied(()=>db.exec("select * from sales_team_shared_cash_checks_v1"),/permission denied/i);await denied(()=>begin(),/permission denied/i);
});

test("candidate installation is atomic through the final named function grant",async()=>{
 const isolated=await sharedCashDatabase(createLocalPostgres());try{
  const original=(await isolated.query("select pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure) source")).rows;
  const sql=readFileSync(sharedCashReconciliationCandidate,"utf8"),fault=sql.replace("end $grants$;","end $grants$;grant execute on function public.missing_resolution_final_grant() to service_role;");expect(fault).not.toBe(sql);
  await expect(isolated.exec(fault)).rejects.toThrow(/missing_resolution_final_grant/);await isolated.exec("rollback");
  expect((await isolated.query("select to_regclass('sales_team_shared_cash_checks_v1') checks")).rows).toEqual([{checks:null}]);expect((await isolated.query("select pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure) source")).rows).toEqual(original);
 }finally{await isolated.close();}
},30000);
