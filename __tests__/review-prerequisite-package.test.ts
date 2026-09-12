/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeFixturePurchaseWrites, installPre024ReviewFixture, reviewFixture as f } from "../test-support/review-pre024-fixture";
import ratingCatalog from "../test-support/staging-rating-catalog-20260908.json";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Exercise the same local preparation helper as the operator summary.
const tool = require("../test-support/prepare-review-prerequisites.cjs") as {
  sources: Array<[string, string]>;
  readSources: () => Array<{ name: string; sql: string }>;
  unwrapSource: (sql: string) => string;
  prepareReviewPrerequisites: (input?: Array<{ name: string; sql: string }>) => {
    sql: string; sha256: string; sourceCount: number; bytes: number;
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Existing non-mutating quote/comment masker.
const { maskOpaqueSql } = require("../test-support/prepare-exact-staging-bundle.cjs") as { maskOpaqueSql: (sql: string) => string };

declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const sourceBytes = tool.sources.map(([name]) => readFileSync(join(process.cwd(), "supabase/schema", name)));
const bundle = () => tool.prepareReviewPrerequisites();
jest.setTimeout(60000);
beforeEach(async () => { db = createLocalPostgres(); await installPre024ReviewFixture(db); });
afterEach(async () => { await db.close(); });
afterAll(() => {
  for (const [index, [name]] of tool.sources.entries()) {
    expect(readFileSync(join(process.cwd(), "supabase/schema", name))).toEqual(sourceBytes[index]);
  }
});

async function asRole<T>(role: "anon" | "authenticated" | "service_role", user: string | null, action: () => Promise<T>): Promise<T> {
  await db.exec(`begin; set local role ${role}`);
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user ?? ""]);
    expect((await db.query<{ role: string }>("select current_user role")).rows[0].role).toBe(role);
    return await action();
  } finally { await db.exec("rollback"); }
}
const writeReview = (reviewer = f.buyer, creator = f.creator, post: string | null = f.post) => db.query<{ id: string }>(
  `insert into public.reviews(reviewer_id,creator_id,post_id,rating,comment,updated_at)
   values($1,$2,$3,5,'Synthetic combined package review',now()) returning id`, [reviewer, creator, post]);
async function install() { await closeFixturePurchaseWrites(db); await db.exec(bundle().sql); }
const oldRows = async () => (await db.query(`select id,reviewer_id,creator_id,rating,comment,created_at,updated_at
  from public.reviews order by id`)).rows;
const rowCount = async (table: string) => Number((await db.query<{ n: number }>(`select count(*)::integer n from public.${table}`)).rows[0].n);

async function catalogState() {
  const columns = (await db.query<{ attname: string }>(`select attname,format_type(atttypid,atttypmod) type,attnotnull,attacl::text
    from pg_attribute where attrelid='public.reviews'::regclass and attnum>0 and not attisdropped order by attnum`)).rows;
  const constraints = (await db.query(`select conname,pg_get_constraintdef(oid) definition from pg_constraint
    where conrelid='public.reviews'::regclass order by conname`)).rows;
  const indexes = (await db.query(`select indexname,indexdef from pg_indexes where schemaname='public'
    and tablename='reviews' order by indexname`)).rows;
  const policies = (await db.query<{ polname: string }>(`select polname,polcmd,polpermissive,polroles::text,
    pg_get_expr(polqual,polrelid) using_expression,pg_get_expr(polwithcheck,polrelid) check_expression
    from pg_policy where polrelid in ('public.reviews'::regclass,'public.purchases'::regclass) order by polname`)).rows;
  const triggers = (await db.query<{ tgname: string }>(`select tgname,pg_get_triggerdef(oid) definition from pg_trigger
    where tgrelid='public.reviews'::regclass and not tgisinternal order by tgname`)).rows;
  const routines = (await db.query<{ proname: string }>(`select proname,md5(pg_get_functiondef(p.oid)) definition,proacl::text from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in
    ('update_profile_rating','update_reviews_updated_at','can_review_purchased_post','keep_review_identity') order by proname`)).rows;
  const tables = (await db.query<{ relname: string }>(`select relname,relacl::text,relrowsecurity from pg_class
    where oid in ('public.reviews'::regclass,'public.purchases'::regclass) order by relname`)).rows;
  return { columns, constraints, indexes, policies, triggers, routines, tables, rows: await oldRows() };
}

