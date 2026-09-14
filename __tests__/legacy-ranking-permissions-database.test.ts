/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const migration=readFileSync("supabase/migrations/20260914002844_restrict_legacy_ranking_mutations.sql","utf8");
const id="11111111-1111-4111-8111-111111111111";
jest.setTimeout(90000);
beforeAll(async()=>{
 db=createLocalPostgres();
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create table posts(id uuid primary key,comments_count integer);
 create table user_interest_scores(user_id uuid,category text,score integer,updated_at timestamptz,primary key(user_id,category));
 create table post_metrics(post_id uuid primary key,impressions integer,views integer,total_watch_seconds numeric,completions integer,profile_clicks integer,buy_clicks integer,checkout_starts integer,purchases integer,post_conversion_score numeric,updated_at timestamptz);`);
 await db.exec(readFileSync("supabase/schema/006-atomic-counters.sql","utf8"));
 await db.exec("grant execute on all functions in schema public to public,anon,authenticated");
 await db.exec(migration);
});
afterAll(async()=>{await db.close()});
test("browser roles cannot invoke any legacy ranking mutation",async()=>{
 for(const role of ["anon","authenticated"]){
  await db.exec("set role "+role);
  try{
   for(const call of [
    `select bump_interest_score('${id}','Technology & AI',1000)`,
    `select bump_post_metrics('${id}',p_purchases=>1000)`,
    `select bump_post_metrics_scored('${id}',p_purchases=>1000)`
   ])await expect(db.query(call)).rejects.toThrow(/permission denied/);
  }finally{await db.exec("reset role")}
 }
 expect((await db.query("select count(*)::int as n from post_metrics")).rows).toEqual([{n:0}]);
});
test("server role retains real score updates including the nested metrics call",async()=>{
 await db.exec("set role service_role");
 try{
  expect((await db.query(`select bump_interest_score('${id}','Technology & AI',2) as score`)).rows).toEqual([{score:2}]);
  await db.query(`select bump_post_metrics_scored('${id}',p_views=>2,p_purchases=>1)`);
 }finally{await db.exec("reset role")}
 expect((await db.query("select views,purchases,post_conversion_score::int as score from post_metrics")).rows).toEqual([{views:2,purchases:1,score:27}]);
});
test("migration tolerates an installation without legacy helpers",async()=>{
 const empty=createLocalPostgres();
 try{
  await empty.exec("create role anon;create role authenticated;create role service_role");
  await expect(empty.exec(migration)).resolves.toBeDefined();
 }finally{await empty.close()}
});
