#!/usr/bin/env node
/**
 * Audit every database name in this codebase against the LIVE production schema.
 *
 *   node scripts/audit-live-schema.mjs
 *
 * Why this exists
 * ---------------
 * The jest suite's mock database accepts any column name and any table name, so
 * a query naming a column that does not exist passes all 5,000+ tests and fails
 * only in production, where PostgREST rejects the request and the route 500s.
 * That has shipped four times: purchases.user_id, watch_progress.duration,
 * watch_progress.completed, products.product_id (as a filter), and
 * profiles.booking_url / profiles.allow_booking.
 *
 * No credentials needed
 * ---------------------
 * It reads the project URL and the PUBLIC anon key out of the deployed JS
 * bundle — the same values every visitor's browser already downloads. Nothing
 * secret is used or printed.
 *
 * Read-only
 * ---------
 * Every request is a GET with `limit=0`, so no row is ever read and nothing is
 * written. It deliberately does NOT probe RPC functions by calling them:
 * PostgREST here will invoke a volatile function on GET, so function names are
 * checked against supabase/**.sql instead.
 *
 * How it tells "missing" from "locked down"
 * -----------------------------------------
 *   unknown table   -> 404 PGRST205
 *   unknown column  -> 400 42703      (this fires BEFORE the permission check,
 *                                      so it works on service-role-only tables)
 *   locked table    -> 401 42501      (exists; anon simply cannot read it)
 *
 * Exit code 1 if anything is missing, so it can gate a release.
 */
import fs from "node:fs";
import path from "node:path";

const SITE = process.env.AUDIT_SITE || "https://www.creatornet.net";
const ROOT = process.cwd();

// ---------------------------------------------------------------- discovery
async function discover() {
  const home = await (await fetch(SITE)).text();
  const chunks = [...new Set([...home.matchAll(/\/_next\/static\/[A-Za-z0-9._/-]+\.js/g)].map(m => m[0]))];
  let url = null, key = null;
  for (const c of chunks) {
    const js = await (await fetch(SITE + c)).text();
    url ??= (js.match(/https:\/\/[a-z]{20}\.supabase\.co/) || [])[0] || null;
    key ??= (js.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/) || [])[0] || null;
    if (url && key) break;
  }
  if (!url || !key) throw new Error(`could not find the Supabase URL/anon key in ${SITE}'s bundle`);
  return { base: `${url}/rest/v1`, key };
}

// ------------------------------------------------------------------ parsing
function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git", "coverage"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(e.name) && !p.includes("__tests__") && !p.includes("test-support")) out.push(p);
  }
  return out;
}

const RESERVED = new Set(["true", "false", "null", "undefined"]);

function splitTop(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function normCol(raw) {
  let c = raw.trim();
  if (!c || c === "*" || c.includes("(") || c.includes("!")) return null; // embedded resource / aggregate
  if (c.includes(":")) c = c.split(":").pop().trim();                     // alias:column
  if (c === "count" || RESERVED.has(c)) return null;
  return /^[a-z][a-z0-9_]*$/.test(c) ? c : null;
}

/** Every (table, column, file:line) the code names, including .or() filters. */
export function collectSites(files) {
  const sites = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/\.from\(\s*"([a-z0-9_]+)"\s*\)/g)) {
      const table = m[1];
      const start = m.index;
      const nextFrom = text.indexOf('.from("', start + 5);
      const end = Math.min(text.length, nextFrom === -1 ? start + 1800 : Math.min(nextFrom, start + 1800));
      const win = text.slice(start, end);
      const cols = new Set();

      for (const s of win.matchAll(/\.select\(\s*"([^"]*)"/g))
        for (const raw of splitTop(s[1])) { const c = normCol(raw); if (c) cols.add(c); }

      for (const s of win.matchAll(/\.(eq|neq|gt|gte|lt|lte|like|ilike|is|in|contains|order)\(\s*"([a-z0-9_]+)"/g))
        cols.add(s[2]);

      // .or("kind.is.null,status.neq.canceled") names columns too, and no
      // .select()/.eq() pattern sees them.
      for (const s of win.matchAll(/\.or\(\s*"([^"]+)"/g))
        for (const c of s[1].matchAll(/(^|,)\s*([a-z][a-z0-9_]*)\s*\./g)) cols.add(c[2]);

      for (const s of win.matchAll(/\.(insert|update|upsert)\(\s*(\{[\s\S]{0,700}?\})/g)) {
        for (const k of s[2].matchAll(/(^|[{,\s])([a-z][a-z0-9_]*)\s*:/g))
          if (!RESERVED.has(k[2])) cols.add(k[2]);
        // shorthand properties: { fulfillment, fulfillment_url } — no colon.
        for (const k of s[2].matchAll(/(^|[{,])\s*([a-z][a-z0-9_]*)\s*(?=[,}])/g))
          if (!RESERVED.has(k[2])) cols.add(k[2]);
      }

      if (cols.size) sites.push({ file: path.relative(ROOT, f), line: text.slice(0, start).split("\n").length, table, cols: [...cols] });
    }
  }
  return sites;
}

// ------------------------------------------------------------------- probing
async function main() {
  const { base, key } = await discover();
  const H = { apikey: key, Authorization: `Bearer ${key}` };
  const req = async (u) => {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(u, { headers: H });
        const t = await r.text();
        return { status: r.status, code: (t.match(/"code":"([A-Z0-9]+)"/) || [])[1] || null };
      } catch { await new Promise(r => setTimeout(r, 400)); }
    }
    return { status: 0, code: "NETFAIL" };
  };

  const sites = collectSites(sourceFiles(ROOT));
  const byTable = new Map();
  for (const s of sites) {
    if (!byTable.has(s.table)) byTable.set(s.table, new Set());
    for (const c of s.cols) byTable.get(s.table).add(c);
  }

  const pairs = [...byTable.values()].reduce((a, b) => a + b.size, 0);
  console.log(`auditing ${sites.length} query sites · ${byTable.size} tables · ${pairs} table-column pairs against ${base}\n`);

  const missing = [];
  for (const table of [...byTable.keys()].sort()) {
    if ((await req(`${base}/${table}?select=*&limit=0`)).code === "PGRST205") {
      missing.push({ kind: "table", table });
      console.log(`MISSING TABLE   ${table}`);
      continue;
    }
    const cols = [...byTable.get(table)].sort();
    if ((await req(`${base}/${table}?select=${cols.join(",")}&limit=0`)).status === 400) {
      for (const c of cols) {
        if ((await req(`${base}/${table}?select=${c}&limit=0`)).code === "42703") {
          missing.push({ kind: "column", table, column: c });
          console.log(`MISSING COLUMN  ${table}.${c}`);
        }
      }
    }
  }

  if (!missing.length) { console.log("\nOK — every table and column this codebase names exists in production."); return; }
  console.log(`\n${missing.length} mismatch(es):`);
  for (const m of missing) {
    const where = sites.filter(s => s.table === m.table && (m.kind === "table" || s.cols.includes(m.column)));
    console.log(`\n  ${m.table}${m.column ? "." + m.column : ""}`);
    for (const w of [...new Set(where.map(w => `${w.file}:${w.line}`))]) console.log(`      ${w}`);
  }
  process.exitCode = 1;
}

main().catch(e => { console.error("audit failed:", e.message); process.exitCode = 2; });
