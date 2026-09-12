/* eslint-disable @typescript-eslint/no-require-imports -- Standalone local preparation tool; no database/network client. */
"use strict";
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const manifest = require("./exact-staging-bundle-manifest.json");

// This tool only reads the explicit local source files and returns/prints SQL.
// It does not connect to a database, write an artifact, execute SQL, approve an
// installation, know the hosted project identity, or enable payment features.
// The inventory was derived from a full 022-039 install on the catalog-faithful
// PGlite baseline; these unapplied sources are now numbered 040-057. Tests
// compare the complete resulting inventory independently.
function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object") deepFreeze(child);
  return value;
}
deepFreeze(manifest);
const digest = text => createHash("sha256").update(text, "utf8").digest("hex");
const normalize = text => text.replace(/\r\n/g, "\n");
const literal = text => `'${text.replace(/'/g, "''")}'`;

/** Mask opaque quotes/comments only for a transaction-control safety check.
 * No function body is parsed, interpreted or rewritten. Actual bundled source
 * is the original normalized string with ONLY its exact outside wrappers cut.
 */
function maskOpaqueSql(sql) {
  let output = "", i = 0;
  while (i < sql.length) {
    const start = i;
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2); i = end < 0 ? sql.length : end;
    } else if (sql.startsWith("/*", i)) {
      let depth = 1; i += 2;
      while (depth && i < sql.length) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; }
        else if (sql.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error("Unterminated SQL comment; review source");
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++]; let closed = false;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) i += 2;
          else { i++; closed = true; break; }
        } else i++;
      }
      if (!closed) throw new Error("Unterminated SQL quote; review source");
    } else if (sql[i] === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i))) {
      const delimiter = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)[0];
      const end = sql.indexOf(delimiter, i + delimiter.length);
      if (end < 0) throw new Error("Unterminated opaque SQL body; review source");
      i = end + delimiter.length;
    } else { output += sql[i++]; continue; }
    output += sql.slice(start, i).replace(/[^\n]/g, " ");
  }
  return output;
}

function readSources(repositoryRoot = process.cwd()) {
  return manifest.sources.map(([name]) => ({ name, sql: readFileSync(join(repositoryRoot, "supabase/schema", name), "utf8") }));
}

function preflightSql() {
  const specification = literal(JSON.stringify(manifest));
  return `-- Empty prospective installation only; collision means STOP, never overwrite.
do $cn_exact_preflight$
declare m jsonb := ${specification}::jsonb; item jsonb; target text;
begin
  if to_regnamespace('public') is null or to_regclass('public.booking_payments') is null then
    raise exception 'Required legacy schema missing'; end if;
  foreach target in array array['anon','authenticated','service_role'] loop
    if not exists(select 1 from pg_roles where rolname=target) then
      raise exception 'Required database role missing: %',target; end if;
  end loop;
  foreach target in array array['public.apply_payment_fee_ledger_refund(uuid,bigint)',
    'public.record_payment_refund_state(text,text,bigint,bigint)',
    'public.record_payment_dispute_state(text,text,text,bigint,text,text,bigint)'] loop
    if to_regprocedure(target) is null then raise exception 'Required legacy function missing: %',target; end if;
  end loop;
  -- Broad prefix fence also rejects unknown partial/newer exact candidates.
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname like 'exact\\_installment\\_%' escape '\\') then
    raise exception 'Existing exact relation: reconcile prior installation, do not replay'; end if;
  for item in select value from jsonb_array_elements(m->'relations') loop
    target := item->>0;
    if to_regclass('public.'||quote_ident(target)) is not null then
      raise exception 'Prospective relation collision: %',target; end if;
    if item->>1='r' and (to_regtype('public.'||quote_ident(target)) is not null or
      to_regtype('public.'||quote_ident('_'||target)) is not null) then
      raise exception 'Prospective row/array type collision: %',target; end if;
  end loop;
  for item in select value from jsonb_array_elements(m->'functions') loop
    target := split_part(item->>0,'(',1);
    -- Reject ANY preexisting overload of a newly introduced function name.
    if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=target) then
      raise exception 'Prospective function-name collision: %',target; end if;
  end loop;
  for item in select value from jsonb_array_elements(m->'triggers') loop
    if exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||(item->>0)) and tgname=item->>1) then
      raise exception 'Prospective trigger collision: %.%',item->>0,item->>1; end if;
  end loop;
  for item in select value from jsonb_array_elements(m->'legacyColumns') loop
    if exists(select 1 from pg_attribute where attrelid=to_regclass('public.'||(item->>0))
      and attname=item->>1 and attnum>0 and not attisdropped) then
      raise exception 'Prospective legacy column collision: %.%',item->>0,item->>1; end if;
  end loop;
  for item in select value from jsonb_array_elements(m->'legacyConstraints') loop
    if exists(select 1 from pg_constraint where conrelid=to_regclass('public.'||(item->>0)) and conname=item->>1) then
      raise exception 'Prospective legacy constraint collision: %.%',item->>0,item->>1; end if;
  end loop;
end;
$cn_exact_preflight$;`;
}

