/** @jest-environment ./test-support/pglite-environment.cjs */
import {installSignedSurplusEventsFixture} from "@/test-support/sales-team-surplus-events-schema";
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {sharedCashDatabase,sharedCashReconciliationCandidate} from "@/test-support/sales-team-shared-cash-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {teamCashBalanceFixture} from "@/test-support/sales-team-cash-postgres";
import {inspectTeamReceiptFinancials} from "@/lib/salesTeams/financialChecks";
import {reserveTeamEarnedTransfer,validateTeamTransferRequest,type TeamTransferRequest} from "@/lib/salesTeams/transferReservations";
import {fundTeamAdminRefund} from "@/lib/salesTeams/cashFunding";
import {teamTransferReservationsReady} from "@/lib/salesTeams/policy";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261023180144_sales_team_transfer_reservations.sql";
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,c:TeamReceiptComposition,receiptId:string,raw:jest.Mock;
let advanceClock:(milliseconds:number)=>Promise<void>;
beforeAll(async()=>{
 db=createLocalPostgres();advanceClock=await installTeamLocalClock(db);await sharedCashDatabase(db);
 for(const path of [sharedCashReconciliationCandidate,"supabase/migrations/20261023042321_sales_team_retained_refund_funding.sql","supabase/migrations/20261023060912_sales_team_automatic_recovery.sql","supabase/migrations/20261023063905_sales_team_worker_refund_recovery.sql","supabase/migrations/20261023174324_sales_team_no_outbound_shared_recovery.sql",candidate,"supabase/migrations/20261023182527_sales_team_transfer_observations.sql","supabase/migrations/20261023184139_sales_team_transfer_execution.sql","supabase/migrations/20261023190044_sales_team_automatic_settlement.sql","supabase/migrations/20261024210829_sales_team_transfer_reversal_observations.sql","supabase/migrations/20261024213841_sales_team_transfer_recovery_reservations.sql","supabase/migrations/20261024215948_sales_team_transfer_recovery_execution.sql","supabase/migrations/20261025184802_sales_team_transfer_reversal_recovery.sql","supabase/migrations/20261025191826_sales_team_combined_settlement.sql","supabase/migrations/20261025195351_sales_team_later_collection.sql","supabase/migrations/20261026185425_sales_team_payment_lifecycle.sql","supabase/migrations/20261026193046_sales_team_expired_collection_retry.sql","supabase/migrations/20261027021620_sales_team_saved_method_authority.sql","supabase/migrations/20261027024721_sales_team_automatic_collection.sql","supabase/migrations/20261027232440_sales_team_protected_daily_surplus.sql","supabase/migrations/20261028000209_sales_team_surplus_execution.sql","supabase/migrations/20261028222238_sales_team_surplus_recovery.sql"])await db.exec(readFileSync(path,"utf8"));
await installSignedSurplusEventsFixture(db);},30000);
beforeEach(async()=>{await db.exec("begin");});afterEach(async()=>{await db.exec("rollback;reset role");jest.restoreAllMocks();});afterAll(async()=>{await db?.close();});
async function fixture(){
 await db.exec("update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true,cash_reservations_enabled=true,settlement_enabled=true,transfer_reservations_enabled=true,transfer_observations_enabled=true,transfer_execution_enabled=true");
 f=await seedTeamCapture(db);f.base.balance.available_on=Math.floor(Date.now()/1000);f.base.balance.status="available";receiptId=String((await f.record()).id);await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,transfer_cost_reserve_cents=30,evidence='{\"scope\":\"synthetic settlement fixture only\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1(),retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1(),transfer_contract_sha256=creatornet_team_private.transfer_contract_digest_v1()");
 let sequence=0;raw=jest.fn(async(method:string,path:string)=>{
  if(method!=="GET")throw Error("Reservation fixture permits GET only");const value=path==="/v1/balance"?teamCashBalanceFixture:path==="/v1/payment_intents/pi_original"?f.base.paymentIntent:path==="/v1/charges/ch_original"?f.base.charge:path==="/v1/balance_transactions/txn_original"?f.base.balance:["/v1/refunds","/v1/disputes"].includes(path)?{object:"list",data:[],has_more:false}:null;
  if(!value)throw Error(path);return JSON.parse(JSON.stringify({...value,lastResponse:{requestId:`req_settlement${++sequence}`}}));
 });
 c={admin:teamSupabaseFixture(db),context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence,stripe:{rawRequest:raw}};
 await inspectTeamReceiptFinancials(c,receiptId,id(29));raw.mockClear();
}
type Run={runId:string;leaseToken:string};
const claim=()=>f.rpc<Run&{status:string}>("claim_sales_team_settlement_run_v1",[id(80),c.context]);
const reserve=(run:Run,beneficiary:"creator"|"closer"="creator",requestId=id(81),taskId=id(82))=>reserveTeamEarnedTransfer(c,{...run,taskId,requestId,receiptId,beneficiary});
const claimTransfer=(run:Run,q:TeamTransferRequest,taskId=id(82))=>f.rpc<{status:string;operation:{lease_token:string}}>("run_sales_team_transfer_execution_v1",[run.runId,run.leaseToken,c.context,taskId,"claim",{operationId:q.operation_id,scope:q.scope,request:q.request}]);
const denied=async(run:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(run()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};

test("the actual transfer reservation candidate installs default off with no commercial reserve default",async()=>{
 expect((await db.query("select transfer_reservations_enabled from sales_team_controls_v1")).rows).toEqual([{transfer_reservations_enabled:false}]);expect((await db.query("select transfer_cost_reserve_cents from sales_team_cash_policy_v1")).rows).toEqual([{transfer_cost_reserve_cents:null}]);
});
test("an earned creator share freezes the accepted recipient and charge-bound original without a provider POST",async()=>{
 await fixture();const run=await claim(),q=await reserve(run);expect(q.request).toMatchObject({method:"POST",path:"/v1/transfers",params:{destination:"acct_creator",source_transaction:"ch_original",transfer_group:`cn_team_${f.sale}`}});
 expect(q.scope).toMatchObject({actorId:null,workerRunId:run.runId});expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:30}]);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
 expect(await claimTransfer(run,q)).toMatchObject({status:"dispatch"});
});
test("commission remains held for the accepted 14-day period",async()=>{
 await fixture();const run=await claim();await denied(()=>reserve(run,"closer"),/CURRENT_EARNED_TRANSFER_SOURCE_REQUIRED/);expect((await db.query("select count(*)::int n from sales_team_transfer_requests_v1")).rows).toEqual([{n:0}]);
});

