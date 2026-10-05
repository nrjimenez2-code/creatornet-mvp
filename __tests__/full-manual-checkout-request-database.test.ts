/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {productPurchaseTerms} from "../lib/purchaseConsent";
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={version:"exact-payment-context-v1",mode:"test",platformAccountId:"acct_owned",supabaseProjectRef:"abcdefghijklmnopqrst",siteOrigin:"https://fixture.vercel.app"};
const product={id:id(4),creator_id:id(3),type:"mentorship",title:"Mentorship",amount_cents:10001,currency:"usd",active:true};
const quote=productPurchaseTerms(product,id(2),id(5));
const snapshot={product,processingFees:{enabled:true,basisPoints:290,fixedCents:30,version:"fees-v1"},
  acceptance:{accepted:true,version:quote.terms.version,fingerprint:quote.fingerprint},termsText:JSON.stringify(quote.terms)};
const plan=async(s:any=snapshot,buyer=id(2),request=id(1),ctx:object=context)=>
  (await db.query<any>("select plan_full_manual_checkout_v1($1,$2,$3,$4,$5,$6) r",[request,buyer,id(4),id(5),ctx,s])).rows[0].r;
beforeAll(async()=>{
  db=createLocalPostgres();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table exact_installment_context_pin_v2(singleton boolean primary key,context jsonb unique);
    create table product_checkout_attempts(id uuid,buyer_id uuid,product_id uuid);
    create table purchases(buyer_id uuid,product_id uuid,post_id uuid);
    create table server_payment_protocols_v1(attempt_id uuid,buyer_id uuid,product_id uuid);
    create table full_server_payment_sources_v1(attempt_id uuid);
    create table server_payment_intent_operations_v1(attempt_id uuid);
    create table server_payment_stops_v1(attempt_id uuid);
    create table full_server_payment_receipts_v1(attempt_id uuid);
    create table full_server_payment_financial_holds_v1(attempt_id uuid);
    create table orders(id uuid);
    create table product_checkout_releases_v1(attempt_id uuid,buyer_id uuid,attempt_key uuid,context jsonb,product_id uuid);`);
  await db.exec(readFileSync("supabase/migrations/20260923045503_full_manual_checkout_requests.sql","utf8"));
  await db.exec(readFileSync("supabase/migrations/20260923052006_full_planned_checkout_release.sql","utf8"));
  await db.exec(readFileSync("supabase/migrations/20260923060536_full_manual_request_discovery.sql","utf8"));
});
const release=async(request=id(1),buyer=id(2),ctx:object=context)=>(await db.query<any>(
  "select release_unreserved_full_checkout_v1($1,$2,$3) r",[request,buyer,ctx])).rows[0].r;
test("unreserved release is durable, preserves identities and permits a different request",async()=>{
  const original=await plan();await db.exec("set local role service_role");
  const released=await release();expect({...released,released_at:null}).toEqual(original);expect(released.released_at).toBeTruthy();
  expect(await release()).toEqual(released);expect(await plan()).toEqual(released);
  const next=await plan(snapshot,id(2),id(10));expect(next.attempt_id).not.toBe(original.attempt_id);
  expect(await release()).toEqual(released);
});
test.each(["server_payment_protocols_v1","product_checkout_attempts","full_server_payment_sources_v1",
  "server_payment_intent_operations_v1","server_payment_stops_v1","full_server_payment_receipts_v1",
  "full_server_payment_financial_holds_v1","orders","purchases"])("existing %s prevents no-dispatch release",async table=>{
  const r=await plan();
  if(table==="server_payment_protocols_v1"||table==="product_checkout_attempts")
    await db.query(`insert into ${table} values($1,$2,$3)`,[r.attempt_id,id(2),id(4)]);
  else if(table==="orders")await db.query("insert into orders values($1)",[r.order_id]);
  else if(table==="purchases")await db.query("insert into purchases values($1,$2,$3)",[id(2),id(4),id(5)]);
  else await db.query(`insert into ${table} values($1)`,[r.attempt_id]);
  expect(await release()).toBeNull();expect((await plan()).released_at).toBeNull();
});
test.each(["server_payment_protocols_v1","product_checkout_attempts"])("release prevents stale %s insertion even after a new request",async table=>{
  const r=await plan();await release();await plan(snapshot,id(2),id(10));
  await expect(db.query(`insert into ${table} values($1,$2,$3)`,[r.attempt_id,id(2),id(4)])).rejects.toThrow("cannot be revived");
});
test.each(["owner","request","context"])("release rejects wrong %s",async issue=>{
  await plan();await expect(release(issue==="request"?id(99):id(1),issue==="owner"?id(99):id(2),
    issue==="context"?{...context,mode:"live"}:context)).rejects.toThrow();
});
test("browser roles cannot release or forge the no-dispatch marker",async()=>{
  expect((await db.query(`select has_function_privilege('anon','release_unreserved_full_checkout_v1(uuid,uuid,jsonb)','EXECUTE') anon,
    has_function_privilege('authenticated','release_unreserved_full_checkout_v1(uuid,uuid,jsonb)','EXECUTE') auth,
    has_table_privilege('service_role','full_manual_checkout_requests_v1','UPDATE') forge`)).rows)
    .toEqual([{anon:false,auth:false,forge:false}]);
});
beforeEach(async()=>{await db.exec("begin");await db.query("insert into exact_installment_context_pin_v2 values(true,$1)",[context]);});
afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db.close();});
test("same request preserves original identities, quote and fees across lost replies",async()=>{
  await db.exec("set local role service_role");const saved=await plan();expect(await plan()).toEqual(saved);
  expect(saved).toMatchObject({request_id:id(1),buyer_id:id(2),product_id:id(4),snapshot});
  expect(saved.attempt_id).not.toBe(saved.attempt_key);expect(saved.order_id).not.toBe(saved.attempt_id);
  await db.exec("reset role");
  expect((await db.query("select * from product_checkout_attempts")).rows).toEqual([]);
});
test.each(["buyer","context","fees","acceptance","product","extra"])("changed %s never replaces the original request",async issue=>{
  const saved=await plan();const s=structuredClone(snapshot) as any;
  if(issue==="fees")s.processingFees.fixedCents++;
  if(issue==="acceptance")s.acceptance.fingerprint="a".repeat(64);
  if(issue==="product")s.product.title="Changed";
  if(issue==="extra")s.extra=true;
  await db.exec("savepoint refused");
  await expect(plan(s,issue==="buyer"?id(9):id(2),id(1),issue==="context"?{...context,mode:"live"}:context)).rejects.toThrow();
  await db.exec("rollback to refused");expect(await plan()).toEqual(saved);
});
test.each(["fingerprint","post","kind","inactive","monthly","owner","extra"])("invalid original %s cannot allocate a request",async issue=>{
  const s=structuredClone(snapshot) as any;
  if(issue==="fingerprint")s.acceptance.fingerprint="a".repeat(64);
  if(issue==="post")s.termsText=s.termsText.replace(id(5),id(9));
  if(issue==="kind")s.product.type="video";
  if(issue==="inactive")s.product.active=false;
  if(issue==="monthly")s.product.membership_terms={amount:10};
  if(issue==="owner")s.product.creator_id=id(2);
  if(issue==="extra")s.extra=true;
  await expect(plan(s)).rejects.toThrow();
});
test.each(["request","legacy attempt","purchase"])("existing %s blocks another original",async issue=>{
  if(issue==="request")await plan();
  if(issue==="legacy attempt")await db.query("insert into product_checkout_attempts values($1,$2,$3)",[id(20),id(2),id(4)]);
  if(issue==="purchase")await db.query("insert into purchases values($1,$2,$3)",[id(2),id(4),id(5)]);
  await expect(plan(snapshot,id(2),id(10))).rejects.toThrow("original recovery");
});
test("verified archived original allows a fresh request without changing the old mapping",async()=>{
  const first=await plan();await db.query("insert into product_checkout_releases_v1 values($1,$2,$3,$4,$5)",[first.attempt_id,id(2),first.attempt_key,context,id(4)]);
  const next=await plan(snapshot,id(2),id(10));expect(next.attempt_id).not.toBe(first.attempt_id);expect(await plan()).toEqual(first);
});
const discover=async(buyer=id(2),product=id(4),ctx:object=context)=>(await db.query<any>(
  "select find_full_manual_checkout_v1($1,$2,$3) r",[buyer,product,ctx])).rows[0].r;
test("discovery returns the sole immutable original without creating any records",async()=>{
  expect(await discover()).toBeNull();const first=await plan();await db.exec("set local role service_role");
  expect(await discover()).toEqual(first);expect(await discover(id(99))).toBeNull();expect(await discover(id(2),id(99))).toBeNull();
});
test.each(["unreserved","archived"])("discovery excludes %s release and returns a later unresolved request",async kind=>{
  const first=await plan();
  if(kind==="unreserved")await release();else await db.query("insert into product_checkout_releases_v1 values($1,$2,$3,$4,$5)",[first.attempt_id,id(2),first.attempt_key,context,id(4)]);
  expect(await discover()).toBeNull();const later=await plan(snapshot,id(2),id(10));expect(await discover()).toEqual(later);
});
test("multiple unresolved originals fail rather than choosing a latest row",async()=>{
  await plan();await db.query(`insert into full_manual_checkout_requests_v1(request_id,buyer_id,product_id,post_id,context,snapshot)
    values($1,$2,$3,$4,$5,$6)`,[id(99),id(2),id(4),id(5),context,snapshot]);
  await expect(discover()).rejects.toThrow("Multiple original requests");
});
test("discovery requires current context and is not browser executable",async()=>{
  expect((await db.query(`select has_function_privilege('anon','find_full_manual_checkout_v1(uuid,uuid,jsonb)','EXECUTE') anon,
    has_function_privilege('authenticated','find_full_manual_checkout_v1(uuid,uuid,jsonb)','EXECUTE') auth`)).rows).toEqual([{anon:false,auth:false}]);
  await expect(discover(id(2),id(4),{...context,mode:"live"})).rejects.toThrow();
});
test("request snapshots cannot be written directly or read by browser roles",async()=>{
  expect((await db.query(`select has_table_privilege('service_role','full_manual_checkout_requests_v1','INSERT') ins,
    has_table_privilege('service_role','full_manual_checkout_requests_v1','UPDATE') upd,
    has_table_privilege('service_role','full_manual_checkout_requests_v1','DELETE') del,
    has_table_privilege('authenticated','full_manual_checkout_requests_v1','SELECT') browser,
    has_function_privilege('anon','plan_full_manual_checkout_v1(uuid,uuid,uuid,uuid,jsonb,jsonb)','EXECUTE') call`)).rows)
    .toEqual([{ins:false,upd:false,del:false,browser:false,call:false}]);
});
