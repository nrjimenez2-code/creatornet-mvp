/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const viewer='22222222-2222-4222-8222-222222222222', other='33333333-3333-4333-8333-333333333333';
const creator='11111111-1111-4111-8111-111111111111', post='44444444-4444-4444-8444-444444444444';
type Result={liked:boolean;likes_count:number;inserted:boolean;category:string|null};
async function call(likeOnly=true, user=viewer, postId=post) {
  await db.exec('set role service_role');
  try { return (await db.query<{result:Result}>('select update_post_like_v1($1,$2,$3) result',[user,postId,likeOnly])).rows[0].result; }
  finally { await db.exec('reset role'); }
}
beforeAll(async()=>{
  db=createLocalPostgres();
  await db.exec(readFileSync('test-support/post-like-fixture.sql','utf8'));
  const taxonomy=readFileSync('supabase/migrations/20260913004646_discover_taxonomy.sql','utf8');
  await db.exec(taxonomy.slice(taxonomy.indexOf('create or replace function'),taxonomy.indexOf('create table')));
  const trigger=readFileSync('supabase/migrations/20260913011108_discover_eligibility_and_measurement.sql','utf8');
  await db.exec(trigger.slice(trigger.indexOf('create or replace function discover_private.like_changed_v1()'),trigger.indexOf('-- Private metrics')));
  await db.exec(readFileSync('supabase/migrations/20260917073719_post_like_single_rpc.sql','utf8'));
},60000);
beforeEach(async()=>{await db.exec('begin');});
afterEach(async()=>{await db.exec('rollback');});
afterAll(async()=>{await db.close();});

test('repeated PUT increments once, retains first category and existing recommendation event',async()=>{
  expect(await call()).toEqual({liked:true,likes_count:1,inserted:true,category:' Content Creation '});
  expect(await call()).toEqual({liked:true,likes_count:1,inserted:false,category:null});
  expect((await db.query('select valid,categories,topics from discover_events_v1')).rows).toEqual([
    {valid:true,categories:['content creation & marketing','technology & ai'],topics:['sample']}]);
  expect((await db.query('select count(*)::int n from likes')).rows).toEqual([{n:1}]);
});
test('POST unlikes then re-likes and preserves event validity transitions',async()=>{
  await call();
  expect(await call(false)).toMatchObject({liked:false,likes_count:0,inserted:false});
  expect((await db.query('select valid from discover_events_v1')).rows).toEqual([{valid:false}]);
  expect(await call(false)).toMatchObject({liked:true,likes_count:1,inserted:true});
  expect((await db.query('select valid from discover_events_v1')).rows).toEqual([{valid:true}]);
});
test('viewer mutations do not remove another viewer like',async()=>{
  await call();await call(true,other);
  expect(await call(false)).toMatchObject({liked:false,likes_count:1});
  expect((await db.query('select user_id from likes')).rows).toEqual([{user_id:other}]);
});
test('creator self-like still has no Discover conversion event',async()=>{
  expect(await call(true,creator)).toMatchObject({liked:true,likes_count:1});
  expect((await db.query('select count(*)::int n from discover_events_v1')).rows).toEqual([{n:0}]);
});
test.each(['anon','authenticated','untrusted'])('%s cannot invoke the server mutation',async role=>{
  expect((await db.query<{allowed:boolean}>("select has_function_privilege($1,'public.update_post_like_v1(uuid,uuid,boolean)','execute') allowed",[role])).rows[0].allowed).toBe(false);
  await db.exec('savepoint denied; set role '+role);
  await expect(db.query('select update_post_like_v1($1,$2,true)',[viewer,post])).rejects.toMatchObject({code:'42501'});
  await db.exec('rollback to denied; reset role');
});
test('counter failure rolls back the like and recommendation trigger together',async()=>{
  await db.exec('alter table posts add constraint force_counter_failure check(likes_count=0); savepoint failure');
  await expect(db.query('select update_post_like_v1($1,$2,true)',[viewer,post])).rejects.toMatchObject({code:'23514'});
  await db.exec('rollback to failure');
  expect((await db.query('select (select count(*)::int from likes) likes,(select count(*)::int from discover_events_v1) events')).rows).toEqual([{likes:0,events:0}]);
});
test('missing post and null actor reject without a mutation',async()=>{
  for(const [user,p,code] of [[viewer,other,'P0002'],[null,post,'22004']]){
    await db.exec('savepoint invalid');
    await expect(db.query('select update_post_like_v1($1,$2,true)',[user,p])).rejects.toMatchObject({code});
    await db.exec('rollback to invalid');
  }
  expect((await db.query('select count(*)::int n from likes')).rows).toEqual([{n:0}]);
});
test('unlike preserves zero floor for an already inconsistent legacy count',async()=>{
  await call();await db.exec('update posts set likes_count=0');
  expect(await call(false)).toMatchObject({liked:false,likes_count:0});
});
test('like preserves the existing zero floor and a foreign actor cannot leave effects',async()=>{
  await db.exec('update posts set likes_count=-2');
  expect(await call()).toMatchObject({liked:true,likes_count:0});
  await db.exec('savepoint foreign_actor');
  await expect(db.query('select update_post_like_v1($1,$2,true)',[post,post])).rejects.toMatchObject({code:'23503'});
  await db.exec('rollback to foreign_actor');
  expect((await db.query('select count(*)::int n from likes')).rows).toEqual([{n:1}]);
});
