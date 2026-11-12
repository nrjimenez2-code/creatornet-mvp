/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {teamFixtureId as id} from "@/test-support/sales-team-postgres";
import {captureRpc as rpc} from "@/test-support/sales-team-capture-postgres";
import {monthlySharedAccountingDatabase,monthlySharedCandidate,discoverLossCandidate,mirrorDiscoverSecurityFixture,monthlySharedReady} from "@/test-support/sales-team-monthly-shared-postgres";

declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
import {ordinary,monthly,historyTables,deliveryTables,seedPreinstallationHistory,preinstallationSnapshot,type Snapshot} from "@/test-support/sales-team-preinstallation-history";
const rows=async(sql:string,args:unknown[]=[]) => (await db.query(sql,args)).rows;
const snapshot=(tables:readonly string[]=historyTables)=>preinstallationSnapshot(db,tables);
async function retainedCatalog(){
 return {
  routines:await rows(`select oid,oid::regprocedure::text signature,proowner,proacl::text,prosecdef,proconfig,pg_get_functiondef(oid) definition
   from pg_proc where pronamespace='public'::regnamespace and (proname in
   ('guard_monthly_mentorship_purchase_v1','guard_monthly_initial_purchase_close_v1','attach_fixed_service_consent_v1','mask_fixed_service_access_v1',
    'purchases_fill_ids','bind_purchase_delivery_v1','prepare_checkout_delivery_v1','immutable_product_delivery_v1',
    'credit_purchase_earnings','reverse_purchase_earnings','credit_payment_fee_ledger_earnings','apply_purchase_refund_earnings','apply_payment_fee_ledger_refund')
    or proname like '%_before_team_v1') order by oid`),
  triggers:await rows(`select oid,tgrelid::regclass::text relation,tgname,tgenabled,tgfoid,pg_get_triggerdef(oid) definition from pg_trigger
   where not tgisinternal and tgrelid in ('purchases'::regclass,'orders'::regclass,'payment_fee_ledger'::regclass,
    'product_delivery_revisions'::regclass,'product_delivery_videos'::regclass,'checkout_delivery_snapshots'::regclass,'purchase_deliveries'::regclass)
    and tgname not in ('guard_monthly_mentorship_purchase_v1','zz_team_monthly_shared_fence_v1') order by oid`),
  tables:await rows("select oid,relname,relowner,relacl::text,relrowsecurity,relforcerowsecurity from pg_class where oid=any($1::regclass[]) order by oid",[historyTables]),
  columns:await rows("select attrelid,attnum,attname,attacl::text from pg_attribute where attrelid=any($1::regclass[]) and attnum>0 and not attisdropped order by attrelid,attnum",[historyTables]),
  policies:await rows("select polrelid,polname,polcmd,polpermissive,polroles,pg_get_expr(polqual,polrelid) using_expr,pg_get_expr(polwithcheck,polrelid) check_expr from pg_policy where polrelid=any($1::regclass[]) order by polrelid,polname",[historyTables]),
  discover:await rows("select oid,proowner,proacl::text,prosecdef,proconfig from pg_proc where oid in ('public.reconcile_discover_sale_v1(uuid)'::regprocedure,'public.discover_ledger_changed_v1()'::regprocedure) order by oid")
 };
}
type Catalog=Awaited<ReturnType<typeof retainedCatalog>>;
const stages:{name:string;history:Snapshot;catalog:Catalog}[]=[];
async function remember(name:string){stages.push({name,history:await snapshot(),catalog:await retainedCatalog()});}
const denied=async(action:()=>Promise<unknown>,pattern:RegExp)=>{
 await db.exec("savepoint denied");
 try{await expect(action()).rejects.toThrow(pattern);}finally{await db.exec("rollback to savepoint denied;release savepoint denied");}
};
beforeAll(async()=>{
 db=createLocalPostgres();await monthlySharedAccountingDatabase(db,false);
 // Establish the source-derived ACL fixture BEFORE taking any inventory;
 // candidate application must never repair or normalize these privileges.
 await mirrorDiscoverSecurityFixture(db);
 expect(await rows("select to_regclass('public.sales_team_monthly_shared_policy_v1') policy")).toEqual([{policy:null}]);
 await seedPreinstallationHistory(db);await remember("predecessor");
 await db.exec(readFileSync(monthlySharedCandidate,"utf8"));await remember("F53");
 await db.exec(readFileSync(discoverLossCandidate,"utf8"));await remember("F54");
},30000);
beforeEach(async()=>{await db.exec("begin");});
afterEach(async()=>{await db.exec("rollback;reset role");});
afterAll(async()=>{await db?.close();});

