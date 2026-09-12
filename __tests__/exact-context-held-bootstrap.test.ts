/** @jest-environment ./test-support/pglite-environment.cjs */
// Only the new 061 boundary: real proposed SQL + installed SDK serialization,
// synthetic HTTP. Existing customer/login/payment/restore acceptance is reused.
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installStagingStructuralBaseline, installExactMigrationsInMemory } from "../test-support/staging-catalog-postgres";
import { createExactContextHeldBootstrap, CONTEXT_RUNTIME_ERROR, type ExactContextRuntimeConfig } from "../lib/installments/contextRuntime";

declare const createLocalPostgres: () => PGlite;
jest.setTimeout(120000);
const ids = { buyer: "11111111-1111-4111-8111-111111111111", creator: "22222222-2222-4222-8222-222222222222",
  product: "33333333-3333-4333-8333-333333333333", post: "44444444-4444-4444-8444-444444444444", booking: "55555555-5555-4555-8555-555555555555" };
const context = { version: "exact-payment-context-v1" as const, mode: "test" as "test" | "live", platformAccountId: "acct_LocalHeld",
  supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa", siteOrigin: "https://synthetic-held.vercel.app" };
const fee = { enabled: true, basisPoints: 290, fixedCents: 30, version: "local-v1" };
const sql = (name: string) => readFileSync(join(process.cwd(), "supabase/proposals", name), "utf8");
let db: PGlite, reservationId: string, config: ExactContextRuntimeConfig;
let customerMetadata: Record<string, string>;
type Body = Record<string, unknown>;
type Mutation = (body: Body, path: string, method: string) => Body;
const signatures: Record<string, string> = {
  read_exact_installment_context_pin_v2: "", read_exact_customer_operation_v2: "$1::uuid,$2::uuid,$3::jsonb",
  read_exact_customer_dispatch_v2: "$1::uuid,$2::uuid,$3::jsonb",
  read_exact_held_step_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text",
  claim_exact_held_step_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text",
  bind_exact_held_step_v2: "$1::uuid,$2::uuid,$3::jsonb,$4::text,$5::uuid,$6::text,$7::text",
};
async function rpc(name: string, args: unknown[]) {
  if (!Object.hasOwn(signatures, name)) throw Error("Unexpected local RPC");
  await db.exec("savepoint local_rpc; set local role service_role");
  try {
    const result = await db.query<{ value: unknown }>(`select to_jsonb(public.${name}(${signatures[name]})) value`, args);
    return JSON.parse(JSON.stringify(result.rows[0].value));
  } catch (e) { await db.exec("rollback to savepoint local_rpc"); throw e; }
  finally { await db.exec("reset role; release savepoint local_rpc"); }
}
async function financialSnapshot() {
  return (await db.query(`select 'booking' kind,to_jsonb(r) details from public.bookings r
    union all select 'payment',to_jsonb(r) from public.booking_payments r
    union all select 'purchase',to_jsonb(r) from public.purchases r
    union all select 'agreement',to_jsonb(r) from public.exact_installment_agreements r
    union all select 'reservation',to_jsonb(r) from public.exact_installment_context_reservations_v2 r order by 1,2`)).rows;
}
function harness(mutate: Mutation = b => b, objects = new Map<string, Body>()) {
  const requests: Array<{ path: string; method: string; body: string | null }> = [];
  const live = config.approvedContext.mode === "live";
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET", headers = new Headers(init?.headers);
    requests.push({ path: url.pathname, method, body: typeof init?.body === "string" ? init.body : null });
    expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
    expect(headers.has("stripe-account") || headers.has("stripe-context")).toBe(false);
    let body: unknown;
    if (url.origin === "https://api.stripe.com") {
      expect(headers.get("authorization")).toBe(`Bearer ${config.stripeSecretKey}`);
      expect(headers.get("stripe-version")).toBe("2025-10-29.clover");
      if (url.pathname === "/v1/account") body = { object: "account", id: context.platformAccountId };
      else if (url.pathname === "/v1/balance") body = { object: "balance", livemode: live };
      else if (url.pathname === "/v1/customers/cus_LocalHeld") body = { object: "customer", id: "cus_LocalHeld", livemode: live,
        balance: 0, email: null, default_source: null, invoice_settings: { default_payment_method: null },
        test_clock: null, delinquent: false, metadata: customerMetadata };
      else if (method === "GET") {
        body = objects.get(url.pathname); if (!body) throw Error("Unknown bound object");
      } else {
        expect(headers.get("idempotency-key")).toMatch(/^cn-exact-v2-held:[a-f0-9-]{36}:[a-f0-9]{64}:[a-f0-9]{64}$/);
        const params = new URLSearchParams(String(init?.body));
        const metadata = Object.fromEntries([...params].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));
        if (url.pathname === "/v1/products") {
          body = { object: "product", id: "prod_LocalHeld", created: Math.floor(Date.now() / 1000), livemode: live,
            active: true, default_price: null, name: params.get("name"), metadata };
          objects.set("/v1/products/prod_LocalHeld", body as Body);
        } else if (url.pathname === "/v1/subscriptions") {
          expect(params.get("customer")).toBe("cus_LocalHeld");
          expect(params.get("items[0][price_data][unit_amount]")).toBe("66633");
          expect(params.get("items[0][price_data][product]")).toBe("prod_LocalHeld");
          expect(params.has("application_fee_percent") || params.has("default_payment_method")).toBe(false);
          body = { object: "subscription", id: "sub_LocalHeld", created: Math.floor(Date.now() / 1000), livemode: live,
            status: "trialing", billing_mode: { type: "classic" }, customer: "cus_LocalHeld", trial_end: Number(params.get("trial_end")),
            cancel_at: Number(params.get("cancel_at")), cancel_at_period_end: false, default_payment_method: null, default_source: null,
            application_fee_percent: null, transfer_data: { destination: "acct_LocalCreator", amount_percent: null },
            collection_method: "charge_automatically", automatic_tax: { enabled: false }, discounts: [], default_tax_rates: [],
            pending_update: null, schedule: null, test_clock: null, metadata, pause_collection: null,
            payment_settings: { payment_method_types: ["card"], save_default_payment_method: "off" },
            trial_settings: { end_behavior: { missing_payment_method: "create_invoice" } },
            items: { has_more: false, data: [{ quantity: 1, tax_rates: [], discounts: [], price: {
              id: "price_LocalHeld", active: true, livemode: live, currency: "usd", product: "prod_LocalHeld", unit_amount: 66633,
              billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } } }] } };
          objects.set("/v1/subscriptions/sub_LocalHeld", body as Body);
        } else if (url.pathname === "/v1/subscriptions/sub_LocalHeld") {
          expect([...params]).toEqual([["pause_collection[behavior]", "keep_as_draft"]]);
          body = { ...objects.get(url.pathname), pause_collection: { behavior: "keep_as_draft", resumes_at: null } };
          objects.set(url.pathname, body as Body);
        } else throw Error("Unexpected provider write");
      }
    } else {
      expect(url.origin).toBe(config.configuredSupabaseUrl);
      expect(headers.get("apikey")).toBe(config.supabaseServiceKey);
      if (url.pathname === "/rest/v1/exact_installment_context_reservations_v2") {
        body = (await db.query("select * from public.exact_installment_context_reservations_v2 where id=$1", [reservationId])).rows;
      } else {
        const a = method === "POST" ? JSON.parse(String(init?.body)) : Object.fromEntries(url.searchParams);
        const ordered = url.pathname.endsWith("_pin_v2") ? [] : [a.p_reservation_id, a.p_actor_id,
          typeof a.p_context === "string" ? a.p_context : JSON.stringify(a.p_context), ...(a.p_stage ? [a.p_stage] : []),
          ...(a.p_step_id ? [a.p_step_id, a.p_provider_id, a.p_request_id] : [])];
        body = await rpc(url.pathname.slice("/rest/v1/rpc/".length), ordered);
      }
    }
    // Clone provider state to emulate JSON responses; injected response faults
    // do not silently mutate the saved synthetic remote object.
    body = mutate(JSON.parse(JSON.stringify(body)) as Body, url.pathname, method);
    const bytes = JSON.stringify(body), response = new Response(bytes, { status: 200,
      headers: { "content-type": "application/json", "request-id": `req_Local${requests.length}` } });
    Object.defineProperties(response, { url: { value: url.href }, json: { value: async () => JSON.parse(bytes) } });
    return response;
  };
  return { runtime: createExactContextHeldBootstrap(config, fetcher), requests, objects,
    writes: () => requests.filter(r => r.method === "POST" && r.path.startsWith("/v1/")) };
}
beforeAll(async () => {
  db = createLocalPostgres(); await installStagingStructuralBaseline(db); await installExactMigrationsInMemory(db);
  for (const name of ["058-payment-context-reservations.sql", "059-context-customer-operation-plans.sql", "060-context-customer-dispatch.sql"]) await db.exec(sql(name));
  await db.exec("alter default privileges in schema public grant all on tables to anon,authenticated,service_role");
  await db.exec(sql("061-context-held-bootstrap.sql"));
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("begin");
  await db.query("insert into auth.users(id) values($1),($2)", [ids.buyer, ids.creator]);
  await db.query("insert into profiles(id,stripe_onboarding_complete,stripe_account_id) values($1,false,null),($2,true,'acct_LocalCreator')", [ids.buyer, ids.creator]);
  await db.query("insert into products(id,creator_id,type,title,is_active,price_cents,amount_cents,currency) values($1,$2,'mentorship','Local held',true,199900,199900,'usd')", [ids.product, ids.creator]);
  await db.query("insert into posts(id,product_id,creator_id,user_id) values($1,$2,$3,$3)", [ids.post, ids.product, ids.creator]);
  await db.query("insert into bookings(id,post_id,creator_id,buyer_id,status) values($1,$2,$3,$4,'booked')", [ids.booking, ids.post, ids.creator, ids.buyer]);
  config = { approvedContext: { ...context }, vercelEnvironment: "preview", configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`,
    configuredSiteOrigin: context.siteOrigin, stripeSecretKey: "sk_test_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "test",
    supabaseServiceKey: "sb_secret_SYNTHETICNOTACREDENTIAL", expectedApiVersion: "2025-10-29.clover" };
});
afterEach(async () => { await db.exec("rollback"); });
async function boundCustomer() {
  const c = JSON.stringify(config.approvedContext);
  await db.query("insert into public.exact_installment_context_pin_v2(context) values($1::jsonb)", [c]);
  reservationId = (await db.query<{ id: string }>("select * from public.reserve_exact_installment_context_v2($1,$2,3,$3::jsonb,$4::jsonb,$4::jsonb)",
    [ids.booking, ids.creator, c, JSON.stringify(fee)])).rows[0].id;
  const op = (await db.query<{ request: { params: { metadata: Record<string, string> } } }>("select * from public.plan_exact_customer_operation_v2($1,$2,$3::jsonb)", [reservationId, ids.creator, c])).rows[0];
  customerMetadata = op.request.params.metadata;
  const claimed = (await db.query<{ value: { attempt: { id: string; claimed_at: string } } }>("select public.claim_exact_customer_dispatch_v2($1,$2,$3::jsonb) value", [reservationId, ids.creator, c])).rows[0].value;
  await db.query("select public.bind_exact_customer_dispatch_v2($1,$2,$3::jsonb,$4,'cus_LocalHeld','req_LocalCustomer',$5)",
    [reservationId, ids.creator, c, claimed.attempt.id, Math.floor(Date.parse(claimed.attempt.claimed_at) / 1000)]);
}

test.each(["test", "live"] as const)("%s: actual SQL and SDK prepare once, inspect/repeat do not resend or touch money", async mode => {
  if (mode === "live") config = { ...config, approvedContext: { ...context, mode, siteOrigin: "https://synthetic-held.example" },
    vercelEnvironment: "production", configuredSiteOrigin: "https://synthetic-held.example", stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL", stripePublishableKeyMode: "live" };
  await boundCustomer(); const h = harness(), before = await financialSnapshot();
  expect(await h.runtime.inspectHeld(reservationId, ids.creator)).toMatchObject({ status: "not_attempted", stage: "product" });
  expect(h.writes()).toHaveLength(0);
  const result = await h.runtime.prepareHeld(reservationId, ids.creator).catch(() => {
    throw Error(`Synthetic stages: ${h.requests.slice(-5).map(r => `${r.method} ${r.path}`).join(", ")}`);
  });
  expect(result).toMatchObject({ status: "held_unpublished", customerId: "cus_LocalHeld", productId: "prod_LocalHeld", subscriptionId: "sub_LocalHeld",
    checkoutPublicationAllowed: false, accountingOperationsAllowed: false, replayAllowed: false });
  expect(await h.runtime.prepareHeld(reservationId, ids.creator)).toEqual(result);
  expect(await h.runtime.inspectHeld(reservationId, ids.creator)).toEqual(result);
  expect(h.writes().map(r => r.path)).toEqual(["/v1/products", "/v1/subscriptions", "/v1/subscriptions/sub_LocalHeld"]);
  expect((await db.query("select count(*)::int n from public.exact_context_held_steps_v2")).rows).toEqual([{ n: 3 }]);
  expect((await db.query("select count(*)::int n from public.exact_context_held_results_v2")).rows).toEqual([{ n: 3 }]);
  expect(await financialSnapshot()).toEqual(before);
});

test.each(["product", "subscription", "hold"])("lost %s create/update response stays uncertain without replacement", async stage => {
  await boundCustomer();
  const path = stage === "product" ? "/v1/products" : stage === "subscription" ? "/v1/subscriptions" : "/v1/subscriptions/sub_LocalHeld";
  const h = harness((b, p, m) => { if (p === path && m === "POST") throw Error("private-marker response lost"); return b; });
  await expect(h.runtime.prepareHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  const after = harness(undefined, h.objects);
  expect(await after.runtime.prepareHeld(reservationId, ids.creator)).toMatchObject({ status: "review_required", stage });
  expect(await after.runtime.inspectHeld(reservationId, ids.creator)).toMatchObject({ status: "review_required", stage });
  expect(after.writes()).toHaveLength(0);
});

test.each(["claim", "bind"])("lost hold %s response uses only known journal state", async which => {
  await boundCustomer(); let enabled = true;
  const h = harness((b, p) => {
    if (enabled && p === `/rest/v1/rpc/${which}_exact_held_step_v2` && (b.attempt as Body)?.stage === "hold") {
      enabled = false; throw Error("private-marker response lost");
    } return b;
  });
  await expect(h.runtime.prepareHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  const writes = h.writes().length;
  expect(await h.runtime.prepareHeld(reservationId, ids.creator)).toMatchObject({ status: which === "bind" ? "held_unpublished" : "review_required" });
  expect(h.writes()).toHaveLength(writes);
});

test.each(["mode", "amount", "destination", "card", "renewal", "hold"])("rejects changed subscription %s without binding/replay", async which => {
  await boundCustomer();
  const h = harness((b, p, m) => {
    if (m !== "POST" || p !== (which === "hold" ? "/v1/subscriptions/sub_LocalHeld" : "/v1/subscriptions")) return b;
    if (which === "mode") b.livemode = true;
    if (which === "amount") ((b.items as { data: Array<{ price: Body }> }).data[0].price).unit_amount = 66634;
    if (which === "destination") (b.transfer_data as Body).destination = "acct_Changed";
    if (which === "card") b.default_payment_method = "pm_Unexpected";
    if (which === "renewal") b.cancel_at = null;
    if (which === "hold") (b.pause_collection as Body).resumes_at = Math.floor(Date.now() / 1000) + 3600;
    return b;
  });
  await expect(h.runtime.prepareHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  const after = harness(undefined, h.objects);
  expect(await after.runtime.prepareHeld(reservationId, ids.creator)).toMatchObject({ status: "review_required", stage: which === "hold" ? "hold" : "subscription" });
  expect(after.writes()).toHaveLength(0);
});

test("fresh customer drift and stale quote block new stages", async () => {
  await boundCustomer();
  const card = harness((b, p) => { if (p.startsWith("/v1/customers/")) (b.invoice_settings as Body).default_payment_method = "pm_Unexpected"; return b; });
  await expect(card.runtime.prepareHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(card.writes()).toHaveLength(0);
  await db.query("update products set amount_cents=199901 where id=$1", [ids.product]);
  const stale = harness(); await expect(stale.runtime.prepareHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(stale.writes()).toHaveLength(0);
});

test("changed saved SQL request and account drift cannot dispatch", async () => {
  await boundCustomer();
  const h = harness((b, p) => {
    if (p.endsWith("claim_exact_held_step_v2")) ((b.attempt as { request: { params: Body } }).request.params).active = false;
    return b;
  });
  await expect(h.runtime.prepareHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.writes()).toHaveLength(0);
  const drift = harness((b, p) => p === "/v1/account" ? { ...b, id: "acct_Changed" } : b);
  await expect(drift.runtime.inspectHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(drift.writes()).toHaveLength(0);
});

test("061 denies client/direct service access, out-of-order claims, result rebinding and deletion", async () => {
  await boundCustomer(); const args = [reservationId, ids.creator, JSON.stringify(config.approvedContext)];
  await expect(rpc("claim_exact_held_step_v2", [...args, "subscription"])).rejects.toThrow("Bound owned product required");
  await expect(rpc("claim_exact_held_step_v2", [...args, "product", "extra"])).rejects.toThrow();
  await expect(rpc("claim_exact_held_step_v2", [reservationId, ids.buyer, args[2], "product"])).rejects.toThrow();
  for (const table of ["exact_context_held_steps_v2", "exact_context_held_results_v2"]) {
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect((await db.query("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed", [role, `public.${table}`])).rows).toEqual([{ allowed: false }]);
    }
  }
  const h = harness(); await h.runtime.prepareHeld(reservationId, ids.creator);
  const bound = (await db.query<{ step_id: string; provider_id: string; request_id: string }>("select b.* from public.exact_context_held_results_v2 b join public.exact_context_held_steps_v2 s on s.id=b.step_id where s.stage='hold'")).rows[0];
  await expect(rpc("bind_exact_held_step_v2", [...args, "hold", bound.step_id, "sub_Other", bound.request_id])).rejects.toThrow("Hold subscription differs");
  await expect(rpc("bind_exact_held_step_v2", [...args, "hold", bound.step_id, bound.provider_id, "req_Other"])).rejects.toThrow("already bound differently");
  for (const table of ["exact_context_held_steps_v2", "exact_context_held_results_v2"]) {
    await db.exec("savepoint immutable"); await expect(db.exec(`delete from public.${table}`)).rejects.toThrow("immutable");
    await db.exec("rollback to savepoint immutable; release savepoint immutable");
  }
});

test.each([31_000, -1_000])("held claim clock change %sms stops before provider send and never recycles", async delta => {
  await boundCustomer(); let claimed = false;
  const actualNow = Date.now.bind(Date), clock = jest.spyOn(Date, "now").mockImplementation(() => actualNow() + (claimed ? delta : 0));
  const h = harness((b, p) => { if (p.endsWith("claim_exact_held_step_v2")) claimed = true; return b; });
  try {
    await expect(h.runtime.prepareHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
    expect(h.writes()).toHaveLength(0);
  } finally { clock.mockRestore(); }
  const after = harness(); expect(await after.runtime.prepareHeld(reservationId, ids.creator)).toMatchObject({ status: "review_required", stage: "product" });
  expect(after.writes()).toHaveLength(0);
});

test("subscription request cannot move the durable product scheduling anchor", async () => {
  await boundCustomer();
  const h = harness((b, p) => {
    const a = b.attempt as { stage: string; anchor_seconds: number; request: { params: Body } } | undefined;
    if (p.endsWith("claim_exact_held_step_v2") && a?.stage === "subscription") {
      // Preserve internal request consistency and claimed_at's allowed range;
      // only cross-stage anchor equality detects this one-second shift.
      a.anchor_seconds -= 1;
      a.request.params.trial_end = Number(a.request.params.trial_end) - 1;
      a.request.params.cancel_at = Number(a.request.params.cancel_at) - 1;
    } return b;
  });
  await expect(h.runtime.prepareHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.writes().map(r => r.path)).toEqual(["/v1/products"]);
});

test("final customer recheck detects a card attached after the hold result", async () => {
  await boundCustomer(); let held = false;
  const h = harness((b, p, m) => {
    if (p === "/v1/subscriptions/sub_LocalHeld" && m === "POST") held = true;
    if (held && p.startsWith("/v1/customers/")) (b.invoice_settings as Body).default_payment_method = "pm_Unexpected";
    return b;
  });
  await expect(h.runtime.prepareHeld(reservationId, ids.creator)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(h.writes()).toHaveLength(3);
  expect((await db.query("select count(*)::int n from public.exact_context_held_results_v2")).rows).toEqual([{ n: 3 }]);
});

test("binding rejects old-snapshot isolation before any identity can be adopted", async () => {
  // Local transaction only. Do not weaken or rewrite the immutable journal to
  // test this guard, and do not claim a hosted multi-connection concurrency test.
  await db.exec("rollback; begin isolation level repeatable read");
  await expect(rpc("bind_exact_held_step_v2", [ids.booking, ids.creator, JSON.stringify(config.approvedContext), "product", ids.product,
    "prod_Other", "req_Other"])).rejects.toThrow("requires READ COMMITTED");
});
