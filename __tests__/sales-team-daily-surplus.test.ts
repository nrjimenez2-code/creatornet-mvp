/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import type {SupabaseClient} from "@supabase/supabase-js";
import {signedSurplusDatabase,seedSignedSurplus} from "@/test-support/sales-team-surplus-ingress-postgres";
import {seedTeamSurplusCash} from "@/test-support/sales-team-surplus-postgres";
import {teamSurplusPayoutFixture} from "@/test-support/sales-team-surplus-payout-fixture";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {runTeamDailySurplus} from "@/lib/salesTeams/dailySurplus";
import {reserveTeamDailySurplus} from "@/lib/salesTeams/surplusReservations";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
import {TEAM_STRIPE_API_VERSION} from "@/lib/salesTeams/providerOperation";

declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261029171329_sales_team_daily_surplus.sql";
let db:PGlite,advance:(ms:number)=>Promise<void>,h:Awaited<ReturnType<typeof seedSignedSurplus>>,offset:number;
const realNow=Date.now;
beforeAll(async()=>{db=createLocalPostgres();advance=await installTeamLocalClock(db);await signedSurplusDatabase(db);await db.exec(readFileSync(candidate,"utf8"));},30000);
beforeEach(async()=>{await db.exec("begin");offset=0;});
afterEach(async()=>{jest.restoreAllMocks();await db.exec("rollback;reset role");});
afterAll(async()=>{await db?.close();});
const setup=async()=>{h=await seedSignedSurplus(db);};
const shift=async(ms=86400000)=>{offset+=ms;await advance(offset);jest.spyOn(Date,"now").mockImplementation(()=>realNow()+offset);};
const finish=()=>h.invoke("finish_sales_team_surplus_run_v1",{p_run_id:h.run.runId,p_lease_token:h.run.leaseToken,p_context:h.c.context,p_failed:false});
const next=async()=>{await finish();await shift();h.raw.mockClear();h.rpc.mockClear();};
const count=async(table:string)=>(await db.query<{n:number}>(`select count(*)::int n from ${table}`)).rows[0].n;
const noNewMoney=()=>db.exec("do $$ declare c record;begin for c in select attname from pg_attribute where attrelid='public.sales_team_controls_v1'::regclass and atttypid='boolean'::regtype and attname<>'singleton' and not attisdropped loop execute format('update public.sales_team_controls_v1 set %I=false',c.attname);end loop;end $$");
async function admit(eventId="evt_dailyOriginal",type="payout.created",mode:"release"|"busy"|"complete"="release"){
 const token=id(310);
 expect(await h.invoke("claim_stripe_event",{p_event_id:`stripe:${eventId}`,p_event_type:type,p_lease_seconds:300,p_claim_token:token})).toBe("new");
 await h.invoke("begin_sales_team_surplus_event_v1",{p_event_id:eventId,p_event_type:type,p_event_created:h.event.created,p_payout_id:h.payout.id,p_request_id:h.q.id,p_context:h.c.context,p_claim_token:token});
 if(mode!=="busy")await h.invoke(mode==="complete"?"complete_stripe_event":"release_stripe_event",{p_event_id:`stripe:${eventId}`,p_claim_token:token});
}
const assertOnlyReads=()=>{expect(h.raw.mock.calls.length).toBeGreaterThan(0);expect(h.raw.mock.calls.every(([method])=>method==="GET")).toBe(true);};

