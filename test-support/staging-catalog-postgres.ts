import type { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import snapshot from "./staging-installment-catalog-20260906.json";
import manifest from "./exact-staging-bundle-manifest.json";

type Details = {
  type?: string; notNull?: boolean; default?: string | null; identity?: string;
  generated?: string; position?: number; definition?: string; valid?: boolean;
  labels?: string[]; body?: string; enabled?: string; rls?: boolean;
};
const rows = snapshot.rows as Array<{ kind: string; name: string; details: Details }>;
const identifier = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Catalog-derived structural compatibility test, exclusively in PGlite memory.
 * No remote connection, credentials, customer rows or filesystem DB is used.
 * All 11 inspected tables retain their columns/defaults/types/constraints,
 * indexes and three existing triggers. auth.users/orders/offerings are only FK
 * target stubs: their full schemas and auth behavior are NOT reproduced.
 * Existing table policies/ACLs are tested separately, not inferred here.
 */
export async function installStagingStructuralBaseline(db: PGlite) {
  if (snapshot.projectRef !== "nwqfofezfzljhxolkycz" || rows.length !== 429) {
    throw new Error("Unexpected staging structural evidence");
  }
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create table public.orders(id uuid primary key); create table public.offerings(id uuid primary key);`);
  for (const r of rows.filter(r => r.kind === "enum")) {
    const labels = r.details.labels!.map(s => `'${s.replace(/'/g, "''")}'`).join(",");
    await db.exec(`create type public.${identifier(r.name)} as enum (${labels})`);
  }
  for (const table of rows.filter(r => r.kind === "table")) {
    const columns = rows.filter(r => r.kind === "column" && r.name.startsWith(`${table.name}.`))
      .sort((a, b) => a.details.position! - b.details.position!);
    const definitions = columns.map(r => {
      const d = r.details;
      if (d.identity || d.generated) throw new Error("Review generated/identity columns before replay");
      return `${identifier(r.name.slice(table.name.length + 1))} ${d.type}` +
        (d.default === null ? "" : ` default ${d.default}`) + (d.notNull ? " not null" : "");
    });
    await db.exec(`create table public.${identifier(table.name)} (${definitions.join(",")})`);
  }
  const constraints = rows.filter(r => r.kind === "constraint");
  for (const r of [...constraints.filter(r => !r.details.definition!.startsWith("FOREIGN KEY")),
    ...constraints.filter(r => r.details.definition!.startsWith("FOREIGN KEY"))]) {
    if (!r.details.valid) throw new Error("Unvalidated staging constraint requires review");
    const [table, name] = r.name.split(".");
    await db.exec(`alter table public.${identifier(table)} add constraint ${identifier(name)} ${r.details.definition}`);
  }
  for (const r of rows.filter(r => r.kind === "index" && !constraints.some(c => c.name === r.name))) {
    if (!r.details.valid) throw new Error("Invalid staging index requires review");
    await db.exec(r.details.definition!);
  }
  for (const r of rows.filter(r => r.kind === "trigger")) {
    if (r.details.enabled !== "O") throw new Error("Unexpected staging trigger state");
    await db.exec(r.details.body!);
    await db.exec(r.details.definition!);
  }
  for (const r of rows.filter(r => r.kind === "dependency_function")) await db.exec(r.details.body!);
  for (const r of rows.filter(r => r.kind === "table" && r.details.rls)) {
    await db.exec(`alter table public.${identifier(r.name)} enable row level security`);
  }
}

/** Share the reviewed bundle order; reject stale copies and unreviewed exact files. */
export function exactMigrationFiles(directoryFiles: readonly string[]): string[] {
  const files = manifest.sources.map(([name]) => name);
  const actual = directoryFiles.filter(f => /^\d+-exact-installment-.*\.sql$/.test(f)).sort();
  if (files.length !== 18 || actual.length !== files.length || files.some((file, index) => file !== actual[index])) {
    throw new Error("Review exact migration bundle inventory");
  }
  return files;
}

export async function installExactMigrationsInMemory(db: PGlite) {
  const directory = join(process.cwd(), "supabase/schema");
  const files = exactMigrationFiles(readdirSync(directory));
  for (const file of files) await db.exec(readFileSync(join(directory, file), "utf8"));
  return files;
}
