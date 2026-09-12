// Real installed Stripe/Supabase SDKs; every response is synthetic in-memory.
// No environment reads, hosted requests, Stripe writes, or payments.
import { buildExactContextCustomerPlan } from "../lib/installments/contextBootstrap";
import { CONTEXT_RUNTIME_ERROR, createExactContextBootstrapPlanner, createExactContextRuntime,
  type ExactContextRuntimeConfig } from "../lib/installments/contextRuntime";
import type { ExactPaymentContext } from "../lib/installments/paymentContext";

const ids = { reservation: "11111111-1111-4111-8111-111111111111", booking: "22222222-2222-4222-8222-222222222222",
  product: "33333333-3333-4333-8333-333333333333", post: "44444444-4444-4444-8444-444444444444",
  buyer: "55555555-5555-4555-8555-555555555555", creator: "66666666-6666-4666-8666-666666666666",
  intent: "77777777-7777-4777-8777-777777777777" };
const planPath = "/rest/v1/rpc/plan_exact_customer_operation_v2";
const readPath = "/rest/v1/rpc/read_exact_customer_operation_v2";
type Reply = { body: unknown; status?: number; finalUrl?: string; redirected?: boolean; contentType?: string };
function fixture(mode: "test" | "live" = "test") {
  const context: ExactPaymentContext = { version: "exact-payment-context-v1", mode,
    platformAccountId: "acct_LocalOnly", supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa",
    siteOrigin: mode === "test" ? "https://synthetic-context.vercel.app" : "https://synthetic-context.example" };
  const config: ExactContextRuntimeConfig = { approvedContext: context, vercelEnvironment: mode === "test" ? "preview" : "production",
    configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`, configuredSiteOrigin: context.siteOrigin,
    stripeSecretKey: `sk_${mode}_SYNTHETICNOTACREDENTIAL`, stripePublishableKeyMode: mode,
    supabaseServiceKey: "sb_secret_SYNTHETICNOTACREDENTIAL", expectedApiVersion: "2025-10-29.clover" };
  const evidence = { approvedContext: context, vercelEnvironment: config.vercelEnvironment,
    stripeSecretKeyMode: mode, stripePublishableKeyMode: mode, observedPlatformAccountId: context.platformAccountId,
    observedSupabaseProjectRef: context.supabaseProjectRef, configuredSupabaseUrl: config.configuredSupabaseUrl,
    configuredSiteOrigin: context.siteOrigin };
  const fee = { enabled: true, basisPoints: 290, fixedCents: 30, version: "local-only-v1" };
  const row = { id: ids.reservation, booking_id: ids.booking, context: { ...context }, status: "reserved_not_issuable",
    created_at: "2026-09-08T10:00:00Z", terms: { version: "exact-cents-context-v2", currency: "usd", bookingId: ids.booking,
      productId: ids.product, postId: ids.post, buyerId: ids.buyer, creatorId: ids.creator, destinationId: "acct_LocalCreator",
      title: "Local-only customer plan", totalCents: 199900, paymentCount: 3,
      firstPaymentFeeSchedule: { ...fee }, renewalFeeSchedule: { ...fee } } };
  const expected = buildExactContextCustomerPlan({ reservationRow: row, contextEvidence: evidence, actorId: ids.creator });
  const intent = { id: ids.intent, reservation_id: row.id, context: expected.context, context_hash: expected.contextHash,
    terms_hash: expected.termsHash, operation_kind: expected.operationKind, request: expected.request,
    request_hash: expected.requestHash, idempotency_key: expected.idempotencyKey,
    status: expected.status, created_at: "2026-09-08T10:01:00Z" };
  const pin = { version: "exact-context-pin-observation-v1", context: { ...context },
    status: "reserved_not_issuable", source: "owner_provisioned_database_pin" };
  const account = { object: "account", id: context.platformAccountId, email: "private-marker@example.invalid" };
  const balance = { object: "balance", livemode: mode === "live" };
  const requests: { url: URL; init: RequestInit }[] = [];
  const behavior: { change?: (reply: Reply, request: URL, ordinal: number) => Reply } = {};
  const fetcher: typeof fetch = jest.fn(async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init: init ?? {} });
    let reply: Reply;
    if (url.pathname === "/v1/account") reply = { body: account };
    else if (url.pathname === "/v1/balance") reply = { body: balance };
    else if (url.pathname.endsWith("/read_exact_installment_context_pin_v2")) reply = { body: pin };
    else if (url.pathname.endsWith("/exact_installment_context_reservations_v2")) reply = { body: [row] };
    else if (url.pathname === planPath || url.pathname === readPath) reply = { body: intent, contentType: "application/vnd.pgrst.object+json" };
    else throw Error("Unexpected synthetic request");
    reply = behavior.change?.(reply, url, requests.length) ?? reply;
    const bytes = JSON.stringify(reply.body);
    const response = new Response(bytes, { status: reply.status ?? 200,
      headers: { "content-type": reply.contentType ?? "application/json", "request-id": "req_LocalOnly" } });
    Object.defineProperties(response, { url: { value: reply.finalUrl ?? url.href }, redirected: { value: reply.redirected ?? false },
      // Preserve JSON bytes while avoiding Jest's native Response realm mismatch.
      json: { value: async () => JSON.parse(bytes) } });
    return response;
  });
  const planner = (override: Partial<ExactContextRuntimeConfig> = {}) => createExactContextBootstrapPlanner({ ...config, ...override }, fetcher);
  const writes = () => requests.filter(r => r.init.method === "POST");
  return { context, config, evidence, expected, row, intent, pin, account, balance, requests, fetcher, behavior, planner, writes };
}

test.each(["test", "live"] as const)("real SDK synthetic %s planner writes one fixed RPC, rechecks identity, never dispatches Stripe", async mode => {
  const f = fixture(mode), planner = f.planner();
  expect(f.requests).toHaveLength(0);
  expect(Object.keys(planner)).toEqual(["planCustomer", "readCustomerPlan"]);
  const result = await planner.planCustomer(ids.reservation, ids.creator);
  expect(result).toEqual({ ...f.expected, id: ids.intent, createdAt: Date.parse(f.intent.created_at) / 1000 });
  expect(result).toMatchObject({ status: "planned_not_dispatchable", providerOperationsAllowed: false,
    accountingOperationsAllowed: false, replayAllowed: false });
  expect(f.requests.map(r => r.url.pathname)).toEqual([
    "/v1/account", "/v1/balance", "/rest/v1/rpc/read_exact_installment_context_pin_v2",
    "/rest/v1/exact_installment_context_reservations_v2", planPath,
    "/v1/account", "/v1/balance", "/rest/v1/rpc/read_exact_installment_context_pin_v2",
  ]);
  expect([...f.requests[3].url.searchParams.entries()]).toEqual([
    ["select", "id,booking_id,context,terms,status,created_at"], ["id", `eq.${ids.reservation}`], ["terms->>creatorId", `eq.${ids.creator}`],
  ]);
  expect(f.writes()).toHaveLength(1);
  const request = f.writes()[0];
  expect(request.url.origin).toBe(f.config.configuredSupabaseUrl);
  expect(request.url.search).toBe("");
  expect(JSON.parse(String(request.init.body))).toEqual({ p_reservation_id: ids.reservation, p_actor_id: ids.creator, p_context: f.context });
  expect(new Headers(request.init.headers).get("content-profile")).toBe("public");
  expect(new Headers(request.init.headers).get("accept")).toBe("application/vnd.pgrst.object+json");
  for (const { url, init } of f.requests) {
    expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
    expect(init.signal).toBeDefined();
    const h = new Headers(init.headers);
    expect(h.has("stripe-account") || h.has("stripe-context") || h.has("idempotency-key")).toBe(false);
    if (url.origin === "https://api.stripe.com") expect(init.method).toBe("GET");
    else expect(url.origin).toBe(f.config.configuredSupabaseUrl);
  }
  expect(JSON.stringify(result)).not.toMatch(/SYNTHETICNOTACREDENTIAL|private-marker|email|payment_method|test_clock/);
  for (const object of [planner, result, result.request, result.request.params, result.request.params.metadata]) expect(Object.isFrozen(object)).toBe(true);
});

test("inspection factory retains its original read-only surface, planner exposes no generic client", () => {
  const f = fixture();
  expect(Object.keys(createExactContextRuntime(f.config, f.fetcher)).sort()).toEqual(["inspectEvent", "observeContext"]);
  expect(Object.keys(f.planner())).toEqual(["planCustomer", "readCustomerPlan"]);
  expect(f.requests).toHaveLength(0);
});

test.each(["bad-id", "wrong-actor", "wrong-row-id", "wrong-owner", "missing-row", "wrong-status", "wrong-context", "api-version"])(
  "%s fails before a plan write", async which => {
    const f = fixture();
    if (which === "wrong-row-id") f.row.id = ids.product;
    if (which === "wrong-owner") f.row.terms.creatorId = ids.buyer;
    if (which === "wrong-status") f.row.status = "active";
    if (which === "wrong-context") f.row.context.platformAccountId = "acct_Different";
    if (which === "missing-row") f.behavior.change = (reply, url) => url.pathname.endsWith("_reservations_v2") ? { body: [] } : reply;
    const p = f.planner(which === "api-version" ? { expectedApiVersion: "2026-01-01.other" } : {});
    await expect(p.planCustomer(which === "bad-id" ? "not-a-reservation" : ids.reservation,
      which === "wrong-actor" ? ids.buyer : ids.creator)).rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
    expect(f.writes()).toHaveLength(0);
  });

test.each(["account", "balance", "pin"])("%s drift before planning prevents the database write", async which => {
  const f = fixture();
  if (which === "account") f.account.id = "acct_Drift";
  if (which === "balance") f.balance.livemode = true;
  if (which === "pin") f.pin.context.supabaseProjectRef = "bbbbbbbbbbbbbbbbbbbb";
  await expect(f.planner().planCustomer(ids.reservation, ids.creator)).rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
  expect(f.writes()).toHaveLength(0);
});

test.each(["lost-response", "api-error", "different-endpoint", "redirected", "missing-url", "non-json", "json-lookalike", "created-status"])(
  "%s at the plan response is redacted, never retried; a plan may already exist", async which => {
    const f = fixture();
    f.behavior.change = (reply, url) => {
      if (url.pathname !== planPath) return reply;
      if (which === "lost-response") throw Error(`private-marker ${f.config.supabaseServiceKey}`);
      if (which === "api-error") return { body: { message: `private-marker ${f.config.supabaseServiceKey}` }, status: 503 };
      if (which === "different-endpoint") return { ...reply, finalUrl: `https://bbbbbbbbbbbbbbbbbbbb.supabase.co${planPath}` };
      if (which === "redirected") return { ...reply, redirected: true };
      if (which === "missing-url") return { ...reply, finalUrl: "" };
      if (which === "non-json") return { ...reply, contentType: "text/html" };
      if (which === "json-lookalike") return { ...reply, contentType: "application/json-unsafe" };
      return { ...reply, status: 201 };
    };
    await expect(f.planner().planCustomer(ids.reservation, ids.creator)).rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
    expect(f.writes()).toHaveLength(1);
    expect(f.requests).toHaveLength(5);
  });

