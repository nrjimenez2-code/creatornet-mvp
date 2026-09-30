/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const creator = "11111111-1111-4111-8111-111111111111";
const other = "33333333-3333-4333-8333-333333333333";
const post = "22222222-2222-4222-8222-222222222222";
const migration = "supabase/migrations/20260930031043_automatic_post_metadata.sql";
type Job = { post_id: string; lease_token: string; source_fingerprint: string; classification_context: unknown; classification_version: number | null };
jest.setTimeout(90000);
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table profiles(id uuid primary key,username text,bio text,tagline text,banned_at timestamptz);
    create table products(id uuid primary key,product_id uuid,creator_id uuid,title text,description text,active boolean);
    create table offerings(id uuid primary key,creator_id uuid,title text,product_metadata jsonb,is_active boolean);
    create table posts(id uuid primary key,creator_id uuid,title text,content text,caption text,video_url text,premium_path text,
      duration_seconds numeric,active boolean default true,hidden_at timestamptz,removed_at timestamptz,
      product_id uuid,offering_id uuid,interests text[] default '{}',topics text[] default '{}',created_at timestamptz default now());
    create table search_video_text_v1(post_id uuid primary key references posts(id) on delete cascade,source_url text not null,
      status text default 'pending',transcript text default '',screen_text text default '',model text,attempts integer default 0,
      lease_token uuid,lease_until timestamptz,retry_at timestamptz default now(),updated_at timestamptz default now(),error_code text,
      search_text text generated always as (transcript || ' ' || screen_text) stored);
    grant select,insert,update,delete on posts,profiles,products,offerings,search_video_text_v1 to service_role;
    grant select,insert,update on posts to authenticated;
    insert into profiles values('${creator}','creator','Ecommerce mentor','',null),('${other}','other','','',null);`);
  await db.exec(readFileSync("supabase/schema/059-search-video-processing.sql", "utf8"));
  await db.exec(`insert into posts(id,creator_id,video_url,interests,topics) values
    ('${post}','${creator}','https://cdn.test/legacy.mp4',array['technology & ai'],array['programming']);
    insert into search_video_text_v1(post_id,source_url,status,attempts,transcript) values
    ('${post}','https://cdn.test/legacy.mp4','ready',2,'Existing transcription');`);
  await db.exec(readFileSync(migration, "utf8"));
  expect((await db.query("select status,attempts,transcript,classification_version from search_video_text_v1")).rows)
    .toEqual([{ status: "ready", attempts: 2, transcript: "Existing transcription", classification_version: null }]);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec(`reset role; delete from posts; delete from products; delete from offerings;
    update profiles set banned_at=null,bio='Ecommerce mentor',tagline='' where id='${creator}';
    insert into posts(id,creator_id,video_url,premium_path,classification_version,interests,topics,duration_seconds)
    values('${post}','${creator}','https://cdn.test/public.mp4','${creator}/private.mp4',1,array['business & entrepreneurship'],array['ecommerce'],10);`);
});
const claim = async () => (await db.query<{ job: Job }>("select claim_search_video_v1() job")).rows[0].job;
const finish = (job: Job, overrides: { token?: string; fingerprint?: string; category?: string; failure?: string | null } = {}) =>
  db.query<{ accepted: boolean }>(`select finish_post_classification_v1($1::uuid,$2::uuid,$3,'','','A person lifts weights.',
    '[{"category":"health & fitness","topics":["strength training"],"evidence":[{"kind":"visual","text":"Barbell lifts","start_seconds":1,"end_seconds":3}]}]'::jsonb,
    array[$4],array['strength training'],'text_and_video','google/gemini-3.6-flash','{"gateway_cost_usd":0.001}'::jsonb,$5) accepted`,
  [job.post_id, overrides.token ?? job.lease_token, overrides.fingerprint ?? job.source_fingerprint, overrides.category ?? "health & fitness", overrides.failure ?? null]);
const metadata = async () => (await db.query<{ interests: string[]; topics: string[] }>("select interests,topics from posts")).rows;

test("migration leaves existing posts and extraction attempts unchanged", async () => {
  // A legacy row still uses the original finish contract and retains its labels.
  await db.exec(`delete from posts; insert into posts(id,creator_id,video_url,interests,topics) values
    ('${post}','${creator}','https://cdn.test/legacy.mp4',array['technology & ai'],array['programming']);`);
  const job = await claim(); expect(job.classification_version).toBeNull();
  const result = await db.query<{ accepted: boolean }>("select finish_search_video_v1($1::uuid,$2::uuid,'Legacy speech','Screen','model',null) accepted", [post, job.lease_token]);
  expect(result.rows[0].accepted).toBe(true);
  expect(await metadata()).toEqual([{ interests: ["technology & ai"], topics: ["programming"] }]);
  expect(await claim()).toBeNull();
});
test("one active extraction, then atomic visual enrichment replaces fallback and keeps search text separate", async () => {
  const job = await claim(); expect(await claim()).toBeNull();
  expect(JSON.stringify(job)).not.toContain("private.mp4");
  expect((await finish(job)).rows[0].accepted).toBe(true);
  expect(await metadata()).toEqual([{ interests: ["health & fitness"], topics: ["strength training"] }]);
  expect((await db.query("select status,search_text,visual_summary,classification_source from search_video_text_v1")).rows)
    .toEqual([{ status: "ready", search_text: " ", visual_summary: "A person lifts weights.", classification_source: "text_and_video" }]);
  expect((await finish(job)).rows[0].accepted).toBe(false);
});
test.each([
  `update posts set video_url='https://cdn.test/changed.mp4'`,
  `update posts set title='Changed title'`,
  `update posts set content='Changed caption'`,
  `update profiles set bio='Learn guitar' where id='${creator}'`,
  `update profiles set tagline='Learn piano' where id='${creator}'`,
  `update posts set creator_id='${other}'`,
  `update posts set hidden_at=now()`,
  `update posts set removed_at=now()`,
  `update posts set active=false`,
  `update profiles set banned_at=now() where id='${creator}'`,
  `delete from posts`,
  `update search_video_text_v1 set lease_until=now()-interval '1 minute'`,
])("rejects a stale or ineligible result: %s", async mutation => {
  const job = await claim(); await db.exec(mutation);
  expect((await finish(job)).rows[0].accepted).toBe(false);
  const rows = await metadata(); if (rows.length) expect(rows[0].interests).toEqual(["business & entrepreneurship"]);
});
test("rejects changed offer context and ownership", async () => {
  await db.exec(`insert into products values('${other}',null,'${creator}','Programming','Learn coding',true); update posts set product_id='${other}'`);
  const job = await claim(); await db.exec("update products set description='Learn piano'");
  expect((await finish(job)).rows[0].accepted).toBe(false);
});
test("wrong leases, fingerprints, and unsupported categories cannot update posts", async () => {
  const job = await claim();
  expect((await finish(job, { token: other })).rows[0].accepted).toBe(false);
  expect((await finish(job, { fingerprint: "stale" })).rows[0].accepted).toBe(false);
  await expect(finish(job, { category: "medicine" })).rejects.toThrow("invalid classification");
  expect((await metadata())[0].interests).toEqual(["business & entrepreneurship"]);
});
test("provider failure preserves published metadata and existing retry delay and attempt cap", async () => {
  const job = await claim(); expect((await finish(job, { failure: "provider_access_denied" })).rows[0].accepted).toBe(true);
  expect((await metadata())[0].interests).toEqual(["business & entrepreneurship"]);
  expect(await claim()).toBeNull();
  await db.exec("update search_video_text_v1 set retry_at=now()-interval '1 minute',attempts=3");
  expect(await claim()).toBeNull();
});
test("ready feature records can re-evaluate changed context without resetting attempts", async () => {
  const job = await claim(); await finish(job);
  await db.exec(`update profiles set bio='New bio' where id='${creator}'; update search_video_text_v1 set retry_at=now()-interval '1 minute'`);
  expect(await claim()).not.toBeNull();
  expect((await db.query("select attempts from search_video_text_v1")).rows).toEqual([{ attempts: 2 }]);
});
test("private analysis and mutation RPCs are unavailable to ordinary clients; marker cannot be forged or changed", async () => {
  await db.exec("set role authenticated");
  await expect(db.query("select * from search_video_text_v1")).rejects.toThrow(/permission denied/);
  await expect(db.query("select claim_search_video_v1()")).rejects.toThrow(/permission denied/);
  await expect(db.query("select post_classification_context_v1($1::uuid)", [post])).rejects.toThrow(/permission denied/);
  await expect(db.exec(`insert into posts(id,creator_id,classification_version) values('${other}','${creator}',1)`)).rejects.toThrow(/publishing service/);
  await expect(db.exec("update posts set interests=array['money & investing']")).rejects.toThrow(/publishing service/);
  await expect(db.exec("update posts set classification_version=null")).rejects.toThrow(/immutable/);
  await db.exec("reset role");
});
