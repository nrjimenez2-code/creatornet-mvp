/** @jest-environment ./test-support/pglite-environment.cjs */
import {readFileSync} from "node:fs";
import type {PGlite} from "@electric-sql/pglite";
import {sharedCashDatabase,sharedCashReconciliationCandidate} from "@/test-support/sales-team-shared-cash-postgres";
import {seedTeamCapture} from "@/test-support/sales-team-capture-postgres";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {teamSupabaseFixture} from "@/test-support/sales-team-supabase-fixture";
import {runTeamAutomaticRecovery} from "@/lib/salesTeams/recovery";
import {inspectSharedUnsentRecovery} from "@/lib/salesTeams/sharedUnsentRecovery";
import {protectSharedCash} from "@/lib/salesTeams/cashFunding";
import {teamCashBalanceFixture} from "@/test-support/sales-team-cash-postgres";
import type {TeamReceiptComposition} from "@/lib/salesTeams/receipts";
import {sharedCashOriginalFixture} from "@/test-support/sales-team-shared-cash-readback";
import type {SharedCashOriginal} from "@/lib/salesTeams/sharedCashReadback";

declare const createLocalPostgres:()=>PGlite;
const candidate="supabase/migrations/20261023174324_sales_team_no_outbound_shared_recovery.sql";
let db:PGlite,f:Awaited<ReturnType<typeof seedTeamCapture>>;
let c:TeamReceiptComposition,values:Record<string,Record<string,unknown>>,raw:jest.Mock;
beforeAll(async()=>{
 db=await sharedCashDatabase(createLocalPostgres());
 for(const path of [sharedCashReconciliationCandidate,"supabase/migrations/20261023042321_sales_team_retained_refund_funding.sql","supabase/migrations/20261023060912_sales_team_automatic_recovery.sql","supabase/migrations/20261023063905_sales_team_worker_refund_recovery.sql",candidate,"supabase/migrations/20261023180144_sales_team_transfer_reservations.sql","supabase/migrations/20261023182527_sales_team_transfer_observations.sql","supabase/migrations/20261023184139_sales_team_transfer_execution.sql","supabase/migrations/20261023190044_sales_team_automatic_settlement.sql","supabase/migrations/20261024210829_sales_team_transfer_reversal_observations.sql","supabase/migrations/20261024213841_sales_team_transfer_recovery_reservations.sql","supabase/migrations/20261024215948_sales_team_transfer_recovery_execution.sql","supabase/migrations/20261025184802_sales_team_transfer_reversal_recovery.sql","supabase/migrations/20261025191826_sales_team_combined_settlement.sql","supabase/migrations/20261025195351_sales_team_later_collection.sql"])await db.exec(readFileSync(path,"utf8"));
},30000);
beforeEach(async()=>{await db.exec("begin");});
afterEach(async()=>{await db.exec("rollback;reset role");});
afterAll(async()=>{await db?.close();});
async function fixture(){
 await db.exec("update sales_team_controls_v1 set event_reconciliation_enabled=true,financial_reconciliation_enabled=true,fulfillment_enabled=true,shared_cash_reconciliation_enabled=true,automatic_recovery_enabled=true,shared_no_outbound_recovery_enabled=true");
 f=await seedTeamCapture(db);await f.record();await db.query("update profiles set role='admin' where id=$1",[id(29)]);
 await db.exec("update sales_team_cash_policy_v1 set reserve_cents=1000,refund_cost_reserve_cents=100,legacy_refund_cost_reserve_cents=100,tip_restoration_cost_reserve_cents=50,evidence='{\"scope\":\"synthetic no-outbound fixture only\"}',shared_adapter_sha256=encode(sha256(convert_to(pg_get_functiondef('creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb)'::regprocedure),'UTF8')),'hex'),shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1(),recovery_contract_sha256=creatornet_team_private.recovery_contract_digest_v1(),no_outbound_contract_sha256=creatornet_team_private.no_outbound_contract_digest_v1()");
 values={"/v1/balance":teamCashBalanceFixture,"/v1/charges/ch_legacy":{object:"charge",id:"ch_legacy",payment_intent:"pi_legacy",currency:"usd",livemode:false,paid:true,captured:true,status:"succeeded",amount:10000,amount_refunded:0,application_fee:"fee_legacy",transfer:"tr_legacy",transfer_data:{destination:"acct_legacy"}}};let sequence=0;
 raw=jest.fn(async(method:string,path:string)=>{if(method!=="GET"||!values[path])throw Error("Only bounded original GETs permitted");return JSON.parse(JSON.stringify({...values[path],lastResponse:{requestId:`req_unsentRuntime${++sequence}`}}));});
 c={admin:teamSupabaseFixture(db),context:f.contract.context,observeContext:async()=>f.contract.context,observeEvidence:async()=>f.evidence,stripe:{rawRequest:raw}};
}
async function legacy(){
 await db.query("insert into payment_fee_ledger(id,creator_id,stripe_payment_intent_id,stripe_charge_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,creator_net_cents,currency,fee_schedule_version) values($1,$2,'pi_legacy','ch_legacy',10000,1200,320,1520,8480,'usd','fixture')",[id(90),id(1)]);
 await f.rpc("create_refund_operation",[id(91),id(90),1000,"creator_discretionary","creator",null,"fixture-no-outbound-original",id(29),"ch_legacy","fee_legacy",0,0,320]);
 await db.exec("update refund_operations set status='failed'");
}
async function tip(status="lost",reversalCents=1000){
 await db.query("insert into tips(id,creator_id,stripe_destination_account_id,currency,dispute_status) values($1,$2,'acct_creator','usd',$3)",[id(90),id(1),status]);
 await f.rpc(status==="won"?"record_tip_dispute_with_cash_v1":"record_tip_dispute_recovery",["dp_unsent",id(90),"pi_tip","ch_tip","tr_tip",1000,Math.floor(Date.now()/1000),reversalCents,status]);
 values["/v1/charges/ch_tip"]={object:"charge",id:"ch_tip",payment_intent:"pi_tip",currency:"usd",livemode:false,paid:true,captured:true,status:"succeeded",amount:2000,amount_refunded:0,application_fee:null,transfer:"tr_tip",transfer_data:{destination:"acct_creator"}};
 values["/v1/disputes/dp_unsent"]={object:"dispute",id:"dp_unsent",charge:"ch_tip",payment_intent:"pi_tip",currency:"usd",livemode:false,amount:1000,status};
 values["/v1/transfers/tr_tip"]={object:"transfer",id:"tr_tip",source_transaction:"ch_tip",destination:"acct_creator",currency:"usd",livemode:false,amount:1000,amount_reversed:1000};
}
type Run={runId:string;leaseToken:string;taskId:string};
async function task(){
 const run=await f.rpc<{runId:string;leaseToken:string}>("claim_sales_team_recovery_run_v1",[id(80),f.contract.context]);
 const t=await f.rpc<{id:string;kind:string}>("next_sales_team_recovery_task_v1",[run.runId,run.leaseToken,f.contract.context,false]);expect(t.kind).toBe("shared_cash");return {...run,taskId:t.id};
}
const begin=(run:Run)=>f.rpc<{eligible:boolean;completed?:boolean;held?:boolean;source:Record<string,unknown>}>("begin_sales_team_shared_unsent_v1",[run.runId,run.leaseToken,f.contract.context,run.taskId]);
const liability=async()=>Number((await db.query<{r:{protectedCents:number}}>("select creatornet_team_private.shared_platform_cash_liabilities_v1($1) r",[f.contract.context])).rows[0].r.protectedCents);
function proof(source:Record<string,unknown>){
 const charge={id:"ch_legacy",paymentIntentId:"pi_legacy",currency:"usd",livemode:false,paid:true,captured:true,status:"succeeded",amountCents:10000,refundedCents:0,applicationFeeId:"fee_legacy",transferId:null,destinationId:null};
 return {fingerprint:source.fingerprint,context:f.contract.context,readStartedAt:Date.now(),charge:{first:{...charge},second:{...charge}},dispute:null,originalTransfer:null,reads:[{path:"/v1/charges/ch_legacy",requestId:"req_unsentFirst"},{path:"/v1/charges/ch_legacy",requestId:"req_unsentSecond"}]};
}
const complete=(run:Run,p:unknown)=>f.rpc<{held:boolean}>("complete_sales_team_shared_unsent_v1",[run.runId,run.leaseToken,f.contract.context,run.taskId,p]);
const denied=async(run:()=>Promise<unknown>,message:RegExp)=>{await db.exec("savepoint denied");try{await expect(run()).rejects.toThrow(message);}finally{await db.exec("rollback to savepoint denied");}};

