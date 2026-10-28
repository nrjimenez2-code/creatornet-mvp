/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {surplusDatabase,seedTeamSurplusCash} from "@/test-support/sales-team-surplus-postgres";
import {installTeamLocalClock} from "@/test-support/sales-team-local-clock";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {reserveTeamDailySurplus} from "@/lib/salesTeams/surplusReservations";
import {dispatchTeamDailySurplus} from "@/lib/salesTeams/surplusExecution";
import {teamSurplusPayoutFixture} from "@/test-support/sales-team-surplus-payout-fixture";
import {observeTeamDailySurplus} from "@/lib/salesTeams/surplusObservations";
import {teamSurplusExecutionReady,teamSurplusExecutionSchemaReady} from "@/lib/salesTeams/policy";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite,advance:(ms:number)=>Promise<void>;
beforeAll(async()=>{db=createLocalPostgres();advance=await installTeamLocalClock(db);await surplusDatabase(db);await db.exec(readFileSync("supabase/migrations/20261028000209_sales_team_surplus_execution.sql","utf8"));await db.exec(readFileSync("supabase/migrations/20261028222238_sales_team_surplus_recovery.sql","utf8"));},30000);
beforeEach(async()=>{await db.exec("begin");});afterEach(async()=>{await db.exec("rollback;reset role");jest.restoreAllMocks();});afterAll(async()=>{await db?.close();});

test("available cash cannot make an original captured confirmation without a verified receipt withdrawable",async()=>{
 const h=await seedTeamSurplusCash(db,{recordReceipt:false}),run=await h.claim();
 expect(h.f.base.paymentIntent.status).toBe("succeeded");expect((await db.query("select count(*)::int n from sales_team_receipts_v1")).rows).toEqual([{n:0}]);
 const prepared=await reserveTeamDailySurplus(h.c,{...run,requestId:id(201)});
 if("request" in prepared)expect(prepared.request.amount_cents).toBeLessThanOrEqual(1000000-h.f.contract.amountCents-1000-20);
 else expect(prepared.status).toBe("held");
});

test("an uncertain original confirmation protects its full potential principal without binding or replay",async()=>{
 const h=await seedTeamSurplusCash(db,{recordReceipt:false,confirmationUncertain:true});
 expect((await db.query("select status,provider_id from sales_team_provider_operations_v1 where id=$1",[h.f.confirmationId])).rows).toEqual([{status:"unknown",provider_id:null}]);
 expect((await db.query<{p:{protectedCents:number}}>("select creatornet_team_private.unreceipted_team_cash_v1($1) p",[h.c.context])).rows[0].p.protectedCents).toBe(h.f.contract.amountCents);
 const prepared=await reserveTeamDailySurplus(h.c,{...await h.claim(),requestId:id(201)});expect(prepared).toMatchObject({status:"new",request:{amount_cents:1000000-h.f.contract.amountCents-1020}});
 expect((await db.query("select status,provider_id from sales_team_provider_operations_v1 where id=$1",[h.f.confirmationId])).rows).toEqual([{status:"unknown",provider_id:null}]);
});

test("the verified receipt replaces potential principal instead of protecting it twice",async()=>{
 const h=await seedTeamSurplusCash(db,{recordReceipt:false});
 expect((await db.query<{p:{protectedCents:number}}>("select creatornet_team_private.unreceipted_team_cash_v1($1) p",[h.c.context])).rows[0].p.protectedCents).toBe(h.f.contract.amountCents);
 await h.f.record();
 const result=(await db.query<{current:{teamCents:number;unreceiptedCollections:{protectedCents:number}};prior:{teamCents:number}}>("select creatornet_team_private.cash_protection_v1($1) current,creatornet_team_private.cash_protection_before_surplus_execution_v1($1) prior",[h.c.context])).rows[0];
 expect(result.current.unreceiptedCollections.protectedCents).toBe(0);expect(result.current.teamCents).toBe(result.prior.teamCents);expect(result.current.teamCents).toBeGreaterThan(0);
});

