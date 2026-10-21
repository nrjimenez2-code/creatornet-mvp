/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
beforeAll(async () => {
  db = createLocalPostgres();
  // Focused migration fixture; not a full hosted-schema installation claim.
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.products(id integer primary key, type text not null, price_cents integer, amount_cents integer, membership_terms jsonb);
    alter table public.products enable row level security;
    insert into public.products values(1,'mentorship',10001,10001,null);`);
  await db.exec(readFileSync(join(process.cwd(), "supabase/migrations/20260921011747_mentorship_installment_options.sql"), "utf8"));
});
afterAll(async () => { await db.close(); });
test("existing products retain empty choices and RLS remains enabled", async () => {
  expect((await db.query("select installment_options from products where id=1")).rows).toEqual([{ installment_options: [] }]);
  expect((await db.query("select relrowsecurity from pg_class where oid='public.products'::regclass")).rows).toEqual([{ relrowsecurity: true }]);
});
test("valid creator choices persist with the original total", async () => {
  await db.query("insert into products values(2,'mentorship',10001,10001,null,$1::smallint[])", [[2, 3, 6]]);
  expect((await db.query("select amount_cents,installment_options from products where id=2")).rows)
    .toEqual([{ amount_cents: 10001, installment_options: [2, 3, 6] }]);
});
test.each([[3, 2], [2, 2], [1], [25], [null]].map(value => [value]))("database rejects malformed choices %p", async choices => {
  await expect(db.query("insert into products values(3,'mentorship',10001,10001,null,$1::smallint[])", [choices])).rejects.toThrow();
});
test.each([
  ["course", 1000, null], ["mentorship", 99, null], ["mentorship", null, null], ["mentorship", 1000, {}],
])("database refuses incompatible type/price/monthly terms: %p", async (type, total, monthly) => {
  await expect(db.query("insert into products values(4,$1,$2,$2,$3,'{2}')", [type, total, monthly])).rejects.toThrow();
});
test("the pure validator has no SECURITY DEFINER privilege", async () => {
  expect((await db.query("select prosecdef from pg_proc where oid='public.valid_mentorship_installment_options_v1(smallint[])'::regprocedure")).rows)
    .toEqual([{ prosecdef: false }]);
});
