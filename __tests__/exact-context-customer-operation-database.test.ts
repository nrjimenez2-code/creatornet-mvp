/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { installStagingStructuralBaseline, installExactMigrationsInMemory } from "../test-support/staging-catalog-postgres";
import manifest from "../test-support/exact-staging-bundle-manifest.json";
import { buildExactContextCustomerPlan, readExactContextCustomerIntent } from "../lib/installments/contextBootstrap";
import { createExactContextBootstrapPlanner, type ExactContextRuntimeConfig } from "../lib/installments/contextRuntime";

declare const createLocalPostgres: () => PGlite;
jest.setTimeout(120000);
const sql058 = readFileSync(join(process.cwd(), "supabase/proposals/058-payment-context-reservations.sql"), "utf8");
const sql059 = readFileSync(join(process.cwd(), "supabase/proposals/059-context-customer-operation-plans.sql"), "utf8");
const ids = { buyer: "11111111-1111-4111-8111-111111111111", creator: "22222222-2222-4222-8222-222222222222",
  product: "33333333-3333-4333-8333-333333333333", post: "44444444-4444-4444-8444-444444444444",
  booking: "55555555-5555-4555-8555-555555555555", absent: "66666666-6666-4666-8666-666666666666" };
const context = { version: "exact-payment-context-v1", mode: "test", platformAccountId: "acct_LocalPlanOnly",
  supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa", siteOrigin: "https://synthetic-plan.vercel.app" };
const first = { enabled: true, basisPoints: 290, fixedCents: 30, version: "first-v1" };
const renewal = { enabled: true, basisPoints: 360, fixedCents: 30, version: "renewal-v1" };
type Reservation = { id: string; booking_id: string; context: typeof context; terms: Record<string, unknown>; status: string; created_at: string };
type Operation = { id: string; reservation_id: string; context: typeof context; context_hash: string; terms_hash: string;
  operation_kind: string; request: Record<string, unknown>; request_hash: string; idempotency_key: string; status: string; created_at: string };
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function evidence(c = context) {
  return { approvedContext: c, vercelEnvironment: c.mode === "test" ? "preview" : "production", stripeSecretKeyMode: c.mode,
    stripePublishableKeyMode: c.mode, observedPlatformAccountId: c.platformAccountId, observedSupabaseProjectRef: c.supabaseProjectRef,
    configuredSupabaseUrl: `https://${c.supabaseProjectRef}.supabase.co`, configuredSiteOrigin: c.siteOrigin };
}
async function baseline() {
  const db = createLocalPostgres();
  await installStagingStructuralBaseline(db);
  await installExactMigrationsInMemory(db);
  await db.exec(sql058);
  await db.exec(`alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role`);
  return db;
}
async function seed(db: PGlite) {
  await db.query("insert into auth.users(id) values($1),($2)", [ids.buyer, ids.creator]);
  await db.query(`insert into profiles(id,stripe_onboarding_complete,stripe_account_id)
    values($1,false,null),($2,true,'acct_LocalCreator')`, [ids.buyer, ids.creator]);
  await db.query(`insert into products(id,creator_id,type,title,is_active,price_cents,amount_cents,currency)
    values($1,$2,'mentorship','Local customer plan',true,199900,199900,'usd')`, [ids.product, ids.creator]);
  await db.query("insert into posts(id,product_id,creator_id,user_id) values($1,$2,$3,$3)", [ids.post, ids.product, ids.creator]);
  await db.query("insert into bookings(id,post_id,creator_id,buyer_id,status) values($1,$2,$3,$4,'booked')",
    [ids.booking, ids.post, ids.creator, ids.buyer]);
}
async function protectedRows(db: PGlite) {
  return (await db.query(`select 'booking' kind,to_jsonb(r) details from public.bookings r
    union all select 'payment',to_jsonb(r) from public.booking_payments r
    union all select 'purchase',to_jsonb(r) from public.purchases r
    union all select 'v1agreement',to_jsonb(r) from public.exact_installment_agreements r
    union all select 'v2reservation',to_jsonb(r) from public.exact_installment_context_reservations_v2 r
    union all select 'ownerpin',to_jsonb(r) from public.exact_installment_context_pin_v2 r order by 1,2`)).rows;
}

describe("NEW local immutable customer plan persistence only", () => {
  let db: PGlite;
  beforeAll(async () => { db = await baseline(); await db.exec(sql059); });
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await db.exec("begin"); await seed(db); });
  afterEach(async () => { await db.exec("rollback"); });
  async function asRole<T>(role: "service_role" | "anon" | "authenticated", call: () => Promise<T>) {
    await db.exec(`set local role ${role}`);
    try { return await call(); } finally { await db.exec("reset role").catch(() => undefined); }
  }
  async function rejected(call: () => Promise<unknown>, match?: string | RegExp) {
    await db.exec("savepoint rejected_case");
    try { await expect(call()).rejects.toThrow(match); }
    finally { await db.exec("rollback to savepoint rejected_case; release savepoint rejected_case"); }
  }
  async function reserve(c = context) {
    await db.query("insert into public.exact_installment_context_pin_v2(context) values($1::jsonb)", [JSON.stringify(c)]);
    return json((await asRole("service_role", () => db.query<Reservation>(
      "select * from public.reserve_exact_installment_context_v2($1,$2,3,$3::jsonb,$4::jsonb,$5::jsonb)",
      [ids.booking, ids.creator, JSON.stringify(c), JSON.stringify(first), JSON.stringify(renewal)]))).rows[0]);
  }
  async function plan(rid: string, actor = ids.creator, c = context) {
    return json((await asRole("service_role", () => db.query<Operation>(
      "select * from public.plan_exact_customer_operation_v2($1,$2,$3::jsonb)", [rid, actor, JSON.stringify(c)]))).rows[0]);
  }
  async function read(rid: string, actor = ids.creator, c = context) {
    return json((await asRole("service_role", () => db.query<Operation>(
      "select * from public.read_exact_customer_operation_v2($1,$2,$3::jsonb)", [rid, actor, JSON.stringify(c)]))).rows[0]);
  }

  test.each([context, { ...context, mode: "live", siteOrigin: "https://synthetic-plan.example" }])(
    "$mode SQL request/hashes round-trip through the real TypeScript planner and strict reader", async c => {
      const r = await reserve(c), before = await protectedRows(db);
      const stored = await plan(r.id, ids.creator, c), repeated = await plan(r.id, ids.creator, c);
      expect(repeated).toEqual(stored);
      const expected = buildExactContextCustomerPlan({ reservationRow: r, contextEvidence: evidence(c), actorId: ids.creator });
      expect(stored).toMatchObject({ reservation_id: r.id, context: c, context_hash: expected.contextHash,
        terms_hash: expected.termsHash, operation_kind: "customer.create", request: expected.request,
        request_hash: expected.requestHash, idempotency_key: expected.idempotencyKey, status: "planned_not_dispatchable" });
      const parsed = readExactContextCustomerIntent({ intentRow: stored, reservationRow: r, contextEvidence: evidence(c), actorId: ids.creator });
      expect(parsed).toMatchObject({ id: stored.id, providerOperationsAllowed: false, accountingOperationsAllowed: false, replayAllowed: false });
      expect(await read(r.id, ids.creator, c)).toEqual(stored);
      expect(Object.keys(stored).sort()).toEqual(["id", "reservation_id", "context", "context_hash", "terms_hash", "operation_kind", "request",
        "request_hash", "idempotency_key", "status", "created_at"].sort());
      expect(await protectedRows(db)).toEqual(before);
    });

  test("UTF8 hex framing agrees for Unicode, escaped title and decimal-normalized numeric fee input", async () => {
    await db.query("update products set title=$1", ['Mentoría 🌱 "quoted" \\ café\nline']);
    await db.query("insert into public.exact_installment_context_pin_v2(context) values($1::jsonb)", [JSON.stringify(context)]);
    const rawFirst = '{"enabled":true,"basisPoints":290.00,"fixedCents":30.0,"version":"vë\/1"}';
    const rawRenewal = '{"enabled":false,"basisPoints":360.0,"fixedCents":30.00,"version":"更新"}';
    // 058 deliberately rejects decimal lexical spellings; constructing a new
    // owner-only synthetic reservation here models equivalent JSON number scale
    // without changing any migration or production record. The real reader and
    // 059 must normalize those integral numeric values to the same hash atoms.
    const r = json((await db.query<Reservation>(`insert into public.exact_installment_context_reservations_v2(booking_id,context,terms)
      select b.id,$1::jsonb,jsonb_build_object('version','exact-cents-context-v2','currency','usd','bookingId',b.id,
        'productId',p.id,'postId',post.id,'buyerId',b.buyer_id,'creatorId',b.creator_id,'destinationId','acct_LocalCreator',
        'title',p.title,'totalCents',199900.00,'paymentCount',3.0,'firstPaymentFeeSchedule',$2::jsonb,'renewalFeeSchedule',$3::jsonb)
      from public.bookings b join public.posts post on post.id=b.post_id join public.products p on p.id=post.product_id returning *`,
    [JSON.stringify(context), rawFirst, rawRenewal])).rows[0]);
    const stored = await plan(r.id);
    const expected = buildExactContextCustomerPlan({ reservationRow: r, contextEvidence: evidence(), actorId: ids.creator });
    expect(stored.terms_hash).toBe(expected.termsHash); expect(stored.request_hash).toBe(expected.requestHash);
    expect(stored.idempotency_key).toBe(expected.idempotencyKey);
    expect(readExactContextCustomerIntent({ intentRow: stored, reservationRow: r, contextEvidence: evidence(), actorId: ids.creator }).replayAllowed).toBe(false);
  });

  test("missing pin/reservation, old identifiers, wrong owner and context never create a plan", async () => {
    await rejected(() => plan(ids.absent), "owner-provisioned");
    const r = await reserve();
    await rejected(() => plan(ids.absent), "Owned blocked");
    await rejected(() => plan(r.id, ids.buyer), "Owned blocked");
    await rejected(() => plan(r.id, ids.creator, { ...context, platformAccountId: "acct_Other" }), "owner-provisioned");
    expect((await db.query("select count(*)::integer n from public.exact_installment_context_customer_operations_v2")).rows).toEqual([{ n: 0 }]);
  });

  test.each([false, true])("current quote checks apply before new or repeated plan (existing=%s)", async exists => {
    const r = await reserve(); if (exists) await plan(r.id);
    for (const mutation of ["update bookings set status='canceled'", "update bookings set creator_id=buyer_id",
      "update products set is_active=false", "update products set amount_cents=199901", "update products set title='Changed quote'",
      "update profiles set stripe_onboarding_complete=false where id='22222222-2222-4222-8222-222222222222'"]) {
      await db.exec("savepoint changed_quote"); await db.exec(mutation);
      const before = await protectedRows(db);
      await rejected(() => plan(r.id));
      expect(await protectedRows(db)).toEqual(before);
      await db.exec("rollback to savepoint changed_quote; release savepoint changed_quote");
    }
  });

  test("a newly present purchase is not adopted by a plan retry; old immutable plan stays diagnostic only", async () => {
    const r = await reserve(), op = await plan(r.id);
    await db.query(`insert into public.purchases(id,buyer_id,creator_id,post_id,product_id,status,currency)
      values(gen_random_uuid(),$1,$2,$3,$4,'paid','usd')`, [ids.buyer, ids.creator, ids.post, ids.product]);
    const before = await protectedRows(db);
    await rejected(() => plan(r.id), "financial evidence cannot be adopted");
    expect(await read(r.id)).toEqual(op);
    expect(await protectedRows(db)).toEqual(before);
  });

  test("owned read is read-only and fails on wrong actor, context or id", async () => {
    const r = await reserve(), op = await plan(r.id);
    await rejected(() => read(r.id, ids.buyer), "Owned customer");
    await rejected(() => read(ids.absent), "Owned customer");
    await rejected(() => read(op.id), "Owned customer"); // Generated operation ID is not a reservation lookup key.
    await rejected(() => read(r.id, ids.creator, { ...context, siteOrigin: "https://other.vercel.app" }), "read admission");
    await db.exec("set transaction read only"); expect(await read(r.id)).toEqual(op);
  });

  test("no role can transition/delete/truncate plans; runtime roles cannot write columns or call internal helpers", async () => {
    const r = await reserve(), op = await plan(r.id);
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]) {
        expect((await db.query("select has_table_privilege($1,'public.exact_installment_context_customer_operations_v2',$2) allowed", [role, privilege])).rows)
          .toEqual([{ allowed: false }]);
      }
      expect((await db.query("select has_column_privilege($1,'public.exact_installment_context_customer_operations_v2','request','UPDATE') allowed", [role])).rows)
        .toEqual([{ allowed: false }]);
      await rejected(() => asRole(role, () => db.query("select * from public.exact_installment_context_customer_operations_v2")), "permission denied");
      await rejected(() => asRole(role, () => db.exec("update public.exact_installment_context_customer_operations_v2 set request=request")), "permission denied");
      await rejected(() => asRole(role, () => db.query("select public.exact_customer_hex_tuple_hash_v2(array['x'])")), "permission denied");
      if (role !== "service_role") {
        await rejected(() => asRole(role, () => db.query("select public.plan_exact_customer_operation_v2($1,$2,$3::jsonb)",
          [r.id, ids.creator, JSON.stringify(context)])), "permission denied");
        await rejected(() => asRole(role, () => db.query("select public.read_exact_customer_operation_v2($1,$2,$3::jsonb)",
          [r.id, ids.creator, JSON.stringify(context)])), "permission denied");
      }
    }
    for (const mutation of ["update public.exact_installment_context_customer_operations_v2 set status='dispatching'",
      "update public.exact_installment_context_customer_operations_v2 set request='{}'::jsonb",
      "delete from public.exact_installment_context_customer_operations_v2", "truncate public.exact_installment_context_customer_operations_v2"]) {
      await rejected(() => db.exec(mutation), "immutable");
    }
    expect(await read(r.id)).toEqual(op);
  });

  test.each([false, true])("SQL-to-SDK planner and reservation recovery use one actual immutable intent (lost response=%s)", async lostResponse => {
    const r = await reserve();
    let before = await protectedRows(db);
    const config: ExactContextRuntimeConfig = { approvedContext: { ...context, version: "exact-payment-context-v1", mode: "test" },
      vercelEnvironment: "preview", configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`,
      configuredSiteOrigin: context.siteOrigin, stripeSecretKey: "sk_test_SYNTHETICNOTACREDENTIAL",
      stripePublishableKeyMode: "test", supabaseServiceKey: "sb_secret_SYNTHETICNOTACREDENTIAL", expectedApiVersion: "2025-10-29.clover" };
    const requests: Array<{ method: string; path: string }> = [];
    const trustedFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input)), headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      requests.push({ method, path: url.pathname });
      expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
      expect(headers.has("stripe-account")).toBe(false); expect(headers.has("stripe-context")).toBe(false);
      expect(headers.has("idempotency-key")).toBe(false);
      let body: unknown;
      if (url.origin === "https://api.stripe.com") {
        expect(method).toBe("GET"); expect(url.search).toBe(""); expect(init?.body == null).toBe(true);
        expect(headers.get("authorization")).toBe(`Bearer ${config.stripeSecretKey}`);
        expect(headers.get("stripe-version")).toBe(config.expectedApiVersion);
        if (url.pathname === "/v1/account") body = { object: "account", id: context.platformAccountId };
        else if (url.pathname === "/v1/balance") body = { object: "balance", livemode: false, available: [], pending: [] };
        else throw Error("Unexpected synthetic provider route");
      } else {
        expect(url.origin).toBe(config.configuredSupabaseUrl);
        expect(headers.get("apikey")).toBe(config.supabaseServiceKey);
        expect(headers.get("authorization")).toBe(`Bearer ${config.supabaseServiceKey}`);
        if (url.pathname === "/rest/v1/rpc/plan_exact_customer_operation_v2") {
          expect(method).toBe("POST"); expect(url.search).toBe("");
          expect(headers.get("content-profile")).toBe("public");
          expect(typeof init?.body).toBe("string");
          const args = JSON.parse(init!.body as string) as { p_reservation_id: string; p_actor_id: string; p_context: unknown };
          expect(args).toEqual({ p_reservation_id: r.id, p_actor_id: ids.creator, p_context: context });
          // The real SQL computes and inserts the request/hashes. No canned
          // operation row or client-provided hash is substituted at this seam.
          body = (await asRole("service_role", () => db.query<Operation>(
            "select * from public.plan_exact_customer_operation_v2($1,$2,$3::jsonb)",
            [args.p_reservation_id, args.p_actor_id, JSON.stringify(args.p_context)]))).rows[0];
          if (lostResponse) throw Error("Synthetic response lost after database plan insertion");
        } else {
          expect(method).toBe("GET"); expect(init?.body == null).toBe(true);
          expect(headers.get("accept-profile")).toBe("public");
          if (url.pathname === "/rest/v1/rpc/read_exact_installment_context_pin_v2") {
            expect(url.search).toBe("");
            body = (await asRole("service_role", () => db.query<{ observation: unknown }>(
              "select public.read_exact_installment_context_pin_v2() observation"))).rows[0].observation;
          } else if (url.pathname === "/rest/v1/rpc/read_exact_customer_operation_v2") {
            // Actual GET RPC must encode JSON text, not '[object Object]'. SQL
            // receives the same jsonb and named reservation argument it expects.
            expect([...url.searchParams.entries()]).toEqual([["p_reservation_id", r.id], ["p_actor_id", ids.creator],
              ["p_context", JSON.stringify(context)]]);
            expect(JSON.parse(url.searchParams.get("p_context")!)).toEqual(context);
            body = (await asRole("service_role", () => db.query<Operation>(
              "select * from public.read_exact_customer_operation_v2(p_reservation_id=>$1,p_actor_id=>$2,p_context=>$3::jsonb)",
              [url.searchParams.get("p_reservation_id"), url.searchParams.get("p_actor_id"), url.searchParams.get("p_context")]))).rows[0];
          } else if (url.pathname === "/rest/v1/exact_installment_context_reservations_v2") {
            expect([...url.searchParams.entries()]).toEqual([["select", "id,booking_id,context,terms,status,created_at"],
              ["id", `eq.${r.id}`], ["terms->>creatorId", `eq.${ids.creator}`]]);
            body = (await asRole("service_role", () => db.query<Reservation>(
              `select id,booking_id,context,terms,status,created_at from public.exact_installment_context_reservations_v2
                where id=$1 and terms->>'creatorId'=$2`,
              [url.searchParams.get("id")!.slice(3), url.searchParams.get("terms->>creatorId")!.slice(3)]))).rows;
          } else throw Error("Unexpected synthetic database route");
        }
      }
      const bytes = JSON.stringify(body);
      const response = new Response(bytes, { status: 200, headers: { "content-type": "application/json", "request-id": "req_LocalPlanOnly" } });
      Object.defineProperties(response, { url: { value: url.href }, redirected: { value: false },
        json: { value: async () => JSON.parse(bytes) } });
      return response;
    };
    const planner = createExactContextBootstrapPlanner(config, trustedFetch);
    expect(Object.keys(planner)).toEqual(["planCustomer", "readCustomerPlan"]);
    if (lostResponse) {
      await expect(planner.planCustomer(r.id, ids.creator)).rejects.toThrow();
      expect(requests.filter(request => request.method === "POST")).toEqual([
        { method: "POST", path: "/rest/v1/rpc/plan_exact_customer_operation_v2" },
      ]);
      expect(await protectedRows(db)).toEqual(before);
      // An owner-only fixture change now makes re-planning inadmissible. The
      // existing immutable plan can still be diagnosed by its known reservation.
      await db.exec("update products set amount_cents=199901; update bookings set status='canceled'");
      before = await protectedRows(db);
      requests.length = 0;
      await db.exec("set transaction read only");
    }
    const planned = lostResponse ? await planner.readCustomerPlan(r.id, ids.creator) : await planner.planCustomer(r.id, ids.creator);
    expect(planned).toMatchObject({ reservationId: r.id, status: "planned_not_dispatchable",
      providerOperationsAllowed: false, accountingOperationsAllowed: false, replayAllowed: false });
    expect(requests).toEqual([
      { method: "GET", path: "/v1/account" }, { method: "GET", path: "/v1/balance" },
      { method: "GET", path: "/rest/v1/rpc/read_exact_installment_context_pin_v2" },
      { method: "GET", path: "/rest/v1/exact_installment_context_reservations_v2" },
      { method: lostResponse ? "GET" : "POST", path: lostResponse ? "/rest/v1/rpc/read_exact_customer_operation_v2" : "/rest/v1/rpc/plan_exact_customer_operation_v2" },
      { method: "GET", path: "/v1/account" }, { method: "GET", path: "/v1/balance" },
      { method: "GET", path: "/rest/v1/rpc/read_exact_installment_context_pin_v2" },
    ]);
    const durable = await read(r.id);
    expect(durable.request_hash).toBe(planned.requestHash); expect(durable.idempotency_key).toBe(planned.idempotencyKey);
    expect((await db.query("select count(*)::integer n from public.exact_installment_context_customer_operations_v2")).rows).toEqual([{ n: 1 }]);
    expect(await protectedRows(db)).toEqual(before);
  });

  test("schema exposes a single plan operation and no dispatch/attempt/result binding fields or RPC", async () => {
    const r = await reserve(), op = await plan(r.id);
    expect(Object.keys(op)).not.toEqual(expect.arrayContaining(["provider_customer_id", "claim_token", "lease_until", "dispatched_at"]));
    expect((await db.query(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('claim_exact_customer_operation_v2','dispatch_exact_customer_operation_v2',
        'bind_exact_customer_operation_v2','complete_exact_customer_operation_v2')`)).rows).toEqual([]);
    expect(op.request).toMatchObject({ version: "exact-context-customer-request-v1", apiVersion: "2025-10-29.clover",
      method: "POST", path: "/v1/customers" });
    expect(JSON.stringify(op.request)).not.toMatch(/email|payment_method|test_clock|address|invoice_settings|default_source/);
  });
});

