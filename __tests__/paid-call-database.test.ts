/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installStagingStructuralBaseline } from "../test-support/staging-catalog-postgres";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const buyer = "11111111-1111-4111-8111-111111111111", creator = "22222222-2222-4222-8222-222222222222";
let product: string;
beforeAll(async () => {
  db = createLocalPostgres(); await installStagingStructuralBaseline(db);
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/076-paid-standalone-calls.sql"), "utf8"));
  await db.query("insert into auth.users(id) values($1),($2)", [buyer, creator]);
  await db.query("insert into profiles(id,username) values($1,'paid_call_buyer'),($2,'paid_call_creator')", [buyer, creator]);
  const result = await db.query<{ value: { id: string } }>("select create_paid_call_product_v1($1,'One call',null,10000,'https://scheduler.example/private') as value", [creator]);
  product = result.rows[0].value.id;
}, 30000);
afterAll(async () => { await db?.close(); });
test("creation uses the actual recorded product schema and keeps destination private", async () => {
  const { rows } = await db.query<{ type: string; amount_cents: number; deliver_url: null }>("select type,amount_cents,deliver_url from products where id=$1", [product]);
  expect(rows[0]).toEqual({ type: "call", amount_cents: 10000, deliver_url: null });
  const acl = await db.query<{ allowed: boolean }>("select has_table_privilege('anon','paid_call_targets','select') or has_table_privilege('authenticated','paid_call_targets','select') or has_function_privilege('authenticated','read_paid_call_access_v1(uuid,uuid)','execute') as allowed");
  expect(acl.rows[0].allowed).toBe(false);
});
test("direct product insertion without private scheduling is refused", async () => {
  await expect(db.query("insert into products(creator_id,title,type,price_cents,amount_cents,currency,plan_months) values($1,'Invalid','call',10000,10000,'usd',1)", [creator])).rejects.toThrow();
});
test("an existing product cannot be reinterpreted as a free or different offer", async () => {
  await expect(db.query("update products set type='mentorship' where id=$1", [product])).rejects.toThrow("change a paid-call offer type");
});
test("an unpaid purchase and a saved card cannot release scheduling", async () => {
  await db.query("insert into posts(id,creator_id,product_id,title) values('33333333-3333-4333-8333-333333333333',$1,$2,'Call post')", [creator, product]);
  const result = await db.query<{ id: string }>("insert into purchases(buyer_id,creator_id,product_id,post_id,session_id,status,access_granted,amount_cents,currency) values($1,$2,$3,'33333333-3333-4333-8333-333333333333','cs_test_setup','pending',false,10000,'usd') returning id", [buyer, creator, product]);
  const purchase = result.rows[0].id;
  const access = await db.query<{ value: unknown }>("select read_paid_call_access_v1($1,$2) as value", [purchase, buyer]);
  expect(access.rows[0].value).toBeNull();
  const listed = await db.query<{ value: { items: Array<Record<string, unknown>> } }>("select list_paid_calls_v1($1,0) as value", [buyer]);
  expect(listed.rows[0].value.items[0].access_granted).toBe(false);
  expect(JSON.stringify(listed.rows[0].value)).not.toContain("scheduler");
  const other = await db.query<{ value: { items: unknown[] } }>("select list_paid_calls_v1($1,0) as value", [creator]);
  expect(other.rows[0].value.items).toEqual([]);
});
test("only an owned paid purchase with its captured-payment ledger releases the target; refunds revoke it", async () => {
  const found = await db.query<{ id: string }>("select id from purchases where buyer_id=$1 and product_id=$2", [buyer, product]);
  const purchase = found.rows[0].id;
  await db.query("update purchases set status='paid',access_granted=true,payment_intent_id='pi_call' where id=$1", [purchase]);
  const read = async (actor: string) => (await db.query<{ value: unknown }>("select read_paid_call_access_v1($1,$2) as value", [purchase, actor])).rows[0].value;
  expect(await read(buyer)).toBeNull();
  await db.query("insert into payment_fee_ledger(creator_id,purchase_id,stripe_payment_intent_id,stripe_charge_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,creator_net_cents,currency,fee_schedule_version,status) values($1,$2,'pi_call','ch_call',10000,1200,320,1520,8480,'usd','synthetic','paid')", [creator, purchase]);
  expect(await read(buyer)).toMatchObject({ scheduling_url: "https://scheduler.example/private", purchase_id: purchase });
  expect(await read(creator)).toBeNull();
  await db.query("update purchases set status='refunded',access_granted=false where id=$1", [purchase]);
  expect(await read(buyer)).toBeNull();
});