test("receipt arrival between balance reads and admission invalidates the old protection basis",async()=>{
 const h=await seedTeamSurplusCash(db,{recordReceipt:false}),run=await h.claim();await h.rpc("begin_sales_team_surplus_cash_v1",[run.runId,run.leaseToken,h.c.context,id(250)]);
 await h.rpc("complete_sales_team_surplus_cash_v1",[run.runId,run.leaseToken,h.c.context,id(250),{context:h.c.context,availableCents:1000000,firstRequestId:"req_beforeReceipt1",secondRequestId:"req_beforeReceipt2",readStartedAt:Date.now()}]);await h.f.record();
 await expect(h.rpc("prepare_sales_team_surplus_v1",[run.runId,run.leaseToken,h.c.context,id(201),id(250)])).rejects.toThrow(/FRESH_TEAM_SURPLUS_CASH_REQUIRED/);
});

test("only the existing conclusive unpaid closure can remove an unreceipted original",async()=>{
 const h=await seedTeamSurplusCash(db,{recordReceipt:false});await h.f.rpc("stop_sales_team_payment_v1",[h.f.sale,h.f.buyer]);
 const proof={context:h.c.context,obligationId:h.f.contract.obligationId,paymentIntentId:"pi_original",status:"canceled",paymentMethodId:null,amountReceived:0,amountCapturable:0,unpaidMethod:true,authorizedTokenId:null,authorizedPaymentMethodId:null,latestChargeId:null,providerRequestId:"req_canceledOriginal",observedAt:Math.floor(Date.now()/1000),readStartedAt:Date.now()};
 await h.f.rpc("record_sales_team_payment_state_v1",[h.f.contract.obligationId,proof]);await h.f.rpc("close_unpaid_sales_team_payment_v1",[h.f.sale,h.f.buyer,proof]);
 expect((await db.query<{p:{protectedCents:number}}>("select creatornet_team_private.unreceipted_team_cash_v1($1) p",[h.c.context])).rows[0].p.protectedCents).toBe(0);
});

