/**
 * Webhook idempotency guard — lib/stripeEvents.ts
 *
 * Stripe retries a webhook until it gets a 2xx, and can deliver the same event
 * to more than one registered endpoint. Without a guard, a retry re-runs every
 * side effect: re-granting access, re-sending mail, re-incrementing earnings.
 *
 * These tests pin the three behaviours the money path depends on:
 *   1. a first delivery is processed
 *   2. a repeat delivery is skipped
 *   3. a ledger failure does NOT drop the payment (documented fail-open)
 */

const mockInsert = jest.fn();

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({ insert: mockInsert })),
  })),
}));

import { claimStripeEvent } from "@/lib/stripeEvents";

const OLD_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...OLD_ENV,
    NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  };
});

afterAll(() => {
  process.env = OLD_ENV;
});

describe("claimStripeEvent", () => {
  test("a first delivery is claimed and processed", async () => {
    mockInsert.mockResolvedValueOnce({ error: null });

    const result = await claimStripeEvent("evt_first", "checkout.session.completed");

    expect(result).toBe("new");
    expect(mockInsert).toHaveBeenCalledWith({
      id: "evt_first",
      type: "checkout.session.completed",
    });
  });

  test("a repeat delivery is detected by the primary-key conflict and skipped", async () => {
    mockInsert.mockResolvedValueOnce({
      error: { code: "23505", message: 'duplicate key value violates unique constraint "stripe_events_pkey"' },
    });

    const result = await claimStripeEvent("evt_repeat", "checkout.session.completed");

    expect(result).toBe("duplicate");
  });

  test("a conflict is still detected if the driver omits the SQLSTATE code", async () => {
    mockInsert.mockResolvedValueOnce({
      error: { message: "duplicate key value violates unique constraint" },
    });

    expect(await claimStripeEvent("evt_nocode", "charge.refunded")).toBe("duplicate");
  });

  test("an unrelated database error does NOT drop the payment (fail-open, on purpose)", async () => {
    mockInsert.mockResolvedValueOnce({
      error: { code: "08006", message: "connection failure" },
    });

    const result = await claimStripeEvent("evt_dberror", "checkout.session.completed");

    // Deliberate: a problem writing one bookkeeping table must not become a
    // total outage of payment recording. purchases has UNIQUE constraints on
    // session_id and payment_intent_id, so duplicate ROWS remain impossible.
    expect(result).toBe("unrecorded");
  });

  test("a thrown exception also fails open rather than losing the event", async () => {
    mockInsert.mockRejectedValueOnce(new Error("socket hang up"));

    expect(await claimStripeEvent("evt_throw", "payment_intent.succeeded")).toBe("unrecorded");
  });

  test("a missing service-role key fails open and does not crash the webhook", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(await claimStripeEvent("evt_nokey", "checkout.session.completed")).toBe("unrecorded");
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test("the event type is recorded alongside the id, not just the id", async () => {
    mockInsert.mockResolvedValueOnce({ error: null });

    await claimStripeEvent("evt_typed", "invoice.payment_succeeded");

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "invoice.payment_succeeded" })
    );
  });

  test("two concurrent deliveries of one event: exactly one wins", async () => {
    // The insert is the lock — both racers hit the same primary key and the
    // database picks a winner. There is no read-then-write window to lose.
    mockInsert
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { code: "23505", message: "duplicate key" } });

    const [a, b] = await Promise.all([
      claimStripeEvent("evt_race", "checkout.session.completed"),
      claimStripeEvent("evt_race", "checkout.session.completed"),
    ]);

    expect([a, b].filter((r) => r === "new")).toHaveLength(1);
    expect([a, b].filter((r) => r === "duplicate")).toHaveLength(1);
  });
});
