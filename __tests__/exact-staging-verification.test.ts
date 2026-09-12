/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { installStagingStructuralBaseline } from "../test-support/staging-catalog-postgres";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Same non-executing local preparation used by operator.
const { prepareExactVerification } = require("../test-support/prepare-exact-staging-verification.cjs") as { prepareExactVerification: () => {
  metadataSql: string; emptySql: string; compactMetadataSql: string; compactEmptySql: string;
} };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Existing approved bundle and SQL masker.
const { prepareStagingBundle, maskOpaqueSql } = require("../test-support/prepare-exact-staging-bundle.cjs") as {
  prepareStagingBundle: () => { sql: string }; maskOpaqueSql: (sql: string) => string;
};
declare const createLocalPostgres: () => PGlite;
type Verification = {
  observation: Record<string, unknown>; relations: Array<{ present: boolean; expected_kind: string; actual_kind: string; rls: boolean; policy_count: number }>;
  functions: Array<{ signature: string; normalized_definition_hash: string; raw_definition_hash: string; carriage_returns: number;
    present: boolean; reviewed_search_path: boolean; definer: boolean; expected_definer: boolean; server_execute: boolean; expected_server_execute: boolean;
    anon_execute: boolean; authenticated_execute: boolean; any_app_grant_option: boolean }>;
  table_acl_conditions: Array<{ expected_access: boolean; privileges_checked: number }>;
  column_acl_conditions: Array<{ expected_access: boolean }>;
  legacy_fingerprints: unknown; columns_fingerprint: unknown; constraints_fingerprint: unknown; indexes: unknown; triggers: unknown;
};
const v = prepareExactVerification();
let db: PGlite;
jest.setTimeout(120000);
beforeEach(async () => { db = createLocalPostgres(); await installStagingStructuralBaseline(db); });
afterEach(async () => { await db.close(); });
async function audit(sql = v.metadataSql): Promise<Verification> {
  const rows = (await db.exec(sql)).flatMap(r => r.rows) as Array<{ exact_verification: Verification }>;
  expect(rows).toHaveLength(1); return rows[0].exact_verification;
}
test("preparation is read-only bounded catalog SQL; the separate empty check names only sixteen new tables", () => {
  expect(prepareExactVerification()).toEqual(v);
  for (const sql of [v.metadataSql, v.emptySql]) {
    expect(sql).toContain("set transaction read only"); expect(sql).toContain("set local search_path = pg_catalog");
    expect(sql).toContain("set local statement_timeout = '30s'"); expect(sql).toContain("set local lock_timeout = '5s'");
    expect(sql.trimEnd().endsWith("rollback;")).toBe(true);
    expect(maskOpaqueSql(sql)).not.toMatch(/\b(?:create|alter|drop|grant|revoke|insert|update|delete|truncate|commit|call|copy|do)\s+/i);
  }
  expect(maskOpaqueSql(v.metadataSql)).not.toMatch(/\b(?:from|join)\s+(?:public|auth)\s*\./i);
  expect(v.emptySql.match(/not exists\(select 1 from public\."exact_installment_/g)).toHaveLength(16);
  expect(v.emptySql).toContain("set local row_security = off");
});
test("metadata sees complete installation and preserved legacy catalog; compact forms agree and effective MAINTAIN drift is caught", async () => {
  const before = await audit(); expect(before.relations.every(r => !r.present)).toBe(true);
  await db.exec(prepareStagingBundle().sql);
  const after = await audit();
  expect(after.legacy_fingerprints).toEqual(before.legacy_fingerprints);
  expect(after.relations).toHaveLength(57); expect(after.relations.every(r => r.present && r.actual_kind === r.expected_kind)).toBe(true);
  expect(after.relations.filter(r => r.expected_kind === "r").every(r => r.rls && r.policy_count === 0)).toBe(true);
  expect(after.functions).toHaveLength(60); expect(after.functions.every(f => f.present && f.reviewed_search_path && f.definer === f.expected_definer
    && f.server_execute === f.expected_server_execute && !f.anon_execute && !f.authenticated_execute && !f.any_app_grant_option)).toBe(true);
  expect(after.table_acl_conditions).toHaveLength(48); expect(after.table_acl_conditions.every(x => x.expected_access && x.privileges_checked === 8)).toBe(true);
  expect(after.column_acl_conditions).toHaveLength(48); expect(after.column_acl_conditions.every(x => x.expected_access)).toBe(true);
  const pasted = await audit(v.compactMetadataSql);
  expect({ ...pasted, observation: null }).toEqual({ ...after, observation: null });
  for (const sql of [v.emptySql, v.compactEmptySql]) {
    const rows = (await db.exec(sql)).flatMap(r => r.rows) as Array<{ exact_tables_empty: { tables: Record<string, boolean> } }>;
    expect(rows).toHaveLength(1); expect(Object.keys(rows[0].exact_tables_empty.tables)).toHaveLength(16);
    expect(Object.values(rows[0].exact_tables_empty.tables).every(Boolean)).toBe(true);
  }
  await db.exec("grant maintain on public.exact_installment_agreements to anon");
  expect((await audit()).table_acl_conditions.some(x => !x.expected_access)).toBe(true);
});
test("normalizing only CRLF yields identical installed routine code and exact catalog fingerprints", async () => {
  const sql = prepareStagingBundle().sql.replace(/\r\n/g, "\n");
  await db.exec(sql); const lf = await audit();
  const second = createLocalPostgres();
  try {
    await installStagingStructuralBaseline(second); await second.exec(sql.replace(/\n/g, "\r\n"));
    const rows = (await second.exec(v.metadataSql)).flatMap(r => r.rows) as Array<{ exact_verification: Verification }>;
    const crlf = rows[0].exact_verification;
    const normalizedFunctions = (a: Verification) => a.functions.map(({ raw_definition_hash: raw, carriage_returns: cr, ...f }) => {
      expect(typeof raw).toBe("string"); expect(typeof cr).toBe("number"); return f;
    });
    expect(normalizedFunctions(crlf)).toEqual(normalizedFunctions(lf));
    expect(crlf.functions.some((f, i) => f.raw_definition_hash !== lf.functions[i].raw_definition_hash && f.carriage_returns > 0)).toBe(true);
    for (const key of ["columns_fingerprint", "constraints_fingerprint", "indexes", "triggers"] as const) expect(crlf[key]).toEqual(lf[key]);
  } finally { await second.close(); }
});