test("preparation pins original sources and preserves all bytes except reviewed outer transaction tokens", () => {
  const a = bundle();
  expect(a).toEqual(bundle()); expect(a.sourceCount).toBe(2);
  expect(a.sha256).toBe(createHash("sha256").update(a.sql).digest("hex"));
  expect(a.bytes).toBe(Buffer.byteLength(a.sql, "utf8"));
  const masked = maskOpaqueSql(a.sql);
  expect(masked.match(/\bbegin\s*;/gi)).toHaveLength(1);
  expect(masked.match(/\bcommit\s*;/gi)).toHaveLength(1);
  expect(masked).not.toMatch(/\b(?:rollback|savepoint|release)\b/i);
  expect(a.sql).toContain("set local lock_timeout = '5s'");
  expect(a.sql).toContain("set local statement_timeout = '30s'");
  for (const source of tool.readSources()) {
    const body = tool.unwrapSource(source.sql.replace(/\r\n/g, "\n"));
    const section = a.sql.split(`-- SOURCE ${source.name} SHA256-LF `)[1];
    expect(section.slice(section.indexOf("\n") + 1).split(`\n-- END SOURCE ${source.name}`)[0]).toBe(body);
  }
  const sources = tool.readSources();
  expect(() => tool.prepareReviewPrerequisites(sources.slice(1))).toThrow("two");
  expect(() => tool.prepareReviewPrerequisites([...sources].reverse())).toThrow("order");
  expect(() => tool.prepareReviewPrerequisites(sources.map((s, i) => i ? s : { ...s, sql: s.sql + "\n-- drift" }))).toThrow("checksum");
  expect(() => tool.unwrapSource("begin; select 1; commit; begin; select 2; commit;")).toThrow("transaction controls");
  expect(() => tool.unwrapSource("select 1; begin; select 2; commit;")).toThrow("outer transaction");
});

test("captured pre-024 shape is represented and unsafe purchase grants abort the combined package without retaining 024", async () => {
  const before = await catalogState();
  expect(before.columns.map(row => row.attname)).toEqual(["id", "reviewer_id", "creator_id", "rating", "comment", "created_at", "updated_at"]);
  expect(before.policies.filter(row => String(row.polname).includes("reviews"))).toHaveLength(4);
  expect((await db.query<{ n: number }>(`select count(*)::integer n from pg_attribute
    where attrelid='public.purchases'::regclass and attnum>0 and not attisdropped`)).rows[0].n).toBe(44);
  await expect(db.exec(bundle().sql)).rejects.toThrow(/purchase evidence is client-writable/);
  await db.exec("rollback");
  expect(await catalogState()).toEqual(before);
});

test("the separate purchase ACL artifact satisfies 026 before the atomic review package, without changing purchase rows", async () => {
  const purchases = (await db.query("select * from public.purchases order by id")).rows;
  const legacy = await oldRows();
  const prerequisite = readFileSync(join(process.cwd(), "docs/staging-purchases-readonly-acl-prerequisite.sql"), "utf8");
  await db.exec(prerequisite);
  await db.exec(bundle().sql);
  expect(await oldRows()).toEqual(legacy);
  expect((await db.query("select * from public.purchases order by id")).rows).toEqual(purchases);
  await asRole("authenticated", f.buyer, async () => { expect((await writeReview()).rows).toHaveLength(1); });
});

test("a committed separate ACL prerequisite remains closed when the following review transaction rolls back late", async () => {
  await db.exec(readFileSync(join(process.cwd(), "docs/staging-purchases-readonly-acl-prerequisite.sql"), "utf8"));
  await db.exec(`create role inherited_review_fixture; grant inherited_review_fixture to authenticated;
    grant truncate on public.reviews to inherited_review_fixture`);
  const before = await catalogState();
  await expect(db.exec(bundle().sql)).rejects.toThrow(/review inherited roles/);
  await db.exec("rollback");
  expect(await catalogState()).toEqual(before);
  expect((await db.query<{ allowed: boolean }>("select has_table_privilege('authenticated','public.purchases','UPDATE') allowed")).rows[0].allowed).toBe(false);
});