async function executionFixture(enabled=true){
 const h=await seedTeamSurplusCash(db,{maximumCents:5000}),run=await h.claim(),prepared=await reserveTeamDailySurplus(h.c,{...run,requestId:id(201)});
 if(!("request" in prepared))throw Error("Synthetic surplus request required");const q=prepared.request,f=teamSurplusPayoutFixture();
 if(enabled)await db.exec("update sales_team_controls_v1 set surplus_execution_enabled=true");
 let available=1000000,sequence=0,losePost=false;const errors:string[]=[],actions:string[]=[];
 const payout={...f.payout,created:Math.floor(Date.now()/1000),amount:Number(q.amount_cents),destination:q.destination_id,metadata:q.request.params.metadata};
 const debit={...f.debit,created:payout.created,available_on:payout.created,amount:-Number(q.amount_cents),net:-Number(q.amount_cents)};
 const returned={...f.returned,created:payout.created,available_on:payout.created,amount:Number(q.amount_cents),net:Number(q.amount_cents)};
 const raw=jest.fn(async(method:string,path:string,params?:unknown,options?:unknown)=>{
  void params;void options;actions.push(`${method} ${path}`);
  if(method==="POST"){if(path!=="/v1/payouts")throw Error(path);if(losePost)throw Error("Synthetic lost payout response");return {...payout,lastResponse:{requestId:`req_execution${++sequence}`}};}
  const value=path==="/v1/account"?{...f.account,id:h.c.context.platformAccountId}:path==="/v1/balance_settings"?f.settings:path===`/v1/accounts/${h.c.context.platformAccountId}/external_accounts/${q.destination_id}`?{...f.bank,id:q.destination_id,account:h.c.context.platformAccountId}:
   path==="/v1/balance"?{object:"balance",livemode:false,available:[{currency:"usd",amount:available,source_types:{card:available}}],pending:[]}:path==="/v1/payouts/po_original"?payout:path==="/v1/balance_transactions/txn_debit"?debit:path==="/v1/balance_transactions/txn_return"?returned:null;
  if(method!=="GET"||!value)throw Error(path);return {...value,lastResponse:{requestId:`req_execution${++sequence}`}};
 });
 let hook:((name:string,args:Record<string,unknown>,data:unknown)=>Promise<void>)|undefined;
 const originalRpc=h.c.admin.rpc.bind(h.c.admin),rpc=jest.fn(async(name:string,args:Record<string,unknown>)=>{
  // Each real Supabase RPC has its own transaction; preserve that boundary in
  // the suite's outer fixture transaction when the runtime handles a denial.
  await db.exec("savepoint surplus_rpc");const result=await originalRpc(name,args);
  if(result.error){errors.push(String(result.error));await db.exec("rollback to savepoint surplus_rpc");}await db.exec("release savepoint surplus_rpc");
  await hook?.(name,args,result.data);return result;
 });
 const c={...h.c,admin:{...h.c.admin,rpc},stripe:{rawRequest:raw}} as unknown as TeamReceiptComposition;
 const args={...run,requestId:q.id},dispatch=(admit=true)=>dispatchTeamDailySurplus(c,args,admit);
 return {...h,c,run,q,payout,debit,returned,raw,rpc,errors,actions,args,dispatch,setAvailable:(v:number)=>{available=v;},losePost:()=>{losePost=true;},hook:(fn:typeof hook)=>{hook=fn;},bank:f.bank,settings:f.settings};
}
const denied=async(action:()=>Promise<unknown>,pattern:RegExp)=>{await db.exec("savepoint denied_surplus_execution");try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied_surplus_execution");}};
type ExecutionFixture=Awaited<ReturnType<typeof executionFixture>>;
const executePort=(h:ExecutionFixture,phase:string,payload:Record<string,unknown>={})=>h.rpc("run_sales_team_surplus_execution_v1",{p_run_id:h.run.runId,p_lease_token:h.run.leaseToken,p_context:h.c.context,p_request_id:h.q.id,p_phase:phase,p_payload:payload});
const epoch=async()=>(await db.query<{n:number}>("select epoch::int n from sales_team_cash_epoch_v1")).rows[0].n;

test("execution independently defaults off and observation-only callers start no payout transport",async()=>{
 expect(teamSurplusExecutionReady({})).toBe(false);expect(teamSurplusExecutionSchemaReady({})).toBe(false);
 const h=await executionFixture(false);expect((await db.query("select surplus_execution_enabled from sales_team_controls_v1")).rows).toEqual([{surplus_execution_enabled:false}]);
 expect(await h.dispatch(false)).toMatchObject({status:"not_dispatched",bankConfirmed:false});expect(h.raw).not.toHaveBeenCalled();
 expect(await h.dispatch()).toMatchObject({status:"not_enabled",bankConfirmed:false});expect(h.errors).toEqual([]);expect(h.actions.every(x=>x.startsWith("GET"))).toBe(true);
 expect((await db.query("select count(*)::int n from sales_team_provider_operations_v1 where kind='withdrawal'")).rows).toEqual([{n:0}]);
});

test("one exact payout is independently bound, debited and resolved without claiming bank receipt",async()=>{
 const h=await executionFixture(),before=await epoch(),result=await h.dispatch();expect(h.errors).toEqual([]);expect(result).toMatchObject({status:"observed",complete:true,disposition:"debit_observed",bankConfirmed:false});
 const posts=h.raw.mock.calls.filter(([method])=>method==="POST");expect(posts).toHaveLength(1);expect(posts[0]).toEqual(["POST","/v1/payouts",h.q.request.params,expect.objectContaining({apiVersion:"2026-08-26.dahlia",maxNetworkRetries:0,idempotencyKey:`cn-team-v1:${h.q.operation_id}`,timeout:expect.any(Number)})]);
 expect((await db.query("select count(*)::int n from sales_team_surplus_execution_checks_v1")).rows).toEqual([{n:2}]);
 expect((await db.query("select phase from sales_team_surplus_execution_actions_v1 order by id")).rows).toEqual([{phase:"assert"},{phase:"dispatch"},{phase:"bind"}]);
 expect((await db.query("select kind,amount_cents::int amount,fee_cents::int fee from sales_team_surplus_balance_entries_v1")).rows).toEqual([{kind:"debit",amount:-5000,fee:0}]);
 expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:0}]);expect(await epoch()).toBe(before+1);
 expect((await db.query("select creatornet_team_private.cash_available_floor_v1($1,to_jsonb(epoch)) n from sales_team_cash_epoch_v1",[h.c.context])).rows).toEqual([{n:null}]);
 expect(await h.dispatch()).toMatchObject({status:"observed",bankConfirmed:false});expect(h.errors).toEqual([]);expect(h.raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);expect(await epoch()).toBe(before+1);
});

