/** @jest-environment ./test-support/pglite-environment.cjs */
import {installSignedSurplusEventsFixture} from "@/test-support/sales-team-surplus-events-schema";
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {savedMethodDatabase} from "@/test-support/sales-team-saved-method-postgres";
import {seedTeamCapture,captureRpc} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {reserveTeamDailySurplus} from "@/lib/salesTeams/surplusReservations";
import {teamSurplusReservationsReady,teamSurplusReservationsSchemaReady} from "@/lib/salesTeams/policy";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";

declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261027232440_sales_team_protected_daily_surplus.sql";
let db:PGlite,advance:(ms:number)=>Promise<void>;
const rpc=<T=Record<string,unknown>>(name:string,args:unknown[]=[])=>captureRpc<T>(db,name,args);
beforeAll(async()=>{
 db=createLocalPostgres();advance=await installTeamLocalClock(db);await savedMethodDatabase(db);
 await db.exec(readFileSync("supabase/migrations/20261027024721_sales_team_automatic_collection.sql","utf8"));
 const columns=await db.query<{column_name:string}>("select column_name from information_schema.columns where table_schema='public' and table_name='sales_team_cash_reads_v1'");
 expect(columns.rows.map(r=>r.column_name)).toContain("settlement_worker_run_id");
 await db.exec(readFileSync(candidate,"utf8"));await db.exec(readFileSync("supabase/migrations/20261028000209_sales_team_surplus_execution.sql","utf8"));await db.exec(readFileSync("supabase/migrations/20261028222238_sales_team_surplus_recovery.sql","utf8"));
await installSignedSurplusEventsFixture(db);},30000);
beforeEach(async()=>{await db.exec("begin");});afterEach(async()=>{await db.exec("rollback;reset role");jest.restoreAllMocks();});afterAll(async()=>{await db?.close();});

async function fixture(available=1000000){
 await db.exec("update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true");
 const f=await seedTeamCapture(db);await f.record();
 await db.exec("update sales_team_controls_v1 set cash_reservations_enabled=true,surplus_reservations_enabled=true");
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,transfer_cost_reserve_cents=30,evidence='{\"scope\":\"synthetic surplus fixture only\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1(),retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1(),transfer_contract_sha256=creatornet_team_private.transfer_contract_digest_v1()");
 await db.query("update sales_team_surplus_policy_v1 set context=$1,destination_id='ba_fixture',minimum_cents=50,maximum_cents=5000,cost_reserve_cents=20,prerequisites_verified=true,evidence='{\"scope\":\"synthetic only; no bank approval\"}',contract_sha256=creatornet_team_private.surplus_contract_digest_v1()",[f.contract.context]);
 let sequence=0;const raw=jest.fn(async(method:string,path:string)=>{if(method!=="GET"||path!=="/v1/balance")throw Error("Surplus reservation permits only balance GETs");return {object:"balance",livemode:false,available:[{currency:"usd",amount:available,source_types:{card:available}}],pending:[],lastResponse:{requestId:`req_surplus${++sequence}`}};});
 const c={admin:teamSupabaseFixture(db),context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence,stripe:{rawRequest:raw}} as unknown as TeamReceiptComposition;
 const claim=(runId=id(200),admitNew=true)=>rpc<{status:string;runId:string;leaseToken:string}>("claim_sales_team_surplus_run_v1",[runId,c.context,admitNew]);
 return {f,c,raw,claim};
}

test("surplus policy and new reservations independently default off without a bank destination",async()=>{
 expect(teamSurplusReservationsReady({})).toBe(false);expect(teamSurplusReservationsSchemaReady({})).toBe(false);
 expect((await db.query("select surplus_reservations_enabled from sales_team_controls_v1")).rows).toEqual([{surplus_reservations_enabled:false}]);
 expect((await db.query("select destination_id,minimum_cents,maximum_cents,cost_reserve_cents,prerequisites_verified from sales_team_surplus_policy_v1")).rows).toEqual([{destination_id:null,minimum_cents:null,maximum_cents:null,cost_reserve_cents:null,prerequisites_verified:false}]);
});

