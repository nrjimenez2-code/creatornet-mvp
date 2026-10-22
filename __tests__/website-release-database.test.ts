/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closedFeatures } from "@/lib/release/policy";
const owner = "767658b6-7b2a-4cc4-91b4-6a0f78073a8e", tester = "11111111-1111-4111-8111-111111111111", outsider = "22222222-2222-4222-8222-222222222222", invite = "https://discord.gg/bKC8q4z6B";
let db: PGlite;
declare const createLocalPostgres: () => PGlite;
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,phone_confirmed_at timestamptz);
    create table public.profiles(id uuid primary key,role text,banned_at timestamptz);
    create table public.admin_actions(id uuid primary key default gen_random_uuid(),actor_id uuid references public.profiles(id),action text,target_table text,target_id uuid,reason text,created_at timestamptz default now());
    grant select on public.profiles to service_role; grant insert,select on public.admin_actions to service_role;
    insert into auth.users values('${owner}','owner@example.test',now(),null),('${tester}','tester@example.test',now(),null),('${outsider}','other@example.test',now(),null);
    insert into public.profiles values('${owner}','admin',null),('${tester}','user',null),('${outsider}','admin',null);`);
  await db.exec(readFileSync(join(__dirname, "../supabase/migrations/20261021010052_controlled_website_releases.sql"), "utf8"));
}, 30000);
afterAll(async () => { await db?.close(); });
const update = (actor: string, revision: number, hidden = true, flags = closedFeatures()) => db.query("select public.update_website_release_v1($1::uuid,$2::bigint,$3::boolean,$4::jsonb,$5::text)", [actor, revision, hidden, JSON.stringify(flags), invite]);
test("migration initializes hidden, all features closed, no testers; original accounts remain", async () => {
  const result = await db.query<{hidden:boolean;features:object;owner_id:string}>("select * from public.website_release_settings_v1");
  expect(result.rows[0]).toMatchObject({ hidden: true, owner_id: owner, features: closedFeatures() });
  expect((await db.query("select * from public.website_release_testers_v1")).rows).toHaveLength(0);
  expect((await db.query("select * from auth.users")).rows).toHaveLength(3);
});
test.each(["anon", "authenticated"])("%s cannot read configuration, approve testers or invoke mutations", async role => {
  await db.exec(`set role ${role}`);
  try {
    await expect(db.query("select * from public.website_release_settings_v1")).rejects.toThrow(/permission denied/);
    await expect(db.query("select * from public.website_release_testers_v1")).rejects.toThrow(/permission denied/);
    await expect(update(owner, 0)).rejects.toThrow(/permission denied/);
  } finally { await db.exec("reset role"); }
});
test("service role can manage releases through scoped helpers without SELECT on auth.users", async () => {
  await db.exec("begin; set local role service_role");
  try {
    expect((await db.query<{id:string}>("select public.website_existing_email_v1('owner@example.test') as id")).rows[0].id).toBe(owner);
    await update(owner, 0);
    expect((await db.query<{revision:number}>("select revision from public.website_release_settings_v1")).rows[0].revision).toBe(1);
  } finally { await db.exec("rollback"); }
  expect((await db.query<{allowed:boolean}>("select has_table_privilege('service_role','auth.users','select') as allowed")).rows[0].allowed).toBe(false);
});
test("another administrator cannot change settings", async () => { await expect(update(outsider, 0)).rejects.toThrow(/Release owner required/); });
test("update and audit commit together; stale/null revisions and invalid dependencies fail", async () => {
  await update(owner, 0); expect((await db.query("select * from public.admin_actions")).rows).toHaveLength(1);
  await expect(update(owner, 0)).rejects.toThrow(/changed/);
  await expect(db.query("select public.update_website_release_v1($1::uuid,null,true,$2::jsonb,$3)",[owner,JSON.stringify(closedFeatures()),invite])).rejects.toThrow(/changed/);
  await expect(update(owner, 1, false, { ...closedFeatures(), search: true })).rejects.toThrow(/Invalid release/);
  const flags = { ...closedFeatures(), feed: true }; await update(owner, 1, false, flags); await update(owner, 2, true, flags);
  expect((await db.query<{hidden:boolean;features:{feed:boolean}}>("select hidden,features from public.website_release_settings_v1")).rows[0]).toMatchObject({ hidden: true, features: { feed: true } });
});
test("tester changes are audited and never grant an admin role; revoke removes access", async () => {
  await db.query("select public.set_website_tester_v1($1::uuid,3,$2::uuid,true)", [owner,tester]);
  expect((await db.query<{role:string}>("select role from public.profiles where id=$1",[tester])).rows[0].role).toBe("user");
  expect((await db.query("select * from public.website_release_testers_v1")).rows).toHaveLength(1);
  await db.query("select public.set_website_tester_v1($1::uuid,4,$2::uuid,false)", [owner,tester]);
  expect((await db.query("select * from public.website_release_testers_v1")).rows).toHaveLength(0);
});
test("audit failure rolls settings and revision back", async () => {
  await db.exec("alter table public.admin_actions add constraint reject_release_audit check(action <> 'website_release_update') not valid");
  await expect(update(owner, 5)).rejects.toThrow(/reject_release_audit/);
  expect((await db.query<{revision:number}>("select revision from public.website_release_settings_v1")).rows[0].revision).toBe(5);
});
test("owner can revoke a tester whose account became banned", async () => {
  await db.exec("begin");
  try {
    await db.query("select public.set_website_tester_v1($1::uuid,5,$2::uuid,true)", [owner,tester]);
    await db.query("update public.profiles set banned_at=now() where id=$1", [tester]);
    await db.query("select public.set_website_tester_v1($1::uuid,6,$2::uuid,false)", [owner,tester]);
    expect((await db.query("select * from public.website_release_testers_v1")).rows).toHaveLength(0);
  } finally { await db.exec("rollback"); }
});
test("website email registration check returns only an existing verified account", async () => {
  expect((await db.query<{id:string}>("select public.website_existing_email_v1('OWNER@example.test') as id")).rows[0].id).toBe(owner);
  expect((await db.query<{id:string|null}>("select public.website_existing_email_v1('new@example.test') as id")).rows[0].id).toBeNull();
});
