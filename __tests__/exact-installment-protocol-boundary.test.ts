/** NEW rejection-only boundary checks. Synthetic ports only; no provider, SQL,
 * credentials, clock changes, deployments or historical payment reruns. */
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyExactInstallmentProtocol, EXACT_INSTALLMENT_PROTOCOL_ERROR,
  EXACT_INSTALLMENT_PROTOCOL_KEY } from "../lib/installments/protocolBoundary";
import { dispatchExactInstallmentEventSandbox } from "../lib/installments/eventBridge";
import { confirmExactInstallmentSandbox } from "../lib/installments/purchaseLifecycle";
import { creditVerifiedFirstInstallmentSandbox } from "../lib/installments/receiptCredit";
import { activateExactInstallmentSandbox } from "../lib/installments/activation";
import { collectExactRenewalSandbox } from "../lib/installments/renewal";
import { reconcileExactRefundEventSandbox } from "../lib/installments/refundEvent";
import { observeExactDisputeSandbox, observeExactSubscriptionSandbox } from "../lib/installments/lifecycleEvents";
import { recoverExactRenewalSandbox } from "../lib/installments/paymentRecovery";
import { observeExpiredExactCheckoutSandbox } from "../lib/installments/checkoutExpiry";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";
import { createMockClient } from "./__mocks__/supabaseQueryMock";

jest.mock("../lib/installments/receiptCredit", () => ({ creditVerifiedFirstInstallmentSandbox: jest.fn() }));
jest.mock("../lib/installments/activation", () => ({ activateExactInstallmentSandbox: jest.fn() }));
jest.mock("../lib/installments/renewal", () => ({ collectExactRenewalSandbox: jest.fn() }));
jest.mock("../lib/installments/refundEvent", () => ({ reconcileExactRefundEventSandbox: jest.fn() }));
jest.mock("../lib/installments/lifecycleEvents", () => ({ observeExactDisputeSandbox: jest.fn(), observeExactSubscriptionSandbox: jest.fn() }));
jest.mock("../lib/installments/paymentRecovery", () => ({ recoverExactRenewalSandbox: jest.fn() }));
jest.mock("../lib/installments/checkoutExpiry", () => ({ observeExpiredExactCheckoutSandbox: jest.fn() }));

const key = EXACT_INSTALLMENT_PROTOCOL_KEY;
const v1 = "exact-cents-held-v1";
const future = "exact-cents-context-v2";
const marker = <T>(value: T) => ({ [key]: value });
const parent = (value: unknown) => ({ subscription_details: { metadata: marker(value) } });
beforeEach(() => jest.clearAllMocks());

test.each([
  {}, { metadata: null }, { metadata: undefined }, { parent: null },
  { metadata: { installment_fee_setup: "exact-percent-v1" } },
  { parent: { subscription_details: { metadata: { installment_fee_setup: "exact-percent-v1" } } } },
])("absence of the reserved key retains genuine legacy classification: %j", object => {
  expect(classifyExactInstallmentProtocol(object)).toBe("legacy");
});

test.each([{ metadata: marker(v1) }, { parent: parent(v1) }, { metadata: marker(v1), parent: parent(v1) }])(
  "current direct/parent v1 markers retain existing classification: %j", object => {
    expect(classifyExactInstallmentProtocol(object)).toBe("exact-v1");
  });

test.each([future, "future-unknown-protocol", "exact-percent-v1", "", " ", null, undefined, false, 1, {}, []])(
  "present unsupported marker %p can never become legacy", value => {
    for (const object of [{ metadata: marker(value) }, { parent: parent(value) }]) {
      expect(() => classifyExactInstallmentProtocol(object)).toThrow(new Error(EXACT_INSTALLMENT_PROTOCOL_ERROR));
    }
  });

test.each([[v1, future], [future, v1], [v1, null], [undefined, v1]])(
  "conflicting direct=%p / parent=%p is rejected", (direct, nested) => {
    expect(() => classifyExactInstallmentProtocol({ metadata: marker(direct), parent: parent(nested) }))
      .toThrow(EXACT_INSTALLMENT_PROTOCOL_ERROR);
  });

test.each(["metadata", "parent", "subscription_details", "parent metadata", "marker"])(
  "does not invoke an accessor at %s", position => {
    const read = jest.fn(() => { throw new Error("synthetic-private-marker"); });
    const metadata = marker(v1), details = { metadata }, nested = { subscription_details: details };
    const object = { metadata, parent: nested };
    const target = position === "metadata" || position === "parent" ? object :
      position === "subscription_details" ? nested : position === "parent metadata" ? details : metadata;
    const field = position === "parent metadata" ? "metadata" : position === "marker" ? key : position;
    Object.defineProperty(target, field, { enumerable: true, get: read });
    expect(() => classifyExactInstallmentProtocol(object)).toThrow(new Error(EXACT_INSTALLMENT_PROTOCOL_ERROR));
    expect(read).not.toHaveBeenCalled();
  });

