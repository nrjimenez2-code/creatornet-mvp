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
const mockEq = jest.fn();
const mockDelete = jest.fn(() => ({ eq: mockEq }));

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({ insert: mockInsert, delete: mockDelete })),
  })),
}));

import { claimStripeEvent, releaseStripeEvent } from "@/lib/stripeEvents";

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

/**
 * Releasing a claim.
 *
 * The claim is taken BEFORE any side effect, so a handler that throws half way
 * leaves the event id behind. Stripe's retry would then see its own claim,
 * return "duplicate", and acknowledge without doing the work — the payment is
 * captured and never recorded, and Stripe stops retrying because it got a 2xx.
 *
 * That is strictly worse than having no guard, so the failure path has to hand
 * the claim back.
 */
describe("releaseStripeEvent", () => {
  test("deletes the claim row for that event id", async () => {
    mockEq.mockResolvedValueOnce({ error: null });

    await releaseStripeEvent("evt_failed_midway");

    expect(mockDelete).toHaveBeenCalled();
    expect(mockEq).toHaveBeenCalledWith("id", "evt_failed_midway");
  });

  test("a released event can be claimed again, so Stripe's retry is processed", async () => {
    mockInsert.mockResolvedValueOnce({ error: null });
    expect(await claimStripeEvent("evt_retry", "checkout.session.completed")).toBe("new");

    mockEq.mockResolvedValueOnce({ error: null });
    await releaseStripeEvent("evt_retry");

    // The row is gone, so the retry inserts cleanly rather than conflicting.
    mockInsert.mockResolvedValueOnce({ error: null });
    expect(await claimStripeEvent("evt_retry", "checkout.session.completed")).toBe("new");
  });

  test("a failed delete is logged and swallowed, never masking the original error", async () => {
    mockEq.mockResolvedValueOnce({ error: { code: "XXXXX", message: "boom" } });

    await expect(releaseStripeEvent("evt_delete_fails")).resolves.toBeUndefined();
  });
});

/**
 * The two handlers must never share a claim key.
 *
 * Both routes verify against the same STRIPE_WEBHOOK_SECRET, so if Stripe is
 * configured with both endpoints registered they would both legitimately accept
 * the same event. They do DIFFERENT work: the big handler writes purchases,
 * earnings, bookings and access grants; the small one does its own thing.
 *
 * With one shared key, whichever delivery arrived first would make the other
 * return "duplicate" and skip everything — silently dropping a purchase.
 * Namespacing per handler keeps each one idempotent against its own retries
 * without either being able to silence the other.
 */
describe("per-handler claim namespacing", () => {
  test("the same Stripe event can be claimed once per handler", async () => {
    mockInsert.mockResolvedValueOnce({ error: null });
    expect(await claimStripeEvent("stripe:evt_shared", "checkout.session.completed")).toBe("new");

    mockInsert.mockResolvedValueOnce({ error: null });
    expect(await claimStripeEvent("webhook:evt_shared", "checkout.session.completed")).toBe("new");

    expect(mockInsert).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "stripe:evt_shared" }));
    expect(mockInsert).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "webhook:evt_shared" }));
  });

  test("a retry to the SAME handler is still caught as a duplicate", async () => {
    mockInsert.mockResolvedValueOnce({
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    });

    expect(await claimStripeEvent("stripe:evt_shared", "checkout.session.completed")).toBe("duplicate");
  });
});

/**
 * Pin the prefixes in the route files themselves.
 *
 * The tests above prove the library behaves correctly when given distinct keys,
 * but nothing stops someone editing a route to use the other one's prefix. The
 * route files cannot be imported here — they build Stripe and Supabase clients
 * at module scope, which needs real credentials — so this reads them as text,
 * the same approach used by the platform-fee tripwire.
 */
describe("route files use distinct claim prefixes", () => {
  const read = (rel: string) =>
    require("fs").readFileSync(require("path").join(__dirname, "..", rel), "utf8");

  const BIG = "app/api/stripe/webhook/route.ts";
  const SMALL = "app/api/webhook/route.ts";

  test("the big handler claims under stripe:", () => {
    expect(read(BIG)).toMatch(/const claimKey = `stripe:\$\{event\.id\}`/);
  });

  test("the small handler claims under webhook:", () => {
    expect(read(SMALL)).toMatch(/const claimKey = `webhook:\$\{event\.id\}`/);
  });

  test("the two prefixes are not the same", () => {
    const grab = (src: string) => src.match(/const claimKey = `([a-z]+):\$\{event\.id\}`/)?.[1];
    const big = grab(read(BIG));
    const small = grab(read(SMALL));

    expect(big).toBeDefined();
    expect(small).toBeDefined();
    expect(big).not.toBe(small);
  });

  test("each handler releases the key it claimed, not the bare event id", () => {
    for (const f of [BIG, SMALL]) {
      expect(read(f)).toMatch(/releaseStripeEvent\(claimKey\)/);
      expect(read(f)).not.toMatch(/releaseStripeEvent\(event\.id\)/);
    }
  });
});
