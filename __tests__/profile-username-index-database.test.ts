/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

declare const createLocalPostgres: () => PGlite;
const migration = readFileSync('supabase/migrations/20260916133026_profile_username_lookup.sql', 'utf8');
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
let db: PGlite;
let originalSecurity: unknown;
let originalRows: unknown;
let originalUniqueIndex: unknown;
let originalTimeouts: unknown;
jest.setTimeout(60000);

async function securitySnapshot() {
  return (await db.query(`select
    (select jsonb_build_object('rls',relrowsecurity,'forceRls',relforcerowsecurity,
      'owner',relowner,'grants',relacl) from pg_class where oid='public.profiles'::regclass) as table_security,
    (select jsonb_agg(jsonb_build_object('column',attname,'grants',attacl) order by attnum)
      from pg_attribute where attrelid='public.profiles'::regclass and attnum>0 and not attisdropped) as column_security,
    (select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p
      where schemaname='public' and tablename='profiles') as policies`)).rows;
}
const rows = async () => (await db.query('select * from public.profiles order by id')).rows;
const timeouts = async () => (await db.query(`select current_setting('lock_timeout') as lock_timeout,
  current_setting('statement_timeout') as statement_timeout`)).rows;
const existingIndex = async () => (await db.query(`select pg_get_indexdef(indexrelid) as definition,
  indisunique,indisvalid,indisready from pg_index where indexrelid='public.profiles_username_unique'::regclass`)).rows;

beforeAll(async () => {
  db = createLocalPostgres();
  // Synthetic fixture, not a hosted schema dump or real Auth credentials. Real
  // role switching verifies that an index addition does not bypass row access.
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create role untrusted; create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role,untrusted;
    create table public.profiles(id uuid primary key,username text,private_note text);
    create unique index profiles_username_unique on public.profiles using btree(lower(username));
    alter table public.profiles enable row level security;
    grant select on public.profiles to anon,authenticated;
    grant update(username) on public.profiles to authenticated;
    grant all on public.profiles to service_role;
    create policy profile_self_select on public.profiles for select to authenticated using(auth.uid()=id);
    create policy profile_self_update on public.profiles for update to authenticated
      using(auth.uid()=id) with check(auth.uid()=id);`);
  await db.query(`insert into public.profiles values
    ($1,'AlphaOwner','synthetic-owner-private'),($2,'BetaOther','synthetic-other-private'),
    ('00000000-0000-4000-8000-000000000003',null,'synthetic-null-one'),
    ('00000000-0000-4000-8000-000000000004',null,'synthetic-null-two')`, [owner, other]);
  originalSecurity = await securitySnapshot();
  originalRows = await rows();
  originalUniqueIndex = await existingIndex();
  originalTimeouts = await timeouts();
  await db.exec(migration);
});
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db?.close(); });

async function asRole<T>(role: 'anon' | 'authenticated' | 'service_role' | 'untrusted', user: string | null, work: () => Promise<T>) {
  await db.exec('savepoint role_check');
  try {
    await db.exec('set local role ' + role);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user ?? '']);
    return await work();
  } finally {
    // A denied query aborts its transaction; rollback also restores role/claims.
    await db.exec('rollback to savepoint role_check; release savepoint role_check');
  }
}

test('actual migration adds a ready valid nonunique B-tree for exact username equality', async () => {
  const { rows: indexes } = await db.query(`select pg_get_indexdef(indexrelid) as definition,
    indisunique,indisvalid,indisready,indexprs is null as plain_column,indpred is null as all_rows
    from pg_index where indexrelid='public.profiles_username_lookup_idx'::regclass`);
  expect(indexes).toEqual([{
    definition: 'CREATE INDEX profiles_username_lookup_idx ON public.profiles USING btree (username)',
    indisunique: false, indisvalid: true, indisready: true, plain_column: true, all_rows: true,
  }]);
  expect(await existingIndex()).toEqual(originalUniqueIndex);
  expect(await timeouts()).toEqual(originalTimeouts);
});

test('exact matching stays case sensitive and nullable usernames keep SQL equality behavior', async () => {
  for (const [value, expected] of [
    ['AlphaOwner', [owner]], ['alphaowner', []], ['ALPHAOWNER', []], ['absent', []], [null, []],
  ] as const) {
    const result = await db.query<{ id: string }>('select id from public.profiles where username=$1', [value]);
    expect(result.rows.map(row => row.id)).toEqual(expected);
  }
  expect((await db.query('select id from public.profiles where username is null')).rows).toHaveLength(2);
});

test('existing lower-username uniqueness still rejects a case variant and permits multiple nulls', async () => {
  await db.exec('savepoint duplicate_username');
  try {
    await expect(db.query(`insert into public.profiles(id,username)
      values('00000000-0000-4000-8000-000000000005','aLPHAoWNER')`))
      .rejects.toMatchObject({ code: '23505', constraint: 'profiles_username_unique' });
  } finally { await db.exec('rollback to savepoint duplicate_username; release savepoint duplicate_username'); }
  await db.query(`insert into public.profiles(id,username)
    values('00000000-0000-4000-8000-000000000005',null)`);
  expect((await db.query('select id from public.profiles where username is null')).rows).toHaveLength(3);
});

test('migration leaves every fixture row, RLS policy, owner and table/column grant unchanged', async () => {
  expect(await rows()).toEqual(originalRows);
  expect(await securitySnapshot()).toEqual(originalSecurity);
});

test('role-switched reads still enforce own-row access and preserve service/denied-role behavior', async () => {
  expect(await asRole('anon', null, rows)).toEqual([]);
  expect(await asRole('authenticated', owner, rows)).toEqual([
    { id: owner, username: 'AlphaOwner', private_note: 'synthetic-owner-private' },
  ]);
  expect(await asRole('authenticated', other, () => db.query('select id from public.profiles where username=$1', ['AlphaOwner'])))
    .toMatchObject({ rows: [] });
  expect(await asRole('service_role', null, rows)).toEqual(originalRows);
  await expect(asRole('untrusted', null, rows)).rejects.toMatchObject({ code: '42501' });
});
