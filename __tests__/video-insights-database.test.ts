/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
declare const createLocalPostgres: () => PGlite;
const post="11111111-1111-4111-8111-111111111111",owner="22222222-2222-4222-8222-222222222222";
const actor="a".repeat(64),token="b".repeat(64),version="sha256:fixture:10";
const first="33333333-3333-4333-8333-333333333333",second="44444444-4444-4444-8444-444444444444";
let db:PGlite;
beforeAll(async()=>{
  db=createLocalPostgres();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table public.posts(id uuid primary key,creator_id uuid,removed_at timestamptz);
    grant select,update on public.posts to service_role;insert into public.posts values('${post}','${owner}',null);`);
  await db.exec(readFileSync(join(process.cwd(),"supabase/migrations/20260927054350_video_insights.sql"),"utf8"));
},30000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec("begin");});afterEach(async()=>{await db.exec("rollback");});
async function start(id=first,duration:number|null=10,media=version,source="discover") {
  await db.query("select public.start_video_insight_session_v1($1,$2,$3,$4,$5,$6,$7,'feed',now()-interval '30 seconds')",[id,post,actor,token,media,duration,source]);
}
async function event(id=first,sequence=1,seconds=9,intervals:number[][]=[[0,9]],who=actor,secret=token) {
  await db.query("select public.merge_video_insight_event_v1($1,$2,$3,$4,$5,$6)",[id,who,secret,sequence,seconds,JSON.stringify(intervals)]);
}
async function read(media=version,creator=owner) {return (await db.query<{data:any}>("select public.read_video_insights_v1($1,$2,$3) data",[post,creator,media])).rows[0].data;}
test("exact fixture includes immediate exit, completion, opening, elapsed repeats, sources and retention",async()=>{
  await start();await start(second,10,version,"search"); await event();
  await event(first,2,15,[[0,9]]);
  const a=await read();expect(a.sessions).toBe(2);expect(a.watch_seconds).toBe(15);expect(a.unique_seconds).toBe(9);
  expect(a.completions).toBe(1);expect(a.opening).toBe(1);expect(a.buckets).toEqual([1,1,1,1,1,1,1,1,1,0]);
  expect(a.sources).toEqual({discover:1,search:1});
});
test("duplicates and old sequences cannot increase totals",async()=>{
  await start();await start();await event();await event();await event(first,0,10,[[0,10]]);
  expect(await read()).toMatchObject({sessions:1,watch_seconds:9,unique_seconds:9});
});
test("overlaps merge atomically, missing earlier interval payloads never remove coverage",async()=>{
  await start();await event(first,1,3,[[0,3]]);await event(first,3,6,[[2,5],[8,9]]);await event(first,2,4,[[0,4]]);
  expect(await read()).toMatchObject({watch_seconds:6,unique_seconds:6,opening:1,completions:0});
  expect((await read()).buckets).toEqual([1,1,1,1,1,0,0,0,1,0]);
});
test("opening requires complete unique opening; skipped three seconds do not qualify",async()=>{
  await start();await event(first,1,8,[[0,1],[2,9]]);expect((await read()).opening).toBe(0);
  await event(first,2,9,[[1,2]]);expect((await read()).opening).toBe(1);
});
test("short-video opening uses full duration and fractional final bucket",async()=>{
  await start(first,1.5,"short");await event(first,1,1.5,[[0,1.5]]);
  expect(await read("short")).toMatchObject({opening:1,completions:1,buckets:[1,1]});
});
test("long video has at most 300 equal buckets with fractional coverage",async()=>{
  await start(first,600,"long");await event(first,1,1,[[0,1]]);
  expect((await read("long")).buckets).toHaveLength(300);expect((await read("long")).buckets[0]).toBe(0.5);
});
test("unknown duration retains elapsed time and source, duration metrics stay unavailable",async()=>{
  await start(first,null,"unknown","unknown");await event(first,1,2,[[0,2]]);
  expect(await read("unknown")).toMatchObject({sessions:1,watch_seconds:2,buckets:[],completions:0,opening:0,sources:{unknown:1}});
});
test("replacement media has independent aggregates",async()=>{
  await start();await event();await start(second,20,"replacement");
  expect((await read("replacement")).sessions).toBe(1);expect((await read("replacement")).watch_seconds).toBe(0);expect((await read()).watch_seconds).toBe(9);
});
test("wrong actor and token are denied",async()=>{
  await start();await expect(event(first,1,2,[[0,2]],"c".repeat(64))).rejects.toThrow(/Invalid session/);
});
test("wrong owner cannot read even through server role",async()=>{
  await start();await expect(read(version,post)).rejects.toThrow(/Owner required/);
});
test("impossible timing, invalid bounds and oversized intervals are rejected",async()=>{
  await start();await expect(event(first,1,100,[[0,10]])).rejects.toThrow(/Invalid cumulative/);
});
test("out-of-bounds timeline is rejected",async()=>{
  await start();await expect(event(first,1,10,[[0,11]])).rejects.toThrow(/outside timeline/);
});
test("cleanup retains aggregate history and expired tokens cannot recreate a detail row",async()=>{
  await start();await event();await db.exec("update public.video_insight_sessions_v1 set started_at=now()-interval '31 days'");
  await db.exec("select public.cleanup_video_insight_sessions_v1()");expect((await read()).watch_seconds).toBe(9);
  expect((await db.query("select * from public.video_insight_sessions_v1")).rows).toHaveLength(0);
});
test("soft removal purges insights while preserving post, hard removal cascades",async()=>{
  await start();await event();await db.query("update public.posts set removed_at=now() where id=$1",[post]);
  expect((await db.query("select * from public.video_insight_aggregates_v1")).rows).toHaveLength(0);
  expect((await db.query("select * from public.video_insight_sessions_v1")).rows).toHaveLength(0);
  expect((await db.query("select * from public.posts")).rows).toHaveLength(1);
});
test.each(["anon","authenticated"])("%s cannot read/write either table or execute insight functions",async role=>{
  for(const table of ["video_insight_sessions_v1","video_insight_aggregates_v1"]) for(const operation of ["select","insert","update","delete"]) {
    expect((await db.query<{ok:boolean}>("select has_table_privilege($1,$2,$3) ok",[role,`public.${table}`,operation])).rows[0].ok).toBe(false);
  }
  for(const fn of ["public.start_video_insight_session_v1(uuid,uuid,text,text,text,double precision,text,text,timestamptz)",
    "public.merge_video_insight_event_v1(uuid,text,text,integer,double precision,jsonb)","public.read_video_insights_v1(uuid,uuid,text)","public.cleanup_video_insight_sessions_v1()"])
    expect((await db.query<{ok:boolean}>("select has_function_privilege($1,$2,'execute') ok",[role,fn])).rows[0].ok).toBe(false);
  await db.exec(`set local role ${role}`);
  await expect(db.query("select * from public.video_insight_sessions_v1")).rejects.toThrow(/permission denied/);
});
test("RLS enabled, service role works with SECURITY INVOKER and response includes no actor identifiers",async()=>{
  const rows=(await db.query<{relrowsecurity:boolean}>("select relrowsecurity from pg_class where relname in ('video_insight_sessions_v1','video_insight_aggregates_v1')")).rows;
  expect(rows.every(row=>row.relrowsecurity)).toBe(true);
  await db.exec("set local role service_role");await start();await event();
  const a=await read();expect(a.sessions).toBe(1);expect(JSON.stringify(a)).not.toContain(actor);expect(JSON.stringify(a)).not.toContain(token);
});