test("pending principal remains protected when a later financial adjustment reduces its unpaid share",async()=>{
 await fixture();const run=await claim(),q=await reserve(run);await claimTransfer(run,q);await db.exec("update sales_team_creator_balances_v1 set creator_proceeds_cents=creator_proceeds_cents-100");
 expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:130}]);
 expect(await f.rpc("sales_team_transfer_operation_admitted_v1",[q.scope,c.context])).toBe(false);
 expect((await db.query("select creator_released_cents::int n from sales_team_creator_balances_v1")).rows).toEqual([{n:0}]);
});

test("retained refunds cannot reuse a share already promised to a pending transfer",async()=>{
 await fixture();await reserve(await claim());await db.exec("update sales_team_controls_v1 set retained_refund_funding_enabled=true,refund_review_enabled=true,refund_dispatch_enabled=true");
 const revision=Number((await db.query<{r:number}>("select observation_revision r from sales_team_receipts_v1")).rows[0].r);
 const q=await f.rpc<{id:string}>("reserve_sales_team_refund_v1",[id(29),id(25),receiptId,revision,1000,"creator","creator_discretionary",c.context]);
 const checked=await inspectTeamReceiptFinancials(c,receiptId,id(29));await f.rpc("attach_sales_team_refund_check_v1",[id(29),q.id,checked.checkId]);await fundTeamAdminRefund(c,id(29),q.id);
 expect((await db.query("select retained_creator_cents::int creator,retained_commission_cents::int commission from sales_team_cash_reservations_v1")).rows).toEqual([{creator:0,commission:0}]);
 expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:1130}]);
});

