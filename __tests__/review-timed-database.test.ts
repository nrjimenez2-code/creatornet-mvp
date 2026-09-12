/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import originals from "../test-support/review-helper-baselines-20260910.json";
declare const createLocalPostgres: () => PGlite;
const migration = readFileSync(join(process.cwd(), "supabase/schema/101-purchase-review-entitlements-STAGED.sql"), "utf8");
const buyer = "11111111-1111-4111-8111-111111111111", creator = "22222222-2222-4222-8222-222222222222";
const other = "99999999-9999-4999-8999-999999999999", post = "33333333-3333-4333-8333-333333333333", purchase = "44444444-4444-4444-8444-444444444444";
let db: PGlite;
// These SQL adapters isolate the review/RLS contract. Their denial/allowance
// shapes mirror the unchanged real readers, tested in the payment suites.
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema private;
    grant usage on schema public,private,auth to anon,authenticated,service_role;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table public.posts(id uuid,creator_id uuid);
    create table public.purchases(id uuid,buyer_id uuid,post_id uuid,status text,access_granted boolean,fixed jsonb,monthly jsonb);
    create table public.fixed_purchase_service_contracts_v1(id uuid);create table public.monthly_mentorship_agreements_v1(id uuid);
    create function public.read_fixed_service_entitlement_v1(p_purchase_id uuid,p_buyer_id uuid) returns jsonb
      language sql security definer set search_path=pg_catalog as $$select fixed from public.purchases where id=p_purchase_id and buyer_id=p_buyer_id$$;
    create function public.read_monthly_mentorship_entitlement_v1(p_purchase_id uuid,p_buyer_id uuid) returns jsonb
      language sql security definer set search_path=pg_catalog as $$select monthly from public.purchases where id=p_purchase_id and buyer_id=p_buyer_id$$;
    revoke all on function public.read_fixed_service_entitlement_v1(uuid,uuid),public.read_monthly_mentorship_entitlement_v1(uuid,uuid) from public,anon,authenticated,service_role;
    grant execute on function public.read_fixed_service_entitlement_v1(uuid,uuid),public.read_monthly_mentorship_entitlement_v1(uuid,uuid) to service_role;`);
  for (const f of originals) {
    await db.exec(f.definition);
    await db.exec(`revoke all on function ${f.signature} from public,anon,authenticated,service_role;grant execute on function ${f.signature} to authenticated;`);
    if (f.signature.startsWith("private.")) await db.exec(`grant execute on function ${f.signature} to service_role`);
  }
  await db.exec(migration);
  await db.exec(`create table public.reviews(reviewer_id uuid,creator_id uuid,post_id uuid);
    alter table public.reviews enable row level security;grant insert,select on public.reviews to authenticated;
    create policy review_owner on public.reviews for insert to authenticated with check(reviewer_id=auth.uid() and public.can_review_purchased_post(post_id,creator_id));
    insert into public.posts values('${post}','${creator}');
    insert into public.purchases values('${purchase}','${buyer}','${post}','active',false,'{"applicable":false,"allowed":false,"maxAgeSeconds":0}','{"allowed":true,"maxAgeSeconds":30}');`);
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.exec("begin"); await db.query("select set_config('request.jwt.claim.sub',$1,true)", [buyer]); });
afterEach(async () => { await db.exec("rollback"); });
const helpers = async (owner = creator, offer = post, actualBuyer = buyer) => (await db.query<{ staging: boolean; production: boolean }>(
  "select public.can_review_purchased_post($1,$2) staging,private.has_live_purchase_of_post($3,$1,$2) production", [offer, owner, actualBuyer])).rows[0];
test("both observed helpers allow owned current monthly service with legacy access false", async () => {
  await db.exec("set local role authenticated");expect(await helpers()).toEqual({ staging: true, production: true });
  await db.query("insert into public.reviews values($1,$2,$3)", [buyer, creator, post]);
});
test("fixed entitlement wins without monthly fallback", async () => {
  await db.exec(`update public.purchases set fixed='{"applicable":true,"allowed":true,"maxAgeSeconds":19}',monthly=null`);
  await db.exec("set local role authenticated");expect(await helpers()).toEqual({ staging: true, production: true });
});
test.each(["expired", "disputed", "unpaid", "refunded"])("a reader's %s denial blocks both helpers and RLS writes", async () => {
  await db.exec(`update public.purchases set fixed='{"applicable":true,"allowed":false,"maxAgeSeconds":0}'`);
  await db.exec("set local role authenticated");expect(await helpers()).toEqual({ staging: false, production: false });
  await expect(db.query("insert into public.reviews values($1,$2,$3)", [buyer, creator, post])).rejects.toThrow(/row-level security/);
});
test.each([null, "refunded", "failed"])("status %s denies even a positive reader", async status => {
  await db.query("update public.purchases set status=$1", [status]);expect(await helpers()).toEqual({ staging: false, production: false });
});
test.each([null, {}, { allowed: true, maxAgeSeconds: 0 }, { allowed: true, maxAgeSeconds: 3601 }, { allowed: true, maxAgeSeconds: 0.5 }, { allowed: true, maxAgeSeconds: "20" }])(
  "malformed monthly result %p fails closed", async value => {
    await db.query("update public.purchases set monthly=$1", [value === null ? null : JSON.stringify(value)]);
    expect(await helpers()).toEqual({ staging: false, production: false });
  });
test("caller identity, self-review and post/creator fences are preserved", async () => {
  expect(await helpers(other)).toEqual({ staging: false, production: false });
  expect(await helpers(creator, other)).toEqual({ staging: false, production: false });
  expect((await helpers(creator, post, other)).production).toBe(false);
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [other]);expect(await helpers()).toEqual({ staging: false, production: false });
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [creator]);expect(await helpers()).toEqual({ staging: false, production: false });
});
test("legacy paid access and NULL-post labels remain a caller-side concern", async () => {
  await db.exec(`update public.purchases set access_granted=true,status='paid',monthly='{"allowed":true,"maxAgeSeconds":3600}'`);
  expect(await helpers()).toEqual({ staging: true, production: true });
  expect((await db.query<{ ok: boolean }>("select public.can_review_purchased_post(null,$1) ok", [creator])).rows[0].ok).toBe(false);
});
test("wrapper grants remain unchanged and no new API exposes purchases or internal readers", async () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    expect((await db.query<{ ok: boolean }>("select has_function_privilege($1,'public.review_purchase_entitled_v1(uuid,uuid)','execute') ok", [role])).rows[0].ok).toBe(false);
  }
  expect((await db.query<{ acl: string }>("select proacl::text acl from pg_proc where oid='public.can_review_purchased_post(uuid,uuid)'::regprocedure")).rows[0].acl).toBe("{postgres=X/postgres,authenticated=X/postgres}");
  expect((await db.query<{ acl: string }>("select proacl::text acl from pg_proc where oid='private.has_live_purchase_of_post(uuid,uuid,uuid)'::regprocedure")).rows[0].acl).toBe("{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}");
  expect((await db.query<{ ok: boolean }>("select has_table_privilege('authenticated','public.purchases','select') ok")).rows[0].ok).toBe(false);
});
test("the source guard refuses replay without replacing unknown state", async () => { await expect(db.exec(migration)).rejects.toThrow(/already exists/); });
