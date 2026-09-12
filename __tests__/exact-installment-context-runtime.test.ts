// Actual Stripe/Supabase SDK composition with synthetic in-memory Fetch only.
// No SDK method mocks, environment access, hosted records or provider mutations.
import { assertFreshExactRuntimeContextObservation, CONTEXT_RUNTIME_ERROR, createExactContextRuntime,
  type ExactContextRuntimeConfig } from "../lib/installments/contextRuntime";
import type { ExactPaymentContext } from "../lib/installments/paymentContext";

const ids = { reservation: "11111111-1111-4111-8111-111111111111", booking: "22222222-2222-4222-8222-222222222222",
  product: "33333333-3333-4333-8333-333333333333", post: "44444444-4444-4444-8444-444444444444",
  buyer: "55555555-5555-4555-8555-555555555555", creator: "66666666-6666-4666-8666-666666666666", event: "evt_LocalOnly" };
type Reply = { body: unknown; status?: number; finalUrl?: string; redirected?: boolean; contentType?: string };
function fixture(mode: "test" | "live" = "test") {
  const context: ExactPaymentContext = { version: "exact-payment-context-v1", mode,
    platformAccountId: "acct_LocalOnly", supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa",
    siteOrigin: mode === "test" ? "https://synthetic-context.vercel.app" : "https://synthetic-context.example" };
  const config: ExactContextRuntimeConfig = { approvedContext: context, vercelEnvironment: mode === "test" ? "preview" : "production",
    configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`, configuredSiteOrigin: context.siteOrigin,
    stripeSecretKey: `sk_${mode}_SYNTHETICNOTACREDENTIAL`, stripePublishableKeyMode: mode,
    supabaseServiceKey: "sb_secret_SYNTHETICNOTACREDENTIAL", expectedApiVersion: "2025-10-29.clover" };
  const fee = { enabled: true, basisPoints: 290, fixedCents: 30, version: "local-only-v1" };
  const row = { id: ids.reservation, booking_id: ids.booking, context: { ...context }, status: "reserved_not_issuable",
    created_at: "2026-09-08T10:00:00Z", terms: { version: "exact-cents-context-v2", currency: "usd", bookingId: ids.booking,
      productId: ids.product, postId: ids.post, buyerId: ids.buyer, creatorId: ids.creator, destinationId: "acct_LocalCreator",
      title: "Local-only blocked reservation", totalCents: 199900, paymentCount: 3,
      firstPaymentFeeSchedule: { ...fee }, renewalFeeSchedule: { ...fee } } };
  const pin = { version: "exact-context-pin-observation-v1", context: { ...context },
    status: "reserved_not_issuable", source: "owner_provisioned_database_pin" };
  const account = { object: "account", id: context.platformAccountId, email: "private-marker@example.invalid" };
  const balance = { object: "balance", livemode: mode === "live", available: [{ amount: 987654321 }] };
  const event = { object: "event", id: ids.event, api_version: config.expectedApiVersion, type: "charge.updated",
    created: 1788861700, livemode: mode === "live", data: { object: { object: "charge", id: "ch_LocalOnly",
      livemode: mode === "live", metadata: { installment_collection_version: "exact-cents-context-v2",
        installment_plan_id: ids.reservation }, billing_details: { email: "private-marker@example.invalid" } } } };
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
    else if (url.pathname === `/v1/events/${ids.event}`) reply = { body: event };
    else throw Error("Unexpected synthetic transport request");
    reply = behavior.change?.(reply, url, requests.length) ?? reply;
    const body = JSON.stringify(reply.body);
    const response = new Response(body, { status: reply.status ?? 200,
      headers: { "content-type": reply.contentType ?? "application/json", "request-id": "req_LocalOnly" } });
    Object.defineProperties(response, { url: { value: reply.finalUrl ?? url.href },
      redirected: { value: reply.redirected ?? false },
      // Jest's native Response lives in another realm. Real SDKs still parse the
      // same JSON bytes; keep parsed records in this module's ordinary realm.
      json: { value: async () => JSON.parse(body) } });
    return response;
  });
  const runtime = (override: Partial<ExactContextRuntimeConfig> = {}) => createExactContextRuntime({ ...config, ...override }, fetcher);
  return { context, config, account, balance, pin, row, event, requests, fetcher, behavior, runtime };
}

test.each(["test", "live"] as const)("real SDKs observe synthetic %s account/mode and unique endpoint pin, never grant money authority", async mode => {
  const f = fixture(mode), runtime = f.runtime();
  expect(f.requests).toHaveLength(0);
  expect(Object.keys(runtime).sort()).toEqual(["inspectEvent", "observeContext"]);
  const observation = await runtime.observeContext();
  expect(observation.context).toEqual(f.context);
  expect(observation.contextEvidence).toMatchObject({ observedPlatformAccountId: f.context.platformAccountId,
    observedSupabaseProjectRef: f.context.supabaseProjectRef, stripeSecretKeyMode: mode });
  expect(observation.databaseIdentity).toBe("authenticated_project_api_endpoint");
  expect(observation.providerOperationsAllowed).toBe(false);
  expect(observation.accountingOperationsAllowed).toBe(false);
  expect(() => assertFreshExactRuntimeContextObservation(observation)).not.toThrow();
  for (const object of [runtime, observation, observation.context, observation.contextEvidence]) expect(Object.isFrozen(object)).toBe(true);
  expect(f.requests.map(r => r.url.pathname)).toEqual([
    "/v1/account", "/v1/balance", "/rest/v1/rpc/read_exact_installment_context_pin_v2",
  ]);
  for (const { url, init } of f.requests) {
    expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", cache: "no-store" });
    expect(init.body == null).toBe(true);
    const headers = new Headers(init.headers);
    expect(headers.has("stripe-account")).toBe(false);
    expect(headers.has("stripe-context")).toBe(false);
    if (url.host === "api.stripe.com") expect(headers.get("stripe-version")).toBe(f.config.expectedApiVersion);
    else expect(url.origin).toBe(f.config.configuredSupabaseUrl);
  }
  expect(JSON.stringify(observation)).not.toMatch(/SYNTHETICNOTACREDENTIAL|private-marker|987654321/);
});

test("a copied/serialized observation has no runtime provenance", async () => {
  const observation = await fixture().runtime().observeContext();
  for (const copy of [{ ...observation }, JSON.parse(JSON.stringify(observation)), null]) {
    expect(() => assertFreshExactRuntimeContextObservation(copy)).toThrow(CONTEXT_RUNTIME_ERROR);
  }
});

test("freshness rejects wall-clock rewind behind completed observation and expiry from read start", async () => {
  const runtime = fixture().runtime(), start = Date.now();
  // Local mock of clock samples only; no machine clock or payment runtime changes.
  const samples = jest.spyOn(Date, "now").mockReturnValue(start + 1000).mockReturnValueOnce(start);
  try {
    const observation = await runtime.observeContext();
    expect(observation.startedAtMilliseconds).toBe(start);
    expect(observation.observedAtMilliseconds).toBe(start + 1000);
    samples.mockReturnValue(start + 500);
    expect(() => assertFreshExactRuntimeContextObservation(observation)).toThrow(CONTEXT_RUNTIME_ERROR);
    samples.mockReturnValue(start + 1000);
    expect(() => assertFreshExactRuntimeContextObservation(observation)).not.toThrow();
    samples.mockReturnValue(start + 30_001);
    expect(() => assertFreshExactRuntimeContextObservation(observation)).toThrow(CONTEXT_RUNTIME_ERROR);
  } finally { samples.mockRestore(); }
});

test("caller mutation cannot replace approved context or endpoint after factory creation", async () => {
  const f = fixture(), runtime = f.runtime();
  Object.assign(f.context, { platformAccountId: "acct_Mutated", supabaseProjectRef: "bbbbbbbbbbbbbbbbbbbb" });
  Object.assign(f.config, { stripeSecretKey: "sk_live_REPLACED", configuredSupabaseUrl: "https://changed.invalid" });
  const observation = await runtime.observeContext();
  expect(observation.context.platformAccountId).toBe("acct_LocalOnly");
  expect(f.requests.every(r => ["api.stripe.com", "aaaaaaaaaaaaaaaaaaaa.supabase.co"].includes(r.url.host))).toBe(true);
});

test.each([
  { configuredSupabaseUrl: "https://bbbbbbbbbbbbbbbbbbbb.supabase.co" },
  { configuredSupabaseUrl: "http://aaaaaaaaaaaaaaaaaaaa.supabase.co" },
  { configuredSupabaseUrl: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co/" },
  { configuredSiteOrigin: "https://different.vercel.app" },
  { stripeSecretKey: "sk_live_SYNTHETICNOTACREDENTIAL" },
  { stripeSecretKey: "sk_test_UNSAFE\nHEADER" },
  { supabaseServiceKey: "" },
  { expectedApiVersion: "" },
  { stripePublishableKeyMode: "live" },
  { vercelEnvironment: "production" },
] as Partial<ExactContextRuntimeConfig>[])("bad explicit config case %# fails before any SDK request", override => {
  const f = fixture();
  expect(() => f.runtime(override)).toThrow(CONTEXT_RUNTIME_ERROR);
  expect(f.requests).toHaveLength(0);
});

test("configuration accessors and injected client/header options fail without executing getters", () => {
  const f = fixture(), getter = jest.fn(() => "private-marker");
  const bad = Object.defineProperty({ ...f.config }, "stripeSecretKey", { enumerable: true, get: getter });
  expect(() => createExactContextRuntime(bad, f.fetcher)).toThrow(CONTEXT_RUNTIME_ERROR);
  expect(getter).not.toHaveBeenCalled();
  expect(() => createExactContextRuntime({ ...f.config, stripeAccount: "acct_Override" } as ExactContextRuntimeConfig, f.fetcher))
    .toThrow(CONTEXT_RUNTIME_ERROR);
  expect(f.requests).toHaveLength(0);
});

test.each(["account", "mode", "missing-pin", "copied-pin", "pin-status", "pin-source", "pin-extra"])("mismatched/unavailable %s cannot produce observed evidence", async which => {
  const f = fixture();
  if (which === "account") f.account.id = "acct_Different";
  if (which === "mode") f.balance.livemode = true;
  if (which === "copied-pin") f.pin.context = { ...f.pin.context, supabaseProjectRef: "bbbbbbbbbbbbbbbbbbbb" };
  if (which === "pin-status") f.pin.status = "active";
  if (which === "pin-source") f.pin.source = "project_ref_from_guc";
  if (which === "pin-extra") Object.assign(f.pin, { observedProjectRef: f.context.supabaseProjectRef });
  if (which === "missing-pin") f.behavior.change = (reply, url) => url.pathname.endsWith("_pin_v2") ? { body: null } : reply;
  await expect(f.runtime().observeContext()).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(f.requests.length).toBeLessThanOrEqual(3);
});

test.each(["account", "balance", "pin"])("a later %s observation rejects drift instead of reusing cached evidence", async which => {
  const f = fixture(), runtime = f.runtime();
  await runtime.observeContext();
  f.behavior.change = (reply, url, ordinal) => {
    if (ordinal > 3 && url.pathname.endsWith(which === "pin" ? "_pin_v2" : `/${which}`)) {
      return { body: which === "account" ? { ...f.account, id: "acct_Changed" } : which === "balance"
        ? { ...f.balance, livemode: true } : { ...f.pin, context: { ...f.context, mode: "live" } } };
    }
    return reply;
  };
  await expect(runtime.observeContext()).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
});

test.each(["missing-final-url", "different-endpoint", "redirected", "redirect-status", "non-json", "api-error"])("%s response never attests a project even if its body is a matching copied pin", async which => {
  const f = fixture();
  f.behavior.change = (reply, url) => {
    if (!url.pathname.endsWith("_pin_v2")) return reply;
    if (which === "missing-final-url") return { ...reply, finalUrl: "" };
    if (which === "different-endpoint") return { ...reply, finalUrl: `https://bbbbbbbbbbbbbbbbbbbb.supabase.co${url.pathname}` };
    if (which === "redirected") return { ...reply, redirected: true };
    if (which === "redirect-status") return { ...reply, status: 302 };
    if (which === "non-json") return { ...reply, contentType: "text/html" };
    return { body: { message: "private-marker", details: f.config.supabaseServiceKey }, status: 403 };
  };
  await expect(f.runtime().observeContext()).rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
  expect(f.requests).toHaveLength(3); // No retry or alternate destination.
});