test.each(["request", "hash", "key", "status", "reservation", "extra", "missing"])("malformed saved %s cannot escape as a valid plan", async which => {
  const f = fixture();
  f.behavior.change = (reply, url) => {
    if (url.pathname !== planPath) return reply;
    const row = JSON.parse(JSON.stringify(f.intent));
    if (which === "request") row.request.params.email = "private-marker@example.invalid";
    if (which === "hash") row.terms_hash = "0".repeat(64);
    if (which === "key") row.idempotency_key = "caller-controlled";
    if (which === "status") row.status = "dispatchable";
    if (which === "reservation") row.reservation_id = ids.booking;
    if (which === "extra") row.stripe_customer_id = "cus_Invented";
    return { ...reply, body: which === "missing" ? null : row };
  };
  await expect(f.planner().planCustomer(ids.reservation, ids.creator)).rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
  expect(f.writes()).toHaveLength(1);
  expect(f.requests.filter(r => r.url.origin === "https://api.stripe.com").every(r => r.init.method === "GET")).toBe(true);
});

test.each(["account", "balance", "pin"])("%s changes after RPC commit: no rollback, retry, binding or dispatch", async which => {
  const f = fixture();
  f.behavior.change = (reply, url, ordinal) => {
    if (ordinal <= 5) return reply;
    if (which === "account" && url.pathname === "/v1/account") return { body: { ...f.account, id: "acct_Changed" } };
    if (which === "balance" && url.pathname === "/v1/balance") return { body: { ...f.balance, livemode: true } };
    if (which === "pin" && url.pathname.endsWith("_pin_v2")) return { body: { ...f.pin, status: "active" } };
    return reply;
  };
  await expect(f.planner().planCustomer(ids.reservation, ids.creator)).rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
  expect(f.writes()).toHaveLength(1);
});

