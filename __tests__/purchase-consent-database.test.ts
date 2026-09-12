/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installStagingStructuralBaseline } from "../test-support/staging-catalog-postgres";
import { productPurchaseTerms } from "@/lib/purchaseConsent";
declare const createLocalPostgres: () => PGlite;
jest.setTimeout(90000);
let db: PGlite;
const buyer = "10000000-0000-4000-8000-000000000001", creator = "10000000-0000-4000-8000-000000000002";
const product = { id: "10000000-0000-4000-8000-000000000004", creator_id: creator, type: "course",
  title: "Owned course", description: "One complete course", price_cents: 10000, amount_cents: 10000, currency: "usd" };
beforeAll(async () => {
  db = createLocalPostgres(); await installStagingStructuralBaseline(db);
  await db.exec(readFileSync(join(process.cwd(), "supabase/schema/020-product-checkout-idempotency.sql"), "utf8"));
  await db.exec(readFileSync(join(process.cwd(), "supabase/proposals/077-versioned-purchase-consent.sql"), "utf8"));
  await db.query("insert into auth.users(id) values($1),($2)", [buyer, creator]);
  await db.query("insert into public.profiles(id,username) values($1,'consent_buyer'),($2,'consent_creator')", [buyer, creator]);
  await db.query("insert into public.products(id,creator_id,title,description,type,price_cents,amount_cents,currency,plan_months) values($1,$2,$3,$4,'course',10000,10000,'usd',1)", [product.id, creator, product.title, product.description]);
});
afterAll(async () => { await db?.close(); });
const quote = productPurchaseTerms(product, buyer, null);
async function record(terms: unknown = quote.terms) {
  return db.query<{ id: string }>("select public.record_product_purchase_consent_v1($1,$2,$3,null,$4::jsonb,$5) id", [buyer, creator, product.id, JSON.stringify(terms), quote.fingerprint]);
}
test("#6 real proposed SQL records acceptance once and preserves the original timestamp on retry", async () => {
  const first = (await record()).rows[0].id, second = (await record()).rows[0].id;
  expect(second).toBe(first);
  const rows = await db.query<{ terms: unknown; accepted_at: unknown }>("select terms,accepted_at from public.product_purchase_consents_v1");
  expect(rows.rows).toHaveLength(1); expect(rows.rows[0].terms).toEqual(quote.terms); expect(rows.rows[0].accepted_at).toBeTruthy();
});
test("#6 SQL refuses changed price, buyer, and product identities", async () => {
  for (const change of [{ amountCents: 50 }, { buyerId: creator }, { productId: creator }]) {
    await expect(record({ ...quote.terms, ...change })).rejects.toThrow("does not match");
  }
});
test("#6 browser roles cannot read or fabricate acceptance and service cannot rewrite it", async () => {
  const result = await db.query<{ role_name: string; can_read: boolean; can_write: boolean; can_record: boolean }>(`
    select r as role_name,has_table_privilege(r,'public.product_purchase_consents_v1','SELECT') can_read,
      has_table_privilege(r,'public.product_purchase_consents_v1','UPDATE') can_write,
      has_function_privilege(r,'public.record_product_purchase_consent_v1(uuid,uuid,uuid,uuid,jsonb,text)','EXECUTE') can_record
    from unnest(array['anon','authenticated','service_role']) r`);
  expect(result.rows).toEqual([
    { role_name: "anon", can_read: false, can_write: false, can_record: false },
    { role_name: "authenticated", can_read: false, can_write: false, can_record: false },
    { role_name: "service_role", can_read: true, can_write: false, can_record: true },
  ]);
});

test("#6 SQL rejects an attempt linked to another buyer's acceptance", async () => {
  const id = (await record()).rows[0].id;
  await expect(db.query(`insert into public.product_checkout_attempts
    (buyer_id,purchase_identity,creator_id,product_id,order_id,terms_fingerprint,purchase_consent_id)
    values($1,'wrong-buyer',$1,$2,gen_random_uuid(),$3,$4)`, [creator, product.id, quote.fingerprint, id]))
    .rejects.toThrow("Checkout acceptance ownership differs");
});

test("#6 SQL links the owned attempt and permits rollback without rewriting the immutable acceptance", async () => {
  const id = (await record()).rows[0].id;
  const result = await db.query<{ id: string }>(`insert into public.product_checkout_attempts
    (buyer_id,purchase_identity,creator_id,product_id,order_id,terms_fingerprint,purchase_consent_id)
    values($1,'owned-consent',$2,$3,gen_random_uuid(),$4,$5) returning id`, [buyer, creator, product.id, quote.fingerprint, id]);
  await db.query("update public.product_checkout_attempts set purchase_consent_id=null where id=$1", [result.rows[0].id]);
  expect((await db.query("select id from public.product_purchase_consents_v1 where id=$1", [id])).rows).toHaveLength(1);
});