test("the original immutable reservation replays without duplicating its source or cost hold",async()=>{
 await fixture();const run=await claim(),q=await reserve(run),replayed=await reserve(run);expect(replayed).toMatchObject({id:q.id,operation_id:q.operation_id,request:q.request,scope:q.scope});
 expect((await db.query("select count(*)::int n from sales_team_transfer_cash_reservations_v1")).rows).toEqual([{n:1}]);expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:30}]);
 await denied(()=>reserve(run,"creator",id(83),id(84)),/ORIGINAL_TRANSFER_REQUEST_REQUIRED/);
 await denied(()=>reserve(run,"creator",q.id,id(84)),/ORIGINAL_SETTLEMENT_TASK_CHANGED/);
});

test("an audited cancellation requires that no provider journal exists and invalidates older cash reads",async()=>{
 await fixture();const run=await claim();await reserve(run);await f.rpc("begin_sales_team_settlement_cash_v1",[run.runId,run.leaseToken,c.context,id(85)]);
 await f.rpc("cancel_unsent_sales_team_transfer_v1",[run.runId,run.leaseToken,c.context,id(82)]);expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:0}]);
 await denied(()=>f.rpc("complete_sales_team_settlement_cash_v1",[run.runId,run.leaseToken,c.context,id(85),{context:c.context,availableCents:1000000,firstRequestId:"req_oldFirst",secondRequestId:"req_oldSecond",readStartedAt:Date.now()}]),/FRESH_SETTLEMENT_CASH_REQUIRED/);
});

test("an admitted journal can never be relabeled as an unsent cancellation or silently release money",async()=>{
 await fixture();const run=await claim(),q=await reserve(run),journal=await claimTransfer(run,q);
 await f.rpc("mark_sales_team_provider_unknown_v1",[q.operation_id,journal.operation.lease_token]);
 await denied(()=>f.rpc("cancel_unsent_sales_team_transfer_v1",[run.runId,run.leaseToken,c.context,id(82)]),/ORIGINAL_TRANSFER_RECOVERY_REQUIRED/);
 expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:30}]);expect((await db.query("select count(*)::int n from sales_team_transfer_completions_v1")).rows).toEqual([{n:0}]);
});

test.each(["amount","destination","charge","group"])("a changed %s cannot replace the frozen original transfer POST",async change=>{
 await fixture();const q=await reserve(await claim()),request=JSON.parse(JSON.stringify(q.request));
 if(change==="amount")request.params.amount++;if(change==="destination")request.params.destination="acct_foreign";if(change==="charge")request.params.source_transaction="ch_foreign";if(change==="group")request.params.transfer_group="foreign";
 await denied(()=>f.rpc("claim_sales_team_provider_operation_v1",[q.operation_id,q.scope,c.context,request]),/ORIGINAL_EARNED_TRANSFER_REQUIRED/);
 expect(()=>validateTeamTransferRequest(c,{...q,request})).toThrow(/requires reconciliation/);
});

test.each(["account","ownership","payouts","stale","missing"])("recipient %s changes cannot redirect or admit settlement",async change=>{
 await fixture();const run=await claim();
 if(change==="account")await db.exec("update sales_team_recipients_v1 set account_id='acct_other' where account_id='acct_creator'");
 if(change==="ownership")await db.exec("update sales_team_recipients_v1 set ownership_verified=false");
 if(change==="payouts")await db.exec("update sales_team_recipients_v1 set payouts_ready=false");
 if(change==="stale")await db.exec("update sales_team_recipients_v1 set verified_at=clock_timestamp()-interval '16 minutes'");
 if(change==="missing")await db.exec("delete from sales_team_recipients_v1 where account_id='acct_creator'");
 await denied(()=>reserve(run),/CURRENT_EARNED_TRANSFER_SOURCE_REQUIRED/);expect((await db.query("select count(*)::int n from sales_team_transfer_requests_v1")).rows).toEqual([{n:0}]);
});

