/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const session = '11111111-1111-4111-8111-111111111111';
const viewer = '22222222-2222-4222-8222-222222222222';
const post = '33333333-3333-4333-8333-333333333333';
const creator = '44444444-4444-4444-8444-444444444444';
const other = '55555555-5555-4555-8555-555555555555';
const actor = 'user:' + viewer;
const rpc = 'select discover_user_compact_page_v1($1::uuid,$2::text,$3::uuid,$4::bigint,$5::int) result';
const args = [session, actor, viewer, 0, 20];
const create = `select discover_create_user_compact_page_v1($1,$2,'discover',$3::uuid[],
  $4::jsonb,0,20,'pilot','control',$5::jsonb) result`;
jest.setTimeout(90000);
async function asRole<T>(role: string, fn: () => Promise<T>) {
  await db.exec('set role ' + role);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
async function sqlError(fn: () => Promise<unknown>, code: string) {
  await db.exec('savepoint expected_error');
  try { await expect(fn()).rejects.toMatchObject({code}); }
  finally { await db.exec('rollback to savepoint expected_error; release savepoint expected_error'); }
}
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`create role anon; create role authenticated; create role untrusted; create role service_role bypassrls;
    create table posts(id uuid primary key,creator_id uuid,product_id uuid,offering_id uuid,
      title text,content text,caption text,interests text[],topics text[],hashtags text[],created_at timestamptz,
      video_url text,poster_url text,price_cents bigint,allow_booking bool,booking_url text,likes_count int,
      comments_count int,shares_count int,purchase_count int,active bool,hidden_at timestamptz,removed_at timestamptz);
    create table profiles(id uuid primary key,full_name text,username text,avatar_url text,banned_at timestamptz,
      stripe_account_id text,stripe_onboarding_complete bool,private_extra text);
    create table products(id uuid primary key,product_id uuid,creator_id uuid,title text,description text,
      type text,price_cents bigint,amount_cents bigint,active bool);
    create table offerings(id uuid primary key,creator_id uuid,title text,type text,product_metadata jsonb,is_active bool);
    create table discover_sessions_v1(id uuid primary key default gen_random_uuid(),actor text,user_id uuid,tab text,
      post_ids uuid[],audiences jsonb,pilot_id text,pilot_variant text,pilot_placements jsonb,
      expires_at timestamptz default now()+interval '1 hour');
    create table likes(user_id uuid,post_id uuid,primary key(user_id,post_id));
    create table follows(follower_id uuid,following_id uuid,primary key(follower_id,following_id));
    alter table discover_sessions_v1 enable row level security;
    alter table likes enable row level security; alter table follows enable row level security;
    grant select on posts,profiles,products,offerings,discover_sessions_v1,likes,follows to service_role;
    grant insert on discover_sessions_v1 to service_role;`);
  await db.query('insert into profiles(id,username,private_extra) values($1,$2,$3)', [creator,'creator','private']);
  await db.query('insert into posts(id,creator_id,title,active,video_url) values($1,$2,$3,true,$4)',
    [post,creator,'post','https://example.invalid/private.mp4?signature=unchanged']);
  await db.query('insert into discover_sessions_v1(id,actor,user_id,post_ids) values($1,$2,$3,array[$4::uuid])',
    [session,actor,viewer,post]);
  await db.query('insert into likes values($1,$2),($3,$4)', [viewer,post,other,other]);
  await db.query('insert into follows values($1,$2),($3,$4)', [viewer,creator,other,other]);
  for (const migration of ['20260915052139_discover_inventory_batch.sql','20260916051608_discover_compact_page.sql',
    '20260916235737_discover_viewer_state_page.sql']) await db.exec(readFileSync('supabase/migrations/'+migration,'utf8'));
});
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db.close(); });

test('bounded state preserves compact-page data and cursor parity across a large snapshot', async () => {
  await db.query(`update discover_sessions_v1 set post_ids=array_prepend($1::uuid,
    array(select md5(n::text)::uuid from generate_series(1,10000)n)) where id=$2`, [post,session]);
  await asRole('service_role', async () => {
    for (const offset of [0,20,9998,10001,Number.MAX_SAFE_INTEGER]) {
      const {rows} = await db.query<{result: any; original: any}>(`select
        discover_user_compact_page_v1($1,$2,$3,$4,20) result,
        discover_compact_page_v1($1,$2,$4,20) original`, [session,actor,viewer,offset]);
      const {viewer_state, ...page} = rows[0].result;
      expect(page).toEqual(rows[0].original);
      expect(page.page_post_ids.length).toBeLessThanOrEqual(20);
      expect(viewer_state).toEqual({user_id:viewer,liked_post_ids:offset===0?[post]:[],
        followed_creator_ids:offset===0?[creator]:[]});
    }
  });
});

