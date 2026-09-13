/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const creator = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
jest.setTimeout(90000);
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table public.profiles(id uuid primary key);
    insert into public.profiles values ('${creator}'),('${other}');`);
  await db.exec(readFileSync("supabase/migrations/20260913220917_scheduling_oauth_connections.sql", "utf8"));
});
afterAll(async () => { await db.close(); });
afterEach(async () => { await db.exec("reset role; truncate scheduling_connections_v1, scheduling_oauth_attempts_v1 cascade;"); });

test("browser roles cannot read or mutate credential, OAuth-state or event-type tables", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    for (const table of ["scheduling_connections_v1", "scheduling_oauth_attempts_v1", "scheduling_event_types_v1"]) {
      await expect(db.query(`select * from ${table}`)).rejects.toThrow(/permission denied/i);
      await expect(db.query(`delete from ${table}`)).rejects.toThrow(/permission denied/i);
    }
    await db.exec("reset role");
  }
  const { rows } = await db.query<{ count: number }>("select count(*)::int as count from pg_class where relname in ('scheduling_connections_v1','scheduling_oauth_attempts_v1','scheduling_event_types_v1') and relrowsecurity");
  expect(rows[0].count).toBe(3);
});

test("connected cannot be reported before both OAuth credentials and webhook exist", async () => {
  await db.exec("set role service_role");
  await expect(db.query("insert into scheduling_connections_v1(creator_id,provider,status) values($1,'calcom','connected')", [creator])).rejects.toThrow(/check constraint/i);
  await db.query("insert into scheduling_connections_v1(creator_id,provider) values($1,'calcom')", [creator]);
  const { rows } = await db.query("select status from scheduling_connections_v1");
  expect(rows).toEqual([{ status: "pending" }]);
});

test("one provider account cannot be actively connected to two creators", async () => {
  await db.query("insert into scheduling_connections_v1(creator_id,provider,account_id) values($1,'calcom','account')", [creator]);
  await expect(db.query("insert into scheduling_connections_v1(creator_id,provider,account_id) values($1,'calcom','account')", [other])).rejects.toThrow(/duplicate key/i);
  await db.exec("update scheduling_connections_v1 set status='disconnected'");
  await db.query("insert into scheduling_connections_v1(creator_id,provider,account_id) values($1,'calcom','account')", [other]);
});

test("OAuth state can be consumed once and only by its creator before expiry", async () => {
  const hash = "a".repeat(64);
  await db.query("insert into scheduling_oauth_attempts_v1(state_hash,creator_id,provider,verifier_ciphertext,expires_at) values($1,$2,'calcom','encrypted',now()+interval '10 minutes')", [hash, creator]);
  const consume = (owner: string) => db.query("delete from scheduling_oauth_attempts_v1 where state_hash=$1 and creator_id=$2 and expires_at>now() returning provider", [hash, owner]);
  expect((await consume(other)).rows).toHaveLength(0);
  expect((await consume(creator)).rows).toEqual([{ provider: "calcom" }]);
  expect((await consume(creator)).rows).toHaveLength(0);
});
