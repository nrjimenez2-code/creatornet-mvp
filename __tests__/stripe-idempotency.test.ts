/** Webhook idempotency guard — processing leases and completion state. */

import { readFileSync } from "node:fs";
import path from "node:path";

const mockRpc = jest.fn();

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => ({ rpc: mockRpc })),
}));

import {
  claimStripeEvent,
  completeStripeEvent,
  releaseStripeEvent,
} from "@/lib/stripeEvents";

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
  test("a first delivery receives the processing lease", async () => {
    mockRpc.mockResolvedValueOnce({ data: "new", error: null });

    await expect(
      claimStripeEvent("evt_first", "checkout.session.completed")
    ).resolves.toEqual({ status: "new", claimToken: expect.any(String) });
    expect(mockRpc).toHaveBeenCalledWith("claim_stripe_event", {
      p_event_id: "evt_first",
      p_event_type: "checkout.session.completed",
      p_lease_seconds: 300,
      p_claim_token: expect.any(String),
    });
  });

  test("a completed delivery is skipped", async () => {
    mockRpc.mockResolvedValueOnce({ data: "duplicate", error: null });
    await expect(
      claimStripeEvent("evt_repeat", "checkout.session.completed")
    ).resolves.toEqual({ status: "duplicate" });
  });

  test("a concurrent in-progress delivery is retryable, not a completed duplicate", async () => {
    mockRpc.mockResolvedValueOnce({ data: "busy", error: null });
    await expect(
      claimStripeEvent("evt_busy", "invoice.payment_succeeded")
    ).resolves.toEqual({ status: "busy" });
  });

  test("a database error fails closed", async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "08006", message: "connection failure" },
    });
    await expect(
      claimStripeEvent("evt_dberror", "checkout.session.completed")
    ).resolves.toEqual({ status: "unrecorded" });
  });

  test("a thrown exception fails closed", async () => {
    mockRpc.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(
      claimStripeEvent("evt_throw", "payment_intent.succeeded")
    ).resolves.toEqual({ status: "unrecorded" });
  });

  test("a missing service-role key fails closed before touching the database", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(
      claimStripeEvent("evt_nokey", "checkout.session.completed")
    ).resolves.toEqual({ status: "unrecorded" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test("an invalid database result fails closed", async () => {
    mockRpc.mockResolvedValueOnce({ data: "mystery", error: null });
    await expect(
      claimStripeEvent("evt_invalid", "charge.refunded")
    ).resolves.toEqual({ status: "unrecorded" });
  });

  test("two concurrent deliveries produce one owner and one retryable waiter", async () => {
    mockRpc
      .mockResolvedValueOnce({ data: "new", error: null })
      .mockResolvedValueOnce({ data: "busy", error: null });
    const [a, b] = await Promise.all([
      claimStripeEvent("evt_race", "checkout.session.completed"),
      claimStripeEvent("evt_race", "checkout.session.completed"),
    ]);
    expect([a, b].filter((value) => value.status === "new")).toHaveLength(1);
    expect([a, b].filter((value) => value.status === "busy")).toHaveLength(1);
  });
});

describe("event completion and failure release", () => {
  test("completion is durable before the webhook returns 2xx", async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(
      completeStripeEvent("stripe:evt_done", "11111111-1111-4111-8111-111111111111")
    ).resolves.toBeUndefined();
    expect(mockRpc).toHaveBeenCalledWith("complete_stripe_event", {
      p_event_id: "stripe:evt_done",
      p_claim_token: "11111111-1111-4111-8111-111111111111",
    });
  });

  test("an unowned completion throws so Stripe retries", async () => {
    mockRpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(
      completeStripeEvent("stripe:evt_lost", "22222222-2222-4222-8222-222222222222")
    ).rejects.toThrow(
      /was not owned/
    );
  });

  test("release only asks the database to drop an in-progress claim", async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(
      releaseStripeEvent("stripe:evt_failed", "33333333-3333-4333-8333-333333333333")
    ).resolves.toBeUndefined();
    expect(mockRpc).toHaveBeenCalledWith("release_stripe_event", {
      p_event_id: "stripe:evt_failed",
      p_claim_token: "33333333-3333-4333-8333-333333333333",
    });
  });

  test("release is best effort and never masks the original handler error", async () => {
    mockRpc.mockResolvedValueOnce({
      data: false,
      error: { code: "XXXXX", message: "boom" },
    });
    await expect(
      releaseStripeEvent(
        "stripe:evt_release_error",
        "44444444-4444-4444-8444-444444444444"
      )
    ).resolves.toBeUndefined();
  });
});

describe("both webhook URLs use the canonical completed-event guard", () => {
  const read = (rel: string) =>
    readFileSync(path.join(__dirname, "..", rel), "utf8");
  const canonical = "app/api/stripe/webhook/route.ts";
  const legacy = "app/api/webhook/route.ts";

  test("the canonical handler claims, completes, and releases one shared key", () => {
    const source = read(canonical);
    expect(source).toMatch(/const claimKey = `stripe:\$\{event\.id\}`/);
    expect(source).toMatch(/completeStripeEvent\(claimKey, claim\.claimToken\)/);
    expect(source).toMatch(/releaseStripeEvent\(claimKey, claim\.claimToken\)/);
  });

  test("the legacy URL delegates to the canonical handler", () => {
    const source = read(legacy);
    expect(source).toMatch(
      /import \{ POST as handleStripeWebhook \} from "@\/app\/api\/stripe\/webhook\/route"/
    );
    expect(source).toMatch(/return handleStripeWebhook\(req\)/);
    expect(source).not.toMatch(/claimStripeEvent/);
  });

  test("migration 019 implements processing, completed, and lease states atomically", () => {
    const source = read("supabase/schema/019-creator-processing-fees.sql");
    expect(source).toContain("create or replace function public.claim_stripe_event");
    expect(source).toContain("return 'busy';");
    expect(source).toContain("create or replace function public.complete_stripe_event");
    expect(source).toContain(
      "drop function if exists public.claim_stripe_event(text, text, integer)",
    );
    expect(source).toContain(
      "drop function if exists public.complete_stripe_event(text)",
    );
    expect(source).toContain(
      "drop function if exists public.release_stripe_event(text)",
    );
    expect(source).toMatch(
      /where id = p_event_id\s+and status = 'processing'\s+and claim_token = p_claim_token/,
    );
    expect(source.trimStart()).toMatch(/^--[\s\S]*\nbegin;/);
    expect(source.trimEnd().endsWith("commit;")).toBe(true);
  });
});
