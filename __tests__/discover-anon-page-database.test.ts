/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
declare const createLocalPostgres: () => PGlite;

let db: PGlite;
const session = '11111111-1111-4111-8111-111111111111';
const anonymous = '22222222-2222-4222-8222-222222222222';
const post = '33333333-3333-4333-8333-333333333333';
const creator = '44444444-4444-4444-8444-444444444444';
const other = '55555555-5555-4555-8555-555555555555';
const actor = 'anon:' + anonymous;
const rpc = 'select public.discover_anon_compact_page_v1($1::uuid,$2::uuid,$3::bigint,$4::integer) as result';
const args: unknown[] = [session, anonymous, 0, 20];
const signature = 'public.discover_anon_compact_page_v1(uuid,uuid,bigint,integer)';
jest.setTimeout(90000);

async function asRole<T>(name: 'service_role' | 'anon' | 'authenticated' | 'untrusted', work: () => Promise<T>): Promise<T> {
  await db.exec('set role ' + name);
  try { return await work(); } finally { await db.exec('reset role'); }
}
async function expectSqlError(work: () => Promise<unknown>, code: string) {
  // Keep a deliberate statement failure from aborting the enclosing test fixture.
  await db.exec('savepoint expected_failure');
  try { await expect(work()).rejects.toMatchObject({ code }); }
  finally {
    await db.exec('rollback to savepoint expected_failure');
    await db.exec('release savepoint expected_failure');
  }
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
    create table discover_sessions_v1(id uuid primary key,actor text,post_ids uuid[],expires_at timestamptz);
    create table discover_identity_links_v1(anonymous_id uuid primary key,user_id uuid not null);
    alter table discover_sessions_v1 enable row level security;
    alter table discover_identity_links_v1 enable row level security;
    grant select on posts,profiles,products,offerings,discover_sessions_v1,discover_identity_links_v1 to service_role;`);
  await db.query('insert into profiles(id,username,private_extra) values($1,$2,$3)', [creator, 'synthetic-creator', 'private-extra']);
  await db.query('insert into posts(id,creator_id,title,active,video_url) values($1,$2,$3,true,$4)',
    [post, creator, 'synthetic-post', 'https://example.invalid/private/video.mp4?synthetic-signature=unchanged']);
  await db.query("insert into discover_sessions_v1 values($1,$2,array[$3::uuid],now()+interval '1 hour')", [session, actor, post]);
  for (const migration of ['20260915052139_discover_inventory_batch.sql', '20260916051608_discover_compact_page.sql',
    '20260916064728_discover_anon_compact_page.sql']) {
    await db.exec(readFileSync('supabase/migrations/' + migration, 'utf8'));
  }
});
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db.close(); });

test('unclaimed owned pages match the existing compact RPC across cursor boundaries', async () => {
  await db.query(`update discover_sessions_v1 set post_ids=array_prepend($1::uuid,
    array(select md5(n::text)::uuid from generate_series(1,10000)n)) where id=$2`, [post, session]);
  await asRole('service_role', async () => {
    for (const offset of [0, 20, 9998, 10001, Number.MAX_SAFE_INTEGER]) {
      const { rows } = await db.query<{ checked: any; original: any }>(`select
        public.discover_anon_compact_page_v1($1,$2,$3,20) as checked,
        public.discover_compact_page_v1($1,'anon:'||$2::text,$3,20) as original`, [session, anonymous, offset]);
      expect(rows[0].checked).toEqual({ anonymousClaimChecked: true, page: rows[0].original });
      expect(rows[0].checked.page.total_count).toBe(10001);
      expect(rows[0].checked.page.page_post_ids.length).toBeLessThanOrEqual(20);
      expect(rows[0].checked.page).not.toHaveProperty('post_ids');
    }
  });
});

test('only the service role may execute the stable invoker with fixed search path', async () => {
  const { rows } = await db.query<{ prosecdef: boolean; provolatile: string; proconfig: string[] }>(
    'select prosecdef,provolatile,proconfig from pg_proc where oid=$1::regprocedure', [signature]);
  expect(rows[0]).toEqual({ prosecdef: false, provolatile: 's', proconfig: ['search_path=""'] });
  for (const name of ['anon', 'authenticated', 'untrusted'] as const) {
    await asRole(name, () => expectSqlError(() => db.query(rpc, args), '42501'));
  }
  // The unrelated role has only PUBLIC inheritance; denial proves no default PUBLIC grant.
  await expect(asRole('service_role', () => db.query(rpc, args))).resolves.toMatchObject({ rows: [{ result: { anonymousClaimChecked: true } }] });
});

test('missing, foreign, null and expired sessions reveal only unavailability', async () => {
  await asRole('service_role', async () => {
    for (const params of [[session, other, 0, 20], [other, anonymous, 0, 20], [null, anonymous, 0, 20], [session, null, 0, 20]]) {
      await expectSqlError(() => db.query(rpc, params), 'CN001');
    }
  });
  await db.exec("update discover_sessions_v1 set expires_at=now()-interval '1 second'");
  await asRole('service_role', () => expectSqlError(() => db.query(rpc, args), 'CN001'));
});

test('invalid bounds preserve SQLSTATE22023 before the page is read', async () => {
  await asRole('service_role', async () => {
    for (const [offset, limit] of [[-1, 20], [null, 20], [0, 0], [0, 51], [0, null]]) {
      await expectSqlError(() => db.query(rpc, [session, anonymous, offset, limit]), '22023');
    }
  });
});

test('a claim appearing after an allowed read rejects the still-anonymous session', async () => {
  await asRole('service_role', () => db.query(rpc, args));
  await db.query('insert into discover_identity_links_v1 values($1,$2)', [anonymous, creator]);
  expect((await db.query<{ actor: string }>('select actor from discover_sessions_v1 where id=$1', [session])).rows[0].actor).toBe(actor);
  await asRole('service_role', async () => {
    await expectSqlError(() => db.query(rpc, args), 'CN001');
    // Check the identity before returning an empty page too.
    await expectSqlError(() => db.query(rpc, [session, anonymous, Number.MAX_SAFE_INTEGER, 20]), 'CN001');
  });
});

test('anonymous wrapper cannot read account-owned sessions and leaves the existing user RPC intact', async () => {
  await db.query('update discover_sessions_v1 set actor=$1 where id=$2', ['user:' + creator, session]);
  await asRole('service_role', async () => {
    await expectSqlError(() => db.query(rpc, args), 'CN001');
    const { rows } = await db.query<{ page: any }>('select public.discover_compact_page_v1($1,$2,0,20) as page', [session, 'user:' + creator]);
    expect(rows[0].page.page_post_ids).toEqual([post]);
  });
});

test('fresh moderation fields, media URLs and compact inventory projection remain unchanged', async () => {
  await db.exec('update posts set hidden_at=now(),removed_at=now(); update profiles set banned_at=now();');
  const { rows } = await asRole('service_role', () => db.query<{ result: any }>(rpc, args));
  const inventory = rows[0].result.page.inventory;
  expect(inventory.posts[0].hidden_at).not.toBeNull();
  expect(inventory.posts[0].removed_at).not.toBeNull();
  expect(inventory.profiles[0].banned_at).not.toBeNull();
  expect(inventory.posts[0].video_url).toBe('https://example.invalid/private/video.mp4?synthetic-signature=unchanged');
  expect(inventory.profiles[0]).not.toHaveProperty('private_extra');
  // SQL supplies current facts; the existing application renderer still filters them.
});

test('missing claim-read or delegate privileges fail without an unchecked fallback', async () => {
  await db.exec('revoke select on discover_identity_links_v1 from service_role');
  await asRole('service_role', () => expectSqlError(() => db.query(rpc, args), '42501'));
  await db.exec('grant select on discover_identity_links_v1 to service_role');
  await db.exec('revoke execute on function discover_compact_page_v1(uuid,text,bigint,integer) from service_role');
  await asRole('service_role', () => expectSqlError(() => db.query(rpc, args), '42501'));
});

test('page checks do not create or modify sessions, identities or inventory', async () => {
  const state = async () => (await db.query<{ state: any }>(`select jsonb_build_object(
    'sessions',(select jsonb_agg(to_jsonb(s)) from discover_sessions_v1 s),
    'identities',(select jsonb_agg(to_jsonb(i)) from discover_identity_links_v1 i),
    'posts',(select jsonb_agg(to_jsonb(p)) from posts p),
    'profiles',(select jsonb_agg(to_jsonb(p)) from profiles p)) as state`)).rows[0].state;
  const before = await state();
  await asRole('service_role', () => db.query(rpc, args));
  await asRole('service_role', () => expectSqlError(() => db.query(rpc, [session, other, 0, 20]), 'CN001'));
  expect(await state()).toEqual(before);
});