test("the actual no-outbound candidate installs default off",async()=>{
 expect((await db.query("select shared_no_outbound_recovery_enabled from sales_team_controls_v1")).rows).toEqual([{shared_no_outbound_recovery_enabled:false}]);
});
test("a born-guarded never-claimed terminal original releases only after independent source proof",async()=>{
 await fixture();await legacy();const held=await liability();expect(held).toBeGreaterThan(1000);const run=await task(),b=await begin(run);expect(b.eligible).toBe(true);
 expect(await complete(run,proof(b.source))).toEqual({held:false});expect(await liability()).toBe(0);
 await f.rpc("finish_sales_team_recovery_task_v1",[run.runId,run.leaseToken,f.contract.context,run.taskId,false]);await db.exec("set constraints all immediate");
 expect((await db.query("select count(*)::int n from sales_team_shared_unsent_origins_v1")).rows).toEqual([{n:1}]);
});

test("the bounded worker retires the unsent obligation without a provider write and skips settled requeue",async()=>{
 await fixture();await legacy();expect(await runTeamAutomaticRecovery(c,{recoverSharedUnsent:true})).toEqual({status:"complete",observed:1,held:0});expect(raw).toHaveBeenCalledTimes(2);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);expect(await liability()).toBe(0);
 raw.mockClear();expect(await runTeamAutomaticRecovery(c,{recoverSharedUnsent:true})).toMatchObject({status:"slot_consumed",observed:0});expect(raw).not.toHaveBeenCalled();
});