test("an active owner is busy; a consumed UTC slot does not acquire another task",async()=>{
 await setup();h.raw.mockClear();expect(await runTeamDailySurplus(h.c,{admitNew:true})).toEqual({status:"busy",bankConfirmed:false});
 await finish();expect(await runTeamDailySurplus(h.c,{admitNew:true})).toEqual({status:"slot_consumed",bankConfirmed:false});expect(h.raw).not.toHaveBeenCalled();
 expect(await count("sales_team_surplus_requests_v1")).toBe(1);
});
test("a genuinely never-journaled original cancels without payout or new reservation",async()=>{
 await setup();await next();await noNewMoney();const operations=(await db.query("select * from sales_team_provider_operations_v1 order by id")).rows;
 expect(await runTeamDailySurplus(h.c)).toMatchObject({status:"complete",moneyStatus:"not_dispatched",requestId:h.q.id,bankConfirmed:false});
 expect(h.raw).not.toHaveBeenCalled();expect((await db.query("select * from sales_team_provider_operations_v1 order by id")).rows).toEqual(operations);
 expect(await count("sales_team_surplus_requests_v1")).toBe(1);expect(await count("sales_team_surplus_resolutions_v1")).toBe(1);
});
test("unknown original response recovers by its independently retrieved creation event with new money off",async()=>{
 await setup();h.losePost();await h.dispatch();await next();await noNewMoney();
 expect(await runTeamDailySurplus(h.c)).toMatchObject({status:"complete",moneyStatus:"observed",requestId:h.q.id,bankConfirmed:false});assertOnlyReads();
 expect((await db.query("select status,provider_id from sales_team_provider_operations_v1 where id=$1",[h.q.operation_id])).rows).toEqual([{status:"bound",provider_id:"po_original"}]);
 expect(await count("sales_team_surplus_recovery_proofs_v1")).toBe(1);expect(await count("sales_team_surplus_requests_v1")).toBe(1);
});
test("missing original creation proof stays encumbered and never replays POST",async()=>{
 await setup();h.losePost();await h.dispatch();await next();const raw=h.raw.getMockImplementation()!;
 h.raw.mockImplementation(async(method,path)=>path==="/v1/events"?{object:"list",url:"/v1/events",has_more:false,data:[],lastResponse:{requestId:"req_missingOriginal"}}:raw(method,path));
 expect(await runTeamDailySurplus(h.c,{admitNew:true})).toMatchObject({status:"review_required",moneyStatus:"reconciliation_required",bankConfirmed:false});assertOnlyReads();
 expect(await count("sales_team_surplus_resolutions_v1")).toBe(0);expect(await count("sales_team_surplus_requests_v1")).toBe(1);
});
test("bound pending debit is observed next day without fresh payout authority",async()=>{
 await setup();h.debit.status="pending";await h.dispatch();await next();await noNewMoney();h.debit.status="available";
 expect(await runTeamDailySurplus(h.c)).toMatchObject({status:"complete",moneyStatus:"observed",bankConfirmed:false});assertOnlyReads();
 expect(await count("sales_team_surplus_balance_entries_v1")).toBe(1);
});
test.each(["release","complete"] as const)("stored signed event in %s shared state completes only with fresh independent money",async mode=>{
 await setup();h.debit.status="pending";await h.dispatch();await admit("evt_dailyOriginal","payout.created",mode);await next();await noNewMoney();h.debit.status="available";
 await db.exec("set local role service_role");expect(await runTeamDailySurplus(h.c)).toMatchObject({status:"complete",bankConfirmed:false});assertOnlyReads();
 expect(await count("sales_team_surplus_event_results_v1")).toBe(1);expect((await db.query("select status from stripe_events")).rows).toEqual([{status:"completed"}]);
});
test("a busy signed claim keeps its hold and token while independent money may be observed",async()=>{
 await setup();h.debit.status="pending";await h.dispatch();await next();await admit("evt_dailyOriginal","payout.created","busy");h.debit.status="available";
 expect(await runTeamDailySurplus(h.c)).toMatchObject({status:"review_required",bankConfirmed:false});assertOnlyReads();expect(await count("sales_team_surplus_event_results_v1")).toBe(0);
 expect((await db.query("select status,claim_token from stripe_events")).rows).toEqual([{status:"processing",claim_token:id(310)}]);
});
test("late signed failure retains immutable debit resolution until available return is independently proved",async()=>{
 await setup();await h.dispatch();const original=(await db.query("select * from sales_team_surplus_resolutions_v1")).rows;
 await admit("evt_dailyFailure","payout.failed");h.payout.status="failed";h.payout.failure_balance_transaction="txn_return";h.returned.status="pending";await next();await noNewMoney();
 expect(await runTeamDailySurplus(h.c)).toMatchObject({status:"review_required",bankConfirmed:false});expect(await count("sales_team_surplus_event_results_v1")).toBe(0);
 expect(await count("stripe_events")).toBe(0);await shift();h.returned.status="available";
 expect(await runTeamDailySurplus(h.c)).toMatchObject({status:"complete",bankConfirmed:false});assertOnlyReads();
 expect((await db.query("select * from sales_team_surplus_resolutions_v1")).rows).toEqual(original);expect(await count("sales_team_surplus_balance_entries_v1")).toBe(2);
 expect(await count("sales_team_surplus_event_results_v1")).toBe(1);
});
test("at most three stored events are claimed in a slot; an extra event retains the hold",async()=>{
 await setup();h.debit.status="pending";await h.dispatch();for(let n=0;n<4;n++)await admit(`evt_daily${n}`);await next();h.debit.status="available";
 expect(await runTeamDailySurplus(h.c,{admitNew:true})).toMatchObject({status:"review_required",bankConfirmed:false});assertOnlyReads();
 expect(await count("sales_team_surplus_event_results_v1")).toBe(3);expect(h.rpc.mock.calls.filter(([name])=>name==="claim_stripe_event")).toHaveLength(3);
 await shift();expect(await runTeamDailySurplus(h.c)).toMatchObject({status:"complete",bankConfirmed:false});expect(await count("sales_team_surplus_event_results_v1")).toBe(4);
 expect(await count("sales_team_surplus_requests_v1")).toBe(1);
});
test("reclaimed signed claim fences stale completion and does not release its new owner",async()=>{
 await setup();h.debit.status="pending";await h.dispatch();await admit();await next();h.debit.status="available";const raw=h.raw.getMockImplementation()!;let reclaimed=false;
 h.raw.mockImplementation(async(method,path)=>{
  if(path==="/v1/payouts/po_original"&&!reclaimed){reclaimed=true;await db.exec("update stripe_events set claimed_at=clock_timestamp()-interval '301 seconds'");
   expect(await h.invoke("claim_stripe_event",{p_event_id:"stripe:evt_dailyOriginal",p_event_type:"payout.created",p_lease_seconds:300,p_claim_token:id(311)})).toBe("new");}
  return raw(method,path);
 });
 expect(await runTeamDailySurplus(h.c)).toMatchObject({status:"review_required",bankConfirmed:false});expect(await count("sales_team_surplus_event_results_v1")).toBe(0);
 expect((await db.query("select status,claim_token from stripe_events")).rows).toEqual([{status:"processing",claim_token:id(311)}]);assertOnlyReads();
});
test("provider failure releases only owned signed claims and preserves money holds",async()=>{
 await setup();h.debit.status="pending";await h.dispatch();await admit();await next();h.raw.mockRejectedValue(Error("synthetic provider failure"));
 expect(await runTeamDailySurplus(h.c)).toMatchObject({status:"review_required",bankConfirmed:false});expect(await count("stripe_events")).toBe(0);
 expect(await count("sales_team_surplus_event_results_v1")).toBe(0);expect(await count("sales_team_surplus_resolutions_v1")).toBe(0);assertOnlyReads();
});
test("failed parallel money read drains its already-admitted sibling before finishing the worker",async()=>{
 await setup();await h.dispatch();await admit("evt_dailyFailure","payout.failed");await next();h.payout.status="failed";h.payout.failure_balance_transaction="txn_return";
 const raw=h.raw.getMockImplementation()!;let release!:()=>void,admitted!:()=>void,settled=false;
 const pending=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{admitted=resolve;});
 h.raw.mockImplementation(async(method,path)=>{
  if(path==="/v1/balance_transactions/txn_debit")throw Error("synthetic first read failure");
  if(path==="/v1/balance_transactions/txn_return"){admitted();await pending;}return raw(method,path);
 });
 const run=runTeamDailySurplus(h.c).finally(()=>{settled=true;});await started;await Promise.resolve();
 expect(settled).toBe(false);expect(h.rpc.mock.calls.some(([name])=>name==="finish_sales_team_surplus_run_v1")).toBe(false);
 release();expect(await run).toMatchObject({status:"review_required",bankConfirmed:false});
});
test.each([36000,65000,-1])("elapsed clock offset %i stops further context admission and preserves the original",async elapsed=>{
 await setup();h.debit.status="pending";await h.dispatch();await next();let now=0,calls=0;
 const c={...h.c,observeContext:async()=>{if(++calls===2)now=elapsed;return h.c.context;}};
 expect(await runTeamDailySurplus(c,{now:()=>now})).toMatchObject({status:"review_required",bankConfirmed:false});expect(h.raw).not.toHaveBeenCalled();
 expect(await count("sales_team_surplus_resolutions_v1")).toBe(0);
});
test("changed context before claim cannot consume a slot",async()=>{
 await setup();await next();const c={...h.c,observeContext:async()=>({...h.c.context,platformAccountId:"acct_foreign"})};
 await expect(runTeamDailySurplus(c)).rejects.toThrow(/context changed/);expect(h.rpc).not.toHaveBeenCalled();expect(h.raw).not.toHaveBeenCalled();
});
test.each(["token","context","request","expired"])("pending-event reader requires exact current %s authority",async fault=>{
 await setup();await h.dispatch();await admit();await next();const run=await h.claim(id(320),false);await reserveTeamDailySurplus(h.c,{...run,requestId:id(321)});
 if(fault==="expired")await shift(90001);
 await expect(h.invoke("read_sales_team_surplus_pending_events_v1",{p_run_id:run.runId,p_lease_token:fault==="token"?id(999):run.leaseToken,
  p_context:fault==="context"?{...h.c.context,platformAccountId:"acct_foreign"}:h.c.context,p_request_id:fault==="request"?id(999):h.q.id})).rejects.toThrow(/CURRENT_TEAM_SURPLUS_WORKER_REQUIRED|ORIGINAL_DAILY_SURPLUS_TASK_REQUIRED/);
});
test("reader exposes service-only execution with a fixed search path; all five digests bind it",async()=>{
 const signature="public.read_sales_team_surplus_pending_events_v1(uuid,uuid,jsonb,uuid)";
 for(const role of ["anon","authenticated","service_role"])expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,signature])).rows).toEqual([{allowed:role==="service_role"}]);
 expect((await db.query("select prosecdef,proconfig from pg_proc where oid=$1::regprocedure",[signature])).rows).toEqual([{prosecdef:true,proconfig:["search_path=pg_catalog"]}]);
 const names=["transfer_contract_digest_v1","shared_cash_contract_digest_v1","retained_cash_contract_digest_v1","recovery_contract_digest_v1","surplus_contract_digest_v1"],read=()=>Promise.all(names.map(async name=>(await db.query<{d:string}>(`select creatornet_team_private.${name}() d`)).rows[0].d)),before=await read();
 const body=(await db.query<{s:string}>("select pg_get_functiondef($1::regprocedure) s",[signature])).rows[0].s;
 await db.exec(body.replace(/AS \$function\$/i,"AS $function$\n-- synthetic reader drift\n"));(await read()).forEach((value,i)=>expect(value).not.toBe(before[i]));
});