test('all three invokers have fixed search paths and no public/client execution permission', async () => {
  const {rows} = await db.query<{proname: string; prosecdef: boolean; provolatile: string; proconfig: string[]}>(
    "select proname,prosecdef,provolatile,proconfig from pg_proc where proname in ('discover_page_viewer_state_v1','discover_user_compact_page_v1','discover_create_user_compact_page_v1')");
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.prosecdef).toBe(false); expect(row.proconfig).toEqual(['search_path=""']);
    expect(row.provolatile).toBe(row.proname.includes('create') ? 'v' : 's');
    const {rows: privileges} = await db.query<{role: string; allowed: boolean}>(`select r role,
      has_function_privilege(r,p.oid,'execute') allowed from pg_proc p,
      unnest(array['anon','authenticated','untrusted','service_role']) r where proname=$1`, [row.proname]);
    for (const privilege of privileges) expect(privilege.allowed).toBe(privilege.role==='service_role');
  }
  for (const role of ['anon','authenticated','untrusted'])
    await asRole(role, () => sqlError(() => db.query(rpc,args),'42501'));
});

test('missing, foreign, anonymous, null, mismatched stored user and expired sessions fail closed', async () => {
  await asRole('service_role', async () => {
    for (const params of [[other,actor,viewer,0,20],[session,'user:'+other,other,0,20],
      [session,actor,other,0,20],[session,'anon:'+viewer,viewer,0,20],
      [session,actor,null,0,20],[null,actor,viewer,0,20],[session,null,viewer,0,20]])
      await sqlError(() => db.query(rpc,params),'CN001');
  });
  await db.query('update discover_sessions_v1 set user_id=$1',[other]);
  await asRole('service_role', () => sqlError(() => db.query(rpc,args),'CN001'));
  await db.query("update discover_sessions_v1 set user_id=$1,expires_at=now()-interval '1 second'",[viewer]);
  await asRole('service_role', () => sqlError(() => db.query(rpc,args),'CN001'));
});

test('bounds, live like/follow changes and fresh moderation remain authoritative', async () => {
  for (const [offset,limit] of [[-1,20],[null,20],[0,0],[0,51],[0,null]])
    await asRole('service_role', () => sqlError(() => db.query(rpc,[session,actor,viewer,offset,limit]),'22023'));
  await db.query('delete from likes where user_id=$1;',[viewer]);
  await db.query('delete from follows where follower_id=$1',[viewer]);
  await db.exec('update posts set hidden_at=now(),removed_at=now(); update profiles set banned_at=now()');
  const {rows} = await asRole('service_role', () => db.query<{result: any}>(rpc,args));
  expect(rows[0].result.viewer_state).toEqual({user_id:viewer,liked_post_ids:[],followed_creator_ids:[]});
  const inventory = rows[0].result.inventory;
  expect(inventory.posts[0].hidden_at).not.toBeNull(); expect(inventory.profiles[0].banned_at).not.toBeNull();
  expect(inventory.profiles[0]).not.toHaveProperty('private_extra');
  expect(inventory.posts[0].video_url).toBe('https://example.invalid/private.mp4?signature=unchanged');
});

test('creation keeps full ranking, audience and pilot state with private first-page state', async () => {
  const ids = [post,...Array.from({length:100},(_,i)=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0'))];
  const audiences = {[post]:'general'}, placements = {[post]:{position:0}};
  const {rows} = await asRole('service_role', () => db.query<{result: any}>(create,
    [actor,viewer,ids,JSON.stringify(audiences),JSON.stringify(placements)]));
  expect(rows[0].result.page.page_post_ids).toEqual(ids.slice(0,20));
  expect(rows[0].result.page.total_count).toBe(101);
  expect(rows[0].result.page.viewer_state).toEqual({user_id:viewer,liked_post_ids:[post],followed_creator_ids:[creator]});
  const stored = await db.query('select post_ids,audiences,pilot_id,pilot_variant,pilot_placements from discover_sessions_v1 where id=$1',[rows[0].result.id]);
  expect(stored.rows[0]).toEqual({post_ids:ids,audiences,pilot_id:'pilot',pilot_variant:'control',pilot_placements:placements});
});

test('creation rejects inconsistent identities and rolls back insertion when viewer state cannot be read', async () => {
  const count = async () => (await db.query<{n:number}>('select count(*)::int n from discover_sessions_v1')).rows[0].n;
  const before = await count();
  for (const [identity,id] of [['user:'+other,viewer],['anon:'+viewer,null],[actor,null]])
    await asRole('service_role', () => sqlError(() => db.query(create,[identity,id,[post],'{}','{}']),'22023'));
  await db.exec('revoke select on likes from service_role');
  await asRole('service_role', () => sqlError(() => db.query(create,[actor,viewer,[post],'{}','{}']),'42501'));
  expect(await count()).toBe(before);
});
