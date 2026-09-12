/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../test-support/exact-staging-bundle-manifest.json";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Reuse the reviewed SQL quote/comment masker.
const { maskOpaqueSql } = require("../test-support/prepare-exact-staging-bundle.cjs") as { maskOpaqueSql: (source: string) => string };

declare const createLocalPostgres: () => PGlite;
const sql = readFileSync(join(process.cwd(), "docs/reviews-staging-preflight-json.sql"), "utf8");
const compact = sql.replace(/\r\n/g, "\n").split("\n").filter(line => !line.trimStart().startsWith("--"))
  .map(line => line.trim()).filter(Boolean).join(" ");
type Audit = {
  observation: Record<string, unknown>;
  roles: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  existing_review_candidate_routines: Array<Record<string, unknown>>;
  exact_bundle: Record<string, unknown>;
};
let db: PGlite;
jest.setTimeout(60000);
beforeEach(() => { db = createLocalPostgres(); });
afterEach(async () => { await db.close(); });
async function inspect(query = sql): Promise<Audit> {
  const rows = (await db.exec(query)).flatMap(result => result.rows) as Array<{ preflight: Audit }>;
  expect(rows).toHaveLength(1);
  expect(Object.keys(rows[0])).toEqual(["preflight"]);
  return rows[0].preflight;
}

test("embedded inventory is exactly the canonical manifest and query has one read-only rollback wrapper", () => {
  expect(JSON.parse(sql.split("$manifest$")[1])).toEqual(manifest);
  expect(compact).toMatch(/^begin; set transaction read only; set local search_path = pg_catalog;/);
  expect(compact).toContain("set local statement_timeout = '30s'");
  expect(compact).toContain("set local lock_timeout = '5s'");
  expect(compact.endsWith("rollback;")).toBe(true);
  expect(maskOpaqueSql(compact)).not.toMatch(/\b(?:insert|update|delete|truncate|create|alter|drop|grant|revoke|commit|call|copy|do)\s+/i);
});

test("empty local schema returns missing-role/target metadata, never a false PASS or an exception", async () => {
  const result = await inspect();
  expect(result.observation).toMatchObject({ transaction_read_only: "on", search_path: "pg_catalog", statement_timeout: "30s", lock_timeout: "5s" });
  expect(result.roles).toHaveLength(3);
  expect(result.roles.every(role => role.present === false)).toBe(true);
  expect(result.relations).toHaveLength(5);
  expect(result.relations.every(relation => relation.present === false)).toBe(true);
  expect(result.exact_bundle).toMatchObject({ relation_collisions: [], function_name_collisions: [],
    broad_prefix_relations: [], row_array_type_collisions: [], trigger_collisions: [],
    legacy_column_collisions: [], legacy_constraint_collisions: [] });
});