test("missing immutable birth provenance never turns a historical terminal status into a release",async()=>{
 await fixture();await db.exec("alter table refund_operations disable trigger sales_team_unsent_refund_origin_v1");await legacy();await db.exec("alter table refund_operations enable trigger sales_team_unsent_refund_origin_v1");
 expect(await runTeamAutomaticRecovery(c,{recoverSharedUnsent:true})).toEqual({status:"review_required",observed:0,held:1});expect(raw).not.toHaveBeenCalled();expect(await liability()).toBeGreaterThan(1000);
});

test("a single admitted outgoing attempt stays held even when no provider identity was returned",async()=>{
 await fixture();await legacy();await db.exec("update sales_team_controls_v1 set cash_reservations_enabled=true");
 await protectSharedCash(c,{kind:"legacy_refund",id:id(91)},id(29));raw.mockClear();
 expect(await runTeamAutomaticRecovery(c,{recoverSharedUnsent:true})).toEqual({status:"review_required",observed:0,held:1});expect(raw).not.toHaveBeenCalled();expect(await liability()).toBeGreaterThan(1000);
});

test("claimed originals are ineligible even if their current status and provider IDs look unsent",async()=>{
 await fixture();await legacy();await db.exec("update refund_operations set attempt_count=1");const run=await task();expect(await begin(run)).toEqual({eligible:false});expect(await liability()).toBeGreaterThan(1000);
});

test.each(["stable","parent","request","context","extra","stale"])("SQL rejects forged %s proof without releasing cash",async change=>{
 await fixture();await legacy();const run=await task(),b=await begin(run),p=proof(b.source);
 if(change==="stable")p.charge.second.amountCents--;
 if(change==="parent")p.charge.first.paymentIntentId=p.charge.second.paymentIntentId="pi_foreign";
 if(change==="request")p.reads[1].requestId=p.reads[0].requestId;
 if(change==="context")p.context={...p.context,mode:"live"};
 if(change==="extra")Object.assign(p,{privateCustomer:"unwanted"});
 if(change==="stale")p.readStartedAt-=60000;
 await denied(()=>complete(run,p),/REQUIRED|SHAPE/);expect((await db.query("select count(*)::int n from sales_team_shared_unsent_results_v1")).rows).toEqual([{n:0}]);expect(await liability()).toBeGreaterThan(1000);
});