test("a lost payout response remains the same unknown original and is never posted again",async()=>{
 const h=await executionFixture();h.losePost();expect(await h.dispatch()).toMatchObject({status:"reconciliation_required"});expect(h.errors).toEqual([]);
 expect((await db.query("select status,provider_id from sales_team_provider_operations_v1 where id=$1",[h.q.operation_id])).rows).toEqual([{status:"unknown",provider_id:null}]);
 expect(await h.dispatch()).toMatchObject({status:"reconciliation_required"});expect(h.raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
 expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:5020}]);
 await denied(()=>h.rpc("run_sales_team_surplus_execution_v1",{p_run_id:h.run.runId,p_lease_token:h.run.leaseToken,p_context:h.c.context,p_request_id:h.q.id,p_phase:"cancel",p_payload:{}}).then(r=>{if(r.error)throw r.error;}),/ORIGINAL_SURPLUS_RECOVERY_REQUIRED/);
});

test.each(["cash","bank","control"])("a post-claim %s loss prevents the payout POST and keeps its original reservation",async fault=>{
 const h=await executionFixture();h.hook(async(name,args)=>{
  if(name!=="run_sales_team_surplus_execution_v1")return;
  if(args.p_phase==="claim"){if(fault==="cash")h.setAvailable(3000);if(fault==="bank")h.bank.status="errored";}
  if(args.p_phase==="assert"&&fault==="control")await db.exec("update sales_team_controls_v1 set surplus_execution_enabled=false");
 });
 expect(await h.dispatch()).toMatchObject({status:"reconciliation_required"});expect(h.raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(0);
 expect((await db.query("select count(*)::int n from sales_team_surplus_resolutions_v1")).rows).toEqual([{n:0}]);expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:5020}]);
});

