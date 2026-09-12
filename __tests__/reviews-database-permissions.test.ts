/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

declare const createLocalPostgres: () => PGlite;
const migration = readFileSync(join(process.cwd(), "supabase/schema/026-reviews-require-purchase-STAGED.sql"), "utf8");
const perPost = readFileSync(join(process.cwd(), "supabase/schema/024-reviews-per-post-STAGED.sql"), "utf8");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const buyer = id(1), otherBuyer = id(2), creator = id(3), otherCreator = id(4), post = id(11), otherPost = id(12);
let db: PGlite;
jest.setTimeout(60000);

// A minimal synthetic schema matching the review/purchase columns used by the
// migration, not a hosted dump. Real role switching is essential: setting a JWT
// claim while remaining the superuser would silently bypass every RLS policy.
beforeEach(async () => {
  db = createLocalPostgres();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create table public.posts(id uuid primary key,creator_id uuid);
    create table public.purchases(id uuid primary key default gen_random_uuid(),buyer_id uuid,
      post_id uuid references public.posts(id),access_granted boolean,status text);
    alter table public.purchases enable row level security;
    -- No purchase permissions for clients: eligibility must not require them.
    grant all on public.purchases,public.posts to service_role;
    create table public.reviews(id uuid primary key default gen_random_uuid(),reviewer_id uuid not null,
      creator_id uuid not null,rating integer not null check(rating between 1 and 5),
      comment text not null check(char_length(comment) between 10 and 1000),
      created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
      unique(reviewer_id,creator_id));
    alter table public.reviews enable row level security;
    create policy "Anyone can read reviews" on public.reviews for select using(true);
    create policy "Users can insert their own reviews" on public.reviews for insert with check(auth.uid()=reviewer_id);
    create policy "Users can update their own reviews" on public.reviews for update using(auth.uid()=reviewer_id)
      with check(auth.uid()=reviewer_id);
    create policy "Users can delete their own reviews" on public.reviews for delete using(auth.uid()=reviewer_id);
    grant all on public.reviews to anon,authenticated,service_role;
    grant update(id),insert(created_at),references(creator_id) on public.reviews to public,anon,authenticated;
    insert into public.posts values('${post}','${creator}'),('${otherPost}','${otherCreator}');
    insert into public.purchases(buyer_id,post_id,access_granted,status) values('${buyer}','${post}',true,'paid');
  `);
  await db.exec(perPost);
});
afterEach(async () => { await db?.close(); });

async function asClient<T>(role: "anon" | "authenticated", user: string | null, action: () => Promise<T>): Promise<T> {
  await db.exec(`begin; set local role ${role}`);
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user ?? ""]);
    return await action();
  } finally { await db.exec("rollback"); }
}
const writeReview = (reviewer = buyer, owner = creator, offer: string | null = post) => db.query<{ id: string; rating: number; post_id: string | null }>(`
  insert into public.reviews(reviewer_id,creator_id,post_id,rating,comment,updated_at)
  values($1,$2,$3,5,'Synthetic review only',now()) returning id,rating,post_id`, [reviewer, owner, offer]);
const seedReview = async (reviewer = buyer, owner = creator, offer: string | null = post) => {
  const result = await writeReview(reviewer, owner, offer);
  return String(result.rows[0].id);
};
const helper = (offer = post, owner = creator) => db.query<{ ok: boolean }>(
  "select public.can_review_purchased_post($1::uuid,$2::uuid) ok", [offer, owner]);

test("grants only existing API columns; strips table/column write drift and preserves server/public reads", async () => {
  await migrationPass();
  for (const role of ["anon", "authenticated"]) {
    for (const privilege of ["INSERT", "UPDATE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]) {
      expect((await db.query<{ ok: boolean }>("select has_table_privilege($1,'public.reviews',$2) ok", [role, privilege])).rows[0].ok).toBe(false);
    }
    for (const col of ["id", "created_at"]) {
      expect((await db.query<{ ok: boolean }>("select has_column_privilege($1,'public.reviews',$2,'UPDATE') ok", [role, col])).rows[0].ok).toBe(false);
    }
    expect((await db.query<{ ok: boolean }>("select has_table_privilege($1,'public.purchases','SELECT') ok", [role])).rows[0].ok).toBe(false);
  }
  expect((await db.query<{ ok: boolean }>("select has_column_privilege('authenticated','public.reviews','reviewer_id','UPDATE') ok")).rows[0].ok).toBe(true);
  expect((await db.query<{ ok: boolean }>("select has_table_privilege('service_role','public.reviews','INSERT,UPDATE,DELETE,SELECT') ok")).rows[0].ok).toBe(true);
  expect((await db.query("select polname from pg_policy where polrelid='public.reviews'::regclass and polcmd='r'")).rows)
    .toEqual([{ polname: "Anyone can read reviews" }]);
});
const migrationPass = () => db.exec(migration);

test.each(["paid", "active", "complete"])("purchase status %s supports inserts and current API unchanged-identity updates", async status => {
  await db.query("update public.purchases set status=$1", [status]);
  await migrationPass();
  await asClient("authenticated", buyer, async () => {
    expect((await helper()).rows[0].ok).toBe(true);
    const inserted = await writeReview();
    const updated = await db.query(`update public.reviews set reviewer_id=$1,creator_id=$2,post_id=$3,
      rating=4,comment='Updated synthetic review',updated_at=now() where id=$4 returning rating`,
      [buyer, creator, post, inserted.rows[0].id]);
    expect(updated.rows).toEqual([{ rating: 4 }]);
  });
});

test.each([["refunded", true], ["failed", true], [null, true], ["paid", false], ["active", false]])(
  "status %s / access %s denies insert and editing old reviews, but allows owner deletion", async (status, access) => {
    const review = await seedReview();
    await db.query("update public.purchases set status=$1,access_granted=$2", [status, access]);
    await migrationPass();
    await asClient("authenticated", buyer, async () => {
      expect((await helper()).rows[0].ok).toBe(false);
      expect((await db.query("update public.reviews set rating=4 where id=$1 returning id", [review])).rows).toEqual([]);
      expect((await db.query("delete from public.reviews where id=$1 returning id", [review])).rows).toHaveLength(1);
    });
    await expect(asClient("authenticated", buyer, () => writeReview())).rejects.toThrow(/row-level security/);
  });

test("eligibility depends only on purchase access/status, not new amount/collection conditions", async () => {
  // The review gate deliberately consumes authoritative purchase state, not
  // refund amounts, installment paid_count, collection holds or invoice totals.
  await db.exec("update public.purchases set status='active',access_granted=true");
  await migrationPass();
  await asClient("authenticated", buyer, async () => {
    expect((await writeReview()).rows).toHaveLength(1);
  });
});

test("caller-bound helper cannot query another buyer and cannot be redirected through search_path", async () => {
  await migrationPass();
  await asClient("authenticated", otherBuyer, async () => {
    expect((await helper()).rows[0].ok).toBe(false);
    expect((await helper(post, buyer)).rows[0].ok).toBe(false);
  });
  expect((await db.query(`select proname,prosecdef,proconfig from pg_proc
    where oid='public.can_review_purchased_post(uuid,uuid)'::regprocedure`)).rows)
    .toEqual([{ proname: "can_review_purchased_post", prosecdef: true, proconfig: ["search_path=pg_catalog"] }]);
  expect((await db.query<{ legacy: string | null }>("select to_regprocedure('public.has_live_purchase_of_post(uuid,uuid)') legacy")).rows[0].legacy).toBeNull();
  await db.exec(`create temp table purchases(buyer_id uuid,post_id uuid,access_granted boolean,status text);
    insert into purchases values('${otherBuyer}','${post}',true,'paid'); grant select on purchases to authenticated;`);
  await asClient("authenticated", otherBuyer, async () => {
    await db.exec("set local search_path=pg_temp,public");
    expect((await helper()).rows[0].ok).toBe(false);
  });
  await expect(asClient("anon", null, () => helper())).rejects.toThrow(/permission denied/);
  await asClient("authenticated", null, async () => { expect((await helper()).rows[0].ok).toBe(false); });
});

test("broad permissive ALL policy cannot bypass purchase, reviewer, creator ownership, self or NULL-post fences", async () => {
  await db.exec("create policy unexpected_permissive_all on public.reviews for all using(true) with check(true)");
  await db.exec(`insert into public.purchases(buyer_id,post_id,access_granted,status) values('${creator}','${post}',true,'paid')`);
  await migrationPass();
  for (const [user, reviewer, owner, offer] of [
    [otherBuyer, otherBuyer, creator, post], [buyer, otherBuyer, creator, post],
    [buyer, buyer, otherCreator, post], [creator, creator, creator, post],
    [buyer, buyer, creator, null], [buyer, buyer, otherCreator, otherPost],
  ]) {
    await expect(asClient("authenticated", user, () => writeReview(reviewer!, owner!, offer))).rejects.toThrow(/row-level security/);
  }
  const review = await seedReview();
  await asClient("authenticated", otherBuyer, async () => {
    expect((await db.query("update public.reviews set rating=4 where id=$1 returning id", [review])).rows).toEqual([]);
    expect((await db.query("delete from public.reviews where id=$1 returning id", [review])).rows).toEqual([]);
  });
  await expect(asClient("authenticated", buyer, () => db.query(
    "update public.reviews set creator_id=$1 where id=$2", [otherCreator, review]))).rejects.toThrow(/identity cannot be changed/);
  await expect(asClient("authenticated", buyer, () => db.query(
    "update public.reviews set reviewer_id=$1 where id=$2", [otherBuyer, review]))).rejects.toThrow(/identity cannot be changed/);
});

test("even two qualifying purchases cannot move an existing review to another offer or creator", async () => {
  const sameCreatorPost = id(13);
  await db.exec(`insert into public.posts values('${sameCreatorPost}','${creator}');
    insert into public.purchases(buyer_id,post_id,access_granted,status) values
      ('${buyer}','${otherPost}',true,'paid'),('${buyer}','${sameCreatorPost}',true,'active');`);
  const review = await seedReview(); await migrationPass();
  for (const [offer, owner] of [[otherPost, otherCreator], [sameCreatorPost, creator]]) {
    await expect(asClient("authenticated", buyer, () => db.query(
      "update public.reviews set post_id=$1,creator_id=$2 where id=$3", [offer, owner, review]))).rejects.toThrow(/identity cannot be changed/);
  }
  expect((await db.query("select post_id,creator_id from public.reviews where id=$1", [review])).rows)
    .toEqual([{ post_id: post, creator_id: creator }]);
  // Even a trusted data writer must not silently reassign rating identity.
  await db.exec("begin; set local role service_role");
  await expect(db.query("update public.reviews set post_id=$1,creator_id=$2 where id=$3", [otherPost, otherCreator, review])).rejects.toThrow(/identity cannot be changed/);
  await db.exec("rollback");
});

test("legacy NULL-post rows remain publicly readable and owner-deletable, not editable or convertible", async () => {
  const legacy = await seedReview(buyer, creator, null);
  await migrationPass();
  await asClient("anon", null, async () => {
    expect((await db.query("select id from public.reviews where id=$1", [legacy])).rows).toHaveLength(1);
  });
  await asClient("authenticated", buyer, async () => {
    expect((await db.query("update public.reviews set rating=4,post_id=$1 where id=$2 returning id", [post, legacy])).rows).toEqual([]);
    expect((await db.query("delete from public.reviews where id=$1 returning id", [legacy])).rows).toHaveLength(1);
  });
  expect((await db.query("select id from public.reviews where id=$1", [legacy])).rows).toHaveLength(1); // client test rolled back
});

test("direct anonymous writes and authenticated TRUNCATE/identity-admin columns are denied", async () => {
  const review = await seedReview(); await migrationPass();
  for (const sql of ["truncate public.reviews", "delete from public.reviews", "update public.reviews set rating=1"]) {
    await expect(asClient("anon", null, () => db.exec(sql))).rejects.toThrow(/permission denied/);
  }
  await expect(asClient("anon", null, () => writeReview())).rejects.toThrow(/permission denied/);
  await expect(asClient("authenticated", buyer, () => db.exec("truncate public.reviews"))).rejects.toThrow(/permission denied/);
  await expect(asClient("authenticated", buyer, () => db.query("update public.reviews set id=$1 where id=$2", [id(90), review]))).rejects.toThrow(/permission denied/);
  await expect(asClient("authenticated", buyer, () => db.exec("update public.reviews set created_at=now()"))).rejects.toThrow(/permission denied/);
});

test.each([
  ["alter table public.reviews disable row level security", "RLS-enabled"],
  ["alter table public.reviews add column unreviewed text", "unexpected review columns"],
  ["drop index public.reviews_reviewer_post_unique", "unique index"],
  ["grant update(access_granted) on public.purchases to authenticated", "purchase evidence has client column writes"],
  ['alter policy "Users can insert their own reviews" on public.reviews with check(auth.uid()=reviewer_id and rating>=4)', "policy expressions missing or changed"],
  ['alter policy "Users can update their own reviews" on public.reviews using(auth.uid()=reviewer_id and rating>=4)', "policy expressions missing or changed"],
  ["create function public.has_live_purchase_of_post(uuid,uuid) returns boolean language sql as $$select true$$", "helper already exists"],
  ["create policy reviews_owner_delete on public.reviews for delete using(true)", "policy name collision"],
])("preflight refuses drift without committing partial changes: %s", async (drift, expected) => {
  await db.exec(drift);
  const policiesBefore = (await db.query(`select polname,pg_get_expr(polqual,polrelid) using_expression,
    pg_get_expr(polwithcheck,polrelid) check_expression from pg_policy where polrelid='public.reviews'::regclass order by polname`)).rows;
  await expect(migrationPass()).rejects.toThrow(expected); await db.exec("rollback");
  expect((await db.query<{ helper: string | null }>("select to_regprocedure('public.can_review_purchased_post(uuid,uuid)') helper")).rows[0].helper).toBeNull();
  expect((await db.query<{ ok: boolean }>("select has_table_privilege('authenticated','public.reviews','TRUNCATE') ok")).rows[0].ok).toBe(true);
  expect((await db.query(`select polname,pg_get_expr(polqual,polrelid) using_expression,
    pg_get_expr(polwithcheck,polrelid) check_expression from pg_policy where polrelid='public.reviews'::regclass order by polname`)).rows).toEqual(policiesBefore);
});

test.each([
  "create role inherited_fixture; grant inherited_fixture to authenticated; grant truncate on public.reviews to inherited_fixture",
  "create role inherited_fixture; grant inherited_fixture to authenticated; grant update(id) on public.reviews to inherited_fixture",
])("unreviewed inherited privileges abort even after DDL; original grants, policies and rows are restored", async drift => {
  const review = await seedReview(); await db.exec(drift);
  await expect(migrationPass()).rejects.toThrow(/review inherited roles/); await db.exec("rollback");
  expect((await db.query<{ helper: string | null }>("select to_regprocedure('public.can_review_purchased_post(uuid,uuid)') helper")).rows[0].helper).toBeNull();
  expect((await db.query("select id from public.reviews")).rows).toEqual([{ id: review }]);
  expect((await db.query<{ ok: boolean }>("select has_table_privilege('anon','public.reviews','INSERT') ok")).rows[0].ok).toBe(true);
});

test("server permissions relying on PUBLIC fail atomically instead of silently being removed", async () => {
  await db.exec("revoke select on public.reviews from service_role; grant select on public.reviews to public");
  await expect(migrationPass()).rejects.toThrow(/server permission lost/); await db.exec("rollback");
  expect((await db.query<{ helper: string | null }>("select to_regprocedure('public.can_review_purchased_post(uuid,uuid)') helper")).rows[0].helper).toBeNull();
});

test("reapplication fails closed and leaves the first successful migration intact", async () => {
  await migrationPass(); await expect(migrationPass()).rejects.toThrow(/helper already exists/); await db.exec("rollback");
  await asClient("authenticated", buyer, async () => { expect((await writeReview()).rows).toHaveLength(1); });
});