test("a forged earlier hold date does not bypass the accepted commission terms",async()=>{
 await fixture();await db.exec("update sales_team_commission_balances_v1 set hold_until=clock_timestamp()-interval '1 second'");
 const run=await claim();await denied(()=>reserve(run,"closer"),/CURRENT_EARNED_TRANSFER_SOURCE_REQUIRED/);
});

test("a one-cent liquidity shortfall preserves every other liability and creates no transfer reservation",async()=>{
 await fixture();const run=await claim();const needed=(await db.query<{n:number}>("select ((p->>'teamCents')::bigint+(p->'shared'->>'protectedCents')::bigint+(p->>'reserveCents')::bigint+creatornet_team_private.cash_encumbered_v1()+30)::int n from (select creatornet_team_private.cash_protection_v1($1) p) x",[c.context])).rows[0].n;
 const original=raw.getMockImplementation()!;raw.mockImplementation(async(...args)=>{const value=await original(...args);if(args[1]==="/v1/balance")value.available=[{currency:"usd",amount:needed-1,source_types:{card:needed-1}}];return value;});
 await denied(()=>reserve(run),/PROTECTED_PLATFORM_FUNDS_INSUFFICIENT/);expect((await db.query("select count(*)::int n from sales_team_transfer_requests_v1")).rows).toEqual([{n:0}]);
});

test("bound originals remain recoverable after new transfer admission is turned off",async()=>{
 await fixture();const run=await claim(),q=await reserve(run);await claimTransfer(run,q);await f.rpc("bind_sales_team_provider_operation_v1",[q.operation_id,"tr_original","req_originalPost",false]);
 await db.exec("update sales_team_controls_v1 set settlement_enabled=false,transfer_reservations_enabled=false");
 expect(await f.rpc("claim_sales_team_provider_operation_v1",[q.operation_id,q.scope,c.context,q.request])).toMatchObject({status:"bound",operation:{provider_id:"tr_original"}});
 expect((await db.query("select creator_released_cents::int n from sales_team_creator_balances_v1")).rows).toEqual([{n:0}]);
});

test("wrong workers, tokens and contexts cannot create a cash observation",async()=>{
 await fixture();const run=await claim();await denied(()=>reserve({...run,leaseToken:id(84)}),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);
 await denied(()=>f.rpc("begin_sales_team_settlement_cash_v1",[run.runId,run.leaseToken,{...c.context,mode:"live"},id(85)]),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);
 await db.query("update sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id=$1",[run.runId]);await denied(()=>reserve(run),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);
 expect((await db.query("select count(*)::int n from sales_team_cash_reads_v1")).rows).toEqual([{n:0}]);
});

test("the independently reviewed contract and explicit reserve are required before claiming a run",async()=>{
 await fixture();await db.exec("update sales_team_cash_policy_v1 set transfer_cost_reserve_cents=null");await denied(claim,/TRANSFER_CONTRACT_REVIEW_REQUIRED/);
 await db.exec("update sales_team_cash_policy_v1 set transfer_cost_reserve_cents=30,transfer_contract_sha256=null");await denied(claim,/TRANSFER_CONTRACT_REVIEW_REQUIRED/);
});

test("changed named liquidity proof code invalidates the current worker's reviewed contract",async()=>{
 await fixture();const run=await claim();
 await db.exec("create or replace function creatornet_team_private.cash_available_floor_v1(p_context jsonb,p_epoch jsonb) returns numeric language sql stable security invoker set search_path=pg_catalog as $$ select 999999999::numeric $$");
 await denied(()=>reserve(run),/CURRENT_SETTLEMENT_WORKER_REQUIRED/);
});

