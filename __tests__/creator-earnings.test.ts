/**
 * Creator earnings — the money actually reaching the creator.
 *
 * These import and invoke the real helper and the real /api/confirm-purchase
 * handler. Every test was mutation-checked: the fix was reverted and the test
 * confirmed to fail.
 *
 * The exactly-once guarantee itself lives in the database (migration 018) and
 * was verified directly against production inside a rolled-back DO block:
 * credit -> t, second credit -> f, reverse -> t, second reverse -> f, balances
 * returning exactly to their starting values.
 */

process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";
process.env.NEXT_PUBLIC_SITE_URL = "https://www.creatornet.net";

import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";
import {
  creditPurchaseEarnings,
  reversePurchaseEarnings,
  reverseEarningsForPaymentIntent,
} from "@/lib/creatorEarnings";

let db: MockClient;
let authUser: { id: string } | null = { id: "buyer_1" };
let retrieveImpl: () => any;

jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: authUser } }) } }),
  createSupabaseServer: () => ({ auth: { getUser: async () => ({ data: { user: authUser } }) } }),
}));
jest.mock("@/lib/stripeClient", () => ({
  getStripe: () => ({ checkout: { sessions: { retrieve: async () => retrieveImpl() } } }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  authUser = { id: "buyer_1" };
});

// ---------------------------------------------------------------------------
// The helper
// ---------------------------------------------------------------------------

describe("creditPurchaseEarnings", () => {
  it("takes the 12% platform fee off before crediting", async () => {
    db = createMockClient((op: Op) =>
      op.table === "credit_purchase_earnings" ? { data: true, error: null } : undefined
    );

    const credited = await creditPurchaseEarnings(db as any, "p1", 10000);

    expect(credited).toBe(true);
    const rpc = db.opsFor("credit_purchase_earnings")[0];
    expect(rpc).toBeDefined();
    // $100.00 gross -> $12.00 fee -> $88.00 to the creator, per lib/money.ts.
    expect(rpc.payload).toEqual({ p_purchase_id: "p1", p_creator_amount_cents: 8800 });
  });

  it("reports false when the database refused (already credited)", async () => {
    db = createMockClient((op: Op) =>
      op.table === "credit_purchase_earnings" ? { data: false, error: null } : undefined
    );
    expect(await creditPurchaseEarnings(db as any, "p1", 10000)).toBe(false);
  });

  it("never throws when crediting fails — delivery must not depend on bookkeeping", async () => {
    db = createMockClient((op: Op) =>
      op.table === "credit_purchase_earnings"
        ? { data: null, error: { message: "boom" } }
        : undefined
    );
    await expect(creditPurchaseEarnings(db as any, "p1", 10000)).resolves.toBe(false);
  });

  it("does nothing without a purchase id", async () => {
    db = createMockClient(() => undefined);
    expect(await creditPurchaseEarnings(db as any, null, 10000)).toBe(false);
    expect(db.opsFor("credit_purchase_earnings")).toHaveLength(0);
  });

  it("treats a missing amount as zero rather than crediting NaN", async () => {
    db = createMockClient((op: Op) =>
      op.table === "credit_purchase_earnings" ? { data: true, error: null } : undefined
    );
    await creditPurchaseEarnings(db as any, "p1", null);
    expect((db.opsFor("credit_purchase_earnings")[0].payload as any).p_creator_amount_cents).toBe(0);
  });
});

describe("reverseEarningsForPaymentIntent", () => {
  it("reverses only the purchases that were actually credited", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") {
        return { data: [{ id: "p1" }, { id: "p2" }], error: null };
      }
      if (op.table === "reverse_purchase_earnings") return { data: true, error: null };
      return undefined;
    });

    const n = await reverseEarningsForPaymentIntent(db as any, "pi_1");

    expect(n).toBe(2);
    // It must filter to credited rows, or it would try to reverse everything.
    const lookup = db.opsFor("purchases").find((o) => o.kind === "select");
    expect(lookup!.notFilters).toContainEqual({
      column: "earnings_credited_at",
      op: "is",
      value: null,
    });
    expect(db.opsFor("reverse_purchase_earnings")).toHaveLength(2);
  });

  it("does nothing without a payment intent", async () => {
    db = createMockClient(() => undefined);
    expect(await reverseEarningsForPaymentIntent(db as any, null)).toBe(0);
  });
});

describe("reversePurchaseEarnings", () => {
  it("never throws when the reversal fails", async () => {
    db = createMockClient((op: Op) =>
      op.table === "reverse_purchase_earnings"
        ? { data: null, error: { message: "boom" } }
        : undefined
    );
    await expect(reversePurchaseEarnings(db as any, "p1")).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The route that actually runs in production
// ---------------------------------------------------------------------------

describe("/api/confirm-purchase pays the creator", () => {
  const paidSession = {
    id: "cs_test_1",
    mode: "payment",
    payment_status: "paid",
    status: "complete",
    amount_total: 10000,
    currency: "usd",
    payment_intent: "pi_1",
    subscription: null,
    metadata: {
      buyer_user_id: "buyer_1",
      product_id: "prod_1",
      post_id: "post_1",
      creator_id: "creator_1",
      order_id: "order_1",
    },
  };

  function dbFor(updateResult: unknown) {
    return createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") return { data: { id: "p1" }, error: null };
      if (op.table === "purchases" && op.kind === "update") return { data: updateResult, error: null };
      if (op.table === "credit_purchase_earnings") return { data: true, error: null };
      return undefined;
    });
  }

  /**
   * Reverts to: the route never credited anyone. This is the whole bug — the
   * only path the browser triggers left every creator's balance at zero.
   */
  it("credits the creator for a paid one-time purchase", async () => {
    db = dbFor({ id: "p1", status: "paid" });
    retrieveImpl = () => paidSession;

    const { POST } = await import("@/app/api/confirm-purchase/route");
    const res = await POST(
      new Request("https://x/api/confirm-purchase", {
        method: "POST",
        body: JSON.stringify({ session_id: "cs_test_1" }),
      })
    );

    expect(res.status).toBe(200);
    const rpc = db.opsFor("credit_purchase_earnings")[0];
    expect(rpc).toBeDefined();
    expect(rpc.payload).toEqual({ p_purchase_id: "p1", p_creator_amount_cents: 8800 });
  });

  it("does NOT credit a subscription session", async () => {
    db = dbFor({ id: "p1", status: "processing" });
    retrieveImpl = () => ({ ...paidSession, mode: "subscription", subscription: "sub_1" });

    const { POST } = await import("@/app/api/confirm-purchase/route");
    await POST(
      new Request("https://x/api/confirm-purchase", {
        method: "POST",
        body: JSON.stringify({ session_id: "cs_test_1" }),
      })
    );

    expect(db.opsFor("credit_purchase_earnings")).toHaveLength(0);
  });

  /**
   * A null update row means the terminal-status guard matched nothing, i.e. the
   * purchase is refunded. Paying out then would hand a refunded sale to the
   * creator. The database refuses too, but the route must not even ask.
   */
  it("does NOT credit when the purchase is refunded", async () => {
    db = dbFor(null);
    retrieveImpl = () => paidSession;

    const { POST } = await import("@/app/api/confirm-purchase/route");
    await POST(
      new Request("https://x/api/confirm-purchase", {
        method: "POST",
        body: JSON.stringify({ session_id: "cs_test_1" }),
      })
    );

    expect(db.opsFor("credit_purchase_earnings")).toHaveLength(0);
  });
});