test("the actual purchase and rating ACL prerequisites compose with 024/026 while preserving the service API and legacy rows", async () => {
  // Minimal synthetic legacy storage is only for the captured routine definition;
  // this does not reproduce or certify hosted profile_reviews policies or clients.
  await db.exec(`create table public.profile_reviews(profile_id uuid,reviewer_id uuid,rating integer,
    updated_at timestamptz default now(),primary key(profile_id,reviewer_id))`);
  const legacyRoutine = ratingCatalog.routines.find(row => row.signature === "public.set_profile_rating(uuid,uuid,integer)");
  if (!legacyRoutine || createHash("md5").update(legacyRoutine.definition).digest("hex") !== legacyRoutine.definition_fingerprint)
    throw new Error("Legacy rating definition drift");
  await db.exec(legacyRoutine.definition);
  for (const routine of ratingCatalog.routines) {
    expect((await db.query<{ hash: string }>("select md5(pg_get_functiondef($1::regprocedure)) hash", [routine.signature])).rows[0].hash)
      .toBe(routine.definition_fingerprint);
  }
  await db.exec(`grant execute on function public.set_profile_rating(uuid,uuid,integer),public.update_profile_rating(uuid)
    to public,anon,authenticated,postgres,service_role`);
  const legacy = await oldRows();
  const purchases = (await db.query("select * from public.purchases order by id")).rows;
  await db.exec(readFileSync(join(process.cwd(), "docs/staging-purchases-readonly-acl-prerequisite.sql"), "utf8"));
  await db.exec(readFileSync(join(process.cwd(), "docs/staging-rating-acl-prerequisite.sql"), "utf8"));
  await db.exec(bundle().sql);
  expect(await oldRows()).toEqual(legacy);
  expect((await db.query<{ post_id: string | null }>("select post_id from public.reviews")).rows.every(row => row.post_id === null)).toBe(true);
  expect((await db.query("select * from public.purchases order by id")).rows).toEqual(purchases);
  for (const role of ["anon", "authenticated"] as const) {
    for (const sql of ["update public.purchases set status='paid'", "truncate public.reviews"])
      await expect(asRole(role, f.buyer, () => db.exec(sql))).rejects.toThrow(/permission denied/);
    await expect(asRole(role, f.buyer, () => db.query("select * from public.set_profile_rating($1,$2,5)", [f.creator, f.buyer])))
      .rejects.toThrow(/permission denied/);
    await expect(asRole(role, f.buyer, () => db.query("select * from public.update_profile_rating($1)", [f.creator])))
      .rejects.toThrow(/permission denied/);
  }
  await asRole("authenticated", f.buyer, async () => { expect((await writeReview()).rows).toHaveLength(1); });
  await asRole("service_role", null, async () => {
    const review = (await writeReview()).rows[0].id;
    expect((await db.query(`update public.reviews set reviewer_id=$1,creator_id=$2,post_id=$3,
      rating=3,comment='Synthetic service API update',updated_at=now() where id=$4 returning id`,
    [f.buyer, f.creator, f.post, review])).rows).toHaveLength(1);
    expect((await db.query<{ n: number }>("select review_count::integer n from public.update_profile_rating($1)", [f.creator])).rows[0].n).toBe(2);
    expect((await db.query("delete from public.reviews where id=$1 returning id", [review])).rows).toHaveLength(1);
    expect((await db.query<{ n: number }>("select review_count::integer n from public.update_profile_rating($1)", [f.creator])).rows[0].n).toBe(1);
    await db.query(`insert into public.admin_actions(actor_id,action,target_table,target_id,reason)
      values($1,'remove_review','reviews',$2,'Synthetic combined prerequisite moderation')`, [f.creator, review]);
    expect(await rowCount("admin_actions")).toBe(1);
  });
  expect(await oldRows()).toEqual(legacy);
  for (const routine of ratingCatalog.routines) {
    expect((await db.query<{ hash: string }>("select md5(pg_get_functiondef($1::regprocedure)) hash", [routine.signature])).rows[0].hash)
      .toBe(routine.definition_fingerprint);
  }
});