test("a later explicit database-plan repeat uses fresh evidence and identical arguments, not a Stripe retry", async () => {
  const f = fixture(), planner = f.planner();
  const first = await planner.planCustomer(ids.reservation, ids.creator);
  const second = await planner.planCustomer(ids.reservation, ids.creator);
  expect(second).toEqual(first);
  expect(f.writes()).toHaveLength(2);
  expect(f.writes()[1].init.body).toBe(f.writes()[0].init.body);
  expect(f.requests.filter(r => r.url.pathname === "/v1/account")).toHaveLength(4);
  expect(second.replayAllowed).toBe(false);
});

test("stale pre-write evidence fails before planning and post-commit expiry never retries", async () => {
  const start = Date.now();
  for (const phase of ["before", "after"]) {
    const f = fixture(), clock = jest.spyOn(Date, "now").mockImplementation(() =>
      f.requests.length >= (phase === "before" ? 4 : 5) ? start + 30_001 : start);
    try {
      await expect(f.planner().planCustomer(ids.reservation, ids.creator)).rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
      expect(f.writes()).toHaveLength(phase === "before" ? 0 : 1);
    } finally { clock.mockRestore(); }
  }
});

test("real SDK owned recovery uses the known reservation and a JSON-encoded GET context, not an unknown operation ID", async () => {
  const f = fixture();
  const result = await f.planner().readCustomerPlan(ids.reservation, ids.creator);
  expect(result).toMatchObject({ id: ids.intent, reservationId: ids.reservation, status: "planned_not_dispatchable", replayAllowed: false });
  expect(f.requests.map(r => r.url.pathname)).toEqual([
    "/v1/account", "/v1/balance", "/rest/v1/rpc/read_exact_installment_context_pin_v2",
    "/rest/v1/exact_installment_context_reservations_v2", readPath,
    "/v1/account", "/v1/balance", "/rest/v1/rpc/read_exact_installment_context_pin_v2",
  ]);
  const rpc = f.requests[4];
  expect([...rpc.url.searchParams.entries()]).toEqual([
    ["p_reservation_id", ids.reservation], ["p_actor_id", ids.creator], ["p_context", JSON.stringify(f.context)],
  ]);
  expect(new Headers(rpc.init.headers).get("accept-profile")).toBe("public");
  expect(new Headers(rpc.init.headers).get("accept")).toBe("application/vnd.pgrst.object+json");
  expect(f.requests.every(r => r.init.method === "GET" && r.init.body == null)).toBe(true);
  expect(f.writes()).toHaveLength(0);
});

