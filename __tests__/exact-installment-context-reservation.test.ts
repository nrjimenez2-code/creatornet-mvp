// New v2 blocked-reservation parser/RPC boundary only; every client is a fake.
// No provider, hosted database, environment settings, old checkout or payment.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExactPaymentContext } from "../lib/installments/paymentContext";
import { CONTEXT_RESERVATION_VERSION, createExactContextReservationStore, readExactContextReservation } from "../lib/installments/contextReservation";
import { readContextFirstReceipt } from "../lib/installments/contextInvoice";
import { FIXED_PURCHASE_CONSENT_VERSION } from "../lib/installments/purchaseConsent";
import { calculateInstallmentPlan } from "../lib/installmentPlan";

const ids = { reservation: "11111111-1111-4111-8111-111111111111", booking: "22222222-2222-4222-8222-222222222222",
  product: "33333333-3333-4333-8333-333333333333", post: "44444444-4444-4444-8444-444444444444",
  buyer: "55555555-5555-4555-8555-555555555555", creator: "66666666-6666-4666-8666-666666666666" };
const failure = "Exact context reservation requires review";
function fixture(mode: "test" | "live" = "test") {
  const context: ExactPaymentContext = { version: "exact-payment-context-v1", mode,
    platformAccountId: "acct_SyntheticPlatform", supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa",
    siteOrigin: mode === "test" ? "https://synthetic-reservation.vercel.app" : "https://synthetic-reservation.example" };
  const evidence = { approvedContext: { ...context }, vercelEnvironment: mode === "test" ? "preview" : "production",
    stripeSecretKeyMode: mode, stripePublishableKeyMode: mode, observedPlatformAccountId: context.platformAccountId,
    observedSupabaseProjectRef: context.supabaseProjectRef, configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`,
    configuredSiteOrigin: context.siteOrigin };
  const first = { enabled: true, basisPoints: 290, fixedCents: 30, version: "synthetic-first-v1" };
  const renewal = { enabled: true, basisPoints: 360, fixedCents: 30, version: "synthetic-renewal-v1" };
  const terms = { version: CONTEXT_RESERVATION_VERSION, currency: "usd", bookingId: ids.booking,
    productId: ids.product, postId: ids.post, buyerId: ids.buyer, creatorId: ids.creator,
    destinationId: "acct_SyntheticCreator", title: "Synthetic blocked mentorship", totalCents: 199900, paymentCount: 3,
    firstPaymentFeeSchedule: { ...first }, renewalFeeSchedule: { ...renewal } };
  const row = { id: ids.reservation, booking_id: ids.booking, context: { ...context }, terms,
    status: "reserved_not_issuable", created_at: "2026-09-08T10:00:00Z" };
  const response: { data: unknown; error: unknown } = { data: row, error: null };
  const single = jest.fn(async () => response), maybeSingle = jest.fn(async () => response);
  const eq = jest.fn(() => ({ maybeSingle })), select = jest.fn(() => ({ eq }));
  const admin = { rpc: jest.fn(() => ({ single })), from: jest.fn(() => ({ select })) };
  const store = () => createExactContextReservationStore({ admin: admin as unknown as SupabaseClient, context, contextEvidence: evidence });
  const input = { actorId: ids.creator, bookingId: ids.booking, paymentCount: 3,
    firstPaymentFeeSchedule: first, renewalFeeSchedule: renewal };
  return { context, evidence, terms, row, response, admin, single, select, eq, maybeSingle, store, input };
}

test.each(["test", "live"] as const)("%s context survives a blocked v2 reservation round-trip without becoming a payment capability", mode => {
  const f = fixture(mode);
  const saved = readExactContextReservation(JSON.parse(JSON.stringify(f.row)), f.evidence);
  expect(saved.context).toEqual(f.context);
  expect(saved.terms).toEqual(f.terms);
  expect(saved.status).toBe("reserved_not_issuable");
  expect(saved.providerOperationsAllowed).toBe(false);
  for (const value of [saved, saved.context, saved.terms, saved.terms.firstPaymentFeeSchedule, saved.terms.renewalFeeSchedule]) {
    expect(Object.isFrozen(value)).toBe(true);
  }
  f.row.context.platformAccountId = "acct_Changed";
  f.terms.firstPaymentFeeSchedule.fixedCents = 99;
  expect(saved.context.platformAccountId).toBe("acct_SyntheticPlatform");
  expect(saved.terms.firstPaymentFeeSchedule.fixedCents).toBe(30);
});

test.each([
  (f: ReturnType<typeof fixture>) => { f.terms.version = "exact-cents-held-v1"; },
  (f: ReturnType<typeof fixture>) => { Object.assign(f.terms, { previewOrigin: f.context.siteOrigin }); },
  (f: ReturnType<typeof fixture>) => { Object.assign(f.terms, { bookingPaymentId: ids.reservation }); },
  (f: ReturnType<typeof fixture>) => { Object.assign(f.terms, { context: f.context }); },
  (f: ReturnType<typeof fixture>) => { f.row.status = "active"; },
  (f: ReturnType<typeof fixture>) => { f.row.status = "preparing"; },
  (f: ReturnType<typeof fixture>) => { f.row.booking_id = ids.product; },
  (f: ReturnType<typeof fixture>) => { f.row.created_at = "not a timestamp"; },
  (f: ReturnType<typeof fixture>) => { f.terms.paymentCount = 1; },
  (f: ReturnType<typeof fixture>) => { f.terms.firstPaymentFeeSchedule.fixedCents = 99999999; },
  (f: ReturnType<typeof fixture>) => { f.terms.firstPaymentFeeSchedule.version = "v".repeat(201); },
  (f: ReturnType<typeof fixture>) => { f.row.context.platformAccountId = "acct_Different"; },
  (f: ReturnType<typeof fixture>) => { f.row.context.mode = "live"; },
  (f: ReturnType<typeof fixture>) => { Object.assign(f.row, { stripe_checkout_session_id: "cs_test_synthetic" }); },
])("incompatible/mixed persisted row case %# fails closed without v1 parsing", change => {
  const f = fixture(); change(f);
  expect(() => readExactContextReservation(f.row, f.evidence)).toThrow(failure);
});

test("accessors, extra fields and proxy exceptions cannot run through scalar parsing or leak errors", () => {
  const f = fixture();
  const getter = jest.fn(() => { throw Error("synthetic-private-marker"); });
  const row = Object.defineProperty({ ...f.row }, "context", { enumerable: true, get: getter });
  expect(() => readExactContextReservation(row, f.evidence)).toThrow(failure);
  expect(getter).not.toHaveBeenCalled();
  const proxy = new Proxy(f.row, { ownKeys() { throw Error("synthetic-private-marker"); } });
  expect(() => readExactContextReservation(proxy, f.evidence)).toThrow(failure);
});

test("adapter uses only the new blocked RPC, never old claims, Checkout or financial methods", async () => {
  const f = fixture();
  const store = f.store();
  expect(Object.keys(store).sort()).toEqual(["load", "reserve"]);
  const saved = await store.reserve(f.input);
  expect(saved.providerOperationsAllowed).toBe(false);
  expect(f.admin.rpc).toHaveBeenCalledTimes(1);
  expect(f.admin.rpc).toHaveBeenCalledWith("reserve_exact_installment_context_v2", {
    p_booking_id: ids.booking, p_actor_id: ids.creator, p_count: 3, p_context: f.context,
    p_first_fee: f.input.firstPaymentFeeSchedule, p_renewal_fee: f.input.renewalFeeSchedule,
  });
  expect(f.admin.from).not.toHaveBeenCalled();
});

test("fresh factory evidence is pinned against caller mutation before the RPC completes", async () => {
  const f = fixture(); const store = f.store();
  const pending = store.reserve(f.input);
  Object.assign(f.context, { siteOrigin: "https://changed.example" });
  f.evidence.observedPlatformAccountId = "acct_Changed";
  f.input.firstPaymentFeeSchedule.fixedCents = 1000;
  expect((await pending).context.platformAccountId).toBe("acct_SyntheticPlatform");
  const params = f.admin.rpc.mock.calls[0] as unknown as [string, { p_context: ExactPaymentContext; p_first_fee: { fixedCents: number } }];
  expect(params[1].p_first_fee.fixedCents).toBe(30);
  expect(params[1].p_context.siteOrigin).toBe("https://synthetic-reservation.vercel.app");
});

test("wrong initial context or invalid request makes no RPC call", async () => {
  const f = fixture();
  f.evidence.observedPlatformAccountId = "acct_Wrong";
  expect(f.store).toThrow(failure);
  expect(f.admin.rpc).not.toHaveBeenCalled();
  const ok = fixture(), store = ok.store();
  await expect(store.reserve({ ...ok.input, paymentCount: 99 })).rejects.toThrow(failure);
  await expect(store.reserve({ ...ok.input, actorId: "not-an-actor" })).rejects.toThrow(failure);
  expect(ok.admin.rpc).not.toHaveBeenCalled();
});

test("stateful evidence descriptors are read once before validation, never swapped before an RPC", async () => {
  const f = fixture();
  let reads = 0;
  const evidence = new Proxy(f.evidence, { getOwnPropertyDescriptor(target, key) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (key === "observedPlatformAccountId") {
      reads += 1;
      return { ...descriptor, value: reads === 1 ? f.context.platformAccountId : "acct_SwappedAfterValidation" };
    }
    return descriptor;
  } });
  const store = createExactContextReservationStore({ admin: f.admin as unknown as SupabaseClient,
    context: f.context, contextEvidence: evidence });
  expect((await store.reserve(f.input)).context.platformAccountId).toBe(f.context.platformAccountId);
  expect(reads).toBe(1);
  const bad = fixture();
  const wrongEvidence = new Proxy(bad.evidence, { getOwnPropertyDescriptor(target, key) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    return key === "observedPlatformAccountId" ? { ...descriptor, value: "acct_WrongInitially" } : descriptor;
  } });
  expect(() => createExactContextReservationStore({ admin: bad.admin as unknown as SupabaseClient,
    context: bad.context, contextEvidence: wrongEvidence })).toThrow(failure);
  expect(bad.admin.rpc).not.toHaveBeenCalled();
});

test.each(["error", "missing", "owner", "context", "fees", "count"])("ambiguous/mismatched RPC %s never returns a usable reservation", async which => {
  const f = fixture();
  if (which === "error") f.response.error = { message: "synthetic-private-marker" };
  if (which === "missing") f.response.data = null;
  if (which === "owner") f.terms.creatorId = ids.buyer;
  if (which === "context") f.row.context.supabaseProjectRef = "bbbbbbbbbbbbbbbbbbbb";
  if (which === "fees") f.terms.renewalFeeSchedule.fixedCents = 33;
  if (which === "count") f.terms.paymentCount = 4;
  await expect(f.store().reserve(f.input)).rejects.toThrow(failure);
  expect(f.admin.rpc).toHaveBeenCalledTimes(1);
});

test("load requires an actual owned v2 row; absence/errors/wrong IDs cannot become legacy absence", async () => {
  const f = fixture(); const store = f.store();
  expect((await store.load(ids.reservation, ids.creator)).id).toBe(ids.reservation);
  expect(f.admin.from).toHaveBeenCalledWith("exact_installment_context_reservations_v2");
  expect(f.select).toHaveBeenCalledWith("id,booking_id,context,terms,status,created_at");
  expect(f.eq).toHaveBeenCalledWith("id", ids.reservation);
  await expect(store.load(ids.reservation, ids.buyer)).rejects.toThrow(failure);
  f.row.id = ids.product;
  await expect(store.load(ids.reservation, ids.creator)).rejects.toThrow(failure);
  f.response.data = null;
  await expect(store.load(ids.reservation, ids.creator)).rejects.toThrow(failure);
  f.response.error = { message: "synthetic-private-marker" };
  await expect(store.load(ids.reservation, ids.creator)).rejects.toThrow(failure);
  expect(f.admin.rpc).not.toHaveBeenCalled();
});
function receiptFixture() {
  const f = fixture(), r = readExactContextReservation(f.row, f.evidence);
  const first = calculateInstallmentPlan(r.terms.totalCents, r.terms.paymentCount, r.terms.renewalFeeSchedule, r.terms.firstPaymentFeeSchedule).payments[0];
  const receipt = { session_id: "cs_test_Receipt", payment_intent_id: "pi_Receipt", charge_id: "ch_Receipt",
    balance_transaction_id: "txn_Receipt", payment_method_id: "pm_Receipt", amount_cents: first.amountCents,
    application_fee_cents: first.fees.totalCreatorDeductionCents, actual_stripe_fee_cents: 0, paid_at: r.createdAt + 1 };
  return { r, receipt };
}
test.each([undefined, null, "wrong-version"])("duration invoice parser rejects missing or wrong owned consent %s", consent => {
  const { r, receipt } = receiptFixture();
  const agreed: typeof r = { ...r, terms: { ...r.terms, purchaseConsentVersion: FIXED_PURCHASE_CONSENT_VERSION } };
  expect(() => readContextFirstReceipt({ ...receipt, ...(consent === undefined ? {} : { purchase_consent_version: consent }) }, agreed))
    .toThrow("Context invoice requires review");
});
test("duration invoice parser accepts only the agreement's exact consent version", () => {
  const { r, receipt } = receiptFixture(), paid = { ...receipt, purchase_consent_version: FIXED_PURCHASE_CONSENT_VERSION };
  expect(readContextFirstReceipt(paid, { ...r, terms: { ...r.terms, purchaseConsentVersion: FIXED_PURCHASE_CONSENT_VERSION } })).toEqual(paid);
});
test("duration invoice parser normalizes legacy SQL NULL without fabricating consent or mutating the response", () => {
  const { r, receipt } = receiptFixture(), old = Object.freeze({ ...receipt, purchase_consent_version: null });
  expect(readContextFirstReceipt(old, r)).toEqual(receipt);
  expect(readContextFirstReceipt(receipt, r)).toEqual(receipt);
  expect(old.purchase_consent_version).toBeNull();
  expect(() => readContextFirstReceipt({ ...receipt, purchase_consent_version: FIXED_PURCHASE_CONSENT_VERSION }, r)).toThrow();
});
