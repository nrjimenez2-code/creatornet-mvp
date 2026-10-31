/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const owner = "767658b6-7b2a-4cc4-91b4-6a0f78073a8e", other = "11111111-1111-4111-8111-111111111111";
let db: PGlite;
declare const createLocalPostgres: () => PGlite;
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,phone_confirmed_at timestamptz); create table public.profiles(id uuid primary key,role text,banned_at timestamptz); create table public.admin_actions(id uuid primary key default gen_random_uuid(),actor_id uuid references public.profiles(id),action text,target_table text,target_id uuid,reason text,created_at timestamptz default now()); grant select on public.profiles to service_role; grant insert,select on public.admin_actions to service_role;");
  await db.query("insert into auth.users values($1,'owner@example.test',now(),null),($2,'other@example.test',now(),null)", [owner, other]);
  await db.query("insert into public.profiles values($1,'admin',null),($2,'admin',null)", [owner, other]);
  for (const name of ["20261021010052_controlled_website_releases.sql", "20261022232949_website_public_holding_page.sql"]) await db.exec(readFileSync(join(__dirname, "../supabase/migrations", name), "utf8"));
}, 30000);
afterAll(async () => db?.close());
beforeEach(async () => db.exec("begin"));
afterEach(async () => db.exec("rollback"));
const setPage = (page: unknown, actor = owner, revision: number | null = 0) => db.query("select public.set_website_public_page_v1($1::uuid,$2::bigint,$3::text)", [actor, revision, page]);
const snapshot = async () => (await db.query<Record<string, unknown>>("select * from public.website_release_settings_v1")).rows[0];

test("additive migration preserves Coming Soon, owner, hiding, flags and existing account rows", async () => {
  expect(await snapshot()).toMatchObject({ public_page: "coming-soon", hidden: true, owner_id: owner, revision: 0 });
  expect((await db.query("select * from auth.users")).rows).toHaveLength(2);
  expect((await db.query("select * from public.website_release_testers_v1")).rows).toHaveLength(0);
});
test("service-only owner change is reversible, audited and leaves all other settings intact", async () => {
  const before = await snapshot();
  await db.exec("set local role service_role");
  await setPage("blank");
  const blank = await snapshot();
  expect(blank).toEqual({ ...before, public_page: "blank", revision: 1, updated_at: blank.updated_at });
  await setPage("coming-soon", owner, 1);
  const restored = await snapshot();
  expect(restored).toEqual({ ...before, revision: 2, updated_at: restored.updated_at });
  const audit = (await db.query<{action:string;reason:string}>("select action,reason from public.admin_actions order by created_at,id")).rows;
  expect(audit).toHaveLength(2);
  expect(audit.every(row => row.action === "website_public_page_update")).toBe(true);
  expect(audit.map(row => JSON.parse(row.reason).after.public_page).sort()).toEqual(["blank", "coming-soon"]);
});
test.each(["anon", "authenticated"])("%s cannot invoke the page mutation", async role => {
  await db.exec("set local role " + role);
  await expect(setPage("blank")).rejects.toThrow(/permission denied/);
});
test("another administrator cannot change the page", async () => {
  await expect(setPage("blank", other)).rejects.toThrow(/Release owner required/);
});
test.each([null, "unknown", ""])("invalid page %s cannot be saved", async page => {
  await expect(setPage(page)).rejects.toThrow(/Invalid public page/);
});
test.each([null, -1, 1])("stale or missing revision %s is rejected", async revision => {
  await expect(setPage("blank", owner, revision)).rejects.toThrow(/changed/);
});
test("audit failure rolls the page and revision back", async () => {
  await db.exec("alter table public.admin_actions add constraint reject_public_page_audit check(action <> 'website_public_page_update') not valid; savepoint before_change");
  await expect(setPage("blank")).rejects.toThrow(/reject_public_page_audit/);
  await db.exec("rollback to savepoint before_change");
  expect(await snapshot()).toMatchObject({ public_page: "coming-soon", revision: 0 });
});
test("the existing release RPC preserves the saved page choice", async () => {
  await setPage("blank");
  const before = await snapshot();
  await db.query("select public.update_website_release_v1($1::uuid,1,true,$2::jsonb,'https://discord.gg/bKC8q4z6B')", [owner, JSON.stringify(before.features)]);
  expect(await snapshot()).toMatchObject({ public_page: "blank", hidden: true, features: before.features, revision: 2 });
});