test("a changing source during observation records held without financial release",async()=>{
 await fixture();await legacy();const get=raw.getMockImplementation()!;let n=0;
 raw.mockImplementation(async(...args)=>{if(++n===2)await db.exec("update refund_operations set status='pending'");return get(...args);});
 expect(await runTeamAutomaticRecovery(c,{recoverSharedUnsent:true})).toMatchObject({status:"review_required",held:1});expect(await liability()).toBeGreaterThan(1000);expect((await db.query("select proof from sales_team_shared_unsent_results_v1")).rows).toEqual([{proof:{holdReason:"source_changed"}}]);
});

test("a later source change restores the full commitment and invalidates old cash observations",async()=>{
 await fixture();await legacy();await db.exec("update sales_team_controls_v1 set cash_reservations_enabled=true");
 expect(await runTeamAutomaticRecovery(c,{recoverSharedUnsent:true})).toMatchObject({observed:1,held:0});expect(await liability()).toBe(0);
 await f.rpc("begin_sales_team_cash_read_v1",[id(94),id(29),c.context]);await db.exec("update refund_operations set status='pending'");expect(await liability()).toBeGreaterThan(1000);
 await denied(()=>f.rpc("complete_sales_team_cash_read_v1",[id(94),id(29),{context:c.context,availableCents:1000000,firstRequestId:"req_first",secondRequestId:"req_second",readStartedAt:Date.now()}]),/FRESH_PLATFORM_CASH_REQUIRED/);
});

test("current worker token, exact task identity and immutable history remain enforced",async()=>{
 await fixture();await legacy();const run=await task();await denied(()=>begin({...run,leaseToken:id(81)}),/CURRENT_RECOVERY_WORKER_REQUIRED/);
 const b=await begin(run);await denied(()=>db.exec("delete from sales_team_shared_unsent_origins_v1"),/immutable/i);
 await complete(run,proof(b.source));await denied(()=>db.exec("update sales_team_shared_unsent_results_v1 set held=true"),/immutable/i);
 await db.exec("set role authenticated");await denied(()=>db.exec("select * from sales_team_shared_unsent_origins_v1"),/permission denied/i);
});

test("completed checks replay without another provider GET while new work gates are disabled",async()=>{
 await fixture();await legacy();const run=await task();expect(await inspectSharedUnsentRecovery(c,run)).toEqual({held:false});raw.mockClear();await db.exec("update sales_team_controls_v1 set shared_no_outbound_recovery_enabled=false,cash_reservations_enabled=false");
 expect(await inspectSharedUnsentRecovery(c,run)).toEqual({held:false});expect(raw).not.toHaveBeenCalled();expect(await liability()).toBe(0);
});

test.each(["lost","prevented","warning_closed"])("a current %s tip dispute with no admitted restoration releases after two original charge/dispute reads",async status=>{
 await fixture();await tip(status);expect(await liability()).toBe(1050);await db.exec("set role service_role");
 expect(await runTeamAutomaticRecovery(c,{recoverSharedUnsent:true})).toEqual({status:"complete",observed:1,held:0});expect(await liability()).toBe(0);expect(raw).toHaveBeenCalledTimes(4);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);await db.exec("set constraints all immediate");
});

test("a later genuine win restores protection before the original restoration can be admitted",async()=>{
 await fixture();await tip();await db.exec("update sales_team_controls_v1 set cash_reservations_enabled=true");
 expect(await runTeamAutomaticRecovery(c,{recoverSharedUnsent:true})).toMatchObject({observed:1,held:0});expect(await liability()).toBe(0);
 expect(await f.rpc("record_tip_dispute_with_cash_v1",["dp_unsent",id(90),"pi_tip","ch_tip","tr_tip",1000,Math.floor(Date.now()/1000)+1,1000,"won"])).toBe(false);
 expect(await liability()).toBe(1050);expect(await f.rpc("sales_team_shared_cash_admitted_v1",["tip_restoration","dp_unsent"])).toBe(false);
 await protectSharedCash(c,{kind:"tip_restoration",id:"dp_unsent"},null);
 expect(await f.rpc("sales_team_shared_cash_admitted_v1",["tip_restoration","dp_unsent"])).toBe(true);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});