test("inherited, hidden and proxy fields cannot establish safe fallback or leak diagnostics", () => {
  const hidden = {};
  Object.defineProperty(hidden, key, { value: v1, enumerable: false });
  for (const object of [{ metadata: Object.create(marker(v1)) }, { metadata: hidden },
    Object.create({ metadata: marker(v1) }),
    new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("synthetic-private-marker"); } })]) {
    expect(() => classifyExactInstallmentProtocol(object)).toThrow(new Error(EXACT_INSTALLMENT_PROTOCOL_ERROR));
  }
});

test("classification neither mutates metadata nor reserializes a protocol", () => {
  const metadata = Object.freeze({ ...marker(v1), installment_plan_id: "synthetic-plan" });
  const object = Object.freeze({ metadata });
  const before = JSON.stringify(object);
  expect(classifyExactInstallmentProtocol(object)).toBe("exact-v1");
  expect(JSON.stringify(object)).toBe(before);
});

test("native structuredClone plain objects retain v1 and legacy classification across realms", () => {
  expect(classifyExactInstallmentProtocol(structuredClone({ metadata: marker(v1) }))).toBe("exact-v1");
  expect(classifyExactInstallmentProtocol(structuredClone({ metadata: {} }))).toBe("legacy");
  class CustomPayload { metadata = marker(v1); }
  expect(() => classifyExactInstallmentProtocol(new CustomPayload())).toThrow(EXACT_INSTALLMENT_PROTOCOL_ERROR);
});

function webhook(type = "charge.updated") {
  const f = exactInstallmentFixture(); f.paid();
  const binding = { agreementId: f.agreement.id, purchaseId: "99999999-9999-4999-8999-999999999999",
    sessionId: f.session.id, subscriptionId: f.subscription.id, customerId: f.customer.id,
    status: "awaiting_first", previewOrigin: f.terms.previewOrigin };
  const bindings = { bySession: jest.fn(async () => null as typeof binding | null),
    bySubscription: jest.fn(async () => null as typeof binding | null), byIntent: jest.fn(async () => null as typeof binding | null) };
  const creditStore = { bindPurchase: jest.fn(), recordRefundEvidence: jest.fn(), credit: jest.fn(), reconcileDispute: jest.fn() };
  const activationStore = { claim: jest.fn(), complete: jest.fn() };
  const invoiceStore = { claim: jest.fn(), prepareDispatch: jest.fn(), admitDispatch: jest.fn(), recordReceipt: jest.fn(),
    completeAgreement: jest.fn(), priorPayments: jest.fn() };
  const lifecycleStore = { seed: jest.fn(), fulfillFirst: jest.fn() };
  const refundStore = { creditedReceipt: jest.fn(), hold: jest.fn(), apply: jest.fn(), confirmAdminDelivery: jest.fn() };
  const lifecycleEventStore = { read: jest.fn(), hold: jest.fn(), observe: jest.fn(), dispute: jest.fn() };
  const recoveryStore = { begin: jest.fn(), finish: jest.fn(), has: jest.fn() };
  const invoice = { id: "in_synthetic", livemode: false, customer: f.customer.id, metadata: {},
    parent: { subscription_details: { subscription: f.subscription.id, metadata: {} } } };
  const api = { ...f.mocks, invoices: { retrieve: jest.fn(async () => invoice), pay: jest.fn(), create: jest.fn() } };
  const object: Record<string, unknown> = { id: type.startsWith("checkout.") ? f.session.id :
    type.startsWith("invoice.") ? invoice.id : type.startsWith("payment_intent.") ? f.pi.id :
    type.startsWith("customer.subscription.") ? f.subscription.id : type.startsWith("charge.dispute.") ? "dp_synthetic" : f.charge.id,
    metadata: {}, payment_intent: f.pi.id, charge: f.charge.id,
    parent: { subscription_details: { subscription: f.subscription.id, metadata: {} } } };
  const env: Record<string, string | undefined> = { ...f.env,
    CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY: "false", CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE: "false" };
  const args = { verifiedEvent: { id: "evt_synthetic", type, livemode: false, data: { object } } as unknown as Stripe.Event,
    bindings, store: f.store, creditStore, activationStore, invoiceStore, lifecycleStore, refundStore,
    lifecycleEventStore, recoveryStore, stripe: api as unknown as Stripe, env };
  const legacy = jest.fn();
  const run = async () => {
    const result = await dispatchExactInstallmentEventSandbox(args);
    if (!result.handled) legacy();
    return result;
  };
  return { f, binding, bindings, args, api, object, invoice, legacy, run };
}