function postconditionSql() {
  const specification = literal(JSON.stringify(manifest));
  return `-- These assertions execute before the ONLY COMMIT; failure rolls back all 18.
do $cn_exact_postconditions$
declare m jsonb := ${specification}::jsonb; item jsonb; c pg_class%rowtype; p pg_proc%rowtype;
  target text; caller text; has_rows boolean; actual_count integer;
begin
  select count(*) into actual_count from pg_class cl join pg_namespace n on n.oid=cl.relnamespace
    where n.nspname='public' and cl.relname like 'exact\\_installment\\_%' escape '\\';
  if actual_count<>jsonb_array_length(m->'relations') then raise exception 'Exact relation inventory differs'; end if;
  for item in select value from jsonb_array_elements(m->'relations') loop
    target := item->>0;
    select * into c from pg_class where oid=to_regclass('public.'||quote_ident(target));
    if not found or c.relkind::text is distinct from item->>1 then
      raise exception 'Exact relation missing/type differs: %',target; end if;
    if item->>1='r' then
      if not c.relrowsecurity or not has_table_privilege('service_role',c.oid,'SELECT') or
        has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or
        has_any_column_privilege('service_role',c.oid,'INSERT,UPDATE,REFERENCES') then
        raise exception 'Exact private table/server ACL differs: %',target; end if;
      foreach caller in array array['anon','authenticated'] loop
        if has_table_privilege(caller,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or
          has_any_column_privilege(caller,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') then
          raise exception 'Exact client table/column access remains: %',target; end if;
      end loop;
      if exists(select 1 from pg_policy where polrelid=c.oid) then
        raise exception 'Unexpected exact table policy: %',target; end if;
      execute format('select exists(select 1 from public.%I)',target) into has_rows;
      if has_rows then raise exception 'Schema-only installation unexpectedly has exact data: %',target; end if;
    end if;
  end loop;
  select count(*) into actual_count from pg_proc fn join pg_namespace n on n.oid=fn.pronamespace
    where n.nspname='public' and fn.proname in
      (select split_part(value->>0,'(',1) from jsonb_array_elements(m->'functions'));
  if actual_count<>jsonb_array_length(m->'functions') then raise exception 'Exact function inventory differs'; end if;
  for item in select value from jsonb_array_elements(m->'functions') loop
    target := 'public.'||(item->>0);
    select * into p from pg_proc where oid=to_regprocedure(target);
    if not found or p.prosecdef is distinct from (item->>2)::boolean or cardinality(p.proconfig) is distinct from 1 or
      regexp_replace(p.proconfig[1],'\\s','','g') is distinct from 'search_path=public,pg_temp' or
      has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') or
      has_function_privilege('service_role',p.oid,'EXECUTE') is distinct from (item->>1)::boolean then
      raise exception 'Exact function configuration/ACL differs: %',target; end if;
  end loop;
  for item in select value from jsonb_array_elements(m->'triggers') loop
    if not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||(item->>0)) and tgname=item->>1
      and not tgisinternal and tgenabled='O' and tgtype=(item->>3)::smallint
      and tgfoid=to_regprocedure('public.'||(item->>2))) then
      raise exception 'Exact trigger configuration differs: %.%',item->>0,item->>1; end if;
  end loop;
  if not exists(select 1 from pg_attribute where attrelid='public.booking_payments'::regclass
    and attname='installment_collection_version' and atttypid='text'::regtype and not attnotnull and not atthasdef
    and attnum>0 and not attisdropped) then raise exception 'Prospective marker column differs'; end if;
  if not exists(select 1 from pg_constraint where conrelid='public.booking_payments'::regclass
    and conname='booking_payments_installment_collection_version_check' and contype='c' and convalidated) then
    raise exception 'Prospective marker constraint differs'; end if;
end;
$cn_exact_postconditions$;`;
}

