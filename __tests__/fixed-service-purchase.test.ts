import type { SupabaseClient } from "@supabase/supabase-js";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
import { fulfillFixedServicePurchase } from "../lib/fixedServicePurchase";
const metadata = { fixed_service_version: "fixed-service-months-v1", purchase_consent_id: "consent",
  checkout_attempt_key: "attempt", order_id: "order", product_id: "product", creator_id: "creator", buyer_id: "buyer" };
const mockStripe = { paymentIntents: { retrieve: jest.fn() }, charges: { retrieve: jest.fn() } };
jest.mock("../lib/stripeClient", () => ({ getStripe: () => mockStripe }));
const capturedAt = Math.floor(Date.now() / 1000) - 60;
const pi = { id: "pi_Captured", status: "succeeded", capture_method: "automatic", latest_charge: "ch_Captured",
  livemode: false, amount: 10000, amount_received: 10000, currency: "usd", metadata };
const charge = { id: "ch_Captured", payment_intent: pi.id, status: "succeeded", paid: true, captured: true,
  amount: 10000, amount_captured: 10000, currency: "usd", livemode: false, refunded: false, amount_refunded: 0,
  disputed: false, created: capturedAt };
let result: { data: unknown; error: unknown };
const db = createMockClient(() => result);
const admin = db as unknown as SupabaseClient;
beforeEach(() => {
  db.ops.length = 0; jest.clearAllMocks(); result = { data: true, error: null };
  mockStripe.paymentIntents.retrieve.mockResolvedValue({ ...pi });
  mockStripe.charges.retrieve.mockResolvedValue({ ...charge });
});
test("fixed one-time fulfillment binds the verified capture time, never the current/session time", async () => {
  await fulfillFixedServicePurchase(admin, "purchase", pi.id, metadata);
  expect(db.ops).toHaveLength(1);
  expect(db.ops[0]).toMatchObject({ table: "bind_fixed_service_one_time_v1", payload: {
    p_purchase_id: "purchase", p_consent_id: "consent", p_attempt_key: "attempt", p_payment_intent_id: pi.id,
    p_charge_id: charge.id, p_captured_at: capturedAt, p_amount_cents: 10000, p_currency: "usd" } });
});
test.each([{ status: "processing" }, { capture_method: "manual" }, { amount_received: 9999 },
  { metadata: { ...metadata, purchase_consent_id: "other" } }])("unconfirmed or mismatched intent cannot grant service: %p", async patch => {
  mockStripe.paymentIntents.retrieve.mockResolvedValue({ ...pi, ...patch });
  await expect(fulfillFixedServicePurchase(admin, "purchase", pi.id, metadata)).rejects.toThrow("Verified");
  expect(db.ops).toHaveLength(0);
});
test.each([{ captured: false }, { paid: false }, { amount_captured: 9999 }, { amount_refunded: 1 },
  { disputed: true }, { payment_intent: "pi_Other" }, { created: capturedAt + 86400 }, { livemode: true }])(
  "invalid captured charge cannot grant service: %p", async patch => {
    mockStripe.charges.retrieve.mockResolvedValue({ ...charge, ...patch });
    await expect(fulfillFixedServicePurchase(admin, "purchase", pi.id, metadata)).rejects.toThrow("Verified");
    expect(db.ops).toHaveLength(0);
  });
test("a failed database binding stays retryable", async () => {
  result = { data: null, error: { message: "synthetic" } };
  await expect(fulfillFixedServicePurchase(admin, "purchase", pi.id, metadata)).rejects.toThrow("could not be bound");
});
test("legacy purchases bypass the fixed-service binding", async () => {
  await fulfillFixedServicePurchase(admin, "purchase", pi.id, {});
  expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled(); expect(db.ops).toHaveLength(0);
});
test("pausing new timed offers does not discard a previously paid service promise", async () => {
  const saved = process.env.CREATOR_FIXED_SERVICE_ONE_TIME_READY;
  process.env.CREATOR_FIXED_SERVICE_ONE_TIME_READY = "false";
  try { await fulfillFixedServicePurchase(admin, "purchase", pi.id, metadata); expect(db.ops).toHaveLength(1); }
  finally { if (saved === undefined) delete process.env.CREATOR_FIXED_SERVICE_ONE_TIME_READY; else process.env.CREATOR_FIXED_SERVICE_ONE_TIME_READY = saved; }
});

