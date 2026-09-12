/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeFixturePurchaseWrites, installPre024ReviewFixture } from "../test-support/review-pre024-fixture";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Existing local package preparation and masker.
const { prepareReviewPrerequisites } = require("../test-support/prepare-review-prerequisites.cjs") as { prepareReviewPrerequisites: () => { sql: string } };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Existing quote/comment masker.
const { maskOpaqueSql } = require("../test-support/prepare-exact-staging-bundle.cjs") as { maskOpaqueSql: (sql: string) => string };
declare const createLocalPostgres: () => PGlite;
const sql = readFileSync(join(process.cwd(), "docs/staging-review-original-columns-postcheck.sql"), "utf8");
const compact = sql.split(/\r?\n/).filter(line => !line.trimStart().startsWith("--")).map(line => line.trim()).filter(Boolean).join(" ");
type Check = { observed_at: string; original_column_count: number; original_columns_hash: string; current_column_count: number;
  original_seven_columns_match: boolean; current_columns: Array<{ attname: string }>; post_foreign_keys: Array<{ validated: boolean; definition: string }>;
  post_indexes: Array<{ valid: boolean; ready: boolean; definition: string }> };
let db: PGlite;
jest.setTimeout(60000);
beforeEach(() => { db = createLocalPostgres(); });
afterEach(async () => { await db.close(); });
async function inspect(source = sql): Promise<Check> {
  const rows = (await db.exec(source)).flatMap(result => result.rows) as Array<{ original_columns_postcheck: Check }>;
  expect(rows).toHaveLength(1); return rows[0].original_columns_postcheck;
}
test("follow-up contains only bounded catalog reads and does not pass for a missing relation", async () => {
  expect(compact).toMatch(/^begin; set transaction read only; set local search_path = pg_catalog;/);
  expect(compact).toContain("set local statement_timeout = '30s'"); expect(compact).toContain("set local lock_timeout = '5s'");
  expect(compact.endsWith("rollback;")).toBe(true);
  expect(maskOpaqueSql(compact)).not.toMatch(/\b(?:insert|update|delete|truncate|create|alter|drop|grant|revoke|commit|call|copy|do)\s+/i);
  expect(maskOpaqueSql(compact)).not.toMatch(/\b(?:from|join)\s+(?:public|auth)\s*\./i);
  expect((await inspect()).original_seven_columns_match).toBe(false);
});
test("original-column hash equals the earlier audit, survives024026, and detects retained-column drift", async () => {
  await installPre024ReviewFixture(db);
  const prior = (await db.exec(readFileSync(join(process.cwd(), "docs/staging-review-postinstall-json.sql"), "utf8")))
    .flatMap(result => result.rows) as Array<{ postinstall: { relations: Array<{ name: string; columns_hash: string }> } }>;
  const before = await inspect();
  expect(before.original_column_count).toBe(7);
  expect(before.original_columns_hash).toBe(prior[0].postinstall.relations.find(row => row.name === "reviews")?.columns_hash);
  await closeFixturePurchaseWrites(db); await db.exec(prepareReviewPrerequisites().sql);
  const after = await inspect();
  expect(after.current_column_count).toBe(8); expect(after.original_column_count).toBe(7);
  expect(after.original_columns_hash).toBe(before.original_columns_hash);
  expect(after.current_columns.filter(column => column.attname !== "post_id")).toEqual(before.current_columns);
  expect(after.post_foreign_keys).toEqual([expect.objectContaining({ validated: true, definition: "FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE" })]);
  expect(after.post_indexes).toHaveLength(2); expect(after.post_indexes.every(index => index.valid && index.ready)).toBe(true);
  const pasted = await inspect(compact);
  expect({ ...pasted, observed_at: null }).toEqual({ ...after, observed_at: null });
  await db.exec("alter table public.reviews alter column comment set default 'LOCAL_DRIFT_CANARY'");
  const drift = await inspect(); expect(drift.original_columns_hash).not.toBe(before.original_columns_hash);
  expect(JSON.stringify(drift)).not.toContain("LOCAL_DRIFT_CANARY");
});
