/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

declare const createLocalPostgres: () => PGlite;
const repair = readFileSync(join(process.cwd(), "docs/staging-purchases-readonly-acl-prerequisite.sql"), "utf8");
const buyer = "00000000-0000-4000-8000-000000000001";
const otherBuyer = "00000000-0000-4000-8000-000000000002";
const row = "00000000-0000-4000-8000-000000000011";
let db: PGlite;
jest.setTimeout(60000);

beforeEach(async () => {
  db = createLocalPostgres();
  // 44 SYNTHETIC columns exercise catalog enumeration, not a claim that these
  // auxiliary definitions reproduce the hosted database's 44 actual columns.
  const auxiliary = Array.from({ length: 38 }, (_, i) => `aux_${i + 1} text`).join(",");
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls; create role read_auditor;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create table public.purchases(id uuid primary key,buyer_id uuid,post_id uuid,access_granted boolean,status text,
      ${auxiliary},"odd column" text);
    alter table public.purchases enable row level security;
    create policy buyer_read on public.purchases for select to authenticated using(buyer_id=auth.uid());
    create policy buyer_insert on public.purchases for insert to authenticated with check(buyer_id=auth.uid());
    create policy buyer_update on public.purchases for update to authenticated using(buyer_id=auth.uid()) with check(buyer_id=auth.uid());
    create policy buyer_delete on public.purchases for delete to authenticated using(buyer_id=auth.uid());
    create function public.purchase_test_touch() returns trigger language plpgsql as $$begin return new; end$$;
    create trigger synthetic_touch before update on public.purchases for each row execute function public.purchase_test_touch();
    grant all on public.purchases to anon,authenticated,service_role;
    grant update(aux_1),insert(aux_2),references(aux_3),update("odd column") on public.purchases to anon,authenticated;
    grant select(aux_4) on public.purchases to public;
    grant select(aux_5) on public.purchases to read_auditor with grant option;
    insert into public.purchases(id,buyer_id,status,access_granted,aux_1) values
      ('${row}','${buyer}','paid',true,'synthetic buyer row'),
      ('00000000-0000-4000-8000-000000000012','${otherBuyer}','paid',true,'synthetic other row');
  `);
});
afterEach(async () => { await db.close(); });

async function asRole<T>(role: "anon" | "authenticated" | "service_role", user: string | null, action: () => Promise<T>): Promise<T> {
  await db.exec(`begin; set local role ${role}`);
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user ?? ""]);
    return await action();
  } finally { await db.exec("rollback"); }
}
const rows = async () => (await db.query("select * from public.purchases order by id")).rows;
const catalog = async () => (await db.query(`select jsonb_build_object(
  'policies',(select jsonb_agg(to_jsonb(p) order by p.polname) from pg_policy p where p.polrelid='public.purchases'::regclass),
  'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid) order by t.tgname) from pg_trigger t where t.tgrelid='public.purchases'::regclass),
  'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull)
    order by a.attnum) from pg_attribute a where a.attrelid='public.purchases'::regclass and a.attnum>0 and not a.attisdropped),
  'rls',c.relrowsecurity,'owner',c.relowner) metadata from pg_class c where c.oid='public.purchases'::regclass`)).rows;
const selectAcl = async () => (await db.query(`select 0 as attnum,x.grantor,x.grantee,x.is_grantable from pg_class c
    cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
    where c.oid='public.purchases'::regclass and x.privilege_type='SELECT'
    union all select a.attnum,x.grantor,x.grantee,x.is_grantable from pg_attribute a cross join lateral aclexplode(a.attacl) x
    where a.attrelid='public.purchases'::regclass and a.attnum>0 and not a.attisdropped and x.privilege_type='SELECT'
    order by 1,3,2`)).rows;
const hasTable = async (role: string, privilege: string) => (await db.query<{ allowed: boolean }>(
  "select has_table_privilege($1,'public.purchases',$2) allowed", [role, privilege])).rows[0].allowed;

test("observed grants and independent column writes are removed; SELECT provenance, schema, policies, triggers and rows survive", async () => {
  const beforeRows = await rows(), beforeCatalog = await catalog(), beforeSelect = await selectAcl();
  await db.exec(repair);
  expect(await rows()).toEqual(beforeRows);
  expect(await catalog()).toEqual(beforeCatalog);
  expect(await selectAcl()).toEqual(beforeSelect);
  for (const role of ["anon", "authenticated"]) {
    for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]) {
      expect(await hasTable(role, privilege)).toBe(false);
    }
    for (const privilege of ["INSERT", "UPDATE", "REFERENCES"]) {
      expect((await db.query<{ allowed: boolean }>("select has_any_column_privilege($1,'public.purchases',$2) allowed", [role, privilege])).rows[0].allowed).toBe(false);
    }
  }
  for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]) {
    expect(await hasTable("service_role", privilege)).toBe(true);
  }
});

test("real role-switched buyer reads remain RLS-scoped while every direct client mutation is denied", async () => {
  const buyerRows = () => asRole("authenticated", buyer, () => db.query("select id from public.purchases order by id"));
  expect((await buyerRows()).rows).toEqual([{ id: row }]);
  await db.exec(repair);
  expect((await buyerRows()).rows).toEqual([{ id: row }]);
  await asRole("anon", null, async () => { expect((await db.query("select id from public.purchases")).rows).toEqual([]); });
  for (const role of ["anon", "authenticated"] as const) {
    for (const sql of [
      `insert into public.purchases(id,buyer_id,status) values('00000000-0000-4000-8000-000000000099','${buyer}','paid')`,
      "update public.purchases set access_granted=false", "update public.purchases set aux_1='synthetic changed'",
      "delete from public.purchases", "truncate public.purchases",
    ]) await expect(asRole(role, buyer, () => db.exec(sql))).rejects.toThrow(/permission denied/);
  }
  await asRole("service_role", null, async () => {
    expect((await db.query("update public.purchases set aux_1='synthetic server edit' where id=$1 returning id", [row])).rows).toEqual([{ id: row }]);
    expect((await db.query("delete from public.purchases where id=$1 returning id", [row])).rows).toEqual([{ id: row }]);
    expect((await db.query("insert into public.purchases(id,buyer_id) values($1,$2) returning id", [row, buyer])).rows).toEqual([{ id: row }]);
  });
});

test.each(['grant update on public.purchases to public','grant update("odd column") on public.purchases to public'])(
  "unseen PUBLIC write provenance stops before changes: %s", async grant => {
  await db.exec(grant);
  const beforeSelect = await selectAcl();
  await expect(db.exec(repair)).rejects.toThrow(/unseen PUBLIC write grants/); await db.exec("rollback");
  expect(await selectAcl()).toEqual(beforeSelect);
  const publicWrites = await db.query(`select x.privilege_type from pg_class c cross join lateral aclexplode(c.relacl) x
    where c.oid='public.purchases'::regclass and x.grantee=0 and x.privilege_type<>'SELECT'
    union all select x.privilege_type from pg_attribute a cross join lateral aclexplode(a.attacl) x
    where a.attrelid='public.purchases'::regclass and x.grantee=0 and x.privilege_type<>'SELECT'`);
  expect(publicWrites.rows).toEqual([{ privilege_type: "UPDATE" }]);
  expect(await hasTable("anon", "TRUNCATE")).toBe(true);
});

test("already-closed replay is a deliberate no-op with exact SELECT grants and buyer policies preserved", async () => {
  await db.exec(repair);
  const before = [await rows(), await catalog(), await selectAcl()];
  await db.exec(repair);
  expect([await rows(), await catalog(), await selectAcl()]).toEqual(before);
});

test("non-owner client grant provenance is refused instead of trying to revoke another grantor's authority", async () => {
  await db.exec("grant update on public.purchases to service_role with grant option; set role service_role; grant update on public.purchases to authenticated; reset role");
  const provenance = () => db.query(`select x.grantor from pg_class c cross join lateral aclexplode(c.relacl) x
    where c.oid='public.purchases'::regclass and x.grantee=(select oid from pg_roles where rolname='authenticated')
      and x.grantor=(select oid from pg_roles where rolname='service_role') and x.privilege_type='UPDATE'`);
  expect((await provenance()).rows).toHaveLength(1);
  await expect(db.exec(repair)).rejects.toThrow(/unreviewed client grant provenance/); await db.exec("rollback");
  expect((await provenance()).rows).toHaveLength(1);
  expect(await hasTable("anon", "TRUNCATE")).toBe(true);
});

test.each(["INSERT", "MAINTAIN"])("server %s inherited only through a client grant makes the entire repair roll back", async privilege => {
  await db.exec(`revoke ${privilege} on public.purchases from service_role; grant anon to service_role`);
  const before = [await rows(), await catalog(), await selectAcl()];
  await expect(db.exec(repair)).rejects.toThrow(/invariant changed/); await db.exec("rollback");
  expect(await hasTable("service_role", privilege)).toBe(true);
  expect(await hasTable("anon", "UPDATE")).toBe(true);
  expect([await rows(), await catalog(), await selectAcl()]).toEqual(before);
});

test.each([
  ["grant update on public.purchases to inherited_writer", "unreviewed client role membership"],
  ["grant update(aux_1) on public.purchases to inherited_writer", "unreviewed client role membership"],
])("unexpected inherited privileges fail without touching role grants: %s", async (grant, error) => {
  await db.exec(`create role inherited_writer; grant inherited_writer to authenticated; ${grant}`);
  const before = [await rows(), await catalog(), await selectAcl()];
  await expect(db.exec(repair)).rejects.toThrow(error); await db.exec("rollback");
  expect(await hasTable("anon", "TRUNCATE")).toBe(true);
  expect((await db.query<{ inherited: boolean }>("select pg_has_role('authenticated','inherited_writer','MEMBER') inherited")).rows[0].inherited).toBe(true);
  expect([await rows(), await catalog(), await selectAcl()]).toEqual(before);
});

test.each([
  ["alter table public.purchases disable row level security", "ordinary RLS-enabled"],
  ["alter table public.purchases alter column status type varchar(100)", "core column/type drift"],
  ["create table public.synthetic_child() inherits(public.purchases)", "inherited/partitioned"],
  ["create role alternate_owner; alter table public.purchases owner to alternate_owner", "reviewed table owner"],
  ["alter role authenticated bypassrls", "ownership/bypass inheritance"],
  ["revoke insert on public.purchases from service_role", "existing server CRUD"],
  ["grant update on public.purchases to authenticated with grant option", "write grant options"],
  ["revoke maintain on public.purchases from authenticated", "baseline drift"],
])("unreviewed baseline/schema/ownership drift fails closed before ACL changes: %s", async (drift, error) => {
  await db.exec(drift);
  const before = [await rows(), await catalog(), await selectAcl()];
  await expect(db.exec(repair)).rejects.toThrow(error); await db.exec("rollback");
  expect(await hasTable("anon", "TRUNCATE")).toBe(true);
  expect([await rows(), await catalog(), await selectAcl()]).toEqual(before);
});

test("a table-closed but column-writable partial state needs review rather than being treated as a safe replay", async () => {
  await db.exec("revoke insert,update,delete,truncate,references,trigger,maintain on public.purchases from authenticated; grant update(aux_1) on public.purchases to authenticated");
  expect((await db.query<{ allowed: boolean }>("select has_column_privilege('authenticated','public.purchases','aux_1','UPDATE') allowed")).rows[0].allowed).toBe(true);
  await expect(db.exec(repair)).rejects.toThrow(/baseline drift/); await db.exec("rollback");
  expect((await db.query<{ allowed: boolean }>("select has_column_privilege('authenticated','public.purchases','aux_1','UPDATE') allowed")).rows[0].allowed).toBe(true);
  expect(await hasTable("anon", "TRUNCATE")).toBe(true);
});
