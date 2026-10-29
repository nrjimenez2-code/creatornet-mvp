/** @jest-environment ./test-support/pglite-environment.cjs */
import {installSignedSurplusEventsFixture} from "@/test-support/sales-team-surplus-events-schema";
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import type Stripe from "stripe";
import {surplusDatabase,seedTeamSurplusCash} from "../test-support/sales-team-surplus-postgres";
import {teamSurplusPayoutFixture} from "../test-support/sales-team-surplus-payout-fixture";
import {teamFixtureId as id} from "../test-support/sales-team-postgres";
import {installTeamLocalClock} from "../test-support/sales-team-local-clock";
import {reserveTeamDailySurplus} from "@/lib/salesTeams/surplusReservations";
import {dispatchTeamDailySurplus} from "@/lib/salesTeams/surplusExecution";
import {recoverTeamDailySurplus} from "@/lib/salesTeams/surplusRecovery";
import {observeTeamDailySurplus} from "@/lib/salesTeams/surplusObservations";
import {readTeamUnknownSurplus} from "@/lib/salesTeams/surplusRecoveryReadback";
import {TEAM_STRIPE_API_VERSION} from "@/lib/salesTeams/providerOperation";
import type {TeamSurplusMoneySource} from "@/lib/salesTeams/surplusPayoutPolicy";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261028222238_sales_team_surplus_recovery.sql",execution="supabase/migrations/20261028000209_sales_team_surplus_execution.sql";
let db:PGlite,advance:(ms:number)=>Promise<void>;
beforeAll(async()=>{db=createLocalPostgres();advance=await installTeamLocalClock(db);await surplusDatabase(db);await db.exec(readFileSync(execution,"utf8"));await db.exec(readFileSync(candidate,"utf8"));await installSignedSurplusEventsFixture(db);await db.exec(readFileSync("supabase/migrations/20261029171329_sales_team_daily_surplus.sql","utf8"));},30000);
beforeEach(async()=>{await db.exec("begin");});afterEach(async()=>{await db.exec("rollback;reset role");jest.restoreAllMocks();});afterAll(async()=>{await db?.close();});
async function fixture(){
 const h=await seedTeamSurplusCash(db,{maximumCents:5000}),run=await h.claim(),prepared=await reserveTeamDailySurplus(h.c,{...run,requestId:id(201)});
 if(!("request" in prepared))throw Error("Synthetic original required");const q=prepared.request,f=teamSurplusPayoutFixture();
 await db.exec("update sales_team_controls_v1 set surplus_execution_enabled=true");let seq=0;
 const payout={...f.payout,created:Math.floor(Date.now()/1000),amount:Number(q.amount_cents),destination:q.destination_id,metadata:q.request.params.metadata};
 const debit={...f.debit,created:payout.created,available_on:payout.created},returned={...f.returned,created:payout.created,available_on:payout.created};
 const event={id:"evt_original",object:"event",type:"payout.created",api_version:TEAM_STRIPE_API_VERSION,account:null,context:null,created:payout.created,livemode:false,
  request:{id:"req_originalCreate",idempotency_key:`cn-team-v1:${q.operation_id}`},data:{object:{...payout,lastResponse:undefined}}} as unknown as Stripe.Event;
 const events:Stripe.Event[]=[event];
 const raw=jest.fn(async(method:string,path:string):Promise<Record<string,unknown>>=>{
  if(method==="POST"){if(path!=="/v1/payouts")throw Error(path);throw Error("Synthetic lost original payout response");}
  const value=path==="/v1/account"?{...f.account,id:h.c.context.platformAccountId}:path==="/v1/balance_settings"?f.settings:path.startsWith("/v1/accounts/")?{...f.bank,id:q.destination_id,account:h.c.context.platformAccountId}:
   path==="/v1/balance"?{object:"balance",livemode:false,available:[{currency:"usd",amount:1000000,source_types:{card:1000000}}],pending:[]}:
   path==="/v1/events"?{object:"list",url:"/v1/events",has_more:false,data:events}:path==="/v1/events/evt_original"?event:
   path==="/v1/payouts/po_original"?payout:path==="/v1/balance_transactions/txn_debit"?debit:path==="/v1/balance_transactions/txn_return"?returned:null;
  if(method!=="GET"||!value)throw Error(path);return {...value,lastResponse:{requestId:`req_recoveryFixture${++seq}`}};
 });
 const originalRpc=h.c.admin.rpc.bind(h.c.admin),errors:string[]=[];
 const rpc=jest.fn(async(name:string,args:Record<string,unknown>)=>{
  await db.exec("savepoint recovery_rpc");const result=await originalRpc(name,args);
  if(result.error){errors.push(String(result.error));await db.exec("rollback to savepoint recovery_rpc");}await db.exec("release savepoint recovery_rpc");return result;
 });
 const c={...h.c,admin:{...h.c.admin,rpc},stripe:{rawRequest:raw}} as unknown as TeamReceiptComposition;
 const dispatch=()=>dispatchTeamDailySurplus(c,{...run,requestId:q.id},true),recover=()=>recoverTeamDailySurplus(c,q.id);
 const begin=async(checkId=id(251))=>{const r=await rpc("begin_sales_team_surplus_recovery_v1",{p_check_id:checkId,p_request_id:q.id,p_context:c.context});if(r.error)throw r.error;return r.data as TeamSurplusMoneySource;};
 const complete=async(proof:unknown,checkId=id(251))=>{const r=await rpc("complete_sales_team_surplus_recovery_v1",{p_check_id:checkId,p_request_id:q.id,p_context:c.context,p_proof:proof});if(r.error)throw r.error;return r.data;};
 return {...h,c,run,q,event,events,payout,debit,returned,raw,rpc,errors,dispatch,recover,begin,complete};
}
const state=async(h:Awaited<ReturnType<typeof fixture>>)=>(await db.query("select status,provider_id,provider_request_id from sales_team_provider_operations_v1 where id=$1",[h.q.operation_id])).rows[0];
const epoch=async()=>(await db.query<{n:number}>("select epoch::int n from sales_team_cash_epoch_v1")).rows[0].n;
test("lost original response is recovered exactly once with independent money and no replacement payout",async()=>{
 const h=await fixture();expect(await h.dispatch()).toMatchObject({status:"reconciliation_required"});const before=await epoch();
 expect(await h.recover()).toMatchObject({status:"observed",complete:true,bankConfirmed:false});expect(h.errors).toEqual([]);
 expect(await state(h)).toMatchObject({status:"bound",provider_id:"po_original",provider_request_id:"req_originalCreate"});expect(await epoch()).toBe(before+1);
 expect(await observeTeamDailySurplus(h.c,h.q.id)).toMatchObject({status:"observed",recorded:true,bankConfirmed:false});expect(await epoch()).toBe(before+1);
 expect(h.raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);expect((await db.query("select count(*)::int n from sales_team_surplus_balance_entries_v1")).rows).toEqual([{n:1}]);
});
test("outcome recovery remains available after the worker expires and new-money controls are off",async()=>{
 const h=await fixture();await h.dispatch();const realNow=Date.now;await advance(120000);jest.spyOn(Date,"now").mockImplementation(()=>realNow()+120000);
 await db.exec("do $$ declare c record;begin for c in select attname from pg_attribute where attrelid='public.sales_team_controls_v1'::regclass and atttypid='boolean'::regtype and attname<>'singleton' and not attisdropped loop execute format('update public.sales_team_controls_v1 set %I=false',c.attname);end loop;end $$");
 await db.exec("set local role service_role");expect(await h.recover()).toMatchObject({status:"observed",bankConfirmed:false});await db.exec("reset role");
 expect(h.raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});
test("a pending debit binds original identity but preserves the reservation until later available money",async()=>{
 const h=await fixture();await h.dispatch();h.debit.status="pending";
 expect(await h.recover()).toMatchObject({status:"reconciliation_required",complete:false,bankConfirmed:false});expect(await state(h)).toMatchObject({status:"bound"});
 expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:5020}]);
 h.debit.status="available";expect(await observeTeamDailySurplus(h.c,h.q.id)).toMatchObject({status:"observed"});
});
test("failed original recovery accounts for the debit and return while retaining immutable creation identity",async()=>{
 const h=await fixture();await h.dispatch();h.payout.status="failed";h.payout.failure_balance_transaction="txn_return";
 expect(await h.recover()).toMatchObject({status:"observed",bankConfirmed:false});expect((await db.query("select kind,amount_cents::int amount from sales_team_surplus_balance_entries_v1 order by kind")).rows).toEqual([{kind:"debit",amount:-5000},{kind:"return",amount:5000}]);
});
test("empty discovery keeps unknown money protected without an unsent resolution",async()=>{
 const h=await fixture();await h.dispatch();h.events.length=0;expect(await h.recover()).toMatchObject({status:"reconciliation_required"});
 expect(await state(h)).toMatchObject({status:"unknown",provider_id:null});expect((await db.query("select count(*)::int n from sales_team_surplus_resolutions_v1")).rows).toEqual([{n:0}]);
});
test("a never-journaled reservation is not an unknown dispatched original",async()=>{
 const h=await fixture();await expect(h.recover()).rejects.toThrow(/DISPATCHED_UNKNOWN_SURPLUS_REQUIRED/);expect(h.raw).not.toHaveBeenCalled();
});
test.each(["key","request","event","version","context","incomplete","ambiguous","cursor","duplicate_event","duplicate_reads","money","bank_confirmation","freshness"])("SQL rejects forged %s evidence and rolls the outcome bind back",async fault=>{
 const h=await fixture();await h.dispatch();const q=await h.begin(),proof=(await readTeamUnknownSurplus(h.c,q))!;
 if(fault==="key")proof.event.idempotencyKey="other";if(fault==="request")proof.event.originalRequestId="bad";if(fault==="event")proof.event.eventId="evt_other";
 if(fault==="version")proof.event.apiVersion="2020-08-27";if(fault==="context")proof.context={...proof.context,platformAccountId:"acct_other"};
 if(fault==="incomplete")proof.pages[0].hasMore=true;if(fault==="ambiguous")proof.pages[0].events.push({...proof.pages[0].events[0],eventId:"evt_second"});
 if(fault==="cursor")proof.pages[0].startingAfter="evt_unseen";if(fault==="duplicate_event")proof.pages[0].events.push(proof.pages[0].events[0]);
 if(fault==="duplicate_reads")proof.firstEventRequestId=proof.money.firstPayoutRequestId;if(fault==="money")proof.money.debit.amountCents=-1;
 if(fault==="bank_confirmation")(proof.money as {bankConfirmed:boolean}).bankConfirmed=true;if(fault==="freshness")proof.readStartedAt-=61000;
 await expect(h.complete(proof)).rejects.toThrow();expect(await state(h)).toMatchObject({status:"unknown",provider_id:null});
 expect((await db.query("select count(*)::int n from sales_team_surplus_recovery_proofs_v1")).rows).toEqual([{n:0}]);expect((await db.query("select count(*)::int n from sales_team_surplus_balance_entries_v1")).rows).toEqual([{n:0}]);
});
test("the exact completed recovery is idempotent but its receipt cannot change",async()=>{
 const h=await fixture();await h.dispatch();const proof=(await readTeamUnknownSurplus(h.c,await h.begin()))!;await h.complete(proof);const before=await epoch();
 expect(await h.complete(proof)).toMatchObject({recorded:false,bankConfirmed:false});expect(await epoch()).toBe(before);
 await expect(h.complete({...proof,to:proof.to-1})).rejects.toThrow(/ORIGINAL_SURPLUS_RECOVERY_CHANGED/);
});
test("overlapping recovery admissions cannot own the same creation event or book money twice",async()=>{
 const h=await fixture();await h.dispatch();const first=(await readTeamUnknownSurplus(h.c,await h.begin(id(251))))!,second=(await readTeamUnknownSurplus(h.c,await h.begin(id(252))))!;
 await h.complete(first,id(251));const before=await epoch();await expect(h.complete(second,id(252))).rejects.toThrow(/unique/);
 expect(await epoch()).toBe(before);expect((await db.query("select count(*)::int n from sales_team_surplus_balance_entries_v1")).rows).toEqual([{n:1}]);
});
test("recovery histories are immutable and service callers have no raw write privileges",async()=>{
 const h=await fixture();await h.dispatch();await h.recover();
 for(const table of ["sales_team_surplus_recovery_checks_v1","sales_team_surplus_recovery_proofs_v1"]){
  expect((await db.query("select relrowsecurity rls from pg_class where oid=$1::regclass",[`public.${table}`])).rows).toEqual([{rls:true}]);
  for(const role of ["anon","authenticated","service_role"]){expect((await db.query("select has_table_privilege($1,$2,'INSERT,UPDATE,DELETE') allowed",[role,`public.${table}`])).rows).toEqual([{allowed:false}]);}
  await db.exec("savepoint immutable_recovery");await expect(db.exec(`delete from public.${table}`)).rejects.toThrow(/IMMUTABLE/);await db.exec("rollback to savepoint immutable_recovery");
 }
 for(const role of ["anon","authenticated"]){expect((await db.query("select has_function_privilege($1,'public.complete_sales_team_surplus_recovery_v1(uuid,uuid,jsonb,jsonb)','EXECUTE') allowed",[role])).rows).toEqual([{allowed:false}]);}
});
test.each(["begin","complete"])("all five financial digests bind the %s recovery owner",async owner=>{
 const digests=["transfer_contract_digest_v1","shared_cash_contract_digest_v1","retained_cash_contract_digest_v1","recovery_contract_digest_v1","surplus_contract_digest_v1"],read=async()=>Promise.all(digests.map(async n=>(await db.query<{d:string}>(`select creatornet_team_private.${n}() d`)).rows[0].d));
 const before=await read(),signature=`public.${owner}_sales_team_surplus_recovery_v1(uuid,uuid,jsonb${owner==="complete"?",jsonb":""})`;
 const body=(await db.query<{s:string}>("select pg_get_functiondef($1::regprocedure) s",[signature])).rows[0].s;await db.exec(body.replace(/AS \$function\$/i,"AS $function$\n-- synthetic drift\n"));const after=await read();after.forEach((value,i)=>expect(value).not.toBe(before[i]));
});
test.each(["dependency","late_grant"])("F42 %s failure rolls back its schema and function changes",async fault=>{
 const isolated=createLocalPostgres();try{await surplusDatabase(isolated);await isolated.exec(readFileSync(execution,"utf8"));
  if(fault==="dependency")await isolated.exec("alter function creatornet_team_private.surplus_contract_digest_v1() rename to fixture_missing_surplus_digest");
  const inventory=async()=>(await isolated.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) body,proacl::text grants from pg_proc where pronamespace in ('public'::regnamespace,'creatornet_team_private'::regnamespace) order by oid")).rows,before=await inventory(),sql=readFileSync(candidate,"utf8");
  await expect(isolated.exec(fault==="late_grant"?sql.replace("commit;","grant execute on function public.missing_recovery_grant() to service_role;commit;"):sql)).rejects.toThrow();await isolated.exec("rollback");expect(await inventory()).toEqual(before);
  expect((await isolated.query("select to_regclass('public.sales_team_surplus_recovery_proofs_v1') proof")).rows).toEqual([{proof:null}]);
 }finally{await isolated.close();}
},30000);