test("settlement history is immutable, ordinary roles are denied, and service callers cannot fabricate completion",async()=>{
 await fixture();await reserve(await claim());await denied(()=>db.exec("delete from sales_team_transfer_requests_v1"),/immutable/i);
 await db.exec("set role service_role");await denied(()=>db.query("insert into sales_team_transfer_completions_v1(request_id,transfer_id,balance_id,worker_run_id,proof) values($1,'tr_fake','txn_fake',$2,'{}')",[id(81),id(80)]),/permission denied/i);
 await db.exec("set role authenticated");await denied(claim,/permission denied/i);await denied(()=>db.exec("select * from sales_team_transfer_requests_v1"),/permission denied/i);
});

test("source readiness is separately default off and independent of new buyer admission",()=>{
 const env={CREATOR_SALES_TEAM_SCHEMA_READY:"true",CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY:"true",CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY:"true",CREATOR_TEAM_PAYMENT_SCHEMA_READY:"true",CREATOR_TEAM_RECEIPT_SCHEMA_READY:"true",CREATOR_TEAM_EVENT_SCHEMA_READY:"true",CREATOR_TEAM_FINANCIAL_SCHEMA_READY:"true",CREATOR_TEAM_REFUND_DISPATCH_SCHEMA_READY:"true",CREATOR_TEAM_CASH_SCHEMA_READY:"true",CREATOR_TEAM_SETTLEMENT_READY:"true"};
 expect(teamTransferReservationsReady(env)).toBe(false);const ready={...env,CREATOR_TEAM_TRANSFER_RESERVATIONS_SCHEMA_READY:"true",CREATOR_TEAM_TRANSFER_RESERVATIONS_READY:"true"};expect(teamTransferReservationsReady(ready)).toBe(true);expect(teamTransferReservationsReady({...ready,CREATOR_TEAM_TRANSFER_RESERVATIONS_SCHEMA_READY:"false"})).toBe(false);expect(teamTransferReservationsReady({...ready,CREATOR_TEAM_TRANSFER_RESERVATIONS_READY:"false"})).toBe(false);
});

test("unrecovered same-creator commission overpayment holds new creator proceeds",async()=>{
 await fixture();await db.exec("update sales_team_commission_balances_v1 set released_cents=earned_cents+1");const run=await claim();
 await denied(()=>reserve(run),/CURRENT_EARNED_TRANSFER_SOURCE_REQUIRED/);
});

test("a foreign balance cannot provide an unpaid-share offset for the original pending transfer",async()=>{
 await fixture();const run=await claim(),q=await reserve(run);await claimTransfer(run,q);await db.query("update sales_team_creator_balances_v1 set creator_id=$1",[id(3)]);
 expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:Number(q.amount_cents)+30}]);expect(await f.rpc("sales_team_transfer_operation_admitted_v1",[q.scope,c.context])).toBe(false);
});

test("service callers can reserve an earned share through the exact invoker grants",async()=>{
 await fixture();await db.exec("set role service_role");const run=await claim(),q=await reserve(run);await claimTransfer(run,q);
 expect(q.beneficiary).toBe("creator");expect(await f.rpc("sales_team_transfer_operation_admitted_v1",[q.scope,c.context])).toBe(true);
});

test("settlement slots do not overlap or replay after the original worker lease expires",async()=>{
 await fixture();await claim();expect(await f.rpc("claim_sales_team_settlement_run_v1",[id(83),c.context])).toEqual({status:"busy"});
 await db.query("update sales_team_worker_runs_v1 set lease_until=clock_timestamp()-interval '1 second' where id=$1",[id(80)]);
 expect(await f.rpc("claim_sales_team_settlement_run_v1",[id(83),c.context])).toEqual({status:"slot_consumed"});
});