test("a daily reservation freezes the exact approved bank and protects principal and cost without any POST",async()=>{
 const h=await fixture(),run=await h.claim();expect(run.status).toBe("claimed");
 const prepared=await reserveTeamDailySurplus(h.c,{...run,requestId:id(201)});expect(prepared).toMatchObject({status:"new",request:{amount_cents:5000,cost_reserve_cents:20,destination_id:"ba_fixture",operation:null,resolved:false}});
 if(!("request" in prepared))throw Error("Missing surplus reservation");const q=prepared.request;
 expect(q.request).toMatchObject({method:"POST",path:"/v1/payouts",params:{amount:5000,currency:"usd",destination:"ba_fixture",method:"standard",source_type:"card"}});
 expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:5020}]);expect(h.raw).toHaveBeenCalledTimes(2);expect(h.raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
 expect(await rpc("claim_sales_team_provider_operation_v1",[q.operation_id,q.scope,h.c.context,q.request])).toEqual({status:"not_enabled"});
 expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1 where kind='withdrawal'")).rows).toEqual([{n:0}]);
 expect(await reserveTeamDailySurplus(h.c,{...run,requestId:q.id})).toMatchObject({status:"new",request:{id:q.id,request:q.request}});expect(h.raw).toHaveBeenCalledTimes(2);
 expect(await rpc("finish_sales_team_surplus_run_v1",[run.runId,run.leaseToken,h.c.context,false])).toEqual({status:"review_required"});
 expect(await h.claim(id(202))).toEqual({status:"slot_consumed"});
 await advance(24*3600000);const next=await h.claim(id(203),false);expect(next.status).toBe("claimed");expect(await reserveTeamDailySurplus(h.c,{...next,requestId:id(204)})).toMatchObject({status:"original",request:{id:q.id,original_worker_run_id:run.runId,request:q.request}});expect(h.raw).toHaveBeenCalledTimes(2);
});