test("transport exceptions are redacted, never retried and never returned as provider payloads", async () => {
  const f = fixture();
  const transport = jest.fn(async () => { throw new Error(`private-marker ${f.config.stripeSecretKey}`); });
  await expect(createExactContextRuntime(f.config, transport).observeContext()).rejects.toThrow(new Error(CONTEXT_RUNTIME_ERROR));
  expect(transport).toHaveBeenCalledTimes(1);
});

test("same private SDK fetches one event between fresh account/mode/pin reads; result remains unbound and cannot ACK", async () => {
  const f = fixture();
  const result = await f.runtime().inspectEvent(ids.reservation, ids.creator, ids.event);
  expect(result).toMatchObject({ candidateReservationId: ids.reservation, eventId: ids.event, disposition: "unbound_reservation",
    providerOperationsAllowed: false, accountingOperationsAllowed: false, mayAcknowledge: false });
  expect(f.requests.map(r => r.url.pathname)).toEqual([
    "/v1/account", "/v1/balance", "/rest/v1/rpc/read_exact_installment_context_pin_v2",
    "/rest/v1/exact_installment_context_reservations_v2", `/v1/events/${ids.event}`,
    "/v1/account", "/v1/balance", "/rest/v1/rpc/read_exact_installment_context_pin_v2",
  ]);
  expect([...f.requests[3].url.searchParams.entries()]).toEqual([
    ["select", "id,booking_id,context,terms,status,created_at"], ["id", `eq.${ids.reservation}`], ["terms->>creatorId", `eq.${ids.creator}`],
  ]);
  expect(f.requests.every(r => r.init.method === "GET")).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private-marker|billing_details|SYNTHETICNOTACREDENTIAL/);
});

