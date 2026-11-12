/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {teamSharedDatabase} from "@/test-support/sales-team-shared-postgres";
import {installMonthlySharedGuardFixture,installMonthlySharedAccountingFixture,mirrorDiscoverSecurityFixture} from "@/test-support/sales-team-monthly-shared-postgres";
import {ordinary,monthly,historyTables,deliveryTables,seedPreinstallationHistory,preinstallationSnapshot,type Snapshot} from "@/test-support/sales-team-preinstallation-history";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {captureRpc as rpc} from "@/test-support/sales-team-capture-postgres";

declare const createLocalPostgres:()=>PGlite;
let db:PGlite,before:Snapshot,after:Snapshot;
const helpers=["credit_purchase_earnings(uuid,integer)","reverse_purchase_earnings(uuid)","credit_payment_fee_ledger_earnings(uuid)","apply_purchase_refund_earnings(uuid,bigint)","apply_payment_fee_ledger_refund(uuid,bigint)"];
const rows=async(sql:string,args:unknown[]=[]) => (await db.query<Record<string,unknown>>(sql,args)).rows;
let originalRoutines:Awaited<ReturnType<typeof rows>>,retainedRoutines:Awaited<ReturnType<typeof rows>>;
let originalTriggers:Awaited<ReturnType<typeof rows>>,retainedTriggers:Awaited<ReturnType<typeof rows>>;
const routineInventory=()=>rows(`select oid,proowner,prosrc,prosecdef,proconfig from pg_proc where oid=any($1::regprocedure[]) order by oid`,[helpers.map(h=>"public."+h)]);
const triggerInventory=()=>rows(`select oid,tgrelid,tgname,tgfoid,tgenabled,pg_get_triggerdef(oid) definition from pg_trigger where not tgisinternal
 and tgrelid=any($1::regclass[]) and tgname not like 'sales_team_%' order by oid`,[historyTables]);
function oldColumns(actual:Snapshot){
 const result:Snapshot={};
 for(const table of historyTables){
  const keys=Object.keys(before[table][0] as Record<string,unknown>);
  result[table]=actual[table].map(r=>Object.fromEntries(keys.map(k=>[k,(r as Record<string,unknown>)[k]])))
   .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 }
 return result;
}
const denied=async(action:()=>Promise<unknown>,pattern:RegExp)=>{
 await db.exec("savepoint denied");
 try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied;release savepoint denied");}
};
beforeAll(async()=>{
 db=createLocalPostgres();await teamSharedDatabase(db,false);
 // No bank-alert/later-team builder is called here: F11 does not yet exist.
 await installMonthlySharedGuardFixture(db);await installMonthlySharedAccountingFixture(db,false);await mirrorDiscoverSecurityFixture(db);
 expect(await rows("select to_regclass('public.sales_team_shared_receipts_v1') shared")).toEqual([{shared:null}]);
 await seedPreinstallationHistory(db);
 // Preserve a genuinely nonzero historical refund when F11 replaces both
 // ledger constraints; paid-only rows would miss this compatibility case.
 expect(Number(await rpc(db,"apply_purchase_refund_earnings",[ordinary.purchase,200]))).toBe(170);
 expect(Number(await rpc(db,"apply_payment_fee_ledger_refund",[ordinary.ledger,200]))).toBe(0);
 before=await preinstallationSnapshot(db);originalRoutines=await routineInventory();originalTriggers=await triggerInventory();
 await db.exec(readFileSync("supabase/migrations/20261022234208_sales_team_shared_fulfillment.sql","utf8"));
 after=await preinstallationSnapshot(db);
 retainedRoutines=await rows("select oid,proowner,prosrc,prosecdef,proconfig from pg_proc where oid=any($1::oid[]) order by oid",[originalRoutines.map(r=>r.oid)]);
 retainedTriggers=await triggerInventory();
},30000);
beforeEach(async()=>{await db.exec("begin");});
afterEach(async()=>{await db.exec("rollback;reset role");});
afterAll(async()=>{await db?.close();});

