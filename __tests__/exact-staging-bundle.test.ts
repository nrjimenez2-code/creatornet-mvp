/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { exactMigrationFiles, installStagingStructuralBaseline } from "../test-support/staging-catalog-postgres";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";

type Source = { name: string; sql: string };
type Bundle = { sql: string; sha256: string; manifestSha256: string; sourceCount: number };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Exercise the same standalone local CLI implementation.
const tool = require("../test-support/prepare-exact-staging-bundle.cjs") as {
  manifest: {
    sources: Array<[string, string]>; relations: Array<[string, string]>;
    functions: Array<[string, boolean, boolean]>; triggers: Array<[string, string, string, number]>;
  };
  readSources: (root?: string) => Source[];
  prepareStagingBundle: (sources?: Source[]) => Bundle;
  maskOpaqueSql: (sql: string) => string;
};
declare const createLocalPostgres: () => PGlite;
jest.setTimeout(120000);
const t = exactInstallmentFixture().terms;
const bundle = () => tool.prepareStagingBundle();
const normalized = (sql: string) => sql.replace(/\r\n/g, "\n");

describe("deterministic local preparation", () => {
  test("canonical 040-057 discovery shares the manifest and ignores unrelated migrations", () => {
    const files = tool.manifest.sources.map(([name]) => name);
    expect(files.map(file => Number(file.slice(0, 3)))).toEqual(Array.from({ length: 18 }, (_, i) => i + 40));
    expect(exactMigrationFiles([
      ...files.slice().reverse(), "021-admin-refund-operations.sql",
      "024-reviews-per-post-STAGED.sql", "025-feed-v3-purchase-count-STAGED.sql",
      "026-reviews-require-purchase-STAGED.sql",
    ])).toEqual(files);
    expect(() => exactMigrationFiles(files.slice(1))).toThrow("inventory");
    expect(() => exactMigrationFiles([...files, files[0]])).toThrow("inventory");
    expect(() => exactMigrationFiles([...files, "022-exact-installment-agreements.sql"])).toThrow("inventory");
    expect(() => exactMigrationFiles([...files, "058-exact-installment-unreviewed.sql"])).toThrow("inventory");
    expect(() => exactMigrationFiles(["040-exact-installment-other.sql", ...files.slice(1)])).toThrow("inventory");
  });

  test("reads only the eighteen explicit ordered sources and produces the same reviewed SQL", () => {
    const a = bundle(), b = bundle();
    expect(a).toEqual(b); expect(a.sourceCount).toBe(18);
    expect(a.sha256).toBe(createHash("sha256").update(a.sql).digest("hex"));
    expect(a.sql).toContain("NOT AUTHORIZATION TO EXECUTE. NEVER PRODUCTION.");
    expect(a.sql).toContain("set local lock_timeout = '5s'");
    expect(a.sql).toContain("set local statement_timeout = '60s'");
    const masked = tool.maskOpaqueSql(a.sql);
    expect(masked.match(/\bbegin\s*;/gi)).toHaveLength(1);
    expect(masked.match(/\bcommit\s*;/gi)).toHaveLength(1);
    expect(masked).not.toMatch(/\b(?:rollback|savepoint|release|start\s+transaction)\b/i);
  });

  test("preserves every normalized source body byte-for-byte, cutting only known outer wrappers", () => {
    const sql = bundle().sql;
    for (const [file] of tool.manifest.sources) {
      const original = normalized(readFileSync(join(process.cwd(), "supabase/schema", file), "utf8"));
      const body = original.slice("begin;\n".length, original.lastIndexOf("\ncommit;"));
      const afterHeader = sql.split(`-- SOURCE ${file} SHA256-LF `)[1];
      expect(afterHeader.slice(afterHeader.indexOf("\n") + 1).split(`\n-- END SOURCE ${file}`)[0]).toBe(body);
    }
  });

  test("only CRLF/LF differences normalize; missing, reordered, changed or extra files fail closed", () => {
    const sources = tool.readSources();
    expect(tool.prepareStagingBundle(sources.map(s => ({ ...s, sql: normalized(s.sql).replace(/\n/g, "\r\n") })))).toEqual(bundle());
    expect(() => tool.prepareStagingBundle(sources.slice(1))).toThrow("eighteen");
    expect(() => tool.prepareStagingBundle([...sources].reverse())).toThrow("order");
    expect(() => tool.prepareStagingBundle([...sources, sources[0]])).toThrow("eighteen");
    for (const change of ["-- extra comment\n", "commit;\n", "rollback;\n", "\ufeff"]) {
      expect(() => tool.prepareStagingBundle(sources.map((s, i) => i ? s : { ...s, sql: change + s.sql }))).toThrow("checksum");
    }
  });

  test("opaque SQL masking does not mistake comments/quoted bodies for transaction controls", () => {
    const sql = "-- commit;\n/* outer /* nested */ rollback; */\nselect 'begin;', \"commit\"; create function f() returns void as $tag$begin perform 1; end;$tag$ language plpgsql;\nCOMMIT;";
    const masked = tool.maskOpaqueSql(sql);
    expect(masked.match(/\bcommit\s*;/gi)).toHaveLength(1);
    expect(masked).not.toMatch(/rollback|begin/i);
    expect(() => tool.maskOpaqueSql("/* unclosed")).toThrow("Unterminated");
    expect(() => tool.maskOpaqueSql("select 'unclosed")).toThrow("Unterminated");
    expect(() => tool.maskOpaqueSql("do $tag$unclosed")).toThrow("Unterminated");
  });
});

