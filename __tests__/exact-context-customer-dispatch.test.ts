/** @jest-environment ./test-support/pglite-environment.cjs */
// New integration boundary only: actual proposed SQL + installed SDKs, synthetic
// local transport. No provider connection, credentials or historical payment retest.
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installStagingStructuralBaseline, installExactMigrationsInMemory } from "../test-support/staging-catalog-postgres";
import { CONTEXT_RUNTIME_ERROR, createExactContextCustomerBootstrap, type ExactContextRuntimeConfig } from "../lib/installments/contextRuntime";

declare const createLocalPostgres: () => PGlite;
jest.setTimeout(120000);
const sql = (name: string) => readFileSync(join(process.cwd(), "supabase/proposals", name), "utf8");
const ids = { buyer: "11111111-1111-4111-8111-111111111111", creator: "22222222-2222-4222-8222-222222222222",
  product: "33333333-3333-4333-8333-333333333333", post: "44444444-4444-4444-8444-444444444444",
  booking: "55555555-5555-4555-8555-555555555555" };
const context = { version: "exact-payment-context-v1" as const, mode: "test" as "test" | "live",
  platformAccountId: "acct_LocalDispatch", supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa", siteOrigin: "https://synthetic-dispatch.vercel.app" };
const fee = { enabled: true, basisPoints: 290, fixedCents: 30, version: "local-v1" };
const claim = "/rest/v1/rpc/claim_exact_customer_dispatch_v2", bind = "/rest/v1/rpc/bind_exact_customer_dispatch_v2";
let db: PGlite, reservationId: string;
let config: ExactContextRuntimeConfig;
type Change = (body: Record<string, unknown>, path: string) => Record<string, unknown>;

async function rpc(name: string, args: unknown[]) {
  const signatures: Record<string, string> = {
    read_exact_installment_context_pin_v2: "",
    read_exact_customer_operation_v2: "$1::uuid,$2::uuid,$3::jsonb",
    claim_exact_customer_dispatch_v2: "$1::uuid,$2::uuid,$3::jsonb",
    read_exact_customer_dispatch_v2: "$1::uuid,$2::uuid,$3::jsonb",
    bind_exact_customer_dispatch_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::uuid,$5::text,$6::text,$7::bigint",
  };
  if (!Object.hasOwn(signatures, name)) throw Error("Unexpected local RPC");
  await db.exec("savepoint local_rpc; set local role service_role");
  try {
    const result = await db.query<{ value: unknown }>(`select to_jsonb(public.${name}(${signatures[name]})) as value`, args);
    return JSON.parse(JSON.stringify(result.rows[0].value));
  } catch (error) {
    await db.exec("rollback to savepoint local_rpc");
    throw error;
  } finally { await db.exec("reset role; release savepoint local_rpc"); }
}
async function financialSnapshot() {
  return (await db.query(`select 'booking' kind,to_jsonb(r) details from public.bookings r
    union all select 'payment',to_jsonb(r) from public.booking_payments r
    union all select 'purchase',to_jsonb(r) from public.purchases r
    union all select 'agreement',to_jsonb(r) from public.exact_installment_agreements r
    union all select 'reservation',to_jsonb(r) from public.exact_installment_context_reservations_v2 r
    union all select 'plan',to_jsonb(r) from public.exact_installment_context_customer_operations_v2 r order by 1,2`)).rows;
}
function harness(change: Change = body => body) {
  const requests: Array<{ path: string; method: string; body: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET", headers = new Headers(init?.headers);
    requests.push({ path: url.pathname, method, body: typeof init?.body === "string" ? init.body : null });
    expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
    expect(headers.has("stripe-account") || headers.has("stripe-context")).toBe(false);
    let body: unknown;
    if (url.origin === "https://api.stripe.com") {
      expect(headers.get("authorization")).toBe(config.stripeSecretKey ? `Bearer ${config.stripeSecretKey}` : "never");
      expect(headers.get("stripe-version")).toBe("2025-10-29.clover");
      if (url.pathname === "/v1/account") body = { object: "account", id: context.platformAccountId };
      else if (url.pathname === "/v1/balance") body = { object: "balance", livemode: config.approvedContext.mode === "live" };
      else if (url.pathname === "/v1/customers") {
        expect(method).toBe("POST");
        expect(headers.get("idempotency-key")).toMatch(/^cn-exact-v2-customer:[a-f0-9]{64}$/);
        const metadata = Object.fromEntries([...new URLSearchParams(String(init?.body)).entries()].map(([k, v]) => {
          expect(k).toMatch(/^metadata\[[a-z_]+\]$/); return [k.slice(9, -1), v];
        }));
        expect(Object.keys(metadata)).toHaveLength(8);
        body = { object: "customer", id: "cus_LocalCreated", created: Math.floor(Date.now() / 1000),
          livemode: config.approvedContext.mode === "live", balance: 0, email: null, default_source: null,
          invoice_settings: { default_payment_method: null }, delinquent: false, test_clock: null, metadata };
      } else throw Error("Unexpected provider endpoint");
    } else {
      expect(url.origin).toBe(config.configuredSupabaseUrl);
      expect(headers.has("idempotency-key")).toBe(false);
      expect(headers.get("apikey")).toBe(config.supabaseServiceKey);
      if (url.pathname === "/rest/v1/exact_installment_context_reservations_v2") {
        expect(method).toBe("GET");
        expect(url.searchParams.get("id")).toBe(`eq.${reservationId}`);
        body = (await db.query("select * from public.exact_installment_context_reservations_v2 where id=$1", [reservationId])).rows;
      } else {
        const args = method === "POST" ? JSON.parse(String(init?.body)) : Object.fromEntries(url.searchParams);
        const ordered = url.pathname.endsWith("_pin_v2") ? [] : [args.p_reservation_id, args.p_actor_id,
          typeof args.p_context === "string" ? args.p_context : JSON.stringify(args.p_context),
          ...(url.pathname === bind ? [args.p_attempt_id, args.p_customer_id, args.p_request_id, args.p_customer_created] : [])];
        body = await rpc(url.pathname.slice("/rest/v1/rpc/".length), ordered);
      }
    }
    body = change(body as Record<string, unknown>, url.pathname);
    const bytes = JSON.stringify(body);
    const response = new Response(bytes, { status: 200, headers: { "content-type": "application/json", "request-id": "req_LocalCreate" } });
    Object.defineProperties(response, { url: { value: url.href }, json: { value: async () => JSON.parse(bytes) } });
    return response;
  };
  const runtime = createExactContextCustomerBootstrap(config, fetcher);
  return { runtime, requests, creates: () => requests.filter(r => r.path === "/v1/customers"),
    writes: () => requests.filter(r => r.method === "POST") };
}
beforeAll(async () => {
  db = createLocalPostgres();
  await installStagingStructuralBaseline(db); await installExactMigrationsInMemory(db);
  await db.exec(sql("058-payment-context-reservations.sql"));
  await db.exec(sql("059-context-customer-operation-plans.sql"));
  // Ensure the new proposal defeats broad inherited default grants.
  await db.exec("alter default privileges in schema public grant all on tables to anon,authenticated,service_role");
  await db.exec(sql("060-context-customer-dispatch.sql"));
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("begin");
  await db.query("insert into auth.users(id) values($1),($2)", [ids.buyer, ids.creator]);
  await db.query("insert into profiles(id,stripe_onboarding_complete,stripe_account_id) values($1,false,null),($2,true,'acct_LocalCreator')", [ids.buyer, ids.creator]);
  await db.query("insert into products(id,creator_id,type,title,is_active,price_cents,amount_cents,currency) values($1,$2,'mentorship','Local dispatch',true,199900,199900,'usd')", [ids.product, ids.creator]);
  await db.query("insert into posts(id,product_id,creator_id,user_id) values($1,$2,$3,$3)", [ids.post, ids.product, ids.creator]);
  await db.query("insert into bookings(id,post_id,creator_id,buyer_id,status) values($1,$2,$3,$4,'booked')", [ids.booking, ids.post, ids.creator, ids.buyer]);
  config = { approvedContext: { ...context }, vercelEnvironment: "preview", configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`,
    configuredSiteOrigin: context.siteOrigin, stripeSecretKey: "sk_test_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "test",
    supabaseServiceKey: "sb_secret_SYNTHETICNOTACREDENTIAL", expectedApiVersion: "2025-10-29.clover" };
});
afterEach(async () => { await db.exec("rollback"); });
async function plan() {
  const c = JSON.stringify(config.approvedContext);
  await db.query("insert into public.exact_installment_context_pin_v2(context) values($1::jsonb)", [c]);
  reservationId = (await db.query<{ id: string }>("select * from public.reserve_exact_installment_context_v2($1,$2,3,$3::jsonb,$4::jsonb,$4::jsonb)",
    [ids.booking, ids.creator, c, JSON.stringify(fee)])).rows[0].id;
  await db.query("select public.plan_exact_customer_operation_v2($1,$2,$3::jsonb)", [reservationId, ids.creator, c]);
}

test.each(["test", "live"] as const)("%s: SQL claim -> actual SDK customer POST -> SQL binding; repeats/read never resend or touch money", async mode => {
  if (mode === "live") config = { ...config, approvedContext: { ...context, mode, siteOrigin: "https://synthetic-dispatch.example" },
    vercelEnvironment: "production", configuredSiteOrigin: "https://synthetic-dispatch.example", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "live" };
  await plan(); const before = await financialSnapshot(), h = harness();
  const firstRead = await h.runtime.readCustomerResult(reservationId, ids.creator).catch(() => {
    throw Error(`Synthetic request stages: ${h.requests.map(r => r.path).join(", ")}`);
  });
  expect(firstRead).toMatchObject({ status: "not_attempted", replayAllowed: false });
  expect(h.writes()).toHaveLength(0);
  const result = await h.runtime.createCustomer(reservationId, ids.creator);
  expect(result).toMatchObject({ status: "customer_bound", customerId: "cus_LocalCreated", requestId: "req_LocalCreate",
    replayAllowed: false, accountingOperationsAllowed: false, context: config.approvedContext });
  expect(await h.runtime.createCustomer(reservationId, ids.creator)).toEqual(result);
  expect(await h.runtime.readCustomerResult(reservationId, ids.creator)).toEqual(result);
  expect(h.creates()).toHaveLength(1);
  expect((await db.query("select count(*)::int n from public.exact_context_customer_attempts_v2")).rows).toEqual([{ n: 1 }]);
  expect((await db.query("select count(*)::int n from public.exact_context_customer_bindings_v2")).rows).toEqual([{ n: 1 }]);
  expect(await financialSnapshot()).toEqual(before);
});

test.each([claim, "/v1/customers", bind])("response lost after %s: permanent attempt, diagnostic recovery, never automatic recreate", async path => {
  await plan(); const h = harness((body, requested) => { if (requested === path) throw Error("private-marker lost response"); return body; });
  await expect(h.runtime.createCustomer(reservationId, ids.creator)).rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
  const after = harness(), status = path === bind ? "customer_bound" : "review_required";
  expect(await after.runtime.readCustomerResult(reservationId, ids.creator)).toMatchObject({ status });
  expect(await after.runtime.createCustomer(reservationId, ids.creator)).toMatchObject({ status });
  expect(after.creates()).toHaveLength(0);
  expect(h.creates()).toHaveLength(path === claim ? 0 : 1);
});

test.each(["mode", "metadata", "card", "clock", "email", "balance", "created", "deleted"])("wrong customer %s is not bound or retried", async which => {
  await plan(); const h = harness((body, path) => {
    if (path !== "/v1/customers") return body;
    if (which === "mode") body.livemode = true;
    if (which === "metadata") (body.metadata as Record<string, unknown>).terms_hash = "wrong";
    if (which === "card") (body.invoice_settings as Record<string, unknown>).default_payment_method = "pm_Unexpected";
    if (which === "clock") body.test_clock = "clock_Unexpected";
    if (which === "email") body.email = "private-marker@example.invalid";
    if (which === "balance") body.balance = 1;
    if (which === "created") body.created = Number(body.created) - 3600;
    if (which === "deleted") body.deleted = true;
    return body;
  });
  await expect(h.runtime.createCustomer(reservationId, ids.creator)).rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
  expect(h.creates()).toHaveLength(1); expect(h.requests.some(r => r.path === bind)).toBe(false);
  expect(await h.runtime.readCustomerResult(reservationId, ids.creator)).toMatchObject({ status: "review_required", customerId: null });
});

test("changed quote or wrong owner cannot obtain a dispatch claim", async () => {
  await plan(); const h = harness();
  await expect(h.runtime.createCustomer(reservationId, ids.buyer)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  await db.query("update products set amount_cents=199901 where id=$1", [ids.product]);
  await expect(h.runtime.createCustomer(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.creates()).toHaveLength(0);
  expect(await h.runtime.readCustomerResult(reservationId, ids.creator)).toMatchObject({ status: "not_attempted" });
});

test("identity drift after creation preserves uncertainty without recording a binding", async () => {
  await plan(); let sent = false;
  const h = harness((body, path) => {
    if (path === "/v1/customers") sent = true;
    if (sent && path === "/v1/account") return { ...body, id: "acct_Changed" };
    return body;
  });
  await expect(h.runtime.createCustomer(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.creates()).toHaveLength(1); expect(h.requests.some(r => r.path === bind)).toBe(false);
});

test.each([31_000, -1_000])("clock movement of %sms after claim prevents sending; the attempt is not recycled", async delta => {
  await plan(); let claimed = false;
  const actualNow = Date.now.bind(Date), clock = jest.spyOn(Date, "now").mockImplementation(() => actualNow() + (claimed ? delta : 0));
  const h = harness((body, path) => { if (path === claim) claimed = true; return body; });
  try {
    await expect(h.runtime.createCustomer(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect(h.creates()).toHaveLength(0);
  } finally { clock.mockRestore(); }
  const recovered = harness();
  expect(await recovered.runtime.createCustomer(reservationId, ids.creator)).toMatchObject({ status: "review_required" });
  expect(recovered.creates()).toHaveLength(0);
});

test("new tables/RPCs deny public/client/direct service access; binding cannot be overwritten", async () => {
  await plan(); const h = harness(); await h.runtime.createCustomer(reservationId, ids.creator);
  for (const table of ["exact_context_customer_attempts_v2", "exact_context_customer_bindings_v2"]) {
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        expect((await db.query("select has_table_privilege($1,$2,$3) allowed", [role, `public.${table}`, privilege])).rows).toEqual([{ allowed: false }]);
      }
    }
    await db.exec("savepoint immutable");
    await expect(db.exec(`delete from public.${table}`)).rejects.toThrow("immutable");
    await db.exec("rollback to savepoint immutable; release savepoint immutable");
  }
  const bound = (await db.query<{ attempt_id: string; customer_id: string; request_id: string; customer_created: number }>("select * from public.exact_context_customer_bindings_v2")).rows[0];
  const args = [reservationId, ids.creator, JSON.stringify(config.approvedContext), bound.attempt_id, bound.customer_id, bound.request_id, bound.customer_created];
  expect(await rpc("bind_exact_customer_dispatch_v2", args)).toMatchObject({ claimed: false, binding: { customer_id: bound.customer_id } });
  args[4] = "cus_Other";
  await expect(rpc("bind_exact_customer_dispatch_v2", args)).rejects.toThrow("already bound differently");
  for (const role of ["anon", "authenticated"]) {
    expect((await db.query("select has_function_privilege($1,'public.claim_exact_customer_dispatch_v2(uuid,uuid,jsonb)','EXECUTE') allowed", [role])).rows).toEqual([{ allowed: false }]);
  }
});
