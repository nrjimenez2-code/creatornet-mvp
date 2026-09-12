/* eslint-disable @typescript-eslint/no-require-imports -- Local read-only SQL preparation, not a migration runner. */
"use strict";
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { maskOpaqueSql } = require("./prepare-exact-staging-bundle.cjs");

// Separate from the exact-payment manifest. A changed migration requires review,
// never automatic hash replacement. Hashes normalize CRLF to LF only.
const sources = Object.freeze([
  Object.freeze(["024-reviews-per-post-STAGED.sql", "768c8175815eb38a00bfd04b0910296b97a49156e740238a501af680e1a00d5a"]),
  Object.freeze(["026-reviews-require-purchase-STAGED.sql", "719d59961d9474d4be199ff6c27ccdbd01f9b3a980c8d6c2f2d3099f10191c83"]),
]);
const normalize = sql => sql.replace(/\r\n/g, "\n");
const digest = sql => createHash("sha256").update(sql, "utf8").digest("hex");

function readSources(root = process.cwd()) {
  return sources.map(([name]) => ({ name, sql: readFileSync(join(root, "supabase/schema", name), "utf8") }));
}

function unwrapSource(sql) {
  const masked = maskOpaqueSql(sql);
  const controls = [...masked.matchAll(/\b(?:begin|commit|rollback|savepoint|release|abort|end|start\s+transaction|prepare\s+transaction|set\s+(?:local\s+)?transaction)\b/gi)];
  if (controls.length !== 2 || controls[0][0].toLowerCase() !== "begin" || controls[1][0].toLowerCase() !== "commit") {
    throw new Error("Review prerequisite transaction controls changed");
  }
  const start = controls[0].index, finish = controls[1].index;
  const begin = masked.slice(start).match(/^begin\s*;/i), commit = masked.slice(finish).match(/^commit\s*;/i);
  if (!begin || !commit || masked.slice(0, start).trim() || masked.slice(finish + commit[0].length).trim()) {
    throw new Error("Review prerequisite outer transaction shape changed");
  }
  // Keep every other byte, including leading/trailing comments and opaque bodies.
  return sql.slice(0, start) + sql.slice(start + begin[0].length, finish) + sql.slice(finish + commit[0].length);
}

const preflight = `do $review_package_preflight$
begin
  if not exists (select 1 from pg_class where oid=to_regclass('public.reviews') and relkind='r' and relrowsecurity) then
    raise exception 'Review package requires the reviewed pre-024 RLS reviews table';
  end if;
  if (select count(*) from pg_attribute where attrelid='public.reviews'::regclass and attnum>0 and not attisdropped)<>7
    or exists(select 1 from pg_attribute where attrelid='public.reviews'::regclass and attname='post_id' and not attisdropped)
    or not exists(select 1 from pg_constraint where conrelid='public.reviews'::regclass and contype='u'
      and pg_get_constraintdef(oid)='UNIQUE (reviewer_id, creator_id)') then
    raise exception 'Review package requires the captured pre-024 shape; do not replay on an unknown or partial install';
  end if;
  if to_regclass('public.reviews_reviewer_post_unique') is not null or to_regclass('public.idx_reviews_post_id') is not null then
    raise exception 'Review package index-name collision; inspect before proceeding';
  end if;
end;
$review_package_preflight$;`;

function prepareReviewPrerequisites(input = readSources()) {
  if (!Array.isArray(input) || input.length !== sources.length) throw new Error("Expected exactly two review prerequisite sources");
  const sections = input.map((source, index) => {
    const [name, sha256] = sources[index];
    if (!source || source.name !== name || typeof source.sql !== "string") throw new Error("Review prerequisite inventory/order changed");
    const sql = normalize(source.sql);
    if (sql.includes("\r") || sql.charCodeAt(0) === 0xfeff || digest(sql) !== sha256) {
      throw new Error(`Review prerequisite checksum drift: ${name}`);
    }
    return `-- SOURCE ${name} SHA256-LF ${sha256}\n${unwrapSource(sql)}\n-- END SOURCE ${name}`;
  });
  const sql = `-- LOCAL REVIEW DESIGN ONLY. NOT AUTHORIZATION TO EXECUTE. NEVER PRODUCTION.
-- Purchases ACL/rating-RPC prerequisites and hosted project identity require separate review.
-- This package changes neither purchase permissions nor rating functions.
-- One transaction: a 026 preflight or late assertion failure must roll back 024 too.
-- No partial pastes, extra COMMITs, disabled assertions, or automatic retry after uncertainty.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
${preflight}
${sections.join("\n\n")}
commit;
`;
  return Object.freeze({ sql, sha256: digest(sql), sourceCount: sources.length,
    sources: sources.map(([name, sha256]) => ({ name, sha256 })), bytes: Buffer.byteLength(sql, "utf8") });
}

module.exports = { sources, readSources, unwrapSource, prepareReviewPrerequisites };
if (require.main === module) {
  const option = process.argv[2];
  if (process.argv.length !== 3 || !["--summary", "--print"].includes(option)) {
    process.stderr.write("Local design only: node test-support/prepare-review-prerequisites.cjs --summary|--print\n");
    process.exitCode = 2;
  } else {
    const { sql, ...summary } = prepareReviewPrerequisites();
    process.stdout.write(option === "--print" ? sql : JSON.stringify(summary, null, 2) + "\n");
  }
}