describe("atomic installation only in isolated PGlite memory", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = createLocalPostgres();
    await installStagingStructuralBaseline(db);
    await db.exec(`alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      alter default privileges in schema public grant execute on functions to anon,authenticated,service_role`);
    await db.query("insert into auth.users(id) values($1),($2)", [t.creatorId, t.buyerId]);
    await db.query("insert into profiles(id) values($1),($2)", [t.creatorId, t.buyerId]);
    await db.query(`insert into products(id,creator_id,type,title,is_active,price_cents,amount_cents,currency)
      values($1,$2,'mentorship','Synthetic legacy fixture',true,10000,10000,'usd')`, [t.productId, t.creatorId]);
    await db.query("insert into posts(id,product_id,creator_id,user_id) values($1,$2,$3,$3)", [t.postId, t.productId, t.creatorId]);
    await db.query("insert into bookings(id,post_id,creator_id,buyer_id,status) values($1,$2,$3,$4,'booked')",
      [t.bookingId, t.postId, t.creatorId, t.buyerId]);
    await db.query(`insert into booking_payments(id,booking_id,product_id,buyer_id,closer_user_id,plan_type,status,currency,amount_total_cents)
      values($1,$2,$3,$4,$5,'full','pending','usd',10000)`, [t.bookingPaymentId, t.bookingId, t.productId, t.buyerId, t.creatorId]);
  });
  afterEach(async () => { await db?.close(); });

  const catalog = async () => (await db.query(`select 'class' kind,c.relname name,
    jsonb_build_object('kind',c.relkind,'rls',c.relrowsecurity,'owner',c.relowner,'acl',c.relacl) details
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    union all select 'column',c.relname||'.'||a.attname,jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),
      'notNull',a.attnotnull,'acl',a.attacl,'default',pg_get_expr(d.adbin,d.adrelid))
    from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped
    union all select 'constraint',c.relname||'.'||co.conname,jsonb_build_object('definition',pg_get_constraintdef(co.oid),'valid',co.convalidated)
    from pg_constraint co join pg_class c on c.oid=co.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    union all select 'trigger',c.relname||'.'||t.tgname,jsonb_build_object('definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled)
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal
    union all select 'function',p.oid::regprocedure::text,jsonb_build_object('body',pg_get_functiondef(p.oid),'owner',p.proowner,'acl',p.proacl)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    order by 1,2`)).rows;
  const legacyRows = async () => (await db.query<{ kind: string; details: Record<string, unknown> }>(`select 'payment' kind,to_jsonb(b) details from booking_payments b
    union all select 'profile',to_jsonb(p) from profiles p order by 1,2`)).rows;

  test("installs the full explicit inventory and ACLs on the inspected baseline without rewriting legacy values", async () => {
    const beforeRelations = (await db.query<{ name: string }>(`select c.relname name from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'`)).rows.map(r => r.name);
    const beforeFunctions = (await db.query<{ signature: string }>(`select p.oid::regprocedure::text signature from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`)).rows.map(r => r.signature);
    const beforeRows = await legacyRows();
    await db.exec(bundle().sql);
    const addedRelations = (await db.query<{ name: string; kind: string }>(`select c.relname name,c.relkind kind from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by 1`)).rows
      .filter(r => !beforeRelations.includes(r.name)).map(r => [r.name, r.kind]);
    expect(addedRelations).toEqual(tool.manifest.relations);
    const addedFunctions = (await db.query<{ signature: string; server: boolean; client: boolean; definer: boolean }>(`select p.oid::regprocedure::text signature,p.prosecdef definer,
      has_function_privilege('service_role',p.oid,'EXECUTE') server,
      (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')) client
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by 1`)).rows
      .filter(r => !beforeFunctions.includes(r.signature));
    const actualFunctions = addedFunctions.map(r => [r.signature, r.server, r.definer] as const).sort((a, b) => a[0].localeCompare(b[0]));
    expect(actualFunctions).toEqual([...tool.manifest.functions].sort((a, b) => a[0].localeCompare(b[0])));
    expect(addedFunctions.find(r => r.signature === "exact_installment_month(bigint,integer)")?.definer).toBe(false);
    expect(addedFunctions.every(r => !r.client)).toBe(true);
    const afterRows = await legacyRows();
    expect(afterRows).toEqual(beforeRows.map(r => r.kind === "payment" ? { ...r, details: { ...(r.details as object), installment_collection_version: null } } : r));
    // Existing full-payment rows still accept their normal non-identity update.
    await db.query("update booking_payments set status='link_sent' where id=$1", [t.bookingPaymentId]);
    expect((await db.query("select status from booking_payments")).rows).toEqual([{ status: "link_sent" }]);
  });

  test("late failed ACL assertion rolls all migrations back and preserves legacy schema/data", async () => {
    const beforeSchema = await catalog(), beforeRows = await legacyRows();
    // TEST ONLY: corrupt a newly created ACL immediately before final assertions.
    // The preparation API deliberately has no hook for adding arbitrary SQL.
    const poisoned = bundle().sql.replace("-- These assertions execute before the ONLY COMMIT;",
      "grant execute on function public.reserve_exact_card_setup(uuid,uuid,text,uuid,text) to anon;\n-- These assertions execute before the ONLY COMMIT;");
    await expect(db.exec(poisoned)).rejects.toThrow("Exact function configuration/ACL differs");
    await db.exec("rollback");
    expect(await catalog()).toEqual(beforeSchema);
    expect(await legacyRows()).toEqual(beforeRows);
    expect((await db.query("select to_regclass('public.exact_installment_agreements') value")).rows).toEqual([{ value: null }]);
  });

  test("every prospective relation and every new function name is collision fenced before installation", async () => {
    const sql = bundle().sql;
    const preflight = sql.slice(sql.indexOf("do $cn_exact_preflight$"), sql.indexOf("-- SOURCE "));
    for (const [name] of tool.manifest.relations) {
      await db.exec(`begin; create table public.${name}(synthetic integer);`);
      await expect(db.exec(preflight)).rejects.toThrow("Existing exact relation");
      await db.exec("rollback");
    }
    for (const name of new Set(tool.manifest.functions.map(([signature]) => signature.split("(")[0]))) {
      // A different overload is also a collision, not an acceptable partial install.
      await db.exec(`begin; create function public.${name}() returns integer language sql as 'select 1';`);
      await expect(db.exec(preflight)).rejects.toThrow("function-name collision");
      await db.exec("rollback");
    }
  });

  test("row types, arrays and all three legacy alterations are collision fenced", async () => {
    const sql = bundle().sql;
    const preflight = sql.slice(sql.indexOf("do $cn_exact_preflight$"), sql.indexOf("-- SOURCE "));
    const cases = [
      ["create type public.exact_installment_agreements as (synthetic integer)", "Existing exact relation"],
      ["create type public._exact_installment_agreements as (synthetic integer)", "row/array type collision"],
      ["alter table booking_payments add column installment_collection_version text", "legacy column collision"],
      ["alter table booking_payments add constraint booking_payments_installment_collection_version_check check(true)", "legacy constraint collision"],
      ["create function public.synthetic_collision_guard() returns trigger language plpgsql as $$begin return new; end;$$; create trigger exact_installment_booking_binding before update on booking_payments for each row execute function synthetic_collision_guard()", "trigger collision"],
      ["create function public.synthetic_collision_guard() returns trigger language plpgsql as $$begin return new; end;$$; create trigger exact_installment_checkout_estimate before update on booking_payments for each row execute function synthetic_collision_guard()", "trigger collision"]
    ];
    for (const [collision, expected] of cases) {
      await db.exec(`begin; ${collision};`);
      await expect(db.exec(preflight)).rejects.toThrow(expected);
      await db.exec("rollback");
    }
  });

  test("a second install stops before overwriting schema or granting access", async () => {
    await db.exec(bundle().sql);
    const beforeSchema = await catalog(), beforeRows = await legacyRows();
    await expect(db.exec(bundle().sql)).rejects.toThrow("Existing exact relation");
    await db.exec("rollback");
    expect(await catalog()).toEqual(beforeSchema); expect(await legacyRows()).toEqual(beforeRows);
  });
});
