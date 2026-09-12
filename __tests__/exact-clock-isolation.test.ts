/** @jest-environment ./test-support/pglite-environment.cjs */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
import { assertExactClockMemoryDatabase, createExactClockMemoryDatabase,
  type ExactClockMemoryDatabase } from "../test-support/exact-clock-simulation/isolation";

declare const createLocalPostgres: () => PGlite;
// WASM is loaded in the existing native Jest environment rather than Jest's VM.
// Only this test replaces the constructor. The shipped helper has no injection
// hook; assert that its only configuration is the literal empty options object.
jest.mock("@electric-sql/pglite", () => ({ PGlite: jest.fn(function(options: unknown) {
  if (!options || typeof options !== "object" || Reflect.ownKeys(options).length !== 0) {
    throw new Error("Tests permit only the empty memory constructor options");
  }
  return createLocalPostgres();
}) }));

jest.setTimeout(60000);
const root = process.cwd();
let db: ExactClockMemoryDatabase;
beforeAll(async () => { db = await createExactClockMemoryDatabase(); });
afterAll(async () => { await db?.close(); });

test("factory creates only its own memory backend and exposes a frozen minimal handle", async () => {
  expect(PGlite).toHaveBeenLastCalledWith({});
  expect(Object.isFrozen(db)).toBe(true);
  expect(Reflect.ownKeys(db).sort()).toEqual(["close", "exec", "query"]);
  expect(() => assertExactClockMemoryDatabase(db)).not.toThrow();
  const result = await db.query<{ answer: number }>("select $1::integer as answer", [42]);
  expect(result.rows).toEqual([{ answer: 42 }]);
});

test.each(["postgres://synthetic.invalid/example", { dataDir: "synthetic" }, { env: {} }, {}])(
  "factory rejects supplied configuration before construction: %j", async options => {
    const before = jest.mocked(PGlite).mock.calls.length;
    await expect(Reflect.apply(createExactClockMemoryDatabase, undefined, [options])).rejects.toThrow("no configuration");
    expect(jest.mocked(PGlite).mock.calls).toHaveLength(before);
  },
);

test.each([null, {}, { query: jest.fn(), exec: jest.fn(), close: jest.fn() }])(
  "structural or foreign client cannot receive the capability: %j", value => {
    expect(() => assertExactClockMemoryDatabase(value)).toThrow("own active in-memory database");
  },
);

test("property copies, prototypes and proxies do not inherit ownership", () => {
  for (const copy of [{ ...db }, Object.create(db), new Proxy(db, {})]) {
    expect(() => assertExactClockMemoryDatabase(copy)).toThrow("own active in-memory database");
  }
});

test("separate instances do not share private simulation tables and do not mutate public", async () => {
  const other = await createExactClockMemoryDatabase();
  try {
    await db.exec("create schema cnqa_clock_v1; create table cnqa_clock_v1.isolation_probe(value integer); insert into cnqa_clock_v1.isolation_probe values(7)");
    expect((await db.query<{ value: number }>("select value from cnqa_clock_v1.isolation_probe")).rows).toEqual([{ value: 7 }]);
    expect((await other.query<{ absent: boolean }>("select to_regclass('cnqa_clock_v1.isolation_probe') is null as absent")).rows[0].absent).toBe(true);
    for (const target of [db, other]) {
      expect((await target.query<{ count: number }>("select count(*)::integer as count from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','f')")).rows[0].count).toBe(0);
    }
  } finally { await other.close(); }
});

test("close revokes the handle and saved methods; repeated close is harmless", async () => {
  const closed = await createExactClockMemoryDatabase();
  const query = closed.query;
  await closed.close();
  await expect(closed.close()).resolves.toBeUndefined();
  expect(() => assertExactClockMemoryDatabase(closed)).toThrow("own active in-memory database");
  await expect(query("select 1")).rejects.toThrow("own active in-memory database");
  await expect(closed.exec("select 1")).rejects.toThrow("own active in-memory database");
});

function moduleReferences(text: string, file: string): string[] {
  const found: string[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const literal = (node: ts.Node | undefined) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) found.push(node.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal(node.moduleSpecifier);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && node.expression.text === "require")) literal(node.arguments[0]);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) literal(node.moduleReference.expression);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const namespace = resolve(root, "test-support/exact-clock-simulation");
const inside = (file: string, directory: string) => {
  const path = relative(directory, file);
  return path === "" || !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
};
function importCandidate(file: string, specifier: string): string | undefined {
  if (specifier.startsWith("@/")) return resolve(root, specifier.slice(2));
  if (specifier.startsWith(".")) return resolve(dirname(file), specifier);
  if (specifier.startsWith("test-support/")) return resolve(root, specifier);
  return isAbsolute(specifier) ? resolve(specifier) : undefined;
}

test.each([
  'import x from "@/test-support/exact-clock-simulation/isolation";',
  'export {x} from "../test-support/exact-clock-simulation/isolation";',
  'const x=import("@/test-support/exact-clock-simulation/isolation");',
  'const x=require("@/test-support/exact-clock-simulation/isolation");',
])("dependency guard recognizes static namespace entry: %s", source => {
  const file = join(root, "lib/guard-fixture.ts");
  expect(moduleReferences(source, file).some(ref => {
    const path = importCandidate(file, ref);
    return path && inside(path, namespace);
  })).toBe(true);
});

test("application import graph cannot reach the simulation namespace", () => {
  const files: string[] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Review application dependency symlink before simulation acceptance");
      const file = join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(file);
    }
  };
  for (const directory of ["app", "components", "lib"]) collect(join(root, directory));
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const ref of moduleReferences(readFileSync(file, "utf8"), file)) {
      const candidate = importCandidate(file, ref);
      if (!candidate) continue;
      expect({ importer: relative(root, file), reference: ref, forbidden: inside(candidate, namespace) }).toMatchObject({ forbidden: false });
      if (!inside(candidate, root) || inside(candidate, join(root, "node_modules"))) continue;
      const paths = [candidate, ...[".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs"].map(ext => candidate + ext),
        ...["index.ts", "index.tsx", "index.js", "index.jsx"].map(name => join(candidate, name))];
      const resolved = paths.find(path => existsSync(path) && statSync(path).isFile());
      if (resolved && /\.[cm]?[jt]sx?$/.test(extname(resolved))) visit(resolved);
    }
  };
  for (const file of files) visit(file);
});

test("installed 040–057 sources and the canonical hash manifest stay unchanged", () => {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const manifestText = readFileSync(join(root, "test-support/exact-staging-bundle-manifest.json"), "utf8").replace(/\r\n/g, "\n");
  expect(digest(manifestText)).toBe("98008e8d42e60c528046f4ec01d95f8737893f24e8c1dd8e3e300ca1da0be672");
  const manifest = JSON.parse(manifestText) as { sources: [string, string][] };
  expect(manifest.sources).toHaveLength(18);
  for (const [name, hash] of manifest.sources) {
    expect(name).toMatch(/^(04\d|05[0-7])-[-a-z]+\.sql$/);
    const text = readFileSync(join(root, "supabase/schema", name), "utf8").replace(/\r\n/g, "\n");
    expect(digest(text)).toBe(hash);
    expect(text).not.toContain("cnqa_clock_v1");
    expect(text).not.toContain("exact-clock-simulation");
  }
});