test("a later actual worker re-observes the original without changing its original worker or POST",async()=>{
 await fixture();const q=await reserve(await claim());
 // Advance only the synthetic worker's recorded slot; no wall-clock or live job changes.
 await db.query("update sales_team_worker_runs_v1 set scheduled_slot=scheduled_slot-interval '15 minutes',lease_until=clock_timestamp()-interval '1 second' where id=$1",[id(80)]);
 const run=await f.rpc<Run>("claim_sales_team_settlement_run_v1",[id(83),c.context]);
 const replay=await reserve(run,"creator",q.id,id(84));expect(replay).toMatchObject({operation_id:q.operation_id,request:q.request,original_worker_run_id:id(80),scope:q.scope});await claimTransfer(run,replay,id(84));
 expect(await f.rpc("sales_team_transfer_operation_admitted_v1",[q.scope,c.context])).toBe(true);
 expect((await db.query("select count(*)::int n from sales_team_transfer_cash_rechecks_v1")).rows).toEqual([{n:2}]);
});

test("financial proof predating the current receipt observation and unavailable funds each hold settlement",async()=>{
 await fixture();const run=await claim();await db.exec("savepoint missing_check;update sales_team_receipts_v1 set observed_at=clock_timestamp()");
 await denied(()=>reserve(run),/CURRENT_EARNED_TRANSFER_SOURCE_REQUIRED/);await db.exec("rollback to savepoint missing_check");
 await db.exec("update sales_team_receipts_v1 set available_on=clock_timestamp()+interval '1 day'");
 await denied(()=>reserve(run),/CURRENT_EARNED_TRANSFER_SOURCE_REQUIRED/);
});

test("the original saved matured commission preserves departed-closer obligations",async()=>{
 await fixture();
 const offset=15*86400000,realNow=Date.now.bind(Date);jest.spyOn(Date,"now").mockImplementation(()=>realNow()+offset);await advanceClock(offset);
 await inspectTeamReceiptFinancials(c,receiptId,id(29));await db.exec("update sales_team_recipients_v1 set verified_at=clock_timestamp()");
 await db.exec("update sales_team_memberships_v1 set status='removed'");
 const run=await claim(),q=await reserve(run,"closer");expect(q.request.params).toMatchObject({destination:f.contract.terms.distribution.closerRecipientId,source_transaction:"ch_original"});
 expect(Number(q.amount_cents)).toBe(Number((await db.query<{n:string}>("select earned_cents n from sales_team_commission_balances_v1")).rows[0].n));
 expect((await db.query("select released_cents::int n from sales_team_commission_balances_v1")).rows).toEqual([{n:0}]);
});

test("a final-grant migration failure rolls back the candidate and preserves the prior cash contract",async()=>{
 const isolated=await sharedCashDatabase(createLocalPostgres());try{
  for(const path of [sharedCashReconciliationCandidate,"supabase/migrations/20261023042321_sales_team_retained_refund_funding.sql","supabase/migrations/20261023060912_sales_team_automatic_recovery.sql","supabase/migrations/20261023063905_sales_team_worker_refund_recovery.sql","supabase/migrations/20261023174324_sales_team_no_outbound_shared_recovery.sql"])await isolated.exec(readFileSync(path,"utf8"));
  const original=(await isolated.query("select pg_get_functiondef('creatornet_team_private.cash_encumbered_v1()'::regprocedure) source")).rows;
  const source=readFileSync(candidate,"utf8");expect(source.match(/commit;/g)).toHaveLength(1);
  await expect(isolated.exec(source.replace("commit;","grant execute on function public.missing_transfer_final_grant() to service_role;commit;"))).rejects.toThrow(/missing_transfer_final_grant/);
  await isolated.exec("rollback");expect((await isolated.query("select to_regclass('public.sales_team_transfer_requests_v1') relation")).rows).toEqual([{relation:null}]);
  expect((await isolated.query("select pg_get_functiondef('creatornet_team_private.cash_encumbered_v1()'::regprocedure) source")).rows).toEqual(original);
 }finally{await isolated.close();}
},30000);
