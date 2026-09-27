/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const migration = readFileSync(join(process.cwd(),"supabase/migrations/20260926225425_post_view_counts_v1.sql"),"utf8");
let db: PGlite;
declare const createLocalPostgres: () => PGlite;
const first = "00000000-0000-4000-8000-000000000001", empty = "00000000-0000-4000-8000-000000000002";
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.posts (id uuid primary key);
    create table public.post_metrics (post_id uuid primary key references public.posts,views integer);
    create table public.discover_events_v1 (id uuid primary key, post_id uuid,kind text,valid boolean);
    create index discover_events_post_recent_v1 on public.discover_events_v1(post_id);
    grant usage on schema public to service_role,anon,authenticated;
    grant select on public.posts,public.post_metrics,public.discover_events_v1 to service_role;
    insert into public.posts values ('${first}'),('${empty}');
    insert into public.post_metrics values ('${first}',1393);
    insert into public.discover_events_v1 values
      ('00000000-0000-4000-8000-000000000011','${first}','qualified_view',true),
      ('00000000-0000-4000-8000-000000000012','${first}','qualified_view',true),
      ('00000000-0000-4000-8000-000000000013','${first}','qualified_view',false),
      ('00000000-0000-4000-8000-000000000014','${first}','exposure',true),
      ('00000000-0000-4000-8000-000000000015','${first}','completion',true);`);
  await db.exec(migration);
},30000);
afterAll(async () => { await db.close(); });
test("actual SQL combines both sources, excludes invalid/nonview events, returns zero and deduplicates IDs", async () => {
  await db.exec("set role service_role");
  const result = await db.query(`select * from public.get_post_view_counts_v1(array['${first}','${first}','${empty}']::uuid[]) order by post_id`);
  expect(result.rows).toEqual([{post_id:first,view_count:1395},{post_id:empty,view_count:0}]);
  await db.exec("reset role");
});
test("read-only repeated calls do not change metrics or events; unknown IDs have no row", async () => {
  await db.exec(`select * from public.get_post_view_counts_v1(array['${first}']::uuid[]); select * from public.get_post_view_counts_v1(array['${first}']::uuid[]);`);
  expect((await db.query<{views:number}>("select views from public.post_metrics")).rows[0].views).toBe(1393);
  expect((await db.query<{count:number}>("select count(*)::int as count from public.discover_events_v1")).rows[0].count).toBe(5);
  expect((await db.query("select * from public.get_post_view_counts_v1(array['00000000-0000-4000-8000-000000000099']::uuid[])")).rows).toEqual([]);
});
test.each(["anon","authenticated"])("%s cannot execute the count RPC", async role => {
  await db.exec(`set role ${role}`);
  await expect(db.query(`select * from public.get_post_view_counts_v1(array['${first}']::uuid[])`)).rejects.toThrow(/permission denied/);
  await db.exec("reset role");
});
test("input limit is enforced in the database and empty arrays work", async () => {
  await expect(db.query(`select * from public.get_post_view_counts_v1(array_fill('${first}'::uuid,array[101]))`)).rejects.toThrow(/up to 100/);
  await expect(db.query("select * from public.get_post_view_counts_v1(null)")).rejects.toThrow(/up to 100/);
  await expect(db.query("select * from public.get_post_view_counts_v1(array[null]::uuid[])")).rejects.toThrow(/up to 100/);
  expect((await db.query("select * from public.get_post_view_counts_v1(array[]::uuid[])")).rows).toEqual([]);
});
test("migration is replay-safe and the routine remains stable, invoker, and service-only", async () => {
  await db.exec(migration);
  const result = await db.query(`select provolatile,prosecdef,proconfig,
    has_function_privilege('anon',oid,'execute') as anon,
    has_function_privilege('authenticated',oid,'execute') as authenticated,
    has_function_privilege('service_role',oid,'execute') as service
    from pg_proc where proname='get_post_view_counts_v1'`);
  expect(result.rows[0]).toMatchObject({provolatile:"s",prosecdef:false,anon:false,authenticated:false,service:true});
});
