// New planned-only v2 journal tests. Supabase is synthetic; no provider client,
// environment access, hosted schema or actual Stripe customer is involved.
import type { SupabaseClient } from "@supabase/supabase-js";
import { FIXED_PURCHASE_CONSENT_VERSION } from "../lib/installments/purchaseConsent";
import { buildExactContextCustomerPlan, readExactContextCustomerIntent, createExactContextCustomerIntentStore,
  CONTEXT_CUSTOMER_BOOTSTRAP_ERROR, type ExactContextCustomerPlan } from "../lib/installments/contextBootstrap";
import type { ExactPaymentContext } from "../lib/installments/paymentContext";

const ids = { reservation: "11111111-1111-4111-8111-111111111111", booking: "22222222-2222-4222-8222-222222222222",
  product: "33333333-3333-4333-8333-333333333333", post: "44444444-4444-4444-8444-444444444444",
  buyer: "55555555-5555-4555-8555-555555555555", creator: "66666666-6666-4666-8666-666666666666",
  intent: "77777777-7777-4777-8777-777777777777" };
function fixture(mode: "test" | "live" = "test") {
  const context: ExactPaymentContext = { version: "exact-payment-context-v1", mode, platformAccountId: "acct_SyntheticPlatform",
    supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa", siteOrigin: mode === "test" ? "https://synthetic-plan.vercel.app" : "https://synthetic-plan.example" };
  const evidence = { approvedContext: { ...context }, vercelEnvironment: mode === "test" ? "preview" : "production",
    stripeSecretKeyMode: mode, stripePublishableKeyMode: mode, observedPlatformAccountId: context.platformAccountId,
    observedSupabaseProjectRef: context.supabaseProjectRef, configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`,
    configuredSiteOrigin: context.siteOrigin };
  const fee = { enabled: true, basisPoints: 290, fixedCents: 30, version: "synthetic-v1" };
  const reservation = { id: ids.reservation, booking_id: ids.booking, context: { ...context }, status: "reserved_not_issuable",
    created_at: "2026-09-08T10:00:00.123Z", terms: { version: "exact-cents-context-v2", currency: "usd", bookingId: ids.booking,
      productId: ids.product, postId: ids.post, buyerId: ids.buyer, creatorId: ids.creator, destinationId: "acct_SyntheticCreator",
      title: "Synthetic customer plan", totalCents: 199900, paymentCount: 3,
      firstPaymentFeeSchedule: { ...fee }, renewalFeeSchedule: { ...fee } } };
  const input = () => ({ reservationRow: reservation, contextEvidence: evidence, actorId: ids.creator });
  const plan = () => buildExactContextCustomerPlan(input());
  const rowFrom = (p: ExactContextCustomerPlan) => JSON.parse(JSON.stringify({ id: ids.intent, reservation_id: p.reservationId,
    context: p.context, context_hash: p.contextHash, terms_hash: p.termsHash, operation_kind: p.operationKind,
    request: p.request, request_hash: p.requestHash, idempotency_key: p.idempotencyKey,
    status: p.status, created_at: "2026-09-08T10:00:01.456Z" })) as Record<string, unknown>;
  const intent = rowFrom(plan());
  const response: { data: unknown; error: unknown } = { data: intent, error: null };
  const single = jest.fn(async () => response);
  const admin = { rpc: jest.fn(() => ({ single })), from: jest.fn() };
  const store = () => createExactContextCustomerIntentStore({ admin: admin as unknown as SupabaseClient,
    reservationRow: reservation, contextEvidence: evidence });
  const read = () => readExactContextCustomerIntent({ ...input(), intentRow: intent });
  return { context, evidence, reservation, input, plan, rowFrom, intent, response, single, admin, store, read };
}

test.each(["test", "live"] as const)("synthetic %s request has exact pinned envelope/metadata and no dispatch or replay permission", mode => {
  const f = fixture(mode), plan = f.plan(), intent = f.read();
  expect(plan.request).toEqual({ version: "exact-context-customer-request-v1", apiVersion: "2025-10-29.clover",
    method: "POST", path: "/v1/customers", params: { metadata: {
      installment_collection_version: "exact-cents-context-v2", installment_plan_id: ids.reservation,
      booking_id: ids.booking, buyer_id: ids.buyer, creator_id: ids.creator,
      context_hash: plan.contextHash, terms_hash: plan.termsHash, operation_kind: "customer.create",
    } } });
  expect(Object.keys(plan.request.params)).toEqual(["metadata"]);
  expect(plan.idempotencyKey).toMatch(/^cn-exact-v2-customer:[a-f0-9]{64}$/);
  expect(plan.idempotencyKey.length).toBeLessThanOrEqual(255);
  expect(plan.idempotencyKey).not.toContain(ids.reservation);
  expect(intent).toMatchObject({ ...plan, id: ids.intent, createdAt: 1788861601,
    status: "planned_not_dispatchable", providerOperationsAllowed: false, accountingOperationsAllowed: false, replayAllowed: false });
  for (const value of [plan, plan.context, plan.request, plan.request.params, plan.request.params.metadata, intent]) expect(Object.isFrozen(value)).toBe(true);
  expect(f.admin.rpc).not.toHaveBeenCalled();
});

test("same immutable values survive JSON/key-order changes with identical hashes and key", () => {
  const f = fixture(), expected = f.plan();
  const row = JSON.parse(JSON.stringify(f.reservation));
  row.terms = Object.fromEntries(Object.entries(row.terms).reverse());
  row.context = Object.fromEntries(Object.entries(row.context).reverse());
  const reordered = buildExactContextCustomerPlan({ ...f.input(), reservationRow: row });
  expect(reordered).toEqual(expected);
  expect(f.read().request).toEqual(expected.request);
});

test("UTF-8 framing keeps Unicode, separators, escaping and interior whitespace distinct without normalization", () => {
  const titles = ["Café 🎬", "Cafe\u0301 🎬", "a.b:c|d", "ab.c:d|", "A B", "A  B", "A\nB", 'A "B" \\ C'];
  const plans = titles.map(title => { const f = fixture(); f.reservation.terms.title = title; return f.plan(); });
  expect(new Set(plans.map(p => p.termsHash)).size).toBe(titles.length);
  expect(new Set(plans.map(p => p.requestHash)).size).toBe(titles.length);
  expect(new Set(plans.map(p => p.idempotencyKey)).size).toBe(titles.length);
  expect(new Set(plans.map(p => p.contextHash)).size).toBe(1);
});

test.each(["bad\u0000title", "bad\uD800title", "bad\uDC00title"])("PostgreSQL-unrepresentable title case %# fails instead of UTF8 replacement collision", title => {
  const f = fixture(); f.reservation.terms.title = title;
  expect(f.plan).toThrow(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR);
});

test.each(["total", "count", "first-bps", "first-fixed", "first-version", "renewal-bps", "renewal-fixed", "renewal-version", "destination", "product"])("immutable %s change yields a different full-terms request namespace", which => {
  const f = fixture(), before = f.plan(), t = f.reservation.terms;
  if (which === "total") t.totalCents += 1;
  if (which === "count") t.paymentCount = 4;
  if (which === "first-bps") t.firstPaymentFeeSchedule.basisPoints += 1;
  if (which === "first-fixed") t.firstPaymentFeeSchedule.fixedCents += 1;
  if (which === "first-version") t.firstPaymentFeeSchedule.version = "different-version";
  if (which === "renewal-bps") t.renewalFeeSchedule.basisPoints += 1;
  if (which === "renewal-fixed") t.renewalFeeSchedule.fixedCents += 1;
  if (which === "renewal-version") t.renewalFeeSchedule.version = "different-version";
  if (which === "destination") t.destinationId = "acct_AnotherCreator";
  if (which === "product") t.productId = ids.post;
  const after = f.plan();
  expect(after.contextHash).toBe(before.contextHash);
  expect(after.termsHash).not.toBe(before.termsHash);
  expect(after.requestHash).not.toBe(before.requestHash);
  expect(after.idempotencyKey).not.toBe(before.idempotencyKey);
});

test.each(["account", "project", "origin", "reservation"])("%s identity change cannot reuse another contextual plan's key", which => {
  const f = fixture(), before = f.plan();
  if (which === "account") {
    f.reservation.context.platformAccountId = "acct_AnotherPlatform";
    f.evidence.approvedContext.platformAccountId = "acct_AnotherPlatform";
    f.evidence.observedPlatformAccountId = "acct_AnotherPlatform";
  }
  if (which === "project") {
    f.reservation.context.supabaseProjectRef = "bbbbbbbbbbbbbbbbbbbb";
    f.evidence.approvedContext.supabaseProjectRef = "bbbbbbbbbbbbbbbbbbbb";
    f.evidence.observedSupabaseProjectRef = "bbbbbbbbbbbbbbbbbbbb";
    f.evidence.configuredSupabaseUrl = "https://bbbbbbbbbbbbbbbbbbbb.supabase.co";
  }
  if (which === "origin") {
    f.reservation.context.siteOrigin = "https://another.vercel.app";
    f.evidence.approvedContext.siteOrigin = "https://another.vercel.app";
    f.evidence.configuredSiteOrigin = "https://another.vercel.app";
  }
  if (which === "reservation") f.reservation.id = ids.intent;
  expect(f.plan().idempotencyKey).not.toBe(before.idempotencyKey);
});

test.each(["status", "version", "owner", "context"])("unowned/unsupported reservation %s never becomes a plan", which => {
  const f = fixture();
  if (which === "status") f.reservation.status = "active";
  if (which === "version") f.reservation.terms.version = "exact-cents-held-v1";
  if (which === "owner") f.reservation.terms.creatorId = ids.buyer;
  if (which === "context") f.evidence.observedPlatformAccountId = "acct_Wrong";
  expect(f.plan).toThrow(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR);
  expect(f.admin.rpc).not.toHaveBeenCalled();
});

test.each(["reservation_id", "context_hash", "terms_hash", "operation_kind", "request_hash", "idempotency_key", "status", "created_at", "id"])("wrong persisted %s cannot be adopted", key => {
  const f = fixture(); f.intent[key] = "wrong-private-marker";
  expect(f.read).toThrow(new Error(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR));
});

test.each(["context", "apiVersion", "path", "metadata", "email", "card", "test_clock", "extra-result"])("persisted %s mismatch/extra parameter is rejected even when all saved hashes match", which => {
  const f = fixture();
  const request = f.intent.request as { apiVersion: string; path: string; params: { metadata: Record<string, string> } };
  if (which === "context") f.intent.context = { ...f.context, platformAccountId: "acct_Wrong" };
  if (which === "apiVersion") request.apiVersion = "2099-01-01.future";
  if (which === "path") request.path = "/v1/payment_intents";
  if (which === "metadata") request.params.metadata.buyer_id = ids.creator;
  if (which === "email") Object.assign(request.params, { email: "private-marker@example.invalid" });
  if (which === "card") Object.assign(request.params, { payment_method: "pm_Forbidden" });
  if (which === "test_clock") Object.assign(request.params, { test_clock: "clock_Forbidden" });
  if (which === "extra-result") f.intent.stripe_customer_id = "cus_Forbidden";
  expect(f.read).toThrow(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR);
});

test("accessor/proxy diagnostics do not leak or execute a request getter", () => {
  const f = fixture(), getter = jest.fn(() => { throw Error("private-marker"); });
  Object.defineProperty(f.intent, "request", { enumerable: true, get: getter });
  expect(f.read).toThrow(new Error(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR));
  expect(getter).not.toHaveBeenCalled();
  const proxy = new Proxy({}, { ownKeys() { throw new Error("private-marker"); } });
  expect(() => readExactContextCustomerIntent({ ...f.input(), intentRow: proxy })).toThrow(new Error(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR));
});

test("adapter exposes only plan/load, sends no caller request/hash/key, and repeat planning stays non-dispatchable", async () => {
  const f = fixture(), store = f.store();
  expect(Object.keys(store).sort()).toEqual(["load", "plan"]);
  const first = await store.plan(ids.creator), second = await store.plan(ids.creator);
  expect(first).toEqual(second);
  expect(first.replayAllowed).toBe(false);
  expect(first.providerOperationsAllowed).toBe(false);
  expect(f.admin.rpc).toHaveBeenCalledTimes(2);
  for (const call of f.admin.rpc.mock.calls) expect(call).toEqual(["plan_exact_customer_operation_v2", {
    p_reservation_id: ids.reservation, p_actor_id: ids.creator, p_context: f.context,
  }]);
  expect(f.admin.from).not.toHaveBeenCalled();
});

test("load uses known reservation and JSON-encoded context in owned no-write GET RPC", async () => {
  const f = fixture();
  expect((await f.store().load(ids.creator)).id).toBe(ids.intent);
  expect(f.admin.rpc).toHaveBeenCalledWith("read_exact_customer_operation_v2", {
    p_reservation_id: ids.reservation, p_actor_id: ids.creator, p_context: JSON.stringify(f.context),
  }, { get: true });
  expect(f.admin.from).not.toHaveBeenCalled();
});

test("factory snapshots the complete reservation/evidence before caller mutation or async work", async () => {
  const f = fixture(), expected = f.plan(), store = f.store();
  f.reservation.terms.title = "Changed later";
  f.reservation.terms.firstPaymentFeeSchedule.fixedCents = 300;
  f.reservation.context.platformAccountId = "acct_Changed";
  f.evidence.approvedContext.platformAccountId = "acct_Changed";
  f.evidence.observedPlatformAccountId = "acct_Changed";
  const result = await store.plan(ids.creator);
  expect(result.termsHash).toBe(expected.termsHash);
  expect(result.requestHash).toBe(expected.requestHash);
  expect(result.context.platformAccountId).toBe(expected.context.platformAccountId);
  Object.assign(f.intent, { terms_hash: "changed-after-return" });
  expect(result.termsHash).toBe(expected.termsHash);
});

test("invalid or unowned actor IDs fail before any storage call", async () => {
  const f = fixture(), store = f.store();
  await expect(store.plan(ids.buyer)).rejects.toThrow(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR);
  await expect(store.plan("invalid")).rejects.toThrow(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR);
  await expect(store.load(ids.buyer)).rejects.toThrow(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR);
  await expect(store.load("invalid")).rejects.toThrow(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR);
  expect(f.admin.rpc).not.toHaveBeenCalled();
});

test.each(["error", "missing", "wrong-row"])("ambiguous %s storage result never becomes legacy absence or a fresh-create instruction", async which => {
  const f = fixture(), store = f.store();
  if (which === "error") f.response.error = { message: "private-marker" };
  if (which === "missing") f.response.data = null;
  if (which === "wrong-row") f.intent.reservation_id = ids.booking;
  await expect(store.plan(ids.creator)).rejects.toThrow(new Error(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR));
  await expect(store.load(ids.creator)).rejects.toThrow(new Error(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR));
});

test("old plan timestamp never implies Stripe idempotency retention or replay permission", () => {
  const f = fixture();
  f.reservation.created_at = "2020-01-01T00:00:00Z";
  f.intent.created_at = "2020-01-01T00:00:01Z";
  const result = f.read();
  expect(result.replayAllowed).toBe(false);
  expect(result.providerOperationsAllowed).toBe(false);
  expect(Object.keys(result)).not.toContain("dispatchStartedAt");
  expect(Object.keys(result)).not.toContain("retryAfter");
});

test("intent predating the immutable reservation fails closed in parser and both adapter operations", async () => {
  const f = fixture(), store = f.store();
  f.intent.created_at = "2026-09-08T09:59:59.999Z";
  expect(f.read).toThrow(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR);
  await expect(store.plan(ids.creator)).rejects.toThrow(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR);
  await expect(store.load(ids.creator)).rejects.toThrow(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR);
});

test("lost planning response recovers by known reservation using only one owned GET, without knowing operation ID", async () => {
  const f = fixture(), store = f.store();
  // Synthetic committed intent exists, but its original response is uncertain.
  f.single.mockResolvedValueOnce({ data: null, error: { message: "lost-private-response" } });
  await expect(store.plan(ids.creator)).rejects.toThrow(new Error(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR));
  const recovered = await store.load(ids.creator);
  expect(recovered.id).toBe(ids.intent);
  expect(recovered.reservationId).toBe(ids.reservation);
  expect(recovered.providerOperationsAllowed).toBe(false);
  expect(recovered.replayAllowed).toBe(false);
  expect(f.admin.rpc.mock.calls).toEqual([
    ["plan_exact_customer_operation_v2", { p_reservation_id: ids.reservation, p_actor_id: ids.creator, p_context: f.context }],
    ["read_exact_customer_operation_v2", { p_reservation_id: ids.reservation, p_actor_id: ids.creator,
      p_context: JSON.stringify(f.context) }, { get: true }],
  ]);
  expect(f.admin.from).not.toHaveBeenCalled();
});

describe("prospective fixed-total consent hash boundary", () => {
  test("new acceptance version changes terms/request identity, not amounts or context", () => {
    const f = fixture(), original = f.plan();
    Object.assign(f.reservation.terms, { purchaseConsentVersion: FIXED_PURCHASE_CONSENT_VERSION });
    const updated = f.plan();
    expect(updated.contextHash).toBe(original.contextHash);
    expect(updated.termsHash).not.toBe(original.termsHash);
    expect(updated.requestHash).not.toBe(original.requestHash);
    expect(updated.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(f.reservation.terms.totalCents).toBe(199900);
    expect(f.reservation.terms.paymentCount).toBe(3);
    expect(() => readExactContextCustomerIntent({ ...f.input(), intentRow: f.intent })).toThrow();
    const current = f.rowFrom(updated);
    expect(readExactContextCustomerIntent({ ...f.input(), intentRow: current }).termsHash).toBe(updated.termsHash);
  });
  test.each([null, undefined, "", "accepted", "fixed-total-purchase-consent-v2", true, 1])(
    "rejects missing or unsupported version value %p instead of using legacy bytes", value => {
      const f = fixture(); Object.assign(f.reservation.terms, { purchaseConsentVersion: value });
      expect(() => f.plan()).toThrow(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR);
    });
  test("a consent getter is rejected without executing it", () => {
    const f = fixture(), getter = jest.fn(() => FIXED_PURCHASE_CONSENT_VERSION);
    Object.defineProperty(f.reservation.terms, "purchaseConsentVersion", { enumerable: true, get: getter });
    expect(() => f.plan()).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  test("key order does not change prospective request bytes", () => {
    const f = fixture(); Object.assign(f.reservation.terms, { purchaseConsentVersion: FIXED_PURCHASE_CONSENT_VERSION });
    const expected = f.plan(), reordered = JSON.parse(JSON.stringify(f.reservation));
    reordered.terms = Object.fromEntries(Object.entries(reordered.terms).reverse());
    expect(buildExactContextCustomerPlan({ ...f.input(), reservationRow: reordered })).toEqual(expected);
  });
});