test("a paid observation followed by a late failed return appends money once and preserves its first resolution",async()=>{
 const h=await executionFixture(),before=await epoch();h.payout.status="paid";expect(await h.dispatch()).toMatchObject({status:"observed",bankConfirmed:false});expect(h.errors).toEqual([]);
 await db.exec("update sales_team_controls_v1 set surplus_execution_enabled=false,surplus_reservations_enabled=false");h.bank.status="errored";h.payout.status="failed";h.payout.failure_balance_transaction="txn_return";
 expect(await h.dispatch()).toMatchObject({status:"observed",disposition:"returned",bankConfirmed:false});expect(h.errors).toEqual([]);
 expect((await db.query("select disposition from sales_team_surplus_resolutions_v1")).rows).toEqual([{disposition:"debit_observed"}]);
 expect((await db.query("select kind,amount_cents::int amount from sales_team_surplus_balance_entries_v1 order by kind")).rows).toEqual([{kind:"debit",amount:-5000},{kind:"return",amount:5000}]);expect(await epoch()).toBe(before+2);
 await h.dispatch();expect(h.errors).toEqual([]);expect(await epoch()).toBe(before+2);expect(h.raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});

test("an available debit with pending failed return keeps the reservation until independent return availability",async()=>{
 const h=await executionFixture(),before=await epoch();h.payout.status="failed";h.payout.failure_balance_transaction="txn_return";h.returned.status="pending";
 expect(await h.dispatch()).toMatchObject({status:"reconciliation_required",complete:false,bankConfirmed:false});expect(h.errors).toEqual([]);expect(await epoch()).toBe(before+1);
 expect((await db.query("select creatornet_team_private.cash_encumbered_v1()::int n")).rows).toEqual([{n:5020}]);
 h.returned.status="available";expect(await h.dispatch()).toMatchObject({status:"observed",disposition:"returned"});expect(h.errors).toEqual([]);expect(await epoch()).toBe(before+2);
});

test("a true debit exceeding the cost reserve is recorded and holds future new surplus",async()=>{
 const h=await executionFixture();h.debit.fee=21;h.debit.net=-5021;h.debit.fee_details=[{amount:21,currency:"usd",application:null,description:null,type:"stripe_fee"}];
 expect(await h.dispatch()).toMatchObject({status:"observed",held:true,bankConfirmed:false});expect(h.errors).toEqual([]);
 expect((await db.query("select fee_cents::int fee from sales_team_surplus_balance_entries_v1")).rows).toEqual([{fee:21}]);expect((await db.query("select code,status from sales_team_financial_alerts_v1 where code like 'SURPLUS_%'")).rows).toEqual([{code:"SURPLUS_COST_RESERVE_EXCEEDED",status:"open"}]);
});

test("only actual journal absence can cancel a never-dispatched original and expire prior cash",async()=>{
 const h=await executionFixture(),before=await epoch(),result=await executePort(h,"cancel");expect(result.error).toBeNull();expect(result.data).toMatchObject({resolved:true});expect(await epoch()).toBe(before+1);
 expect(await h.dispatch()).toMatchObject({status:"not_dispatched"});expect(h.raw).not.toHaveBeenCalled();await executePort(h,"cancel");expect(await epoch()).toBe(before+1);
});

test("an asserted original response can bind after its provider lease without gaining dispatch authority",async()=>{
 const h=await executionFixture();h.hook(async(name,args)=>{if(name==="run_sales_team_surplus_execution_v1"&&args.p_phase==="dispatch")await advance(31000);});
 await h.dispatch();expect((await db.query("select status,provider_id from sales_team_provider_operations_v1 where id=$1",[h.q.operation_id])).rows).toEqual([{status:"bound",provider_id:"po_original"}]);expect(h.raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});

test("bound money observation works after the worker finishes and every new-money switch is off",async()=>{
 const h=await executionFixture();await h.dispatch();expect(h.errors).toEqual([]);
 await db.exec("update sales_team_controls_v1 set surplus_execution_enabled=false,surplus_reservations_enabled=false,cash_reservations_enabled=false;update sales_team_worker_runs_v1 set status='complete' where kind='surplus'");
 h.payout.status="failed";h.payout.failure_balance_transaction="txn_return";h.bank.status="errored";
 expect(await observeTeamDailySurplus(h.c,h.q.id)).toMatchObject({status:"observed",disposition:"returned",bankConfirmed:false});expect(h.errors).toEqual([]);expect(h.raw.mock.calls.filter(([method])=>method==="POST")).toHaveLength(1);
});

test("the actual service role can execute only through private named admissions and money consumers",async()=>{
 const h=await executionFixture();await db.exec("set role service_role");expect(await h.dispatch()).toMatchObject({status:"observed",bankConfirmed:false});expect(h.errors).toEqual([]);await db.exec("reset role;set constraints all immediate");
});

const privateTables=["sales_team_surplus_execution_checks_v1","sales_team_surplus_execution_admissions_v1","sales_team_surplus_execution_actions_v1","sales_team_surplus_checks_v1","sales_team_surplus_observations_v1","sales_team_surplus_balance_entries_v1"];
test.each(["anon","authenticated","service_role"])("%s cannot forge payout authority, balances or bank proof",async role=>{
 for(const table of privateTables)expect((await db.query("select relrowsecurity rls from pg_class where oid=$1::regclass",[`public.${table}`])).rows).toEqual([{rls:true}]);
 await db.exec(`set role ${role}`);for(const table of privateTables)await denied(()=>db.exec(`insert into public.${table} default values`),/permission denied/i);
 await db.exec("reset role");
 for(const signature of ["public.run_sales_team_surplus_execution_v1(uuid,uuid,jsonb,uuid,text,jsonb)","public.begin_sales_team_surplus_check_v1(uuid,uuid,jsonb)","public.complete_sales_team_surplus_check_v1(uuid,uuid,jsonb,jsonb)","creatornet_team_private.guard_team_surplus_journal_v1()"]){
  expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,signature])).rows).toEqual([{allowed:role==="service_role"}]);
 }
});

