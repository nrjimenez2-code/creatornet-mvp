/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`create role authenticated; create role anon; create role service_role bypassrls;
    create schema auth; grant usage on schema auth to authenticated,anon,service_role;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('audit.uid',true),'')::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select jsonb_build_object('aal',current_setting('audit.aal',true))$$;
    create table auth.mfa_factors(user_id uuid,factor_type text,status text);
    create table public.profiles(id uuid,role text,banned_at timestamptz); insert into profiles(id,role) values('${owner}','admin'),('${other}','user');
    create table orders(id integer,buyer_id uuid); insert into orders values(1,'${owner}'),(2,'${other}');
    alter table orders enable row level security;
    create function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
$$;
    revoke execute on function is_admin() from public; grant execute on function is_admin() to authenticated,service_role;
    create policy own_read on orders for select using(buyer_id=auth.uid());
    create policy admin_read on orders for select using(public.is_admin());
    grant select on orders to authenticated,service_role;
    insert into auth.mfa_factors values('${owner}','totp','verified');`);
  await db.exec(readFileSync(join(__dirname, "../supabase/migrations/20261023030647_admin_totp_assurance.sql"), "utf8"));
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
test.each(["aal1", ""])("admin %s retains own purchase reads but not the admin override", async aal => {
  await db.exec(`set local audit.uid='${owner}';set local audit.aal='${aal}';set local role authenticated;`);
  expect((await db.query("select id from orders order by id")).rows).toEqual([{ id: 1 }]);
});
test("verified AAL2 admin override reads both rows", async () => {
  await db.exec(`set local audit.uid='${owner}';set local audit.aal='aal2';set local role authenticated;`);
  expect((await db.query("select id from orders order by id")).rows).toEqual([{ id: 1 }, { id: 2 }]);
});
test("stale AAL2 after all factors removed cannot use admin override", async () => {
  await db.exec(`delete from auth.mfa_factors;set local audit.uid='${owner}';set local audit.aal='aal2';set local role authenticated;`);
  expect((await db.query("select id from orders")).rows).toEqual([{ id: 1 }]);
});
test("banned administrator cannot use the override even with AAL2 and a factor", async () => {
  await db.exec(`update profiles set banned_at=now() where id='${owner}';set local audit.uid='${owner}';set local audit.aal='aal2';set local role authenticated;`);
  expect((await db.query("select id from orders")).rows).toEqual([{ id: 1 }]);
});
test("ordinary AAL1 buyer keeps owned reads and service-role bypass is intact", async () => {
  await db.exec(`set local audit.uid='${other}';set local audit.aal='aal1';set local role authenticated;`);
  expect((await db.query("select id from orders")).rows).toEqual([{ id: 2 }]);
  await db.exec("reset role;set local role service_role;");
  expect((await db.query("select id from orders")).rows).toHaveLength(2);
});
test("existing execution ACL is preserved, without exposing factors", async () => {
  expect((await db.query("select has_function_privilege('anon','public.is_admin()','execute') allowed")).rows[0]).toEqual({ allowed: false });
  expect((await db.query("select has_function_privilege('authenticated','public.is_admin()','execute') allowed")).rows[0]).toEqual({ allowed: true });
  expect((await db.query("select has_table_privilege('authenticated','auth.mfa_factors','select') allowed")).rows[0]).toEqual({ allowed: false });
});
test("replay or prior helper drift fails before replacing the function", async () => {
  await expect(db.exec(readFileSync(join(__dirname, "../supabase/migrations/20261023030647_admin_totp_assurance.sql"), "utf8"))).rejects.toThrow("Administrator helper drifted");
});