test("metadata, overload/type/prefix collisions and legacy rating execution are visible without rows or routine secrets", async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table public.products(id uuid primary key,creator_id uuid);
    create table public.posts(id uuid primary key,creator_id uuid,product_id uuid references public.products(id));
    create table public.purchases(id uuid primary key,buyer_id uuid,post_id uuid,access_granted boolean,status text);
    create table public.reviews(id uuid primary key,reviewer_id uuid,creator_id uuid,post_id uuid references public.posts(id),
      rating integer,comment text default 'DEFAULT_CANARY_NOT_FOR_OUTPUT',created_at timestamptz,updated_at timestamptz);
    create table public.profile_reviews(profile_id uuid,reviewer_id uuid,rating integer);
    create table public.booking_payments(id uuid,installment_collection_version text,
      constraint booking_payments_installment_collection_version_check check(installment_collection_version is null));
    alter table public.reviews enable row level security;
    create policy "Users can insert their own reviews" on public.reviews for insert with check(auth.uid()=reviewer_id);
    create policy custom_read on public.reviews for select using(comment<>'POLICY_CANARY_NOT_FOR_OUTPUT');
    grant select on public.reviews to anon,authenticated;
    grant update(comment) on public.reviews to authenticated with grant option;
    create function public.keep_review_identity() returns trigger language plpgsql
      set search_path=pg_catalog set app.fixture='CONFIG_CANARY_NOT_FOR_OUTPUT'
      as $$begin perform 'BODY_CANARY_NOT_FOR_OUTPUT'; return new; end$$;
    create trigger fixture_review_trigger before update on public.reviews for each row execute function public.keep_review_identity();
    create function public.set_profile_rating(uuid,uuid,integer) returns integer language sql as $$select 1$$;
    create function public.update_profile_rating(uuid) returns integer language sql as $$select 1$$;
    revoke all on function public.update_profile_rating(uuid) from public;
    grant execute on function public.update_profile_rating(uuid) to service_role;
    create function public.apply_payment_fee_ledger_refund(uuid,bigint) returns integer language sql as $$select 1$$;
    create function public.record_payment_refund_state(text,text,bigint,bigint) returns integer language sql as $$select 1$$;
    create function public.record_payment_dispute_state(text,text,text,bigint,text,text,bigint) returns integer language sql as $$select 1$$;
    create type public.exact_installment_agreements as enum('synthetic');
    create table public.exact_installment_unlisted_fixture(id integer);
    create function public.quote_exact_installment_retry() returns integer language sql as $$select 1$$;
    create trigger exact_installment_booking_binding before update on public.booking_payments
      for each row execute function public.keep_review_identity();
    insert into public.reviews(id,comment) values('00000000-0000-4000-8000-000000000001','ROW_CANARY_NOT_FOR_OUTPUT');
  `);
  const before = (await db.query("select current_setting('search_path') path,current_setting('transaction_read_only') ro,current_setting('statement_timeout') timeout")).rows;
  const result = await inspect();
  const packed = await inspect(compact);
  const withoutTime = (value: Audit) => ({ ...value, observation: { ...value.observation, observed_at: undefined } });
  expect(withoutTime(packed)).toEqual(withoutTime(result));
  for (const canary of ["DEFAULT", "POLICY", "BODY", "CONFIG", "ROW"]) expect(JSON.stringify(result)).not.toContain(`${canary}_CANARY_NOT_FOR_OUTPUT`);
  expect(result.existing_review_candidate_routines).toEqual(expect.arrayContaining([
    expect.objectContaining({ existing_candidate_routine: "public.set_profile_rating(uuid,uuid,integer)", authenticated_execute: true }),
    expect.objectContaining({ existing_candidate_routine: "public.update_profile_rating(uuid)", authenticated_execute: false, service_execute: true }),
  ]));
  expect(result.exact_bundle).toMatchObject({
    inventory_counts: { sources: 18, relations: 57, function_signatures: 60, triggers: 3, legacy_columns: 1, legacy_constraints: 1 },
    relation_collisions: [],
    broad_prefix_relations: [{ relname: "exact_installment_unlisted_fixture", relkind: "r" }],
    row_array_type_collisions: expect.arrayContaining([{ type_name: "exact_installment_agreements", typtype: "e", has_associated_relation: false }]),
    function_name_collisions: [expect.objectContaining({ name: "quote_exact_installment_retry", existing_signature: "public.quote_exact_installment_retry()" })],
    trigger_collisions: [expect.objectContaining({ table_name: "booking_payments", trigger_name: "exact_installment_booking_binding" })],
    legacy_column_collisions: [expect.objectContaining({ column_name: "installment_collection_version" })],
    legacy_constraint_collisions: [expect.objectContaining({ constraint_name: "booking_payments_installment_collection_version_check" })],
    required_legacy_functions: expect.arrayContaining([expect.objectContaining({ signature: "public.apply_payment_fee_ledger_refund(uuid,bigint)", present: true })]),
  });
  const after = (await db.query("select current_setting('search_path') path,current_setting('transaction_read_only') ro,current_setting('statement_timeout') timeout")).rows;
  expect(after).toEqual(before);
  expect((await db.query("select comment from public.reviews")).rows).toEqual([{ comment: "ROW_CANARY_NOT_FOR_OUTPUT" }]);
});
