/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import catalog from "../test-support/staging-rating-catalog-20260908.json";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Reuse the reviewed SQL masker.
const { maskOpaqueSql } = require("../test-support/prepare-exact-staging-bundle.cjs") as { maskOpaqueSql: (source: string) => string };
declare const createLocalPostgres: () => PGlite;
const sql = readFileSync(join(process.cwd(), "docs/staging-review-prerequisite-detail.sql"), "utf8");
const compact = sql.split(/\r?\n/).filter(line => !line.trimStart().startsWith("--")).map(line => line.trim()).filter(Boolean).join(" ");
let db: PGlite;
jest.setTimeout(60000);
beforeEach(() => { db = createLocalPostgres(); });
afterEach(async () => { await db.close(); });

type Detail = {
  observed_at: string;
  transaction_read_only: string;
  routines: Array<{ signature: string; definition: string | null; definition_fingerprint: string | null; present: boolean }>;
  purchase_column_acl: Array<Record<string, unknown>>;
  client_inherited_roles: Array<Record<string, unknown>>;
};
async function inspect(source = sql): Promise<Detail> {
  const rows = (await db.exec(source)).flatMap(result => result.rows) as Array<{ prerequisite_detail: Detail }>;
  expect(rows).toHaveLength(1);
  expect(Object.keys(rows[0])).toEqual(["prerequisite_detail"]);
  return rows[0].prerequisite_detail;
}

test("detail query is read-only, bounded, rollback-ended; saved exact sources match hosted MD5", () => {
  expect(compact).toMatch(/^begin; set transaction read only; set local search_path = pg_catalog;/);
  expect(compact).toContain("set local statement_timeout = '30s'");
  expect(compact).toContain("set local lock_timeout = '5s'");
  expect(compact.endsWith("rollback;")).toBe(true);
  expect(maskOpaqueSql(compact)).not.toMatch(/\b(?:insert|update|delete|truncate|create|alter|drop|grant|revoke|commit|call|copy|do)\s+/i);
  for (const routine of catalog.routines) {
    expect(createHash("md5").update(routine.definition).digest("hex")).toBe(routine.definition_fingerprint);
  }
});

test("absent relations and functions produce missing metadata, not an invented passing baseline", async () => {
  const detail = await inspect();
  expect(detail.transaction_read_only).toBe("on");
  expect(detail.routines).toHaveLength(3);
  expect(detail.routines.every(routine => !routine.present && routine.definition === null)).toBe(true);
  expect(detail.purchase_column_acl).toEqual([]);
  expect(detail.client_inherited_roles).toEqual([]);
});

test("full and pasted forms faithfully report only targeted catalog definitions, not application rows", async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create role synthetic_reader; grant synthetic_reader to authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create table public.purchases(id uuid,buyer_id uuid,access_granted boolean,status text);
    create table public.reviews(id uuid,creator_id uuid,rating integer,comment text,updated_at timestamptz);
    create table public.profile_reviews(profile_id uuid,reviewer_id uuid,rating integer,updated_at timestamptz,
      unique(profile_id,reviewer_id));
    create table public.profiles(id uuid,review_rating numeric,review_count bigint);
    grant select on public.purchases to anon,authenticated;
    grant insert(status) on public.purchases to authenticated;
    create policy buyer_read on public.purchases for select to authenticated using(buyer_id=auth.uid());
    insert into public.reviews(comment) values('ROW_MUST_NOT_BE_RETURNED');
    create function public.unrelated_private_fixture() returns text language sql as $$select 'UNRELATED_BODY_MUST_NOT_BE_RETURNED'$$;
  `);
  for (const routine of catalog.routines) await db.exec(routine.definition);
  await db.exec("create trigger update_reviews_updated_at before update on public.reviews for each row execute function public.update_reviews_updated_at()");
  const original = await inspect();
  const pasted = await inspect(compact);
  expect({ ...pasted, observed_at: null }).toEqual({ ...original, observed_at: null });
  for (const routine of catalog.routines) {
    expect(original.routines).toEqual(expect.arrayContaining([expect.objectContaining({
      signature: routine.signature, definition: routine.definition, definition_fingerprint: routine.definition_fingerprint,
    })]));
  }
  expect(original.purchase_column_acl).toEqual([expect.objectContaining({ attname: "status", grantee: "authenticated", privilege_type: "INSERT" })]);
  expect(original.client_inherited_roles).toEqual([expect.objectContaining({ client_role: "authenticated", inherited_role: "synthetic_reader" })]);
  expect(JSON.stringify(original)).not.toContain("ROW_MUST_NOT_BE_RETURNED");
  expect(JSON.stringify(original)).not.toContain("UNRELATED_BODY_MUST_NOT_BE_RETURNED");
  expect((await db.query("select comment from public.reviews")).rows).toEqual([{ comment: "ROW_MUST_NOT_BE_RETURNED" }]);
  expect((await db.query("select current_setting('transaction_read_only') as ro")).rows).toEqual([{ ro: "off" }]);
});