test("lost write response can be recovered by reservation read without another plan or Stripe call", async () => {
  const f = fixture(), planner = f.planner();
  f.behavior.change = (reply, url) => {
    if (url.pathname === planPath) throw new Error("Synthetic response lost after commit");
    return reply;
  };
  await expect(planner.planCustomer(ids.reservation, ids.creator)).rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
  expect(f.writes()).toHaveLength(1);
  const result = await planner.readCustomerPlan(ids.reservation, ids.creator);
  expect(result.id).toBe(ids.intent);
  expect(result.replayAllowed).toBe(false);
  expect(f.writes()).toHaveLength(1);
  expect(f.requests.slice(5).every(r => r.init.method === "GET")).toBe(true);
});

test.each(["bad-id", "wrong-actor", "wrong-owner", "missing-row", "wrong-context", "api-version"])(
  "owned recovery %s refuses before the read RPC", async which => {
    const f = fixture();
    if (which === "wrong-owner") f.row.terms.creatorId = ids.buyer;
    if (which === "missing-row") f.behavior.change = (reply, url) => url.pathname.endsWith("_reservations_v2") ? { body: [] } : reply;
    if (which === "wrong-context") f.row.context.platformAccountId = "acct_Other";
    await expect(f.planner(which === "api-version" ? { expectedApiVersion: "2026-01-01.other" } : {}).readCustomerPlan(
      which === "bad-id" ? "not-a-reservation" : ids.reservation, which === "wrong-actor" ? ids.buyer : ids.creator))
      .rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
    expect(f.requests.some(r => r.url.pathname === readPath)).toBe(false);
    expect(f.writes()).toHaveLength(0);
  });