async function freshFixture(){
 const f=await seedTeamSurplusCash(db,{maximumCents:5000}),provider=teamSurplusPayoutFixture();await db.exec("update sales_team_controls_v1 set surplus_execution_enabled=true");let sequence=0;
 let payout={...provider.payout,created:Math.floor(Date.now()/1000),destination:"ba_fixture"};
 const raw=jest.fn(async(method:string,path:string,params?:Record<string,unknown>,options?:Record<string,unknown>):Promise<Record<string,unknown>>=>{
  expect(options).toMatchObject({apiVersion:TEAM_STRIPE_API_VERSION,maxNetworkRetries:0});expect(Number(options?.timeout)).toBeLessThanOrEqual(10000);
  if(method==="POST"){expect(path).toBe("/v1/payouts");payout={...payout,...params} as typeof payout;return {...payout,lastResponse:{requestId:"req_freshDailyCreate"}};}
  const value=path==="/v1/account"?{...provider.account,id:f.c.context.platformAccountId}:path==="/v1/balance_settings"?provider.settings:
   path.startsWith("/v1/accounts/")?{...provider.bank,id:"ba_fixture",account:f.c.context.platformAccountId}:
   path==="/v1/payouts/po_original"?payout:path==="/v1/balance_transactions/txn_debit"?{...provider.debit,created:payout.created,available_on:payout.created}:null;
  if(path==="/v1/balance")return await f.c.stripe.rawRequest(method,path,params,options);
  if(method!=="GET"||!value)throw Error(path);return {...value,lastResponse:{requestId:`req_freshDaily${++sequence}`}};
 });
 const base=f.c.admin.rpc.bind(f.c.admin),rpc=jest.fn(async(name:string,args:Record<string,unknown>)=>{
  await db.exec("savepoint daily_rpc");const result=await base(name,args);if(result.error)await db.exec("rollback to savepoint daily_rpc");await db.exec("release savepoint daily_rpc");return result;
 });
 const c={...f.c,admin:{...f.c.admin,rpc} as unknown as SupabaseClient,stripe:{rawRequest:raw}} as unknown as TeamReceiptComposition;
 return {c,raw,rpc};
}
test("fresh authority reserves server-derived protected cash and sends one exact original payout",async()=>{
 const f=await freshFixture();await db.exec("set local role service_role");
 expect(await runTeamDailySurplus(f.c,{admitNew:true})).toMatchObject({status:"complete",moneyStatus:"observed",bankConfirmed:false});
 const posts=f.raw.mock.calls.filter(([method])=>method==="POST");expect(posts).toHaveLength(1);
 const q=(await db.query<{operation_id:string;request:{params:Record<string,unknown>}}>("select operation_id,request from sales_team_surplus_requests_v1")).rows[0];
 expect(posts[0][2]).toEqual(q.request.params);expect(posts[0][3]).toMatchObject({idempotencyKey:`cn-team-v1:${q.operation_id}`});expect(await count("sales_team_surplus_balance_entries_v1")).toBe(1);
 const calls=f.raw.mock.calls.length;expect(await runTeamDailySurplus(f.c,{admitNew:true})).toEqual({status:"slot_consumed",bankConfirmed:false});expect(f.raw).toHaveBeenCalledTimes(calls);
});
test.each(["new_money_off","database_off"])("fresh %s cannot reserve or dispatch",async fault=>{
 const f=await freshFixture();if(fault==="database_off")await noNewMoney();
 expect(await runTeamDailySurplus(f.c,{admitNew:fault!=="new_money_off"})).toEqual({status:"held",bankConfirmed:false});expect(f.raw).not.toHaveBeenCalled();expect(await count("sales_team_surplus_requests_v1")).toBe(0);
});
test("fresh payout permission revoked during destination reads prevents provider dispatch",async()=>{
 const f=await freshFixture(),raw=f.raw.getMockImplementation()!;let revoked=false;
 f.raw.mockImplementation(async(method,path,params,options)=>{
  if(path==="/v1/account"&&!revoked){revoked=true;await db.exec("update sales_team_controls_v1 set surplus_execution_enabled=false");}
  return raw(method,path,params,options);
 });
 expect(await runTeamDailySurplus(f.c,{admitNew:true})).toMatchObject({status:"review_required",bankConfirmed:false});
 expect(f.raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(0);expect(await count("sales_team_surplus_resolutions_v1")).toBe(0);
});
test("fresh payout cannot cross the outer 25-second POST admission cutoff",async()=>{
 const f=await freshFixture();let now=0,observations=0;
 const c={...f.c,observeEvidence:async()=>{if(++observations===2)now=25000;return f.c.observeEvidence();}};
 expect(await runTeamDailySurplus(c,{admitNew:true,now:()=>now})).toMatchObject({status:"review_required",bankConfirmed:false});
 expect(observations).toBe(2);expect(f.raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(0);expect(await count("sales_team_surplus_resolutions_v1")).toBe(0);
});
test("an exhausted initial context budget stops before claiming a worker or admitting provider work",async()=>{
 await setup();h.debit.status="pending";await h.dispatch();await next();let now=0;
 const c={...h.c,observeContext:async()=>{now=65000;return h.c.context;}};
 await expect(runTeamDailySurplus(c,{now:()=>now})).rejects.toThrow(/budget exhausted/);expect(h.rpc).not.toHaveBeenCalled();expect(h.raw).not.toHaveBeenCalled();
});
test.each(["dependency","digest","late_grant"])("F44 %s install failure rolls back every function and grant",async fault=>{
 const isolated=createLocalPostgres();try{await signedSurplusDatabase(isolated);
  if(fault==="dependency")await isolated.exec("alter function public.complete_sales_team_surplus_event_v1(text,uuid,uuid,jsonb) rename to fixture_missing_complete");
  if(fault==="digest")await isolated.exec("create or replace function creatornet_team_private.surplus_contract_digest_v1() returns text language sql stable as $$select 'synthetic drift'::text$$");
  const inventory=async()=>(await isolated.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) body,proacl::text grants from pg_proc where pronamespace in ('public'::regnamespace,'creatornet_team_private'::regnamespace) order by oid")).rows,before=await inventory();
  let sql=readFileSync(candidate,"utf8");if(fault==="late_grant")sql=sql.replace("commit;","grant execute on function public.missing_daily_surplus_grant() to service_role;commit;");
  await expect(isolated.exec(sql)).rejects.toThrow();await isolated.exec("rollback");expect(await inventory()).toEqual(before);
  expect((await isolated.query("select to_regprocedure('public.read_sales_team_surplus_pending_events_v1(uuid,uuid,jsonb,uuid)') fn")).rows).toEqual([{fn:null}]);
 }finally{await isolated.close();}
},30000);
