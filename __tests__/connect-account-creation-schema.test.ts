/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";

const sql = readFileSync(path.join(process.cwd(), "supabase/proposals/098-connect-account-creation.sql"), "utf8");
const creator = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
let db: PGlite;
declare const createLocalPostgres: () => PGlite;
jest.setTimeout(90000);
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${creator}'), ('${other}');`);
  await db.exec(sql);
});
afterAll(async () => { await db.close(); });

test("concurrent reservations admit only one frozen creator attempt", async () => {
  const results = await Promise.allSettled([
    db.query("INSERT INTO public.stripe_connect_account_creations(creator_id,email) VALUES ($1,$2)", [creator, "first@example.invalid"]),
    db.query("INSERT INTO public.stripe_connect_account_creations(creator_id,email) VALUES ($1,$2)", [creator, "second@example.invalid"]),
  ]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  const { rows } = await db.query<{ idempotency_key: string; email: string; created_at: Date }>(
    "SELECT * FROM public.stripe_connect_account_creations WHERE creator_id=$1", [creator]);
  expect(rows).toHaveLength(1);
  expect(rows[0].idempotency_key).toMatch(/^[a-f0-9-]{36}$/);
  expect(rows[0].created_at).toBeTruthy();
});

test("reapplying the proposal retains the original attempt and provider ID", async () => {
  await db.query("UPDATE public.stripe_connect_account_creations SET stripe_account_id='acct_created' WHERE creator_id=$1", [creator]);
  const before = await db.query("SELECT * FROM public.stripe_connect_account_creations");
  await db.exec(sql);
  expect((await db.query("SELECT * FROM public.stripe_connect_account_creations")).rows).toEqual(before.rows);
  await expect(db.query("INSERT INTO public.stripe_connect_account_creations(creator_id,stripe_account_id) VALUES ($1,'acct_created')", [other]))
    .rejects.toThrow(/unique/i);
});

test("anonymous and authenticated clients cannot read or mutate creation records", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`SET ROLE ${role}`);
    try {
      await expect(db.query("SELECT * FROM public.stripe_connect_account_creations")).rejects.toThrow(/permission denied/i);
      await expect(db.query("INSERT INTO public.stripe_connect_account_creations(creator_id) VALUES ($1)", [other])).rejects.toThrow(/permission denied/i);
      await expect(db.query("UPDATE public.stripe_connect_account_creations SET stripe_account_id='acct_stolen'")).rejects.toThrow(/permission denied/i);
    } finally { await db.exec("RESET ROLE"); }
  }
});

test("service role can record a result but cannot rotate keys, edit frozen parameters, or delete attempts", async () => {
  await db.exec("SET ROLE service_role");
  try {
    await db.query("INSERT INTO public.stripe_connect_account_creations(creator_id,email) VALUES ($1,'owned@example.invalid')", [other]);
    await db.query("UPDATE public.stripe_connect_account_creations SET stripe_account_id='acct_other' WHERE creator_id=$1", [other]);
    expect((await db.query("SELECT stripe_account_id FROM public.stripe_connect_account_creations WHERE creator_id=$1", [other])).rows)
      .toEqual([{ stripe_account_id: "acct_other" }]);
    for (const statement of [
      "UPDATE public.stripe_connect_account_creations SET idempotency_key=gen_random_uuid()",
      "UPDATE public.stripe_connect_account_creations SET created_at=now()",
      "UPDATE public.stripe_connect_account_creations SET email='changed@example.invalid'",
      "DELETE FROM public.stripe_connect_account_creations",
    ]) await expect(db.query(statement)).rejects.toThrow(/permission denied/i);
  } finally { await db.exec("RESET ROLE"); }
});