function noFinancialCalls(h: ReturnType<typeof webhook>) {
  for (const call of [creditVerifiedFirstInstallmentSandbox, activateExactInstallmentSandbox, collectExactRenewalSandbox,
    reconcileExactRefundEventSandbox, observeExactDisputeSandbox, observeExactSubscriptionSandbox, recoverExactRenewalSandbox,
    observeExpiredExactCheckoutSandbox, h.f.store.claim, h.f.store.complete, h.f.store.bind, h.f.store.recordFirstReceipt,
    ...Object.values(h.args.creditStore), ...Object.values(h.args.activationStore), ...Object.values(h.args.invoiceStore),
    ...Object.values(h.args.lifecycleStore), ...Object.values(h.args.refundStore), ...Object.values(h.args.lifecycleEventStore),
    ...Object.values(h.args.recoveryStore), h.api.invoices.pay, h.api.invoices.create,
    h.api.customers.create, h.api.products.create, h.api.subscriptions.create, h.api.subscriptions.update, h.api.checkout.sessions.create]) {
    expect(call).not.toHaveBeenCalled();
  }
}

function noProviderOrBindingReads(h: ReturnType<typeof webhook>) {
  for (const call of [...Object.values(h.bindings), h.f.store.load, h.api.invoices.retrieve,
    h.api.charges.retrieve, h.api.paymentIntents.retrieve, h.api.customers.retrieve, h.api.subscriptions.retrieve,
    h.api.checkout.sessions.retrieve]) expect(call).not.toHaveBeenCalled();
}

test.each(["checkout.session.completed", "checkout.session.expired", "invoice.created", "invoice.payment_failed",
  "payment_intent.succeeded", "charge.updated", "charge.refunded", "charge.dispute.created", "customer.subscription.updated"])(
  "all flags off: unsupported %s cannot fall through or touch a financial port", async type => {
    const h = webhook(type); h.object.metadata = marker(future);
    await expect(h.run()).rejects.toThrow(new Error(EXACT_INSTALLMENT_PROTOCOL_ERROR));
    expect(h.legacy).not.toHaveBeenCalled(); noProviderOrBindingReads(h); noFinancialCalls(h);
  });

test.each([null, undefined, "", false])("malformed signed event marker %p rejects before flag evaluation", async value => {
  const h = webhook(); h.object.metadata = marker(value);
  await expect(h.run()).rejects.toThrow(EXACT_INSTALLMENT_PROTOCOL_ERROR);
  noProviderOrBindingReads(h); noFinancialCalls(h); expect(h.legacy).not.toHaveBeenCalled();
});

test("parent future marker conflicts with direct v1 before invoice routing or reads", async () => {
  const h = webhook("invoice.created"); h.object.metadata = marker(v1); h.object.parent = parent(future);
  h.args.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE = "true";
  await expect(h.run()).rejects.toThrow(EXACT_INSTALLMENT_PROTOCOL_ERROR);
  noProviderOrBindingReads(h); noFinancialCalls(h); expect(h.legacy).not.toHaveBeenCalled();
});

test.each(["charge", "PI"])("fresh unsupported %s cannot disguise an unmarked charge.updated as legacy", async source => {
  const h = webhook(); h.args.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY = "true";
  if (source === "charge") Object.assign(h.f.charge, { metadata: marker(future), payment_intent: null });
  else h.f.pi.metadata = marker(future);
  await expect(h.run()).rejects.toThrow(EXACT_INSTALLMENT_PROTOCOL_ERROR);
  noFinancialCalls(h); expect(h.legacy).not.toHaveBeenCalled();
  expect(h.bindings.byIntent).not.toHaveBeenCalled();
  if (source === "charge") expect(h.api.paymentIntents.retrieve).not.toHaveBeenCalled();
});

test.each(["charge", "PI"])("fresh unsupported dispute %s rejects before legacy fallback", async source => {
  const h = webhook("charge.dispute.created"); h.args.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY = "true";
  if (source === "charge") {
    h.object.payment_intent = null;
    Object.assign(h.f.charge, { metadata: marker(future), payment_intent: null });
  } else h.f.pi.metadata = marker(future);
  await expect(h.run()).rejects.toThrow(EXACT_INSTALLMENT_PROTOCOL_ERROR);
  noFinancialCalls(h); expect(h.legacy).not.toHaveBeenCalled();
});

test("fresh unsupported invoice cannot enter the old collector even with a known binding", async () => {
  const h = webhook("invoice.created"); h.args.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE = "true";
  h.bindings.bySubscription.mockResolvedValue(h.binding); h.invoice.metadata = marker(future);
  await expect(h.run()).rejects.toThrow(EXACT_INSTALLMENT_PROTOCOL_ERROR);
  noFinancialCalls(h); expect(h.legacy).not.toHaveBeenCalled();
});

