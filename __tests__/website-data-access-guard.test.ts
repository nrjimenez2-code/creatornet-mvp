/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closedFeatures } from '@/lib/release/policy';

declare const createLocalPostgres: () => PGlite;
const owner='767658b6-7b2a-4cc4-91b4-6a0f78073a8e', tester='11111111-1111-4111-8111-111111111111';
const buyer='22222222-2222-4222-8222-222222222222', stranger='33333333-3333-4333-8333-333333333333';
const purchased='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', own='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', other='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
let db:PGlite;
beforeAll(async()=>{
  db=createLocalPostgres();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create role authenticator;
    create schema auth;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    grant usage on schema auth to anon,authenticated,service_role;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,phone_confirmed_at timestamptz);
    create table public.profiles(id uuid primary key,role text,banned_at timestamptz);
    create table public.admin_actions(id uuid primary key default gen_random_uuid(),actor_id uuid,action text,target_table text,target_id uuid,reason text,created_at timestamptz default now());
    create table public.posts(id uuid primary key,creator_id uuid,title text);
    create table public.purchases(id uuid primary key,buyer_id uuid,post_id uuid);
    create table public.watch_progress(user_id uuid,post_id uuid);
    create table public.bookings(id uuid primary key,buyer_id uuid);
    grant select,insert,update,delete on all tables in schema public to anon,authenticated,service_role;
    alter table posts enable row level security;
    create policy legacy_read on posts for select using(true);
    create policy legacy_write on posts for all to authenticated using(creator_id=auth.uid()) with check(creator_id=auth.uid());
    alter table profiles enable row level security; create policy legacy_profiles on profiles for all using(true) with check(true);
    alter table purchases enable row level security; create policy buyer_only on purchases for select using(buyer_id=auth.uid());
    alter table watch_progress enable row level security; create policy own_progress on watch_progress for all using(user_id=auth.uid()) with check(user_id=auth.uid());
    alter table bookings enable row level security; create policy own_booking on bookings for select using(buyer_id=auth.uid());
    insert into auth.users values('${owner}','owner@example.test',now(),null),('${tester}','tester@example.test',now(),null),('${buyer}','buyer@example.test',now(),null),('${stranger}','stranger@example.test',now(),null);
    insert into profiles values('${owner}','admin',null),('${tester}','user',null),('${buyer}','user',null),('${stranger}','user',null);
    insert into posts values('${purchased}','${owner}','Purchased preview'),('${own}','${buyer}','Own preview'),('${other}','${owner}','Other preview');
    insert into purchases values('${purchased}','${buyer}','${purchased}');
    insert into watch_progress values('${buyer}','${purchased}');
    insert into bookings values('${purchased}','${buyer}');
    create function public.get_feed_v1(p_user_id uuid,p_limit integer) returns setof public.posts language sql stable security definer set search_path='' as $$select * from public.posts limit p_limit$$;
    create function public.get_feed_v3(p_tab text,p_limit integer,p_offset integer) returns setof public.posts language sql stable security definer set search_path='' as $$select * from public.posts limit p_limit offset p_offset$$;`);
  for(const relation of ['products','offerings','follows','likes','post_likes','comments','reviews','post_metrics','post_views','post_events','user_interest_scores','booking_targets','team_routing','closers','booking_clicks','clicks']) {
    await db.exec(`create table public.${relation}(id integer); insert into public.${relation} values(1); alter table public.${relation} enable row level security; create policy legacy_public on public.${relation} for all using(true) with check(true); grant select,insert,update,delete on public.${relation} to anon,authenticated,service_role;`);
  }
  await db.exec(readFileSync(join(__dirname,'../supabase/migrations/20261021010052_controlled_website_releases.sql'),'utf8'));
  await db.exec(readFileSync(join(__dirname,'../supabase/migrations/20261023004846_website_data_access_guard.sql'),'utf8'));
},30000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec('begin');});
afterEach(async()=>{await db.exec('rollback');});

async function asRole<T>(role:string,user:string|null,work:()=>Promise<T>,extra:Record<string,unknown>={}) {
  await db.exec('savepoint caller_check');
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role,...(user?{sub:user}:{}),...extra})]);
  await db.exec(`set local role ${role}`);
  try{return await work();}catch(error){await db.exec('rollback to savepoint caller_check');throw error;}
  finally{await db.exec('reset role; release savepoint caller_check');}
}
const ids=async(table:string)=>(await db.query<{id:string}>(`select id from public.${table} order by id`)).rows.map(r=>r.id);
async function request(path:string){await db.query("select set_config('request.path',$1,true)",[path]);await db.query('select website_release_private.check_data_request_v1()');}
async function release(flags:ReturnType<typeof closedFeatures>,hidden=false){await db.query('update public.website_release_settings_v1 set hidden=$1,features=$2::jsonb',[hidden,JSON.stringify(flags)]);}

test('restrictive policies close overlapping permissive reads for anonymous and ordinary signed-in callers',async()=>{
  for(const [role,user] of [['anon',null],['authenticated',stranger]] as const)await asRole(role,user,async()=>{
    for(const table of ['posts','products','comments','follows','booking_targets','post_metrics'])expect(await ids(table)).toEqual([]);
  });
});
test('owner and approved tester retain access; revocation takes effect with the same JWT',async()=>{
  await db.query('insert into public.website_release_testers_v1(user_id,approved_by) values($1,$2)',[tester,owner]);
  for(const id of [owner,tester])await asRole('authenticated',id,async()=>{expect(await ids('posts')).toHaveLength(3);await request('/rpc/get_feed_v3');expect(await ids('products')).toHaveLength(1);});
  await db.exec('delete from public.website_release_testers_v1');
  await asRole('authenticated',tester,async()=>{expect(await ids('posts')).toEqual([]);});
});
test('banned, unverified and anonymous-auth identities cannot use private access',async()=>{
  await db.query('update profiles set banned_at=now() where id=$1',[owner]);
  await asRole('authenticated',owner,async()=>{expect(await ids('products')).toEqual([]);expect(await ids('posts')).toEqual([purchased,other].sort());expect((await db.query('select banned_at from profiles')).rows[0]).toHaveProperty('banned_at');});
  await db.query('update profiles set banned_at=null where id=$1',[owner]);
  await db.query('update auth.users set email_confirmed_at=null where id=$1',[owner]);
  await asRole('authenticated',owner,async()=>{expect(await ids('posts')).toEqual([]);});
  await db.query('update auth.users set email_confirmed_at=now() where id=$1',[owner]);
  await asRole('authenticated',owner,async()=>{expect(await ids('posts')).toEqual([]);},{is_anonymous:true});
});
test('user metadata cannot spoof the saved owner identity',async()=>{
  await asRole('authenticated',stranger,async()=>{expect(await ids('posts')).toEqual([]);},{user_metadata:{role:'admin',owner_id:owner,is_owner:true}});
});
test('buyer metadata, embedded purchase relationships, own progress and existing bookings survive hidden mode',async()=>{
  await asRole('authenticated',buyer,async()=>{
    expect(await ids('posts')).toEqual([purchased,own].sort());
    expect((await db.query('select p.id from public.purchases p join public.posts s on s.id=p.post_id')).rows).toHaveLength(1);
    expect((await db.query('select * from public.watch_progress')).rows).toHaveLength(1);
    expect((await db.query('select * from public.bookings')).rows).toHaveLength(1);
    expect(await ids('purchases')).toEqual([purchased]);
    expect((await db.query('select id from profiles')).rows).toEqual([{id:buyer}]);
  });
});
test('feed-only release opens feed reads but preserves closed products, engagement and publishing',async()=>{
  await release({...closedFeatures(),feed:true});
  await asRole('anon',null,async()=>{expect(await ids('posts')).toHaveLength(3);expect(await ids('products')).toEqual([]);expect(await ids('comments')).toEqual([]);await request('rpc/get_feed_v1');});
});
test('public features remain public to an anonymous-auth session without granting private access',async()=>{
  await release({...closedFeatures(),feed:true});
  await asRole('authenticated',stranger,async()=>{expect(await ids('posts')).toHaveLength(3);expect(await ids('products')).toEqual([]);},{is_anonymous:true});
});
test('suspension does not remove a buyer-owned recovery preview or hide the caller ban status',async()=>{
  await db.query('update profiles set banned_at=now() where id=$1',[buyer]);
  await asRole('authenticated',buyer,async()=>{expect(await ids('posts')).toEqual([purchased,own].sort());expect((await db.query('select banned_at from profiles')).rows[0]).toHaveProperty('banned_at');expect(await ids('products')).toEqual([]);});
});
test('master hide overrides a saved open feed preference',async()=>{
  await release({...closedFeatures(),feed:true},true);
  await asRole('anon',null,async()=>{expect(await ids('posts')).toEqual([]);});
});
test.each(['/rpc/get_feed_v1','rpc/get_feed_v3','/rest/v1/rpc/get_feed_v1','/rpc/next_booking_target','/rpc/unmapped_future_function'])(
  'direct RPC guard denies closed or unknown route %s before its legacy body executes',async path=>{
    await expect(asRole('anon',null,()=>request(path))).rejects.toThrow(/Website feature is not available/);
  });
test('hook checks both signed-in outsiders and unknown functions when a different feature opens',async()=>{
  await release({...closedFeatures(),feed:true});
  await expect(asRole('authenticated',stranger,()=>request('/rpc/next_booking_target'))).rejects.toThrow(/not available/);
});
test('service-role jobs and fulfillment bypass closed client gates',async()=>{
  await asRole('service_role',null,async()=>{expect(await ids('posts')).toHaveLength(3);expect(await ids('products')).toHaveLength(1);await request('/rpc/next_booking_target');});
});
test('missing configuration fails closed for public reads',async()=>{
  await db.exec('delete from public.website_release_settings_v1');
  await asRole('anon',null,async()=>{expect(await ids('posts')).toEqual([]);expect(await ids('products')).toEqual([]);});
});
test('API hook is registered and original private identity helpers stay non-executable',async()=>{
  const setting=await db.query<{setting:string}>("select unnest(setconfig) as setting from pg_db_role_setting d join pg_roles r on r.oid=d.setrole where r.rolname='authenticator'");
  expect(setting.rows).toEqual([{setting:'pgrst.db_pre_request=website_release_private.check_data_request_v1'}]);
  for(const role of ['anon','authenticated'])expect((await db.query<{allowed:boolean}>("select has_function_privilege($1,'website_release_private.existing_email_v1(text)','EXECUTE') as allowed",[role])).rows[0].allowed).toBe(false);
});
test('a closed publishing feature blocks writes even to the caller-owned post',async()=>{
  await expect(asRole('authenticated',buyer,()=>db.query('insert into posts(id,creator_id,title) values(gen_random_uuid(),$1,$2)',[buyer,'Blocked draft']))).rejects.toThrow(/row-level security/);
});
test('rollback removes only this guard, preserving rows, saved settings and original policies',async()=>{
  const settingsBefore=(await db.query('select * from public.website_release_settings_v1')).rows;
  const rollback=readFileSync(join(__dirname,'../scripts/rollback-website-data-access-guard.sql'),'utf8').replace(/^begin;$/m,'').replace(/^commit;$/m,'');
  await db.exec(rollback);
  expect((await db.query('select * from public.website_release_settings_v1')).rows).toEqual(settingsBefore);
  expect((await db.query('select * from public.posts')).rows).toHaveLength(3);
  expect((await db.query("select policyname from pg_policies where tablename='posts' order by policyname")).rows).toEqual([{policyname:'legacy_read'},{policyname:'legacy_write'}]);
  await asRole('anon',null,async()=>{expect(await ids('posts')).toHaveLength(3);});
});
