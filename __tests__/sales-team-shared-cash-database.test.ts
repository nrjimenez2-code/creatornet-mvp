/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {sharedCashDatabase,sharedCashCandidate} from "@/test-support/sales-team-shared-cash-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {teamCashBalanceFixture} from "@/test-support/sales-team-cash-postgres";
import {protectSharedCash} from "@/lib/salesTeams/cashFunding";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>,c:TeamReceiptComposition,raw:jest.Mock;
beforeAll(async()=>{db=await sharedCashDatabase(createLocalPostgres());},30000);
beforeEach(async()=>{
 await db.exec("begin;update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true,cash_reservations_enabled=true");
 f=await seedTeamCapture(db);await f.record();await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,evidence='{\"scope\":\"synthetic local shared cash fixture\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex')");
 let count=0;raw=jest.fn(async(method,path)=>{if(method!=="GET"||path!=="/v1/balance")throw Error("Shared cash fixture permits balance GET only");return {...structuredClone(teamCashBalanceFixture),lastResponse:{requestId:`req_shared${++count}`}};});
 c={admin:teamSupabaseFixture(db),stripe:{rawRequest:raw},context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence};
});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
const denied=async(run:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(run()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};
async function legacy(currency="usd"){
 await db.query("insert into payment_fee_ledger(id,creator_id,stripe_payment_intent_id,stripe_charge_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,creator_net_cents,currency,fee_schedule_version) values($1,$2,'pi_legacy','ch_legacy',10000,1200,320,1520,8480,$3,'fixture')",[id(90),id(1),currency]);
 return f.rpc<{id:string;customer_refund_amount_cents:number;application_fee_refund_amount_cents:number}>("create_refund_operation",[id(91),id(90),1000,"creator_discretionary","creator",null,"fixture-legacy-original",id(29),"ch_legacy","fee_legacy",0,0,320]);
}
async function tip(status="under_review",target=500){
 await db.query("insert into tips(id,creator_id,stripe_destination_account_id,currency) values($1,$2,'acct_legacy','usd') on conflict(id) do nothing",[id(92),id(1)]);
 return f.rpc<boolean>("record_tip_dispute_with_cash_v1",["dp_legacy",id(92),"pi_tipLegacy","ch_tipLegacy","tr_tipLegacy",500,1000,target,status]);
}
const shared=()=>db.query<{r:{protectedCents:number}}>("select creatornet_team_private.shared_platform_cash_liabilities_v1($1) r",[c.context]);
test("actual legacy refund principal and application-fee adjustment remain globally protected after terminal status",async()=>{
 const q=await legacy(),expected=Number(q.customer_refund_amount_cents)+Number(q.application_fee_refund_amount_cents)+100;
 expect((await shared()).rows[0].r.protectedCents).toBe(expected);
 await db.query("update refund_operations set status='completed',stripe_refund_status='succeeded',stripe_refund_id='re_legacy' where id=$1",[q.id]);
 expect((await shared()).rows[0].r.protectedCents).toBe(expected);
 expect((await db.query("select count(*)::int n from sales_team_shared_cash_commitments_v1")).rows).toEqual([{n:1}]);
});
test("the real legacy claim cannot bypass funding and admits only its exact current shared source",async()=>{
 const q=await legacy();await denied(()=>f.rpc("claim_refund_operation",[q.id,id(93),300]),/SHARED_REFUND_CASH_ADMISSION_REQUIRED/);
 await protectSharedCash(c,{kind:"legacy_refund",id:q.id},id(29));expect(await f.rpc("claim_refund_operation",[q.id,id(93),300])).toBe("claimed");
 expect(raw.mock.calls.every(([method,path])=>method==="GET"&&path==="/v1/balance")).toBe(true);
 await db.exec("update sales_team_controls_v1 set cash_reservations_enabled=false");
 await denied(()=>f.rpc("claim_refund_operation",[q.id,id(94),300]),/SHARED_REFUND_CASH_ADMISSION_REQUIRED/);
});
test("tip incoming recovery is recorded without spending, but old winning-event writers cannot restore unprotected money",async()=>{
 expect(await tip()).toBe(true);expect((await shared()).rows[0].r.protectedCents).toBe(550);
 await denied(()=>f.rpc("record_tip_dispute_recovery",["dp_legacy",id(92),"pi_tipLegacy","ch_tipLegacy","tr_tipLegacy",500,1001,0,"won"]),/SHARED_TIP_CASH_CONTRACT_REQUIRED/);
 expect(await tip("won",0)).toBe(false);
 await protectSharedCash(c,{kind:"tip_restoration",id:"dp_legacy"},null);
 expect(await tip("won",0)).toBe(true);
 expect((await db.query("select actor_id,source_kind from sales_team_cash_reads_v1")).rows).toEqual([{actor_id:null,source_kind:"tip_restoration"}]);
});
test("the current prevented-dispute status can record incoming recovery without a restoration POST",async()=>{
 expect(await tip("prevented")).toBe(true);expect((await db.query("select dispute_status from tips")).rows).toEqual([{dispute_status:"prevented"}]);expect(raw).not.toHaveBeenCalled();
});
test("shared liability changes invalidate a previously admitted outgoing source",async()=>{
 const q=await legacy();await protectSharedCash(c,{kind:"legacy_refund",id:q.id},id(29));expect(await f.rpc("sales_team_shared_cash_admitted_v1",["legacy_refund",q.id])).toBe(true);
 await tip();expect(await f.rpc("sales_team_shared_cash_admitted_v1",["legacy_refund",q.id])).toBe(false);
 await denied(()=>f.rpc("claim_refund_operation",[q.id,id(93),300]),/SHARED_REFUND_CASH_ADMISSION_REQUIRED/);
});
test("an independently observed shortage holds a shared refund without a provider POST",async()=>{
 const q=await legacy();raw.mockImplementation(async()=>({...structuredClone(teamCashBalanceFixture),available:[{currency:"usd",amount:100,source_types:{card:100}}],lastResponse:{requestId:"req_sharedLow"}}));
 await denied(()=>protectSharedCash(c,{kind:"legacy_refund",id:q.id},id(29)),/PROTECTED_PLATFORM_FUNDS_INSUFFICIENT/);
 expect((await db.query("select count(*)::int n from sales_team_shared_cash_admissions_v1")).rows).toEqual([{n:0}]);
});
test("non-admin and impersonated shared readers cannot authorize outgoing money",async()=>{
 const q=await legacy();await denied(()=>protectSharedCash(c,{kind:"legacy_refund",id:q.id},id(1)),/SHARED_CASH_ACTOR_REQUIRED/);
 await tip();await denied(()=>protectSharedCash(c,{kind:"tip_restoration",id:"dp_legacy"},id(29)),/SHARED_CASH_ACTOR_REQUIRED/);
 expect(raw).not.toHaveBeenCalled();
});
test("missing explicit shared fee reserves cannot be replaced with assumed zero costs",async()=>{
 const q=await legacy();await db.exec("update sales_team_cash_policy_v1 set legacy_refund_cost_reserve_cents=null");
 await denied(()=>protectSharedCash(c,{kind:"legacy_refund",id:q.id},id(29)),/SHARED_PLATFORM_CASH_COVERAGE_REQUIRED/);expect(raw).not.toHaveBeenCalled();
});
test("unsupported shared currencies preserve the legacy source and hold new cash admission",async()=>{
 const q=await legacy("eur");expect((await db.query("select currency from refund_operations where id=$1",[q.id])).rows).toEqual([{currency:"eur"}]);
 await denied(shared,/SHARED_PLATFORM_CASH_COVERAGE_REQUIRED/);
});
test("missing trigger coverage and changed original identities cannot become zero protected balances",async()=>{
 const q=await legacy();await denied(()=>db.query("update refund_operations set stripe_charge_id='ch_changed' where id=$1",[q.id]),/ORIGINAL_SHARED_CASH_SOURCE_CHANGED/);
 await denied(()=>db.exec("delete from refund_operations"),/SHARED_CASH_HISTORY_IS_IMMUTABLE/);
 await db.exec("alter table refund_operations disable trigger sales_team_shared_refund_cash_v1");
 await denied(shared,/SHARED_PLATFORM_CASH_COVERAGE_REQUIRED/);
});
test("shared commitments and admissions are private immutable service history",async()=>{
 await legacy();await denied(()=>db.exec("delete from sales_team_shared_cash_commitments_v1"),/immutable/i);
 await db.exec("set role authenticated");await denied(()=>db.exec("select * from sales_team_shared_cash_commitments_v1"),/permission denied/i);await db.exec("reset role");
});
test("the complete shared candidate rolls back after a failure at its final sequence grant",async()=>{
 const isolated=await sharedCashDatabase(createLocalPostgres(),false);try{
  const original=(await isolated.query("select pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure) source")).rows;
  const source=readFileSync(sharedCashCandidate,"utf8"),fault=source.replace("public.sales_team_shared_cash_commitments_v1_version_seq to service_role","public.unknown_final_shared_cash_sequence to service_role");
  expect(fault).not.toBe(source);await expect(isolated.exec(fault)).rejects.toThrow(/unknown_final_shared_cash_sequence/);await isolated.exec("rollback");
  expect((await isolated.query("select to_regclass('sales_team_shared_cash_commitments_v1') commitments,to_regprocedure('claim_refund_operation_before_team_cash_v1(uuid,uuid,integer)')::text wrapper")).rows).toEqual([{commitments:null,wrapper:null}]);
  expect((await isolated.query("select pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure) source")).rows).toEqual(original);
 }finally{await isolated.close();}
},30000);

test("optional exact-context cash phases delegate the existing guard and bind its original ledger",async()=>{
 const isolated=await sharedCashDatabase(createLocalPostgres(),false);try{
  // A supplied guard port isolates wrapper delegation. The full historical
  // context/receipt guard has its own existing integration suite; this fixture
  // does not establish installation compatibility with that whole schema.
  await isolated.exec(`create function public.run_exact_context_admin_refund_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_ledger_id uuid,p_phase text,p_payload jsonb)
   returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$declare saved jsonb;begin
    if p_reservation_id<>'${id(95)}'::uuid or p_phase<>'read' or not exists(select 1 from public.profiles where id=p_actor_id and role='admin') or
     not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'SUPPLIED_CONTEXT_GUARD_REFUSED';end if;
    select to_jsonb(o) into saved from public.refund_operations o where o.id=(p_payload->>'operationId')::uuid and o.payment_fee_ledger_id=p_ledger_id;
    if saved is null then raise exception 'SUPPLIED_CONTEXT_GUARD_REFUSED';end if;return saved;end $$;`);
  await isolated.exec(readFileSync(sharedCashCandidate,"utf8"));
  await isolated.exec("update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true,cash_reservations_enabled=true");
  const seeded=await seedTeamCapture(isolated);await seeded.record();await isolated.query("update profiles set role='admin' where id=$1",[id(29)]);
  await isolated.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,evidence='{\"scope\":\"synthetic context-wrapper fixture\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex')");
  await isolated.query("insert into payment_fee_ledger(id,creator_id,stripe_payment_intent_id,stripe_charge_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,creator_net_cents,currency,fee_schedule_version) values($1,$2,'pi_legacy','ch_legacy',10000,1200,320,1520,8480,'usd','fixture')",[id(90),id(1)]);
  await seeded.rpc("create_refund_operation",[id(91),id(90),1000,"creator_discretionary","creator",null,"fixture-legacy-original",id(29),"ch_legacy","fee_legacy",0,0,320]);
  const call=(actor:string,phase:string,payload:unknown,ledgerId=id(90))=>seeded.rpc("run_exact_context_admin_refund_v2",[id(95),actor,seeded.contract.context,ledgerId,phase,payload]);
  const request={operationId:id(91),readId:id(96)};
  await expect(call(id(1),"cash_begin",request)).rejects.toThrow(/SUPPLIED_CONTEXT_GUARD_REFUSED/);
  await expect(call(id(29),"cash_begin",request,id(97))).rejects.toThrow(/SUPPLIED_CONTEXT_GUARD_REFUSED/);
  expect(await call(id(29),"cash_begin",request)).toBe(true);
  expect(await call(id(29),"cash_complete",{...request,proof:{context:seeded.contract.context,availableCents:1000000,firstRequestId:"req_exactCashFirst",secondRequestId:"req_exactCashSecond",readStartedAt:Date.now()}})).toBe(true);
  expect(await call(id(29),"cash_admit",request)).toBe(true);expect(await call(id(29),"cash_assert",request)).toBe(true);
  await isolated.exec("update sales_team_controls_v1 set cash_reservations_enabled=false");
  await expect(call(id(29),"cash_assert",request)).rejects.toThrow(/SHARED_REFUND_CASH_ADMISSION_REQUIRED/);
 }finally{await isolated.close();}
},30000);