test("024 plus 026 preserves both legacy rows and existing timestamp/rating routines, without touching purchases", async () => {
  const rows = await oldRows();
  await closeFixturePurchaseWrites(db);
  const before = await catalogState();
  const purchases = (await db.query("select * from public.purchases order by id")).rows;
  await db.exec(bundle().sql);
  expect(await oldRows()).toEqual(rows);
  expect((await db.query("select post_id from public.reviews order by id")).rows).toEqual([{ post_id: null }, { post_id: null }]);
  const after = await catalogState();
  expect(after.routines.filter(row => String(row.proname).startsWith("update_"))).toEqual(before.routines);
  expect(after.triggers.find(row => row.tgname === "update_reviews_updated_at")).toEqual(before.triggers[0]);
  expect(after.tables.find(row => row.relname === "purchases")).toEqual(before.tables.find(row => row.relname === "purchases"));
  expect(after.policies.find(row => row.polname === "fixture_buyer_read")).toEqual(before.policies.find(row => row.polname === "fixture_buyer_read"));
  expect((await db.query("select * from public.purchases order by id")).rows).toEqual(purchases);
  await asRole("anon", null, async () => { expect(await rowCount("reviews")).toBe(2); });
});

test("per-post uniqueness permits two purchased offers from one creator alongside the old NULL row, never duplicates", async () => {
  await install();
  await expect(asRole("authenticated", f.buyer, async () => {
    await writeReview(); await writeReview(f.buyer, f.creator, f.sameCreatorPost);
    expect((await db.query("select id from public.reviews where creator_id=$1", [f.creator])).rows).toHaveLength(3);
    await writeReview();
  })).rejects.toThrow(/duplicate key.*reviews_reviewer_post_unique/);
});

test("the 024 post foreign key keeps its cascade while leaving unrelated legacy reviews intact", async () => {
  await install(); await writeReview();
  await db.query("delete from public.posts where id=$1", [f.post]);
  expect(await rowCount("reviews")).toBe(2);
  expect((await db.query<{ post_id: string | null }>("select post_id from public.reviews")).rows.every(row => row.post_id === null)).toBe(true);
});

test("the current API six-field update works and the pre-existing timestamp trigger still runs", async () => {
  await install();
  await asRole("authenticated", f.buyer, async () => {
    const review = (await writeReview()).rows[0].id;
    const result = await db.query<{ updated_at: Date; rating: number }>(`update public.reviews
      set reviewer_id=$1,creator_id=$2,post_id=$3,rating=4,comment='Synthetic edited review',updated_at='2000-01-01T00:00:00Z'
      where id=$4 returning rating,updated_at`, [f.buyer, f.creator, f.post, review]);
    expect(result.rows[0].rating).toBe(4);
    expect(new Date(result.rows[0].updated_at).getUTCFullYear()).toBeGreaterThan(2000);
  });
});

test("unbought, misattributed, self, impersonated and NULL-post direct writes fail even with a broad permissive policy", async () => {
  await db.exec("create policy adversarial_permissive_all on public.reviews for all using(true) with check(true)");
  await db.query(`insert into public.purchases(buyer_id,post_id,product_id,creator_id,status,access_granted)
    select $1,post_id,product_id,creator_id,'paid',true from public.purchases where buyer_id=$2 and post_id=$3`, [f.creator, f.buyer, f.post]);
  await install();
  for (const [user, reviewer, creator, post] of [
    [f.otherBuyer, f.otherBuyer, f.creator, f.post], [f.buyer, f.buyer, f.otherCreator, f.post],
    [f.creator, f.creator, f.creator, f.post], [f.buyer, f.otherBuyer, f.creator, f.post],
    [f.buyer, f.buyer, f.creator, null],
  ]) {
    await expect(asRole("authenticated", user, () => writeReview(reviewer!, creator!, post))).rejects.toThrow(/row-level security/);
  }
});

test.each([[f.sameCreatorPost, f.creator], [f.otherPost, f.otherCreator]])(
  "a qualifying second purchase cannot retarget review identity to %s", async (post, creator) => {
    await install();
    await expect(asRole("authenticated", f.buyer, async () => {
      const review = (await writeReview()).rows[0].id;
      await db.query("update public.reviews set post_id=$1,creator_id=$2 where id=$3", [post, creator, review]);
    })).rejects.toThrow(/identity cannot be changed/);
  });