test.each(["reservation", "actor", "event"])("invalid %s identifier makes no provider or database call", async which => {
  const f = fixture();
  await expect(f.runtime().inspectEvent(which === "reservation" ? "invalid" : ids.reservation,
    which === "actor" ? "invalid" : ids.creator, which === "event" ? "evt_../../v1/balance" : ids.event)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(f.requests).toHaveLength(0);
});

test.each(["owner", "id", "context", "missing"])("wrong/missing reservation %s fails before event retrieval", async which => {
  const f = fixture();
  if (which === "owner") f.row.terms.creatorId = ids.buyer;
  if (which === "id") f.row.id = ids.booking;
  if (which === "context") f.row.context = { ...f.row.context, platformAccountId: "acct_Different" };
  if (which === "missing") f.behavior.change = (reply, url) => url.pathname.endsWith("_reservations_v2") ? { body: [] } : reply;
  await expect(f.runtime().inspectEvent(ids.reservation, ids.creator, ids.event)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(f.requests).toHaveLength(4);
});

test.each(["account", "api-version", "event-id", "protocol"])("retrieved event %s mismatch is not promoted by genuine endpoint evidence", async which => {
  const f = fixture();
  if (which === "account") Object.assign(f.event, { account: "acct_LocalCreator" });
  if (which === "api-version") f.event.api_version = "2020-01-01";
  if (which === "event-id") f.event.id = "evt_Wrong";
  if (which === "protocol") f.event.data.object.metadata.installment_collection_version = "exact-cents-held-v1";
  await expect(f.runtime().inspectEvent(ids.reservation, ids.creator, ids.event)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(f.requests.every(r => r.init.method === "GET")).toBe(true);
});

test("account change after event read quarantines the snapshot before reconciliation", async () => {
  const f = fixture();
  f.behavior.change = (reply, url, ordinal) => ordinal === 6 && url.pathname === "/v1/account"
    ? { body: { ...f.account, id: "acct_ChangedAfterEvent" } } : reply;
  await expect(f.runtime().inspectEvent(ids.reservation, ids.creator, ids.event)).rejects.toThrow(CONTEXT_RUNTIME_ERROR);
  expect(f.requests).toHaveLength(6);
});