function prepareStagingBundle(sources = readSources()) {
  if (!Array.isArray(sources) || sources.length !== 18 || manifest.schemaVersion !== 1 || manifest.sources.length !== 18) {
    throw new Error("Expected the explicit eighteen-source manifest");
  }
  const sections = sources.map((source, index) => {
    const [name, expectedHash] = manifest.sources[index];
    if (!source || source.name !== name || typeof source.sql !== "string") throw new Error("Source inventory/order differs");
    const sql = normalize(source.sql);
    if (sql.includes("\r") || sql.charCodeAt(0) === 0xfeff || digest(sql) !== expectedHash) {
      throw new Error(`Source checksum drift; review before updating manifest: ${name}`);
    }
    if (!sql.startsWith("begin;\n") || !/\ncommit;\n*$/.test(sql)) throw new Error(`Unexpected transaction wrapper: ${name}`);
    const end = sql.lastIndexOf("\ncommit;");
    const body = sql.slice("begin;\n".length, end);
    const masked = maskOpaqueSql(body);
    if (/(^|;)\s*(?:begin|commit|rollback|savepoint|release|abort|end|start\s+transaction|prepare\s+transaction|set\s+(?:local\s+)?transaction)\b/i.test(masked)) {
      throw new Error(`Unexpected inner transaction control: ${name}`);
    }
    return `-- SOURCE ${name} SHA256-LF ${expectedHash}\n${body}\n-- END SOURCE ${name}`;
  });
  const manifestHash = digest(JSON.stringify(manifest));
  const sql = `-- LOCAL REVIEW ARTIFACT ONLY. NOT AUTHORIZATION TO EXECUTE. NEVER PRODUCTION.
-- Operator must verify CreatorNet Staging / ${manifest.projectRefForOperatorCheckOnly} in the dashboard.
-- SQL cannot establish the hosted project identity. Existing ACL/recovery/approval gates remain separate.
-- Initial prospective install only. No flags, Stripe requests, fixture data or legacy backfills.
-- Do not paste pieces, insert extra COMMITs, re-run after uncertainty, or disable protection.
-- Manifest SHA256 ${manifestHash}
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = public, pg_temp;
set local standard_conforming_strings = on;
${preflightSql()}
${sections.join("\n\n")}
${postconditionSql()}
commit;
`;
  return Object.freeze({ sql, sha256: digest(sql), manifestSha256: manifestHash, sourceCount: sections.length });
}

module.exports = { manifest, readSources, prepareStagingBundle, maskOpaqueSql };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--summary", "--print"].includes(args[0])) {
    process.stderr.write("Local review only: node test-support/prepare-exact-staging-bundle.cjs --summary|--print\n");
    process.exitCode = 2;
  } else {
    try {
      const result = prepareStagingBundle();
      process.stdout.write(args[0] === "--print" ? result.sql : JSON.stringify({
        sha256: result.sha256, manifestSha256: result.manifestSha256, sourceCount: result.sourceCount,
        relationCount: manifest.relations.length, tableCount: manifest.relations.filter(r => r[1] === "r").length,
        functionCount: manifest.functions.length, bytes: Buffer.byteLength(result.sql, "utf8"),
        scope: "local review artifact; no connection, execution, file write, or authorization"
      }, null, 2) + "\n");
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