test("legacy reviews remain owner-deletable but not editable or convertible; another owner cannot delete", async () => {
  await install();
  await asRole("authenticated", f.buyer, async () => {
    expect((await db.query("update public.reviews set post_id=$1,rating=5 where id=$2 returning id", [f.post, f.legacy])).rows).toEqual([]);
    expect((await db.query("delete from public.reviews where id=$1 returning id", [f.otherLegacy])).rows).toEqual([]);
    expect((await db.query("delete from public.reviews where id=$1 returning id", [f.legacy])).rows).toHaveLength(1);
  });
});

test.each(["refunded", "failed"])("%s purchase blocks a new edit but preserves owner deletion", async status => {
  await install(); const review = (await writeReview()).rows[0].id;
  await db.query("update public.purchases set status=$1 where buyer_id=$2 and post_id=$3", [status, f.buyer, f.post]);
  await asRole("authenticated", f.buyer, async () => {
    expect((await db.query("update public.reviews set rating=4 where id=$1 returning id", [review])).rows).toEqual([]);
    expect((await db.query("delete from public.reviews where id=$1 returning id", [review])).rows).toHaveLength(1);
  });
});

test("anonymous writes, authenticated truncation and protected-column changes remain impossible", async () => {
  await install();
  for (const sql of ["truncate public.reviews", "delete from public.reviews", "update public.reviews set rating=1"]) {
    await expect(asRole("anon", null, () => db.exec(sql))).rejects.toThrow(/permission denied/);
  }
  await expect(asRole("anon", null, () => writeReview())).rejects.toThrow(/permission denied/);
  for (const sql of ["truncate public.reviews", "update public.reviews set created_at=now()", "update public.reviews set id=gen_random_uuid()"])
    await expect(asRole("authenticated", f.buyer, () => db.exec(sql))).rejects.toThrow(/permission denied/);
  await expect(asRole("anon", null, () => db.query("select public.can_review_purchased_post($1,$2)", [f.post, f.creator]))).rejects.toThrow(/permission denied/);
  await asRole("authenticated", f.otherBuyer, async () => {
    expect((await db.query<{ ok: boolean }>("select public.can_review_purchased_post($1,$2) ok", [f.post, f.creator])).rows[0].ok).toBe(false);
  });
});

test("service moderation keeps its read/delete/recompute/audit workflow and cannot silently retarget identity", async () => {
  await install();
  await asRole("service_role", null, async () => {
    const rows = (await db.query<{ creator_id: string }>("select creator_id from public.reviews where id=$1", [f.otherLegacy])).rows;
    expect(rows[0].creator_id).toBe(f.otherCreator);
    await db.query("delete from public.reviews where id=$1", [f.otherLegacy]);
    expect((await db.query<{ n: number }>("select review_count::integer n from public.update_profile_rating($1)", [f.otherCreator])).rows[0].n).toBe(0);
    expect((await db.query("select review_count,review_rating::double precision review_rating from public.profiles where id=$1", [f.otherCreator])).rows[0])
      .toMatchObject({ review_count: 0, review_rating: 0 });
    await db.query(`insert into public.admin_actions(actor_id,action,target_table,target_id,reason)
      values($1,'remove_review','reviews',$2,'Synthetic moderation test')`, [f.creator, f.otherLegacy]);
    expect(await rowCount("admin_actions")).toBe(1);
  });
  await expect(asRole("service_role", null, () => db.query("update public.reviews set post_id=$1 where id=$2", [f.post, f.legacy])))
    .rejects.toThrow(/identity cannot be changed/);
});

test.each(["truncate", "update(id)"])("late 026 inherited %s failure rolls back 024, all review DDL/grants and existing data", async privilege => {
  await closeFixturePurchaseWrites(db);
  await db.exec(`create role inherited_review_fixture; grant inherited_review_fixture to authenticated;
    grant ${privilege} on public.reviews to inherited_review_fixture`);
  const before = await catalogState();
  await expect(db.exec(bundle().sql)).rejects.toThrow(/review inherited roles/);
  await db.exec("rollback");
  expect(await catalogState()).toEqual(before);
  expect((await db.query<{ added: string | null }>("select to_regclass('public.reviews_reviewer_post_unique') added")).rows[0].added).toBeNull();
});

test("the combined package refuses reapplication without replacing the successful result", async () => {
  await install(); const before = await catalogState();
  await expect(db.exec(bundle().sql)).rejects.toThrow(/captured pre-024 shape/); await db.exec("rollback");
  expect(await catalogState()).toEqual(before);
});