describe("NEW059 local migration safety", () => {
  let db: PGlite;
  beforeAll(async () => { db = await baseline(); });
  afterAll(async () => { await db?.close(); });
  afterEach(async () => { await db.exec("rollback"); });
  const preflight = sql059.slice(sql059.indexOf("do $customer_v2_preflight$"), sql059.indexOf("-- NEW versioned framing"));
  const body = sql059.slice(sql059.indexOf("begin;") + 6, sql059.lastIndexOf("commit;"));
  test("old installed source hashes and reservation proposal remain unmodified", () => {
    for (const [name, hash] of manifest.sources) {
      expect(createHash("sha256").update(readFileSync(join(process.cwd(), "supabase/schema", name), "utf8").replace(/\r\n/g, "\n")).digest("hex")).toBe(hash);
    }
    expect(createHash("sha256").update(sql058).digest("hex")).toBe("d3dee6fd5c5106f527797abe6a881dad1b9e9bbc96e43b005ee0ac15b6a8c1f9");
    expect(sql059).not.toMatch(/create\s+or\s+replace|alter\s+function|update\s+public\.(?:purchases|booking_payments|exact_installment_agreements)\b/i);
  });
  test("late unexpected grant rolls the whole proposal back without changing existing rows", async () => {
    await db.exec("begin"); await seed(db); const before = await protectedRows(db);
    await db.exec("savepoint proposal_case");
    const poisoned = body.replace("-- Final fail-closed assertions", "grant update(request) on public.exact_installment_context_customer_operations_v2 to authenticated;\n-- Final fail-closed assertions");
    await expect(db.exec(poisoned)).rejects.toThrow("column ACL differs");
    await db.exec("rollback to savepoint proposal_case");
    expect(await protectedRows(db)).toEqual(before);
    expect((await db.query("select to_regclass('public.exact_installment_context_customer_operations_v2') value")).rows).toEqual([{ value: null }]);
    expect((await db.query("select to_regprocedure('public.plan_exact_customer_operation_v2(uuid,uuid,jsonb)') value")).rows).toEqual([{ value: null }]);
  });
  test.each([
    "create type public._exact_installment_context_customer_operations_v2 as(synthetic integer)",
    "create table public.exact_installment_context_customer_operations_v2(synthetic integer)",
    "create function public.plan_exact_customer_operation_v2() returns integer language sql as 'select 1'",
  ])("colliding object is rejected before installation: %s", async drift => {
    await db.exec(`begin; ${drift}`); await expect(db.exec(preflight)).rejects.toThrow("collision");
  });
  test("replaying a complete installation refuses to overwrite or reopen it", async () => {
    await db.exec("begin"); await db.exec(body); await db.exec("savepoint repeated");
    await expect(db.exec(preflight)).rejects.toThrow("collision"); await db.exec("rollback to savepoint repeated");
    expect((await db.query("select count(*)::integer n from public.exact_installment_context_customer_operations_v2")).rows).toEqual([{ n: 0 }]);
  });
});