test("raw legacy journal bind and direct row changes cannot invent a payout outcome",async()=>{
 const h=await executionFixture();h.losePost();await h.dispatch();
 await denied(()=>h.f.rpc("bind_sales_team_operation_before_surplus_v1",[h.q.operation_id,"po_forged","req_forged",true]),/ORIGINAL_SURPLUS_OUTCOME_PROOF_REQUIRED/);
 await denied(()=>db.query("update sales_team_provider_operations_v1 set status='bound',provider_id='po_forged',provider_request_id='req_forged' where id=$1",[h.q.operation_id]),/ORIGINAL_SURPLUS_OUTCOME_PROOF_REQUIRED/);
 await denied(()=>db.query("update sales_team_provider_operations_v1 set first_dispatch_at=clock_timestamp()-interval '1 day' where id=$1",[h.q.operation_id]),/ORIGINAL_SURPLUS_JOURNAL_IMMUTABLE/);
});

test("immutable money history and a returned principal cannot be erased by later stale paid evidence",async()=>{
 const h=await executionFixture();h.payout.status="failed";h.payout.failure_balance_transaction="txn_return";await h.dispatch();expect(h.errors).toEqual([]);
 for(const table of [...privateTables,"sales_team_surplus_resolutions_v1"])await denied(()=>db.exec(`delete from public.${table}`),/IMMUTABLE/);
 h.payout.status="paid";h.payout.failure_balance_transaction=null;
 await expect(observeTeamDailySurplus(h.c,h.q.id)).rejects.toThrow(/ORIGINAL_SURPLUS_RETURN_REQUIRED/);
 expect((await db.query("select count(*)::int n from sales_team_surplus_balance_entries_v1")).rows).toEqual([{n:2}]);
});

