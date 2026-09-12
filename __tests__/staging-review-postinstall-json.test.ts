/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installPre024ReviewFixture } from "../test-support/review-pre024-fixture";
import ratingCatalog from "../test-support/staging-rating-catalog-20260908.json";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Exercise approved non-executing package preparation.
const { prepareReviewPrerequisites } = require("../test-support/prepare-review-prerequisites.cjs") as { prepareReviewPrerequisites: () => { sql: string } };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Existing quote/comment masker.
const { maskOpaqueSql } = require("../test-support/prepare-exact-staging-bundle.cjs") as { maskOpaqueSql: (sql: string) => string };
declare const createLocalPostgres: () => PGlite;
const sql = readFileSync(join(process.cwd(), "docs/staging-review-postinstall-json.sql"), "utf8");
const compact = sql.split(/\r?\n/).filter(line => !line.trimStart().startsWith("--")).map(line => line.trim()).filter(Boolean).join(" ");
type NamedRow = { name: string; [key: string]: unknown };
type Audit = {
  observation: { observed_at: string; read_only: string; [key: string]: unknown };
  scope: string;
  conditions: Record<string, boolean | null>;
  roles: Array<{ name: string; present: boolean }>;
  relations: NamedRow[];
  policies: NamedRow[];
  triggers: NamedRow[];
  routines: Array<{ signature: string; definition_hash: string | null; present: boolean; matches_captured_definition: boolean | null;
    effective_execute: Array<{ role: string; execute: boolean | null }> }>;
};
let db: PGlite;
jest.setTimeout(60000);
beforeEach(() => { db = createLocalPostgres(); });
afterEach(async () => { await db.close(); });
async function inspect(source = sql): Promise<Audit> {
  const rows = (await db.exec(source)).flatMap(result => result.rows) as Array<{ postinstall: Audit }>;
  expect(rows).toHaveLength(1); expect(Object.keys(rows[0])).toEqual(["postinstall"]);
  return rows[0].postinstall;
}
const comparable = (result: Audit) => ({ ...result, observation: { ...result.observation, observed_at: null } });
async function fixture() {
  await installPre024ReviewFixture(db);
  await db.exec(`create table public.profile_reviews(profile_id uuid,reviewer_id uuid,rating integer,
    updated_at timestamptz default now(),primary key(profile_id,reviewer_id))`);
  const setter = ratingCatalog.routines.find(row => row.signature === "public.set_profile_rating(uuid,uuid,integer)");
  if (!setter) throw new Error("Captured setter missing");
  await db.exec(setter.definition);
  await db.exec(`grant execute on function public.set_profile_rating(uuid,uuid,integer),public.update_profile_rating(uuid)
    to public,anon,authenticated,postgres,service_role`);
}
test("query is one bounded read-only JSON statement with no app relation reads or invocation", () => {
  expect(compact).toMatch(/^begin; set transaction read only; set local search_path = pg_catalog;/);
  expect(compact).toContain("set local statement_timeout = '30s'");
  expect(compact).toContain("set local lock_timeout = '5s'");
  expect(compact.endsWith("rollback;")).toBe(true);
  const masked = maskOpaqueSql(compact);
  expect(masked).not.toMatch(/\b(?:insert|update|delete|truncate|create|alter|drop|grant|revoke|commit|call|copy|do)\s+/i);
  expect(masked).not.toMatch(/\b(?:from|join)\s+(?:public|auth)\s*\./i);
  expect(masked).not.toMatch(/\b(?:public|auth)\s*\.\s*\w+\s*\(/i);
});
test("missing catalog objects report absence and do not make staged conditions pass", async () => {
  const audit = await inspect();
  expect(audit.roles.every(role => !role.present)).toBe(true);
  expect(audit.routines.every(routine => !routine.present && routine.definition_hash === null)).toBe(true);
  for (const name of ["client_roles_safe", "purchase_clients_select_only_table", "purchase_clients_select_only_columns",
    "purchase_server_all_eight_preserved", "purchase_server_columns_preserved", "reviews_final_client_table_allowlist",
    "reviews_final_column_allowlist", "reviews_server_crud", "reviews_nullable_post_uuid", "reviews_validated_post_fk",
    "reviews_per_post_unique", "reviews_three_restrictive_fence_shapes"]) expect(audit.conditions[name]).not.toBe(true);
  expect(audit.scope).toContain("No overall");
});
test("actual three-unit sequence yields stage-aware conditions, stable purchase metadata and captured rating hashes", async () => {
  await fixture();
  const baseline = await inspect();
  expect(baseline.conditions.purchase_clients_select_only_table).toBe(false);
  expect(baseline.conditions.reviews_nullable_post_uuid).toBe(false);
  expect(baseline.routines.filter(r => r.matches_captured_definition === true)).toHaveLength(3);
  const beforeRows = (await db.query("select * from public.purchases order by id")).rows;
  const legacyRows = (await db.query("select id,comment from public.reviews order by id")).rows;
  await db.exec(readFileSync(join(process.cwd(), "docs/staging-purchases-readonly-acl-prerequisite.sql"), "utf8"));
  const purchase = await inspect();
  for (const key of ["client_roles_safe", "purchase_clients_select_only_table", "purchase_clients_select_only_columns",
    "purchase_server_all_eight_preserved", "purchase_server_columns_preserved"]) expect(purchase.conditions[key]).toBe(true);
  expect(purchase.relations).toEqual(baseline.relations);
  expect(purchase.policies).toEqual(baseline.policies);
  expect(purchase.triggers).toEqual(baseline.triggers);
  expect(purchase.routines).toEqual(baseline.routines);
  await db.exec(readFileSync(join(process.cwd(), "docs/staging-rating-acl-prerequisite.sql"), "utf8"));
  const rating = await inspect();
  expect(rating.relations).toEqual(purchase.relations);
  expect(rating.policies).toEqual(purchase.policies);
  expect(rating.triggers).toEqual(purchase.triggers);
  for (const signature of ["public.set_profile_rating(uuid,uuid,integer)", "public.update_profile_rating(uuid)"]) {
    const routine = rating.routines.find(row => row.signature === signature);
    expect(routine?.matches_captured_definition).toBe(true);
    expect(routine?.effective_execute).toEqual([
      { role: "anon", execute: false, grant_option: false },
      { role: "authenticated", execute: false, grant_option: false },
      { role: "service_role", execute: true, grant_option: false },
    ]);
  }
  await db.exec(prepareReviewPrerequisites().sql);
  const final = await inspect();
  expect(Object.values(final.conditions).every(condition => condition === true)).toBe(true);
  expect(final.relations.filter(row => row.name !== "reviews")).toEqual(baseline.relations.filter(row => row.name !== "reviews"));
  expect(final.policies.filter(row => row.name !== "reviews")).toEqual(baseline.policies.filter(row => row.name !== "reviews"));
  expect(final.triggers.filter(row => row.name !== "reviews")).toEqual(baseline.triggers.filter(row => row.name !== "reviews"));
  expect(final.routines.filter(r => r.matches_captured_definition === true)).toHaveLength(3);
  expect(comparable(await inspect(compact))).toEqual(comparable(final));
  expect((await db.query("select * from public.purchases order by id")).rows).toEqual(beforeRows);
  expect((await db.query("select id,comment from public.reviews order by id")).rows).toEqual(legacyRows);
  expect(JSON.stringify(final)).not.toContain("Synthetic legacy");
  for (const routine of ratingCatalog.routines) expect(JSON.stringify(final)).not.toContain(routine.definition);
  expect((await db.query("select current_setting('transaction_read_only') as ro")).rows).toEqual([{ ro: "off" }]);
  await db.exec("grant update(status) on public.purchases to authenticated");
  const drift = await inspect();
  expect(drift.conditions.purchase_clients_select_only_table).toBe(true);
  expect(drift.conditions.purchase_clients_select_only_columns).toBe(false);
});