test.each(["missing", "wrong-reservation", "bad-key", "provider-binding", "lost-response", "bad-origin", "json-lookalike"])(
  "owned recovery %s never becomes permission to recreate or retry", async which => {
    const f = fixture();
    f.behavior.change = (reply, url) => {
      if (url.pathname !== readPath) return reply;
      if (which === "lost-response") throw new Error(`private-marker ${f.config.supabaseServiceKey}`);
      if (which === "bad-origin") return { ...reply, finalUrl: "https://different.invalid" };
      if (which === "json-lookalike") return { ...reply, contentType: "application/json-unsafe" };
      if (which === "missing") return { ...reply, body: null };
      const body = JSON.parse(JSON.stringify(f.intent));
      if (which === "wrong-reservation") body.reservation_id = ids.booking;
      if (which === "bad-key") body.idempotency_key = "untrusted-key";
      if (which === "provider-binding") body.stripe_customer_id = "cus_Unowned";
      return { ...reply, body };
    };
    await expect(f.planner().readCustomerPlan(ids.reservation, ids.creator)).rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
    expect(f.requests.filter(r => r.url.pathname === readPath)).toHaveLength(1);
    expect(f.writes()).toHaveLength(0);
  });

test("owned recovery final identity drift refuses the saved plan without any write", async () => {
  const f = fixture();
  f.behavior.change = (reply, url, ordinal) => ordinal > 5 && url.pathname === "/v1/account"
    ? { body: { ...f.account, id: "acct_Different" } } : reply;
  await expect(f.planner().readCustomerPlan(ids.reservation, ids.creator)).rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
  expect(f.writes()).toHaveLength(0);
});

test("owned recovery expiry before and after saved-plan lookup stays read-only", async () => {
  const start = Date.now();
  for (const phase of ["before", "after"]) {
    const f = fixture(), clock = jest.spyOn(Date, "now").mockImplementation(() =>
      f.requests.length >= (phase === "before" ? 4 : 5) ? start + 30_001 : start);
    try {
      await expect(f.planner().readCustomerPlan(ids.reservation, ids.creator)).rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
      expect(f.requests.filter(r => r.url.pathname === readPath)).toHaveLength(phase === "before" ? 0 : 1);
      expect(f.writes()).toHaveLength(0);
    } finally { clock.mockRestore(); }
  }
});