test.each(["identity","money","request_ids","bank_confirmation","complete"])("the SQL consumer independently rejects forged %s proof",async fault=>{
 const h=await executionFixture();await h.dispatch();expect(h.errors).toEqual([]);
 h.hook(async(name,args)=>{
  if(name!=="begin_sales_team_surplus_check_v1")return;const proof=(await db.query<{proof:Record<string,unknown>}>("select proof from sales_team_surplus_observations_v1 order by created_at limit 1")).rows[0].proof;
  proof.readStartedAt=Date.now();proof.observedAt=Math.floor(Date.now()/1000);
  if(fault==="identity")proof.requestId=id(299);
  if(fault==="money")(proof.debit as Record<string,unknown>).amountCents=-1;
  if(fault==="request_ids")proof.firstPayoutRequestId=proof.secondPayoutRequestId;
  if(fault==="bank_confirmation")proof.bankConfirmed=true;
  if(fault==="complete")proof.complete=false;
  await denied(()=>h.f.rpc("complete_sales_team_surplus_check_v1",[args.p_check_id,h.q.id,h.c.context,proof]),fault==="request_ids"?/DISTINCT_SURPLUS_READS_REQUIRED/:fault==="money"?/EXACT_SURPLUS_BALANCE_REQUIRED/:fault==="complete"?/DERIVED_SURPLUS_DISPOSITION_REQUIRED/:/FRESH_EXACT_SURPLUS_PAYOUT_REQUIRED/);
 });
 await observeTeamDailySurplus(h.c,h.q.id);expect((await db.query("select count(*)::int n from sales_team_surplus_balance_entries_v1")).rows).toEqual([{n:1}]);
});

test.each(["creatornet_team_private.unreceipted_team_cash_v1(jsonb)","creatornet_team_private.guard_team_surplus_journal_v1()","public.run_sales_team_surplus_execution_v1(uuid,uuid,jsonb,uuid,text,jsonb)","public.complete_sales_team_surplus_check_v1(uuid,uuid,jsonb,jsonb)"])("every financial contract binds the new authority %s",async signature=>{
 const h=await executionFixture(),digests=["transfer_contract_digest_v1","shared_cash_contract_digest_v1","retained_cash_contract_digest_v1","recovery_contract_digest_v1","surplus_contract_digest_v1"],read=async()=>Promise.all(digests.map(async name=>(await db.query<{d:string}>(`select creatornet_team_private.${name}() d`)).rows[0].d)),before=await read();
 const definition=(await db.query<{s:string}>("select pg_get_functiondef($1::regprocedure) s",[signature])).rows[0].s;await db.exec(definition.replace(/AS \$function\$/i,"AS $function$\n-- synthetic authority drift\n"));
 const after=await read();for(let i=0;i<before.length;i++)expect(after[i]).not.toBe(before[i]);await expect(h.dispatch()).rejects.toThrow(/Original surplus task requires review/);expect(h.raw).not.toHaveBeenCalled();
});

test.each(["dependency","late_grant"])("F41 %s failure restores original definitions, grants, columns and triggers",async fault=>{
 const isolated=createLocalPostgres();try{
  await surplusDatabase(isolated);if(fault==="dependency")await isolated.exec("alter function creatornet_team_private.cash_protection_v1(jsonb) rename to fixture_missing_execution_cash");
  const inventory=async()=>(await isolated.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) body,proacl::text grants from pg_proc where pronamespace in ('public'::regnamespace,'creatornet_team_private'::regnamespace) order by oid")).rows;
  const before=await inventory(),sql=readFileSync("supabase/migrations/20261028000209_sales_team_surplus_execution.sql","utf8");
  await expect(isolated.exec(fault==="late_grant"?sql.replace("commit;","grant execute on function public.missing_surplus_execution_grant() to service_role;commit;"):sql)).rejects.toThrow(fault==="dependency"?/cash_protection_v1/:/missing_surplus_execution_grant/);
  await isolated.exec("rollback");expect(await inventory()).toEqual(before);expect((await isolated.query("select to_regclass('public.sales_team_surplus_balance_entries_v1') entries,to_regprocedure('creatornet_team_private.cash_protection_before_surplus_execution_v1(jsonb)') alias")).rows).toEqual([{entries:null,alias:null}]);
  expect((await isolated.query("select count(*)::int n from pg_trigger where tgname='guarded_surplus_journal_v1'")).rows).toEqual([{n:0}]);
  expect((await isolated.query("select count(*)::int n from information_schema.columns where table_name='sales_team_controls_v1' and column_name='surplus_execution_enabled'")).rows).toEqual([{n:0}]);
 }finally{await isolated.close();}
},30000);