const denied=async(action:()=>Promise<unknown>,pattern:RegExp)=>{await db.exec("savepoint denied_surplus");try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied_surplus");}};
type Harness=Awaited<ReturnType<typeof fixture>>;
type Run=Awaited<ReturnType<Harness["claim"]>>;
const protection=async(h:Harness)=>(await db.query<{p:{teamCents:number;shared:{protectedCents:number};reserveCents:number;epoch:number}}>("select creatornet_team_private.cash_protection_v1($1) p",[h.c.context])).rows[0].p;
const beginCash=(h:Harness,run:Run,readId=id(250))=>rpc("begin_sales_team_surplus_cash_v1",[run.runId,run.leaseToken,h.c.context,readId]);
const completeCash=(h:Harness,run:Run,availableCents:number,extra:Record<string,unknown>={},readId=id(250))=>rpc("complete_sales_team_surplus_cash_v1",[run.runId,run.leaseToken,h.c.context,readId,{context:h.c.context,availableCents,firstRequestId:"req_f40first",secondRequestId:"req_f40second",readStartedAt:Date.now(),...extra}]);
const prepareCash=(h:Harness,run:Run,requestId=id(251),readId=id(250))=>rpc("prepare_sales_team_surplus_v1",[run.runId,run.leaseToken,h.c.context,requestId,readId]);

test("server-derived surplus protects held commission, all creator proceeds, shared tip commitments and explicit reserves",async()=>{
 const h=await fixture();await db.exec("update sales_team_surplus_policy_v1 set maximum_cents=1000000");
 await db.query("insert into tips(id,creator_id,stripe_destination_account_id,currency) values($1,$2,'acct_legacy','usd')",[id(92),id(1)]);
 await h.f.rpc("record_tip_dispute_with_cash_v1",["dp_legacy",id(92),"pi_legacy","ch_legacy","tr_legacy",500,1000,500,"under_review"]);
 const p=await protection(h),run=await h.claim(),prepared=await reserveTeamDailySurplus(h.c,{...run,requestId:id(201)});
 expect(p.teamCents).toBeGreaterThan(0);expect(p.shared.protectedCents).toBeGreaterThan(0);
 expect(prepared).toMatchObject({status:"new",request:{amount_cents:1000000-p.teamCents-p.shared.protectedCents-p.reserveCents-20}});
 expect((await db.query("select bool_and(hold_until>clock_timestamp()) held,sum(earned_cents)::int earned,sum(released_cents)::int released from sales_team_commission_balances_v1")).rows[0]).toMatchObject({held:true,released:0});
});

test.each([49,50])("the approved minimum is enforced at the exact %i-cent boundary after every obligation",async free=>{
 const h=await fixture(),p=await protection(h),run=await h.claim();await beginCash(h,run);await completeCash(h,run,p.teamCents+p.shared.protectedCents+p.reserveCents+20+free);
 const result=await prepareCash(h,run);expect(result).toMatchObject(free===49?{status:"insufficient_surplus"}:{status:"new",request:{amount_cents:50}});
 expect((await db.query("select count(*)::int n from sales_team_surplus_requests_v1")).rows).toEqual([{n:free===49?0:1}]);expect(h.raw).not.toHaveBeenCalled();
});

test("the lowest current shared cash observation bounds a newer higher surplus read",async()=>{
 const h=await fixture(),p=await protection(h);await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await rpc("begin_sales_team_cash_read_v1",[id(260),id(29),h.c.context]);
 await rpc("complete_sales_team_cash_read_v1",[id(260),id(29),{context:h.c.context,availableCents:p.teamCents+p.shared.protectedCents+p.reserveCents+70,firstRequestId:"req_adminfirst",secondRequestId:"req_adminsecond",readStartedAt:Date.now()}]);
 const run=await h.claim();expect(await reserveTeamDailySurplus(h.c,{...run,requestId:id(201)})).toMatchObject({status:"new",request:{amount_cents:50}});
});

test.each(["destination_id=null","cost_reserve_cents=null","prerequisites_verified=false","evidence='null'::jsonb","contract_sha256=null"])("unapproved policy %s cannot consume a daily slot",async change=>{
 const h=await fixture();await db.exec(`update sales_team_surplus_policy_v1 set ${change}`);expect(await h.claim()).toEqual({status:"held"});
 expect((await db.query("select count(*)::int n from sales_team_worker_runs_v1 where kind='surplus'")).rows).toEqual([{n:0}]);expect(h.raw).not.toHaveBeenCalled();
});

test("policy changes after independent cash observation invalidate its exact protection snapshot",async()=>{
 const h=await fixture(),run=await h.claim();await beginCash(h,run);await completeCash(h,run,1000000);await db.exec("update sales_team_surplus_policy_v1 set destination_id='ba_changed',revision=revision+1");
 await denied(()=>prepareCash(h,run),/FRESH_TEAM_SURPLUS_CASH_REQUIRED/);expect((await db.query("select count(*)::int n from sales_team_surplus_requests_v1")).rows).toEqual([{n:0}]);
});

test("late control loss holds a fresh reservation instead of spending a prior cash read",async()=>{
 const h=await fixture(),run=await h.claim();await beginCash(h,run);await completeCash(h,run,1000000);await db.exec("update sales_team_controls_v1 set surplus_reservations_enabled=false");
 expect(await prepareCash(h,run)).toEqual({status:"held"});expect((await db.query("select count(*)::int n from sales_team_surplus_requests_v1")).rows).toEqual([{n:0}]);
});

test("the cash window expires before the longer worker lease",async()=>{
 const h=await fixture(),run=await h.claim();await beginCash(h,run);await completeCash(h,run,1000000);await advance(26000);
 await denied(()=>prepareCash(h,run),/FRESH_TEAM_SURPLUS_CASH_REQUIRED/);expect((await db.query("select count(*)::int n from sales_team_surplus_requests_v1")).rows).toEqual([{n:0}]);
});

test.each(["lease","context","expired"])("%s mismatch cannot obtain new cash authority",async fault=>{
 const h=await fixture(),run=await h.claim();if(fault==="expired")await advance(91000);
 await denied(()=>rpc("begin_sales_team_surplus_cash_v1",[run.runId,fault==="lease"?id(299):run.leaseToken,fault==="context"?{...h.c.context,platformAccountId:"acct_foreign"}:h.c.context,id(250)]),/CURRENT_TEAM_SURPLUS_WORKER_REQUIRED/);
});

test.each([0.5,9007199254740992])("cash proof cannot round or accept unsupported %s cents",async cents=>{
 const h=await fixture(),run=await h.claim();await beginCash(h,run);await denied(()=>completeCash(h,run,cents),/FINANCIAL_INTEGER_REQUIRED: availableCents/);
 expect((await db.query("select count(*)::int n from sales_team_cash_observations_v1")).rows).toEqual([{n:0}]);
});

test("one provider request cannot masquerade as both independent cash reads",async()=>{
 const h=await fixture(),run=await h.claim();await beginCash(h,run);await denied(()=>completeCash(h,run,1000000,{secondRequestId:"req_f40first"}),/FRESH_TEAM_SURPLUS_CASH_REQUIRED/);
});

test("a busy run and a different request ID cannot duplicate the reserved original",async()=>{
 const h=await fixture(),run=await h.claim();expect(await h.claim(id(280))).toEqual({status:"busy"});
 const first=await reserveTeamDailySurplus(h.c,{...run,requestId:id(201)});expect(first.status).toBe("new");
 await denied(()=>reserveTeamDailySurplus(h.c,{...run,requestId:id(202)}),/ORIGINAL_TEAM_SURPLUS_REQUEST_REQUIRED/);
 expect((await db.query("select count(*)::int n from sales_team_surplus_requests_v1")).rows).toEqual([{n:1}]);
});

const tables=["sales_team_surplus_policy_v1","sales_team_surplus_runs_v1","sales_team_surplus_requests_v1","sales_team_surplus_tasks_v1","sales_team_surplus_resolutions_v1"];
test.each(["anon","authenticated","service_role"])("%s cannot forge surplus policy, reservations or money-return completion",async role=>{
 const h=await fixture();for(const table of tables)expect((await db.query("select relrowsecurity rls from pg_class where oid=$1::regclass",[`public.${table}`])).rows).toEqual([{rls:true}]);
 await db.exec(`set role ${role}`);for(const table of tables)await denied(()=>db.exec(`insert into public.${table} default values`),/permission denied/i);
 if(role!=="service_role")await denied(()=>h.claim(),/permission denied/i);
});

test("the original policy, destination, principal and run authority cannot be rewritten",async()=>{
 const h=await fixture(),run=await h.claim();await reserveTeamDailySurplus(h.c,{...run,requestId:id(201)});
 await denied(()=>db.exec("update sales_team_surplus_requests_v1 set amount_cents=1"),/IMMUTABLE/);
 await denied(()=>db.exec("update sales_team_surplus_requests_v1 set destination_id='ba_changed'"),/IMMUTABLE/);
 await denied(()=>db.exec("update sales_team_surplus_runs_v1 set allow_new=false"),/IMMUTABLE/);
 await denied(()=>db.exec("delete from sales_team_surplus_requests_v1"),/IMMUTABLE/);
 expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:5020}]);
});