test("pending or failed restoration attempts and changed provider conditions remain held",async()=>{
 await fixture();await tip();await db.exec("update tip_dispute_recoveries set restoration_status='failed'");const run=await task();expect(await begin(run)).toEqual({eligible:false});expect(await liability()).toBe(1050);
});

test("the SQL verifier refuses a claimed terminal tip condition that the actual provider no longer reports",async()=>{
 await fixture();await tip();values["/v1/disputes/dp_unsent"].status="won";
 const run=await task();await denied(()=>inspectSharedUnsentRecovery(c,run),/OWNED_TERMINAL_UNSENT_DISPUTE_REQUIRED/);expect(await liability()).toBe(1050);
});

test("missing reviewed source hash or disabled execution control admits no unsent proof",async()=>{
 await fixture();await legacy();const run=await task();await db.exec("update sales_team_controls_v1 set shared_no_outbound_recovery_enabled=false");expect(await begin(run)).toEqual({eligible:false});
 await db.exec("update sales_team_controls_v1 set shared_no_outbound_recovery_enabled=true;update sales_team_cash_policy_v1 set no_outbound_contract_sha256=null");expect(await begin(run)).toEqual({eligible:false});expect(raw).not.toHaveBeenCalled();
});

test("a source born with a disabled outgoing coverage trigger cannot acquire provenance retroactively",async()=>{
 await fixture();await db.exec("alter table refund_operations disable trigger sales_team_shared_refund_cash_v1");await legacy();await db.exec("alter table refund_operations enable trigger sales_team_shared_refund_cash_v1;update refund_operations set status='failed'");
 const run=await task();expect(await begin(run)).toEqual({eligible:false});expect((await db.query("select count(*)::int n from sales_team_shared_unsent_origins_v1")).rows).toEqual([{n:0}]);expect(await liability()).toBeGreaterThan(1000);
});

test("known actual outflows retain their original independent cash-resolution path after F22",async()=>{
 await fixture();await legacy();await db.exec("update refund_operations set status='completed',stripe_refund_status='succeeded',stripe_refund_id='re_legacy',stripe_application_fee_refund_id='fr_legacy',stripe_application_fee_refund_amount_cents=application_fee_refund_amount_cents");
 const source=(await db.query<{s:SharedCashOriginal}>("select creatornet_team_private.shared_cash_original_v1('legacy_refund',$1,$2) s",[id(91),c.context])).rows[0].s;Object.assign(values,sharedCashOriginalFixture(source).values);
 expect(await runTeamAutomaticRecovery(c,{recoverSharedUnsent:true})).toEqual({status:"complete",observed:1,held:0});expect(await liability()).toBe(0);
 expect((await db.query("select count(*)::int n from sales_team_shared_cash_resolutions_v1")).rows).toEqual([{n:1}]);expect((await db.query("select count(*)::int n from sales_team_shared_unsent_resolutions_v1")).rows).toEqual([{n:0}]);
});

test("a won dispute with an originally frozen zero reversal verifies the fully reversed original transfer",async()=>{
 await fixture();await tip("won",0);expect(await runTeamAutomaticRecovery(c,{recoverSharedUnsent:true})).toEqual({status:"complete",observed:1,held:0});expect(await liability()).toBe(0);expect(raw).toHaveBeenCalledTimes(6);expect(raw.mock.calls.every(([method])=>method==="GET")).toBe(true);
});

test("a won dispute with a positive frozen reversal still requires its actual restoration original",async()=>{
 await fixture();await tip("won");expect(await runTeamAutomaticRecovery(c,{recoverSharedUnsent:true})).toEqual({status:"review_required",observed:0,held:1});expect(await liability()).toBe(1050);expect(raw).not.toHaveBeenCalled();
});

test.each(["balance","parent"])("zero-restoration release refuses changed original transfer %s proof",async change=>{
 await fixture();await tip("won",0);if(change==="balance")values["/v1/transfers/tr_tip"].amount_reversed=999;else values["/v1/transfers/tr_tip"].source_transaction="ch_foreign";
 const run=await task();await denied(()=>inspectSharedUnsentRecovery(c,run),/ACTUAL_ZERO_RESTORATION_OBLIGATION_REQUIRED/);expect(await liability()).toBe(1050);
});