test("F11 preserves every original historical column, including already-refunded amounts and frozen delivery",()=>{
 for(const table of historyTables)expect(before[table].length).toBeGreaterThan(0);
 expect(before.purchases).toHaveLength(2);expect(before.payment_fee_ledger).toHaveLength(2);expect(before.purchase_deliveries).toHaveLength(2);
 expect(oldColumns(after)).toEqual(oldColumns(before));
});
test("F11 adds only empty team identities/reserves to legacy financial rows and keeps fulfillment disabled",async()=>{
 expect(await rows("select sales_team_sale_id from purchases")).toEqual([{sales_team_sale_id:null},{sales_team_sale_id:null}]);
 expect(await rows("select sales_team_sale_id,sales_team_receipt_id from orders")).toEqual([{sales_team_sale_id:null,sales_team_receipt_id:null}]);
 expect(await rows(`select count(*)::int n from payment_fee_ledger where sales_team_sale_id is not null or sales_team_receipt_id is not null or
  team_commission_cents<>0 or team_processing_reserve_cents<>0 or team_payout_reserve_cents<>0 or team_tax_reserve_cents<>0 or
  team_loss_subtotal_cents<>0 or team_processing_credit_cents<>0 or team_creator_deficit_cents<>0 or team_financial_hold`)).toEqual([{n:0}]);
 expect(await rows("select fulfillment_enabled from sales_team_controls_v1")).toEqual([{fulfillment_enabled:false}]);
 for(const table of ["sales_team_purchase_bindings_v1","sales_team_shared_receipts_v1","sales_team_purchase_statistics_v1"])
  expect(await rows(`select count(*)::int n from ${table}`)).toEqual([{n:0}]);
});
test("F11 retains original helper OIDs/bodies/ownership/security and legacy trigger definitions",async()=>{
 expect(originalRoutines).toHaveLength(5);expect(retainedRoutines).toEqual(originalRoutines);
 expect(originalTriggers.length).toBeGreaterThanOrEqual(10);expect(retainedTriggers).toEqual(originalTriggers);
 for(const signature of helpers){
  const renamed=signature.replace("(","_before_team_v1(");
  expect(await rows("select count(*)::int n from pg_proc where oid=$1::regprocedure and oid=any($2::oid[])",["public."+renamed,originalRoutines.map(r=>r.oid)])).toEqual([{n:1}]);
 }
});
test.each(["anon","authenticated","service_role"])("F11 explicitly restricts wrapper and delegate execution for %s",async role=>{
 for(const helper of helpers)for(const signature of [helper,helper.replace("(","_before_team_v1(")])
  expect(await rows("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,"public."+signature])).toEqual([{allowed:role==="service_role"}]);
});
test.each([
 ["total_creator_deduction_cents=151,creator_net_cents=849",/payment_fee_ledger_split_check/],
 ["refunded_amount_cents=100",/payment_fee_ledger_refund_check/],
 ["earnings_reversed_cents=999",/payment_fee_ledger_refund_check/]
] as const)("F11 still rejects invalid legacy ledger changes: %s",async(change,pattern)=>{
 const previous=await preinstallationSnapshot(db);
 await denied(()=>db.query(`update payment_fee_ledger set ${change} where id=$1`,[ordinary.ledger]),pattern);
 expect(await preinstallationSnapshot(db)).toEqual(previous);
});
test("new F11 wrappers finish an existing partial one-time refund without double reversal or identity changes",async()=>{
 const delivery=await preinstallationSnapshot(db,deliveryTables),monthlyRows=await rows("select * from purchases where id=$1",[monthly.purchase]);
 const event=await rows("select id,entity_key,occurred_at from discover_events_v1 where entity_key=$1",["purchase:"+ordinary.purchase]);
 await db.exec("set role service_role");
 expect(await rpc(db,"credit_purchase_earnings",[ordinary.purchase,850])).toBe(false);
 for(const [gross,delta] of [[200,0],[100,0],[1000,680],[1000,0]]){
  expect(Number(await rpc(db,"apply_purchase_refund_earnings",[ordinary.purchase,gross]))).toBe(delta);
  expect(Number(await rpc(db,"apply_payment_fee_ledger_refund",[ordinary.ledger,gross]))).toBe(0);
 }
 await db.exec("reset role");
 expect(await rows("select total_earnings_cents::int earnings from profiles where id=$1",[id(1)])).toEqual([{earnings:850}]);
 expect(await rows("select id,order_id,payment_intent_id,status,access_granted,refunded_amount_cents::int refunded from purchases where id=$1",[ordinary.purchase]))
  .toEqual([{id:ordinary.purchase,order_id:ordinary.order,payment_intent_id:"pi_preinstall_ordinary",status:"refunded",access_granted:false,refunded:1000}]);
 expect(await rows("select id,entity_key,occurred_at from discover_events_v1 where entity_key=$1",["purchase:"+ordinary.purchase])).toEqual(event);
 expect(await rows("select amount_cents::int amount,valid from discover_events_v1 where entity_key=$1",["purchase:"+ordinary.purchase])).toEqual([{amount:0,valid:false}]);
 expect(await rows("select * from purchases where id=$1",[monthly.purchase])).toEqual(monthlyRows);expect(await preinstallationSnapshot(db,deliveryTables)).toEqual(delivery);
});
test("F11 monthly invoice refunds debit the invoice owner without adopting the legacy purchase",async()=>{
 const monthlyRows=await rows("select * from purchases where id=$1",[monthly.purchase]),agreement=await rows("select * from monthly_mentorship_agreements_v1"),delivery=await preinstallationSnapshot(db,deliveryTables);
 await db.exec("set role service_role");
 expect(await rpc(db,"credit_payment_fee_ledger_earnings",[monthly.ledger])).toBe(false);
 for(const [gross,delta] of [[200,170],[200,0],[1000,680],[1000,0]])
  expect(Number(await rpc(db,"apply_payment_fee_ledger_refund",[monthly.ledger,gross]))).toBe(delta);
 await db.exec("reset role");
 expect(await rows("select total_earnings_cents::int earnings from profiles where id=$1",[id(1)])).toEqual([{earnings:680}]);
 expect(await rows("select total_earnings_cents::int earnings from profiles where id=$1",[id(4)])).toEqual([{earnings:777}]);
 expect(await rows("select * from purchases where id=$1",[monthly.purchase])).toEqual(monthlyRows);expect(await rows("select * from monthly_mentorship_agreements_v1")).toEqual(agreement);
 expect(await preinstallationSnapshot(db,deliveryTables)).toEqual(delivery);
});
test("F11 retains monthly/immutable delivery fences and rejects legacy adoption",async()=>{
 const previous=await preinstallationSnapshot(db);
 await denied(()=>db.query("update purchases set access_granted=true where id=$1",[monthly.purchase]),/Monthly service cannot use legacy ownership/);
 await denied(()=>db.query("update purchases set sales_team_sale_id=$1 where id=$2",[id(9791),monthly.purchase]),/ORIGINAL_TEAM_ACCOUNTING_CHANGED/);
 await denied(()=>db.query("update purchases set order_id=$1 where id=$2",[id(9793),ordinary.purchase]),/Purchase delivery cannot be replaced/);
 await denied(()=>db.query("delete from checkout_delivery_snapshots where order_id=$1",[ordinary.order]),/Purchased delivery and published delivery revisions are immutable/);
 expect(await preinstallationSnapshot(db)).toEqual(previous);
});
test.each(["anon","authenticated"])("%s cannot mutate historical money or read delivery after F11",async role=>{
 const previous=await preinstallationSnapshot(db);await db.exec(`set role ${role}`);
 await denied(()=>rpc(db,"apply_purchase_refund_earnings",[ordinary.purchase,1000]),/permission denied/);
 await denied(()=>rpc(db,"apply_payment_fee_ledger_refund",[monthly.ledger,1000]),/permission denied/);
 await denied(()=>db.exec("select * from checkout_delivery_snapshots"),/permission denied/);
 await denied(()=>db.query("update purchases set access_granted=true where id=$1",[monthly.purchase]),/permission denied/);
 await db.exec("reset role");expect(await preinstallationSnapshot(db)).toEqual(previous);
});