test.each(["creatornet_team_private.cash_encumbered_before_transfers_v1()","creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)","creatornet_team_private.cash_protection_before_surplus_v1(jsonb)","public.prepare_sales_team_surplus_v1(uuid,uuid,jsonb,uuid,uuid)"])("surplus binds inherited and current financial authority %s",async signature=>{
 const h=await fixture(),before=(await db.query<{d:string}>("select creatornet_team_private.surplus_contract_digest_v1() d")).rows[0].d;
 const definition=(await db.query<{s:string}>("select pg_get_functiondef($1::regprocedure) s",[signature])).rows[0].s;
 await db.exec(definition.replace(/AS \$function\$/i,"AS $function$\n-- synthetic surplus authority mutation\n"));
 expect((await db.query<{d:string}>("select creatornet_team_private.surplus_contract_digest_v1() d")).rows[0].d).not.toBe(before);
 expect(await rpc("claim_sales_team_surplus_run_v1",[id(200),h.c.context,true])).toEqual({status:"held"});
});

test("named cash wrappers and surplus functions retain service-only execution",async()=>{
 for(const signature of ["creatornet_team_private.cash_protection_v1(jsonb)","creatornet_team_private.cash_encumbered_v1()","creatornet_team_private.surplus_policy_ready_v1(jsonb)","public.claim_sales_team_surplus_run_v1(uuid,jsonb,boolean)","public.prepare_sales_team_surplus_v1(uuid,uuid,jsonb,uuid,uuid)"]){
  for(const role of ["anon","authenticated"])expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,signature])).rows).toEqual([{allowed:false}]);
  expect((await db.query("select has_function_privilege('service_role',$1,'EXECUTE') allowed",[signature])).rows).toEqual([{allowed:true}]);
 }
});

test.each(["dependency","late_grant"])("%s failure restores policy, cash definitions, columns and original permissions",async fault=>{
 const isolated=createLocalPostgres();try{
  await savedMethodDatabase(isolated);await isolated.exec(readFileSync("supabase/migrations/20261027024721_sales_team_automatic_collection.sql","utf8"));
  if(fault==="dependency")await isolated.exec("alter function creatornet_team_private.cash_encumbered_v1() rename to fixture_missing_surplus_cash");
  const names=[fault==="dependency"?"fixture_missing_surplus_cash":"cash_encumbered_v1","cash_protection_v1","transfer_contract_digest_v1","shared_cash_contract_digest_v1","retained_cash_contract_digest_v1","recovery_contract_digest_v1"],inventory=async()=>(await isolated.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) body,proacl::text grants from pg_proc where pronamespace in ('public'::regnamespace,'creatornet_team_private'::regnamespace) and proname=any($1::text[]) order by oid",[names])).rows;
  const columns=async()=>(await isolated.query("select table_name,column_name,column_default from information_schema.columns where table_schema='public' and table_name in ('sales_team_controls_v1','sales_team_cash_reads_v1') order by table_name,ordinal_position")).rows;
  const before=await inventory(),oldColumns=await columns(),sql=readFileSync(candidate,"utf8");
  await expect(isolated.exec(fault==="late_grant"?sql.replace("commit;","grant execute on function public.missing_surplus_final_grant() to service_role;commit;"):sql)).rejects.toThrow(fault==="dependency"?/cash_encumbered_v1/:/missing_surplus_final_grant/);
  await isolated.exec("rollback");expect(await inventory()).toEqual(before);expect(await columns()).toEqual(oldColumns);
  expect((await isolated.query("select to_regclass('public.sales_team_surplus_policy_v1') policy,to_regprocedure('creatornet_team_private.cash_protection_before_surplus_v1(jsonb)') alias")).rows).toEqual([{policy:null,alias:null}]);
 }finally{await isolated.close();}
});
