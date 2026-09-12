/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import catalog from "../test-support/staging-rating-catalog-20260908.json";

declare const createLocalPostgres: () => PGlite;
const sql = readFileSync(join(process.cwd(), "docs/staging-rating-acl-prerequisite.sql"), "utf8");
const rpcSignatures = catalog.routines.slice(0, 2).map((r) => r.signature);
const buyer = "91000000-0000-4000-8000-000000000001";
const creator = "91000000-0000-4000-8000-000000000002";
const anotherBuyer = "91000000-0000-4000-8000-000000000003";
let db: PGlite;
jest.setTimeout(60000);

beforeEach(async () => {
  db = createLocalPostgres();
  // Exact hosted routine definitions; synthetic tables/auth/rows only. This is
  // an ACL/body-preservation test, not a full hosted schema/restore replica.
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to anon,authenticated,service_role;
    create table public.profiles(id uuid primary key,review_rating numeric,review_count bigint);
    create table public.profile_reviews(profile_id uuid,reviewer_id uuid,rating integer,
      updated_at timestamptz default now(),primary key(profile_id,reviewer_id));
    create table public.reviews(id uuid primary key,reviewer_id uuid,creator_id uuid,
      rating integer,comment text,created_at timestamptz,updated_at timestamptz);
    alter table public.reviews enable row level security;
    create policy fixture_read on public.reviews for select using(true);
    grant all on public.profiles,public.profile_reviews,public.reviews to service_role;
    grant select on public.reviews to anon,authenticated;
    create function public.unrelated_rating_fixture() returns integer language sql as $$select 7$$;
    grant execute on function public.unrelated_rating_fixture() to anon,authenticated,service_role;
    insert into public.profiles values('${creator}',4,1),('${buyer}',null,null);
    insert into public.profile_reviews(profile_id,reviewer_id,rating,updated_at)
      values('${creator}','${buyer}',2,'2026-01-01T00:00:00Z');
    insert into public.reviews values('91000000-0000-4000-8000-000000000004','${buyer}',
      '${creator}',4,'Synthetic legacy review','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z');
  `);
  for (const routine of catalog.routines) await db.exec(routine.definition);
  for (const signature of rpcSignatures) {
    await db.exec(`grant execute on function ${signature} to public,anon,authenticated,service_role`);
  }
  await db.exec(`create trigger update_reviews_updated_at before update on public.reviews
    for each row execute function public.update_reviews_updated_at()`);
});
afterEach(async () => { await db?.close(); });

async function functionState() {
  return (await db.query<Record<string, unknown>>(`select p.oid,p.proname,pg_get_functiondef(p.oid) definition,
    p.proowner,p.prosecdef,p.proconfig,p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' order by p.proname`)).rows;
}
async function preservedState() {
  return {
    profiles: (await db.query("select * from public.profiles order by id")).rows,
    legacyRatings: (await db.query("select * from public.profile_reviews order by profile_id,reviewer_id")).rows,
    reviews: (await db.query("select * from public.reviews order by id")).rows,
    tableAcl: (await db.query(`select c.relname,c.relowner,c.relacl::text,c.relrowsecurity from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname`)).rows,
    policies: (await db.query("select to_jsonb(p) state from pg_policy p order by oid")).rows,
    triggers: (await db.query("select to_jsonb(t) state from pg_trigger t where not tgisinternal order by oid")).rows,
  };
}
async function canExecute(role: string, signature: string) {
  return (await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0].allowed;
}
async function expectRejectedUnchanged(message: RegExp) {
  const beforeFunctions = await functionState();
  const beforeOther = await preservedState();
  await expect(db.exec(sql)).rejects.toThrow(message);
  await db.exec("rollback");
  expect(await functionState()).toEqual(beforeFunctions);
  expect(await preservedState()).toEqual(beforeOther);
}

test("all three saved definitions and locally reconstructed catalog hashes match the pinned hosted baseline", async () => {
  expect(catalog.routines).toHaveLength(3);
  expect(catalog.source_project).toBe("nwqfofezfzljhxolkycz");
  expect(catalog.transaction_read_only).toBe("on");
  for (const routine of catalog.routines) {
    expect(createHash("md5").update(routine.definition, "utf8").digest("hex")).toBe(routine.definition_fingerprint);
    const row = (await db.query<{ fingerprint: string }>("select md5(pg_get_functiondef($1::regprocedure)) fingerprint", [routine.signature])).rows[0];
    expect(row.fingerprint).toBe(routine.definition_fingerprint);
    expect(sql).toContain(`'${routine.signature}','${routine.definition_fingerprint}'`);
  }
});

test("only the two client RPC ACLs change; exact bodies, owners, trigger, rows and table policies survive replay", async () => {
  const beforeFunctions = await functionState();
  const beforeOther = await preservedState();
  await db.exec(sql);
  const first = await functionState();
  await db.exec(sql);
  expect(await functionState()).toEqual(first);
  expect(await preservedState()).toEqual(beforeOther);
  for (const previous of beforeFunctions) {
    const current = first.find((r) => r.oid === previous.oid)!;
    if (["set_profile_rating", "update_profile_rating"].includes(String(previous.proname))) {
      expect({ ...current, acl: previous.acl }).toEqual(previous);
    } else expect(current).toEqual(previous);
  }
  for (const signature of rpcSignatures) {
    expect(await canExecute("anon", signature)).toBe(false);
    expect(await canExecute("authenticated", signature)).toBe(false);
    expect(await canExecute("service_role", signature)).toBe(true);
  }
});

test.each(["anon", "authenticated"])("%s cannot invoke either exact RPC after the prerequisite", async (role) => {
  await db.exec(sql);
  const before = await preservedState();
  await db.exec(`set role ${role}`);
  try {
    await expect(db.query("select * from public.set_profile_rating($1,$2,5)", [creator, buyer])).rejects.toThrow(/permission denied for function set_profile_rating/);
    await expect(db.query("select * from public.update_profile_rating($1)", [creator])).rejects.toThrow(/permission denied for function update_profile_rating/);
  } finally { await db.exec("reset role"); }
  expect(await preservedState()).toEqual(before);
});

test("service-role review aggregate update used by submit/admin moderation still runs", async () => {
  await db.exec(sql);
  await db.exec("set role service_role");
  try {
    const rating = (await db.query<{ avg_rating: string; review_count: number }>("select * from public.update_profile_rating($1)", [creator])).rows[0];
    expect(Number(rating.avg_rating)).toBe(4);
    expect(Number(rating.review_count)).toBe(1);
    await db.query("delete from public.reviews where creator_id=$1", [creator]);
    const empty = (await db.query<{ avg_rating: string; review_count: number }>("select * from public.update_profile_rating($1)", [creator])).rows[0];
    expect(Number(empty.avg_rating)).toBe(0);
    expect(Number(empty.review_count)).toBe(0);
  } finally { await db.exec("reset role"); }
});

test("retained service legacy routine still derives identity from auth.uid, never the supplied reviewer", async () => {
  await db.exec(sql);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [buyer]);
  await db.exec("set role service_role");
  try {
    await db.query("select * from public.set_profile_rating($1,$2,3)", [creator, anotherBuyer]);
  } finally { await db.exec("reset role"); }
  expect((await db.query("select reviewer_id,rating from public.profile_reviews order by reviewer_id")).rows).toEqual([{ reviewer_id: buyer, rating: 3 }]);
});