test("fresh unsupported saved Checkout stops charge recovery before first-payment delegation", async () => {
  const h = webhook(); h.args.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE = "true";
  h.bindings.bySession.mockResolvedValue(h.binding);
  h.f.session.metadata = marker(future);
  await expect(h.run()).rejects.toThrow(EXACT_INSTALLMENT_PROTOCOL_ERROR);
  noFinancialCalls(h); expect(h.legacy).not.toHaveBeenCalled();
});

test("v1 charge recovery stays quarantined during preparation pause without any financial delegation", async () => {
  const h = webhook(); h.args.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY = "true";
  h.object.metadata = marker(v1);
  expect(await h.run()).toEqual({ handled: true, disposition: "reconciliation_required" });
  noFinancialCalls(h); expect(h.legacy).not.toHaveBeenCalled(); expect(h.f.store.load).not.toHaveBeenCalled();
});

test("known unmarked v1 binding remains quarantined while preparation is paused", async () => {
  const h = webhook("payment_intent.succeeded"); h.args.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY = "true";
  h.bindings.byIntent.mockResolvedValue(h.binding);
  expect(await h.run()).toEqual({ handled: true, disposition: "reconciliation_required" });
  noFinancialCalls(h); expect(h.legacy).not.toHaveBeenCalled();
});

test("v1 marker with every gate off preserves its original no-fallback rejection", async () => {
  const h = webhook(); h.object.metadata = marker(v1);
  await expect(h.run()).rejects.toThrow("cannot fall back to legacy processing");
  noProviderOrBindingReads(h); noFinancialCalls(h); expect(h.legacy).not.toHaveBeenCalled();
});

test("untagged legacy fee metadata with all gates off remains untouched", async () => {
  const h = webhook(); h.object.metadata = { installment_fee_setup: "exact-percent-v1" };
  expect(await h.run()).toEqual({ handled: false }); expect(h.legacy).toHaveBeenCalledTimes(1);
  noProviderOrBindingReads(h); noFinancialCalls(h);
});

function confirmation() {
  const f = exactInstallmentFixture();
  const row = { id: f.agreement.id, terms: f.terms, status: "awaiting_first", purchase_id: null,
    purchase_seeded_at: null, first_fulfilled_at: null, stripe_customer_id: f.customer.id,
    stripe_subscription_id: f.subscription.id, stripe_checkout_session_id: f.session.id };
  const db = createMockClient(() => ({ data: row, error: null }));
  const env: Record<string, string | undefined> = { ...f.env,
    CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY: "false", CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE: "false" };
  const legacy = jest.fn();
  const run = async () => {
    const result = await confirmExactInstallmentSandbox({ session: f.session, admin: db as unknown as SupabaseClient,
      buyerId: f.terms.buyerId, env });
    if (result === null) legacy();
    return result;
  };
  return { f, db, env, run, legacy };
}

test.each([future, null, undefined, "", false])("confirmation rejects reserved marker %p before even a binding read", async value => {
  const h = confirmation(); Object.assign(h.f.session, { metadata: marker(value) });
  await expect(h.run()).rejects.toThrow(EXACT_INSTALLMENT_PROTOCOL_ERROR);
  expect(h.db.ops).toEqual([]); expect(h.legacy).not.toHaveBeenCalled();
});

test("confirmation rejects a marker accessor without invoking or exposing it", async () => {
  const h = confirmation(); const read = jest.fn(() => { throw new Error("synthetic-private-marker"); });
  Object.defineProperty(h.f.session.metadata, key, { enumerable: true, get: read });
  await expect(h.run()).rejects.toThrow(new Error(EXACT_INSTALLMENT_PROTOCOL_ERROR));
  expect(read).not.toHaveBeenCalled(); expect(h.db.ops).toEqual([]); expect(h.legacy).not.toHaveBeenCalled();
});

test("valid v1 confirmation still reads pending state with preparation paused", async () => {
  const h = confirmation(); h.env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY = "true";
  expect(await h.run()).toEqual({ httpStatus: 202, body: { ok: true, session_id: h.f.session.id, status: "pending" } });
  expect(h.db.ops).toHaveLength(1); expect(h.db.ops[0].kind).toBe("select"); expect(h.legacy).not.toHaveBeenCalled();
});

test("legacy confirmation without schema remains a no-query legacy handoff", async () => {
  const h = confirmation(); h.f.session.metadata = { installment_fee_setup: "exact-percent-v1" };
  expect(await h.run()).toBeNull(); expect(h.db.ops).toEqual([]); expect(h.legacy).toHaveBeenCalledTimes(1);
});