test("F53 and F54 each preserve complete pre-existing rows, financial identities and immutable deliveries",async()=>{
 expect(stages.map(s=>s.name)).toEqual(["predecessor","F53","F54"]);
 const before=stages[0];
 for(const table of historyTables)expect(before.history[table].length).toBeGreaterThan(0);
 expect(before.history.purchases).toHaveLength(2);expect(before.history.payment_fee_ledger).toHaveLength(2);
 expect(before.history.purchase_deliveries).toHaveLength(2);expect(before.history.discover_events_v1).toHaveLength(2);
 for(const stage of stages.slice(1))expect(stage.history).toEqual(before.history);
 expect(await monthlySharedReady(db)).toBe(false);
 expect(await rows("select enabled,contract_sha256 from sales_team_monthly_shared_policy_v1")).toEqual([{enabled:false,contract_sha256:null}]);
 for(const table of ["sales_team_sale_agreements_v1","sales_team_receipts_v1","sales_team_shared_receipts_v1","sales_team_financial_ledger_v1"])
  expect(await rows(`select count(*)::int n from ${table}`)).toEqual([{n:0}]);
});
test("both installations preserve retained routine identities/security, table and column ACLs, RLS and policies",()=>{
 expect(stages[0].catalog.routines.length).toBeGreaterThanOrEqual(18);expect(stages[0].catalog.triggers.length).toBeGreaterThan(5);
 for(const stage of stages.slice(1))expect(stage.catalog).toEqual(stages[0].catalog);
});
test("pre-existing ordinary and invoice earnings cannot be credited twice",async()=>{
 const before=await snapshot();await db.exec("set role service_role");
 expect(await rpc(db,"credit_purchase_earnings",[ordinary.purchase,850])).toBe(false);
 expect(await rpc(db,"credit_payment_fee_ledger_earnings",[ordinary.ledger])).toBe(false);
 expect(await rpc(db,"credit_payment_fee_ledger_earnings",[monthly.ledger])).toBe(false);
 await db.exec("reset role");expect(await snapshot()).toEqual(before);
});
test("ordinary history retains once-only legacy reversal without changing monthly history or delivery",async()=>{
 const delivery=await snapshot(deliveryTables),monthlyRows=await monthlyHistory();
 await db.exec("set role service_role");
 expect(await rpc(db,"reverse_purchase_earnings",[ordinary.purchase])).toBe(true);
 expect(await rpc(db,"reverse_purchase_earnings",[ordinary.purchase])).toBe(false);
 await db.exec("reset role");await balance(850);
 expect(await rows("select purchase_count from posts where id=$1",[ordinary.post])).toEqual([{purchase_count:0}]);
 expect(await monthlyHistory()).toEqual(monthlyRows);expect(await snapshot(deliveryTables)).toEqual(delivery);
});
async function balance(earnings:number){
 expect(await rows("select total_earnings_cents::int earnings from profiles where id=$1",[id(1)])).toEqual([{earnings}]);
 expect(await rows("select total_earnings_cents::int earnings from profiles where id=$1",[id(4)])).toEqual([{earnings:777}]);
}
async function monthlyHistory(){return {
 purchase:await rows("select * from purchases where id=$1",[monthly.purchase]),agreement:await rows("select * from monthly_mentorship_agreements_v1 where id=$1",[monthly.agreement])
};}
test("pre-existing one-time partial/full refunds debit once and preserve original reporting/delivery identities",async()=>{
 const delivery=await snapshot(deliveryTables),legacyMonthly=await monthlyHistory(),orders=await rows("select * from orders");
 const event=await rows("select id,entity_key,occurred_at,post_id,creator_id,user_id from discover_events_v1 where entity_key=$1",["purchase:"+ordinary.purchase]);
 await db.exec("set role service_role");
 for(const [gross,delta,earnings] of [[200,170,1530],[200,0,1530],[100,0,1530],[1000,680,850],[1000,0,850]]){
  expect(Number(await rpc(db,"apply_purchase_refund_earnings",[ordinary.purchase,gross]))).toBe(delta);
  expect(Number(await rpc(db,"apply_payment_fee_ledger_refund",[ordinary.ledger,gross]))).toBe(0);
  await balance(earnings);
 }
 await db.exec("reset role");
 expect(await rows("select id,order_id,payment_intent_id,status,access_granted,refunded_amount_cents::int refunded,earnings_reversed_cents::int reversed from purchases where id=$1",[ordinary.purchase]))
  .toEqual([{id:ordinary.purchase,order_id:ordinary.order,payment_intent_id:"pi_preinstall_ordinary",status:"refunded",access_granted:false,refunded:1000,reversed:850}]);
 expect(await rows("select amount_cents::int amount,valid from discover_events_v1 where entity_key=$1",["purchase:"+ordinary.purchase])).toEqual([{amount:0,valid:false}]);
 expect(await rows("select id,entity_key,occurred_at,post_id,creator_id,user_id from discover_events_v1 where entity_key=$1",["purchase:"+ordinary.purchase])).toEqual(event);
 expect(await rows("select * from orders")).toEqual(orders);expect(await monthlyHistory()).toEqual(legacyMonthly);expect(await snapshot(deliveryTables)).toEqual(delivery);
});
test("pre-existing monthly invoice refunds keep the original agreement/purchase and never use installment entitlement flags",async()=>{
 const before=await monthlyHistory(),delivery=await snapshot(deliveryTables);
 await db.exec("set role service_role");
 for(const [gross,delta,earnings] of [[200,170,1530],[200,0,1530],[100,0,1530],[1000,680,850],[1000,0,850]]){
  expect(Number(await rpc(db,"apply_payment_fee_ledger_refund",[monthly.ledger,gross]))).toBe(delta);await balance(earnings);
 }
 expect(await rpc(db,"credit_payment_fee_ledger_earnings",[monthly.ledger])).toBe(false);
 await db.exec("reset role");expect(await monthlyHistory()).toEqual(before);expect(await snapshot(deliveryTables)).toEqual(delivery);
 expect(await rows("select status,refunded_amount_cents::int refunded,earnings_reversed_cents::int reversed from payment_fee_ledger where id=$1",[monthly.ledger])).toEqual([{status:"refunded",refunded:1000,reversed:850}]);
});
test.each(["access_granted=true","paid_count=1","earnings_credited_at=now()","target_months=1","subscription_id='sub_foreign'"])("pre-existing monthly history still rejects %s",async change=>{
 const before=await snapshot();await db.exec("set role service_role");
 await denied(()=>db.query(`update purchases set ${change} where id=$1`,[monthly.purchase]),/Monthly service cannot use legacy ownership/);
 await db.exec("reset role");expect(await snapshot()).toEqual(before);
});
test("pre-existing monthly identity cannot be replaced or adopted into team accounting",async()=>{
 const before=await snapshot();
 await db.query("insert into monthly_mentorship_agreements_v1(id,purchase_id,buyer_id,creator_id,product_id,post_id,stripe_subscription_id) values($1,$2,$3,$4,$5,$6,'sub_preinstall_monthly')",[id(9790),monthly.purchase,id(11),id(1),monthly.product,monthly.post]);
 await db.exec("set role service_role");
 await denied(()=>db.query("update purchases set monthly_mentorship_id=$1 where id=$2",[id(9790),monthly.purchase]),/Monthly purchase identity cannot be replaced/);
 await denied(()=>db.query("update purchases set sales_team_sale_id=$1 where id=$2",[id(9791),monthly.purchase]),/ORIGINAL_TEAM_ACCOUNTING_CHANGED/);
 await db.exec("reset role");await db.query("delete from monthly_mentorship_agreements_v1 where id=$1",[id(9790)]);expect(await snapshot()).toEqual(before);
});
test("current offer changes cannot replace already purchased links or video revisions",async()=>{
 const delivery=await snapshot(deliveryTables);
 await db.query("insert into product_delivery_revisions(id,product_id,creator_id,links) values($1,$2,$3,'[{\"label\":\"New offer\",\"url\":\"https://fixture.invalid/new\"}]')",[id(9792),ordinary.product,id(1)]);
 await db.query("update products set title='New offer',deliver_url='https://fixture.invalid/new',delivery_revision=$1 where id=$2",[id(9792),ordinary.product]);
 const current=await snapshot(deliveryTables);current.product_delivery_revisions=current.product_delivery_revisions.filter((r)=> (r as {id:string}).id!==id(9792));
 expect(current).toEqual(delivery);
 expect(await rows("select s.links from checkout_delivery_snapshots s join purchase_deliveries d on d.order_id=s.order_id where d.purchase_id=$1",[ordinary.purchase])).toEqual([{links:[{label:"Original course",url:"https://fixture.invalid/preinstall/course"}]}]);
 await denied(()=>db.query("update purchases set order_id=$1 where id=$2",[id(9793),ordinary.purchase]),/Purchase delivery cannot be replaced/);
});
test.each([
 ["product_delivery_revisions","id",ordinary.revision,"links=links"],
 ["product_delivery_videos","revision_id",ordinary.revision,"label=label"],
 ["checkout_delivery_snapshots","order_id",ordinary.order,"title=title"],
 ["purchase_deliveries","purchase_id",ordinary.purchase,"order_id=order_id"]
])("pre-existing %s still rejects update and deletion",async(table,key,value,change)=>{
 const before=await snapshot(deliveryTables);expect(await rows(`select count(*)::int n from ${table} where ${key}=$1`,[value])).toEqual([{n:1}]);
 await denied(()=>db.query(`update ${table} set ${change} where ${key}=$1`,[value]),/Purchased delivery and published delivery revisions are immutable/);
 await denied(()=>db.query(`delete from ${table} where ${key}=$1`,[value]),/Purchased delivery and published delivery revisions are immutable/);
 expect(await snapshot(deliveryTables)).toEqual(before);
});
test.each(["anon","authenticated"])("%s cannot expose historical delivery/finance or invoke service accounting",async role=>{
 const before=await snapshot();await db.exec(`set role ${role}`);
 for(const buyer of [id(10),id(12)]){
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[buyer]);
  for(const table of ["checkout_delivery_snapshots","purchase_deliveries","payment_fee_ledger"])
   await denied(()=>db.exec(`select * from ${table}`),/permission denied/);
  for(const [name,args] of [["apply_purchase_refund_earnings",[ordinary.purchase,1000]],["apply_payment_fee_ledger_refund",[monthly.ledger,1000]],["reconcile_discover_sale_v1",[ordinary.ledger]]] as const)
   await denied(()=>rpc(db,name,[...args]),/permission denied/);
 }
 await db.exec("reset role");expect(await snapshot()).toEqual(before);
});
