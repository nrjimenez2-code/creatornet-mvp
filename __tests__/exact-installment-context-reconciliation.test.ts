// Pure synthetic observations only. No provider, database, receipt or claim.
import { inspectContextReservationEvent, CONTEXT_RECONCILIATION_ERROR } from "../lib/installments/contextReconciliation";
import { CONTEXT_RESERVATION_VERSION } from "../lib/installments/contextReservation";
import type { ExactPaymentContext } from "../lib/installments/paymentContext";

function fixture(mode: "test" | "live" = "test") {
  const context: ExactPaymentContext = { version: "exact-payment-context-v1", mode,
    platformAccountId: "acct_SyntheticPlatform", supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa",
    siteOrigin: mode === "test" ? "https://synthetic-reconcile.vercel.app" : "https://synthetic-reconcile.example" };
  const id = "11111111-1111-4111-8111-111111111111";
  const terms = { version: CONTEXT_RESERVATION_VERSION, currency: "usd", bookingId: "22222222-2222-4222-8222-222222222222",
    productId: "33333333-3333-4333-8333-333333333333", postId: "44444444-4444-4444-8444-444444444444",
    buyerId: "55555555-5555-4555-8555-555555555555", creatorId: "66666666-6666-4666-8666-666666666666",
    destinationId: "acct_SyntheticCreator", title: "Synthetic blocked reservation", totalCents: 199900, paymentCount: 3,
    firstPaymentFeeSchedule: { enabled: true, basisPoints: 290, fixedCents: 30, version: "synthetic-v1" },
    renewalFeeSchedule: { enabled: true, basisPoints: 360, fixedCents: 30, version: "synthetic-v1" } };
  const row = { id, booking_id: terms.bookingId, context, terms, status: "reserved_not_issuable", created_at: "2026-09-08T10:00:00Z" };
  const evidence = { approvedContext: { ...context }, vercelEnvironment: mode === "test" ? "preview" : "production",
    stripeSecretKeyMode: mode, stripePublishableKeyMode: mode, observedPlatformAccountId: context.platformAccountId,
    observedSupabaseProjectRef: context.supabaseProjectRef, configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`,
    configuredSiteOrigin: context.siteOrigin };
  const object = { id: "pi_synthetic", object: "payment_intent", livemode: mode === "live", status: "succeeded",
    metadata: { installment_collection_version: CONTEXT_RESERVATION_VERSION, installment_plan_id: id,
      booking_id: terms.bookingId, buyer_id: terms.buyerId, creator_id: terms.creatorId },
    transfer_data: { destination: terms.destinationId }, client_secret: "SYNTHETIC_NOT_FOR_OUTPUT" };
  const event = { id: "evt_synthetic", object: "event", type: "payment_intent.succeeded", created: 1788861601,
    api_version: "2025-10-29.clover", livemode: mode === "live", data: { object } };
  const args = { reservationRow: row, contextEvidence: evidence, eventId: event.id, expectedApiVersion: event.api_version, event };
  return { context, terms, row, evidence, object, event, args };
}
type Fixture = ReturnType<typeof fixture>;

test("September original Event remains an unbound observation with no payment or ACK authority", () => {
  const f = fixture(); const october = inspectContextReservationEvent(f.args);
  f.event.api_version = "2025-09-30.clover"; const snapshot = JSON.stringify(f.event);
  const september = inspectContextReservationEvent(f.args);
  expect(september).toEqual(october);
  expect(september).toMatchObject({ mayAcknowledge: false, providerOperationsAllowed: false, accountingOperationsAllowed: false });
  expect(JSON.stringify(f.event)).toBe(snapshot);
});
test.each(["test", "live"] as const)("%s successful-looking event with matching metadata remains unbound, never paid or acknowledged", mode => {
  const f = fixture(mode), result = inspectContextReservationEvent(f.args);
  expect(result).toMatchObject({ candidateReservationId: f.row.id, context: f.context,
    eventId: f.event.id, resourceId: f.object.id, disposition: "unbound_reservation",
    providerOperationsAllowed: false, accountingOperationsAllowed: false, mayAcknowledge: false });
  expect(result.observationKey).toMatch(/^cn-exact-v2-observe:[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toMatch(/client_secret|SYNTHETIC_NOT_FOR_OUTPUT|succeeded.*paid|stripe:/);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.context)).toBe(true);
});

test.each([
  ["checkout.session.completed", "checkout.session", "cs_synthetic"],
  ["checkout.session.expired", "checkout.session", "cs_test_synthetic"],
  ["invoice.created", "invoice", "in_synthetic"],
  ["invoice.paid", "invoice", "in_synthetic"],
  ["charge.refunded", "charge", "ch_synthetic"],
  ["charge.dispute.closed", "dispute", "du_synthetic"],
  ["customer.subscription.deleted", "subscription", "sub_synthetic"],
])("%s is only a bounded observation, not the corresponding financial lifecycle action", (type, object, id) => {
  const f = fixture(); f.event.type = type; Object.assign(f.object, { object, id });
  expect(inspectContextReservationEvent(f.args).mayAcknowledge).toBe(false);
});

test.each([
  ["event mode", (f: Fixture) => { f.event.livemode = true; }],
  ["object mode", (f: Fixture) => { f.object.livemode = true; }],
  ["event identity", (f: Fixture) => { f.event.id = "evt_other"; }],
  ["event kind", (f: Fixture) => { f.event.object = "event_notification"; }],
  ["API version", (f: Fixture) => { f.event.api_version = "2026-08-26.preview"; }],
  ["null API version", (f: Fixture) => { Object.assign(f.event, { api_version: null }); }],
  ["invalid configured version", (f: Fixture) => { f.args.expectedApiVersion = "anything"; }],
  ["pre-reservation event", (f: Fixture) => { f.event.created = 1; }],
  ["noninteger event time", (f: Fixture) => { f.event.created += 0.5; }],
  ["connected-account scope", (f: Fixture) => { Object.assign(f.event, { account: f.terms.destinationId }); }],
  ["explicit platform in connected-account field", (f: Fixture) => { Object.assign(f.event, { account: f.context.platformAccountId }); }],
  ["alternate auth context", (f: Fixture) => { Object.assign(f.event, { context: f.context.platformAccountId }); }],
  ["empty account override", (f: Fixture) => { Object.assign(f.event, { account: "" }); }],
  ["wrong object kind", (f: Fixture) => { f.object.object = "charge"; }],
  ["wrong object identity", (f: Fixture) => { f.object.id = "ch_synthetic"; }],
  ["wrong creator destination", (f: Fixture) => { f.object.transfer_data.destination = f.context.platformAccountId; }],
  ["old protocol", (f: Fixture) => { f.object.metadata.installment_collection_version = "exact-cents-held-v1"; }],
  ["unknown protocol", (f: Fixture) => { f.object.metadata.installment_collection_version = "exact-cents-context-v3"; }],
  ["null marker", (f: Fixture) => { Object.assign(f.object.metadata, { installment_collection_version: null }); }],
  ["wrong reservation hint", (f: Fixture) => { f.object.metadata.installment_plan_id = f.terms.bookingId; }],
  ["wrong booking hint", (f: Fixture) => { f.object.metadata.booking_id = f.row.id; }],
  ["wrong buyer hint", (f: Fixture) => { f.object.metadata.buyer_id = f.terms.creatorId; }],
  ["wrong creator hint", (f: Fixture) => { f.object.metadata.creator_id = f.terms.buyerId; }],
  ["conflicting parent marker", (f: Fixture) => { Object.assign(f.object, { parent: { subscription_details: { metadata: { installment_collection_version: "exact-cents-held-v1" } } } }); }],
  ["unsupported type", (f: Fixture) => { f.event.type = "customer.created"; }],
  ["prototype key type", (f: Fixture) => { f.event.type = "toString"; }],
  ["refund without independent object mode", (f: Fixture) => { f.event.type = "refund.created"; Object.assign(f.object, { object: "refund", id: "re_synthetic" }); Reflect.deleteProperty(f.object, "livemode"); }],
  ["missing object mode", (f: Fixture) => { Reflect.deleteProperty(f.object, "livemode"); }],
  ["missing row", (f: Fixture) => { Object.assign(f.args, { reservationRow: null }); }],
  ["old terms", (f: Fixture) => { f.terms.version = "exact-cents-held-v1"; }],
  ["paid status", (f: Fixture) => { f.row.status = "active"; }],
  ["wrong runtime account", (f: Fixture) => { f.evidence.observedPlatformAccountId = "acct_other"; }],
  ["wrong runtime database", (f: Fixture) => { f.evidence.observedSupabaseProjectRef = "bbbbbbbbbbbbbbbbbbbb"; }],
] as const)("rejects %s without legacy fallback or adoption", (_name, change) => {
  const f = fixture(); change(f);
  expect(() => inspectContextReservationEvent(f.args)).toThrow(CONTEXT_RECONCILIATION_ERROR);
});

test("missing metadata is still unbound, not legacy absence", () => {
  const f = fixture(); Reflect.deleteProperty(f.object, "metadata");
  expect(inspectContextReservationEvent(f.args).disposition).toBe("unbound_reservation");
});

test("null platform event fields and expanded matching destination remain blocked", () => {
  const f = fixture(); Object.assign(f.event, { account: null, context: null });
  Object.assign(f.object.transfer_data, { destination: { id: f.terms.destinationId } });
  expect(inspectContextReservationEvent(f.args).providerOperationsAllowed).toBe(false);
});

test("repeated observation yields one stable diagnostic identity, without writing an event claim", () => {
  const f = fixture(), a = inspectContextReservationEvent(f.args), b = inspectContextReservationEvent(f.args);
  expect(a.observationKey).toBe(b.observationKey);
  expect(a.observationKey).not.toBe(`stripe:${f.event.id}`);
  f.object.status = "requires_payment_method";
  expect(inspectContextReservationEvent(f.args).observationKey).toBe(a.observationKey);
});

test.each(["mode", "account", "project", "origin", "reservation", "terms", "event", "resource"])(
  "same opaque IDs cannot collide across changed %s identity", field => {
    const base = fixture(), before = inspectContextReservationEvent(base.args).observationKey;
    const f = fixture(field === "mode" ? "live" : "test");
    if (field === "account") { Object.assign(f.context, { platformAccountId: "acct_another" }); f.evidence.observedPlatformAccountId = "acct_another"; }
    if (field === "project") { Object.assign(f.context, { supabaseProjectRef: "bbbbbbbbbbbbbbbbbbbb" }); f.evidence.observedSupabaseProjectRef = f.context.supabaseProjectRef;
      f.evidence.configuredSupabaseUrl = `https://${f.context.supabaseProjectRef}.supabase.co`; }
    if (field === "origin") { Object.assign(f.context, { siteOrigin: "https://another.vercel.app" }); f.evidence.configuredSiteOrigin = f.context.siteOrigin; }
    if (field === "reservation") { f.row.id = f.terms.productId; f.object.metadata.installment_plan_id = f.row.id; }
    if (field === "terms") f.terms.totalCents += 1;
    if (field === "event") { f.event.id = "evt_another"; f.args.eventId = f.event.id; }
    if (field === "resource") f.object.id = "pi_another";
    f.evidence.approvedContext = { ...f.context };
    expect(inspectContextReservationEvent(f.args).observationKey).not.toBe(before);
  });

test("accessor/inherited/proxy failures are redacted and no accessors are evaluated", () => {
  const f = fixture(), getter = jest.fn(() => { throw Error("SYNTHETIC_PRIVATE_FAILURE"); });
  const event = Object.defineProperty({ ...f.event }, "account", { get: getter, enumerable: true });
  expect(() => inspectContextReservationEvent({ ...f.args, event })).toThrow(CONTEXT_RECONCILIATION_ERROR);
  expect(getter).not.toHaveBeenCalled();
  const inherited = Object.setPrototypeOf({ ...f.event }, { account: "acct_other" });
  expect(() => inspectContextReservationEvent({ ...f.args, event: inherited })).toThrow(CONTEXT_RECONCILIATION_ERROR);
  const proxy = new Proxy(f.event, { getOwnPropertyDescriptor() { throw Error("SYNTHETIC_PRIVATE_FAILURE"); } });
  expect(() => inspectContextReservationEvent({ ...f.args, event: proxy })).toThrow(CONTEXT_RECONCILIATION_ERROR);
});
