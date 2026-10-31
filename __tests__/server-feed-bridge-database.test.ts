/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

declare const createLocalPostgres: () => PGlite;
const fixture = JSON.parse(readFileSync("test-support/server-feed-production-fixture.json", "utf8")) as {
  functions: { name: string; schema: string; definition: string; body_md5: string }[];
};
const migration = readFileSync("supabase/migrations/20261023031406_server_only_legacy_feed_bridge.sql", "utf8");
const postDeploy = readFileSync("supabase/migrations/20261023032324_revoke_legacy_client_feed_after_deploy.sql", "utf8");
const viewer = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const creator = "33333333-3333-4333-8333-333333333333", banned = "44444444-4444-4444-8444-444444444444";
const post = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const names = ["request.jwt.claims", "request.jwt.claim", "request.jwt.claim.sub", "request.jwt.claim.role"];
let db: PGlite;
let preDeploy: { aclUnchanged: boolean; anonymous: string[]; following: string[]; bridge: string[] };
jest.setTimeout(90000);
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;grant usage on schema auth to anon,authenticated,service_role;
    create table profiles(id uuid primary key,full_name text,username text,avatar_url text,stripe_account_id text,stripe_onboarding_complete boolean,banned_at timestamptz);
    create table posts(id uuid primary key,creator_id uuid,product_id uuid,price_cents integer,title text,video_url text,poster_url text,interests text[],hashtags text[],created_at timestamptz default now(),likes_count integer,comments_count integer,shares_count integer,allow_booking boolean,booking_url text,purchase_count integer,active boolean,hidden_at timestamptz,removed_at timestamptz);
    create table follows(follower_id uuid,following_id uuid);
    create table likes(user_id uuid,post_id uuid);
    create table products(id uuid,product_id uuid,type text,amount_cents integer,price_cents integer);
    create table post_metrics(post_id uuid,views integer,completions integer,post_conversion_score numeric);
    create table user_interest_scores(user_id uuid,category text,score numeric);
    insert into profiles values('${creator}','Creator','creator',null,'acct_synthetic',true,null),('${banned}','Banned','banned',null,null,false,now());
    insert into posts(id,creator_id,title,video_url,interests) values('${post}','${creator}','Visible','https://example.invalid/public.mp4',array['topic']),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','${banned}','Banned','https://example.invalid/banned.mp4',array['topic']);
    insert into follows values('${viewer}','${creator}'),('${viewer}','${banned}');
    insert into likes values('${viewer}','${post}');`);
  for (const f of fixture.functions) await db.exec(f.definition);
  await db.exec("grant execute on function public.get_feed_v3(text,integer,integer) to anon,authenticated,service_role;");
  const acl = async () => (await db.query<{ acl: string }>("select proacl::text acl from pg_proc where oid='public.get_feed_v3(text,integer,integer)'::regprocedure")).rows[0].acl;
  const oldAcl = await acl();
  await db.exec(migration);
  preDeploy = { aclUnchanged: oldAcl === await acl(), anonymous: [], following: [], bridge: [] };
  // Before application deployment, current SSR calls must remain available.
  await db.exec("begin;set local role anon");
  await claims([JSON.stringify({role:"anon"}),"","","anon"]);
  preDeploy.anonymous = (await db.query<{post_id:string}>("select * from public.get_feed_v3('discover',20,0)")).rows.map(row=>row.post_id);
  await db.exec("rollback;begin;set local role authenticated");
  await claims([JSON.stringify({role:"authenticated",sub:viewer}),"",viewer,"authenticated"]);
  preDeploy.following = (await db.query<{post_id:string}>("select * from public.get_feed_v3('following',20,0)")).rows.map(row=>row.post_id);
  await db.exec("rollback;begin;set local role service_role");
  preDeploy.bridge = (await call(viewer,"following")).rows.map(row=>row.post_id);
  await db.exec("rollback");
  await db.exec(postDeploy);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });

async function role(value: string) { await db.exec("set local role " + value); }
async function claims(values: string[]) {
  for (let i = 0; i < names.length; i++) await db.query("select set_config($1,$2,true)", [names[i], values[i]]);
}
async function readClaims() {
  const result: string[] = [];
  for (const name of names) result.push((await db.query<{ value: string }>("select current_setting($1,true) value", [name])).rows[0].value);
  return result;
}
const call = (actor: string | null, tab = "discover") => db.query<{ post_id: string; is_liked: boolean; is_following: boolean }>(
  "select * from public.get_feed_for_actor_v1($1,$2,20,0)", [actor, tab]);

test("additive pre-deploy phase preserves old SSR anonymous/following access and permits the new bridge",()=>{
  expect(preDeploy).toEqual({aclUnchanged:true,anonymous:[post],following:[post],bridge:[post]});
});

test("migration retains the exact captured feed body and result contract", async () => {
  const captured = fixture.functions.find(f => f.name === "get_feed_v3")!;
  expect((await db.query<{ hash: string }>("select md5(prosrc) hash from pg_proc where oid='public.get_feed_v3(text,integer,integer)'::regprocedure")).rows[0].hash).toBe(captured.body_md5);
  expect((await db.query<{ same: boolean }>("select pg_get_function_result('public.get_feed_v3(text,integer,integer)'::regprocedure)=pg_get_function_result('public.get_feed_for_actor_v1(uuid,text,integer,integer)'::regprocedure) same")).rows[0].same).toBe(true);
});

test.each(["anon", "authenticated"])("%s cannot call either original feed or actor-forging bridge", async caller => {
  for (const fn of ["public.get_feed_v3(text,integer,integer)", "public.get_feed_for_actor_v1(uuid,text,integer,integer)"]) {
    expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') allowed", [caller, fn])).rows[0].allowed).toBe(false);
  }
  await role(caller);
  await claims([JSON.stringify({ role: "service_role", sub: viewer }), "", viewer, "service_role"]);
  await db.exec("savepoint denied");
  await expect(call(viewer, "following")).rejects.toMatchObject({ code: "42501" });
  await db.exec("rollback to denied");
  await expect(db.query("select * from public.get_feed_v3('following',20,0)")).rejects.toMatchObject({ code: "42501" });
});

test("even an accidental bridge grant cannot turn spoofed claims into the service role", async () => {
  await db.exec("grant execute on function public.get_feed_for_actor_v1(uuid,text,integer,integer) to authenticated");
  await role("authenticated");
  await claims([JSON.stringify({ role: "service_role" }), "", viewer, "service_role"]);
  await expect(call(viewer)).rejects.toMatchObject({ code: "42501" });
});

test("verified viewer retains following/like context while banned creators remain excluded", async () => {
  await role("service_role");
  // All old claim forms deliberately disagree with the supplied verified viewer.
  const before = [JSON.stringify({ role: "service_role", sub: other }), JSON.stringify({ role: "old", sub: other }), other, "service_role"];
  await claims(before);
  const rows = (await call(viewer, "following")).rows;
  expect(rows.map(row => row.post_id)).toEqual([post]);
  expect(rows[0]).toMatchObject({ is_liked: true, is_following: true });
  expect(await readClaims()).toEqual(before);
  expect((await call(other, "following")).rows).toEqual([]);
  expect(await readClaims()).toEqual(before);
});

test("anonymous feed clears inherited viewer identity and preserves original caller context", async () => {
  await role("service_role");
  const before = [JSON.stringify({ role: "authenticated", sub: viewer }), JSON.stringify({ role: "authenticated", sub: viewer }), viewer, "authenticated"];
  await claims(before);
  expect((await call(null, "following")).rows).toEqual([]);
  expect((await call(null)).rows).toEqual([expect.objectContaining({ post_id: post, is_liked: false, is_following: false })]);
  expect(await readClaims()).toEqual(before);
});

test("feed failure preserves every original claim setting", async () => {
  await db.exec("drop table likes");
  await role("service_role");
  const before = [JSON.stringify({ role: "service_role" }), JSON.stringify({ role: "legacy" }), other, "service_role"];
  await claims(before);
  await db.exec("savepoint feed_failure");
  await expect(call(viewer, "following")).rejects.toMatchObject({ code: "42P01" });
  await db.exec("rollback to feed_failure");
  expect(await readClaims()).toEqual(before);
});

test("migration refuses a changed legacy body before altering privileges", async () => {
  await db.exec("drop function public.get_feed_for_actor_v1(uuid,text,integer,integer)");
  const original = fixture.functions.find(f => f.name === "get_feed_v3")!;
  await db.exec(original.definition.replace("v_uid uuid := auth.uid();", "v_uid uuid := null;"));
  // The migration starts its own transaction, so exercise it in an independent DB.
  const isolated = createLocalPostgres();
  try {
    await isolated.exec("create role anon;create role authenticated;create role service_role;create schema auth;create function auth.uid() returns uuid language sql as $$select null::uuid$$;");
    await isolated.exec(original.definition.replace("v_uid uuid := auth.uid();", "v_uid uuid := null;"));
    await expect(isolated.exec(migration)).rejects.toThrow("differs from the reviewed Production");
    await isolated.exec("rollback");
    expect((await isolated.query<{ exists: boolean }>("select to_regprocedure('public.get_feed_for_actor_v1(uuid,text,integer,integer)') is not null as exists")).rows[0].exists).toBe(false);
  } finally { await isolated.close(); }
});

test.each(["missing bridge", "bridge body", "bridge metadata", "bridge PUBLIC grant", "legacy body"])(
  "post-deploy revoke refuses %s drift without closing the old entry prematurely", async drift => {
    const isolated = createLocalPostgres();
    try {
      await isolated.exec("create role anon;create role authenticated;create role service_role;create schema auth;");
      for (const f of fixture.functions) await isolated.exec(f.definition);
      await isolated.exec("grant execute on function public.get_feed_v3(text,integer,integer) to anon,authenticated,service_role");
      await isolated.exec(migration);
      if(drift==="missing bridge") await isolated.exec("drop function public.get_feed_for_actor_v1(uuid,text,integer,integer)");
      if(drift==="bridge body") {
        const definition=(await isolated.query<{definition:string}>("select pg_get_functiondef('public.get_feed_for_actor_v1(uuid,text,integer,integer)'::regprocedure) definition")).rows[0].definition;
        await isolated.exec(definition.replace("return query select * from public.get_feed_v3(p_tab,p_limit,p_offset);","raise exception 'Changed bridge';"));
      }
      if(drift==="bridge metadata") await isolated.exec("alter function public.get_feed_for_actor_v1(uuid,text,integer,integer) security definer");
      if(drift==="bridge PUBLIC grant") await isolated.exec("grant execute on function public.get_feed_for_actor_v1(uuid,text,integer,integer) to public");
      if(drift==="legacy body") await isolated.exec(fixture.functions.find(f=>f.name==="get_feed_v3")!.definition.replace("v_uid uuid := auth.uid();","v_uid uuid := null;"));
      await expect(isolated.exec(postDeploy)).rejects.toThrow(/differs|privileges/);
      await isolated.exec("rollback");
      expect((await isolated.query<{allowed:boolean}>("select has_function_privilege('anon','public.get_feed_v3(text,integer,integer)','EXECUTE') allowed")).rows[0].allowed).toBe(true);
    } finally { await isolated.close(); }
  });