test.each([0, 1, 2])("definition drift of reviewed routine %i aborts before any revocation", async (index) => {
  await db.exec(catalog.routines[index].definition.replace("$function$", "$function$\n-- synthetic definition drift\n"));
  await expectRejectedUnchanged(/definition\/owner drift/);
});

test("an unexpected overload is not silently left as another direct-client entry point", async () => {
  await db.exec("create function public.set_profile_rating(uuid) returns integer language sql as $$select 1$$");
  await expectRejectedUnchanged(/unreviewed routine overload/);
});

test("unknown direct grant or grant option is rejected rather than silently broadened or removed", async () => {
  await db.exec("grant execute on function public.update_profile_rating(uuid) to authenticated with grant option");
  await expectRejectedUnchanged(/unreviewed ACL drift/);
});

test("missing direct service grant is rejected even if PUBLIC currently supplies effective access", async () => {
  await db.exec("revoke execute on function public.update_profile_rating(uuid) from service_role");
  expect(await canExecute("service_role", rpcSignatures[1])).toBe(true);
  await expectRejectedUnchanged(/unreviewed ACL drift/);
});

test("unexpected inherited role membership fails before revocation and preserves memberships", async () => {
  await db.exec("grant service_role to authenticated");
  const memberships = (await db.query("select to_jsonb(m) state from pg_auth_members m order by roleid,member")).rows;
  await expectRejectedUnchanged(/unreviewed client role membership/);
  expect((await db.query("select to_jsonb(m) state from pg_auth_members m order by roleid,member")).rows).toEqual(memberships);
});

test("NOINHERIT but SET-able service role is rejected even after both direct RPC ACLs are repaired", async () => {
  await db.exec(sql);
  await db.exec("grant service_role to authenticated with inherit false, set true");
  expect(await canExecute("authenticated", rpcSignatures[0])).toBe(false);
  const memberships = (await db.query<{ usage: boolean; can_set: boolean }>(
    "select pg_has_role('authenticated','service_role','USAGE') usage,pg_has_role('authenticated','service_role','SET') can_set")).rows[0];
  expect(memberships).toEqual({ usage: false, can_set: true });
  await expectRejectedUnchanged(/unreviewed client role membership/);
});

test.each([false, true])("partial ACL drift is rejected atomically (already replayed: %s)", async (alreadyRepaired) => {
  if (alreadyRepaired) {
    await db.exec(sql);
    await db.exec("grant execute on function public.update_profile_rating(uuid) to authenticated");
  } else await db.exec("revoke execute on function public.update_profile_rating(uuid) from anon");
  await expectRejectedUnchanged(/unreviewed ACL drift/);
});

test("deliberately induced late grant drift rolls back both revokes and the injected change", async () => {
  const beforeFunctions = await functionState();
  const beforeOther = await preservedState();
  const afterRevokes = "revoke execute on function public.update_profile_rating(uuid) from public,anon,authenticated;";
  expect(sql.split(afterRevokes)).toHaveLength(2);
  // Test-only fault injection after both real REVOKEs: preserve every guard and
  // transaction boundary, then prove the final effective-access check aborts.
  const lateFault = sql.replace(afterRevokes, `${afterRevokes}\n grant execute on function public.update_profile_rating(uuid) to authenticated;`);
  await expect(db.exec(lateFault)).rejects.toThrow(/postcondition failed; review inherited roles/);
  await db.exec("rollback");
  expect(await functionState()).toEqual(beforeFunctions);
  expect(await preservedState()).toEqual(beforeOther);
});

test("non-owner execution fails closed and cannot mutate either ACL", async () => {
  const before = await functionState();
  await db.exec("set role authenticated");
  await expect(db.exec(sql)).rejects.toThrow(/reviewed postgres migration owner/);
  await db.exec("rollback; reset role");
  expect(await functionState()).toEqual(before);
});

test("candidate has two explicit EXECUTE revokes, no routine replacement or table/row mutations", () => {
  const commands = sql.replace(/--[^\n]*/g, "");
  expect(commands.match(/revoke execute on function/g)).toHaveLength(2);
  expect(commands).not.toMatch(/\b(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:function|table|policy|trigger)|\b(?:insert\s+into|update\s+public\.|delete\s+from|grant\s+execute)\b/i);
});
