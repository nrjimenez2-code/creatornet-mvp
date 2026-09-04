/**
 * Behavioural tests for the launch-eve money-path fixes.
 *
 * These IMPORT AND INVOKE the real route handlers. That is deliberate: as of
 * the audit, no test in this suite imported a single route module — the
 * payment and auth "tests" read route source as text and regexed it, so they
 * passed whether or not the code worked. Every test below was checked to FAIL
 * against the pre-fix code (see the "reverts to" note on each).
 */

process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_fake";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";
process.env.NEXT_PUBLIC_SITE_URL = "https://www.creatornet.net";

import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";
import { PURCHASE_TERMINAL_STATUSES, purchaseTerminalFilter } from "@/lib/orderStatus";

// ---------------------------------------------------------------------------
// Shared mock wiring
// ---------------------------------------------------------------------------

let db: MockClient;
let constructEventImpl: (body: string, sig: string, secret: string) => any;
const subscriptionsUpdate = jest.fn().mockResolvedValue({});
const subscriptionsRetrieve = jest.fn().mockResolvedValue({
  metadata: { creator_id: "creator_1" },
  transfer_data: { destination: "acct_creator" },
});
const paymentIntentsRetrieve = jest.fn().mockResolvedValue({
  id: "pi_x",
  application_fee_amount: 396,
  latest_charge: {
    id: "ch_x",
    balance_transaction: { id: "txn_x", fee: 126 },
  },
});

jest.mock("@supabase/supabase-js", () => ({
  createClient: () => db,
}));

jest.mock("@/lib/stripeClient", () => ({
  getStripe: () => ({
    webhooks: { constructEvent: (b: string, s: string, k: string) => constructEventImpl(b, s, k) },
    subscriptions: { update: subscriptionsUpdate, retrieve: subscriptionsRetrieve },
    checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } },
    paymentIntents: { retrieve: paymentIntentsRetrieve },
    charges: { retrieve: jest.fn() },
    balanceTransactions: { retrieve: jest.fn() },
  }),
}));

jest.mock("@/lib/posthogServer", () => ({ trackServerEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/updateInterestScore", () => ({ updateInterestScore: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/updatePostMetrics", () => ({ updatePostMetrics: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/stripeEvents", () => ({
  claimStripeEvent: jest.fn().mockResolvedValue({
    status: "new",
    claimToken: "11111111-1111-4111-8111-111111111111",
  }),
  completeStripeEvent: jest.fn().mockResolvedValue(undefined),
  releaseStripeEvent: jest.fn().mockResolvedValue(undefined),
}));

function webhookRequest(): any {
  return {
    headers: { get: (n: string) => (n === "stripe-signature" ? "t=1,v1=fake" : null) },
    text: async () => "{}",
  };
}

/** A minimal product checkout.session.completed. */
function productSession(over: Record<string, unknown> = {}) {
  return {
    id: "cs_test_SECOND",
    mode: "payment",
    payment_status: "paid",
    amount_total: 10000,
    currency: "usd",
    payment_intent: "pi_second",
    subscription: null,
    metadata: {
      product_id: "prod_1",
      post_id: "post_1",
      creator_id: "creator_1",
      buyer_user_id: "buyer_1",
      order_id: "order_2",
      ...(over.metadata as Record<string, unknown> | undefined),
    },
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  subscriptionsUpdate.mockResolvedValue({});
  subscriptionsRetrieve.mockResolvedValue({
    metadata: { creator_id: "creator_1" },
    transfer_data: { destination: "acct_creator" },
  });
  paymentIntentsRetrieve.mockResolvedValue({
    id: "pi_x",
    application_fee_amount: 396,
    latest_charge: {
      id: "ch_x",
      balance_transaction: { id: "txn_x", fee: 126 },
    },
  });
});

describe("Stripe webhook destination signatures", () => {
  it("accepts the separate connected-account webhook secret", async () => {
    db = createMockClient(() => undefined);
    const verify = jest.fn((_body: string, _signature: string, secret: string) => {
      if (secret === "whsec_fake") throw new Error("wrong destination secret");
      if (secret === "whsec_connect_fake") {
        return {
          id: "evt_connect_signature",
          type: "unhandled.test",
          data: { object: {} },
        };
      }
      throw new Error("unexpected secret");
    });
    constructEventImpl = verify;

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(verify).toHaveBeenNthCalledWith(1, "{}", "t=1,v1=fake", "whsec_fake");
    expect(verify).toHaveBeenNthCalledWith(
      2,
      "{}",
      "t=1,v1=fake",
      "whsec_connect_fake",
    );
  });
});

// ---------------------------------------------------------------------------
// CN-01 — repeat checkout must still deliver
// ---------------------------------------------------------------------------

describe("CN-01: a second checkout on the same post still records the purchase", () => {
  /**
   * purchases carries UNIQUE (buyer_id, post_id). /api/checkout writes a pending
   * row on every checkout start and swallows the duplicate on the second one, so
   * the paying session has NO row keyed to its session_id.
   *
   * Reverts to: looking up by session_id only. The handler then inserted, hit the
   * unique constraint, swallowed it, returned null, and the caller skipped
   * fulfilment entirely — buyer charged, no access, creator not credited.
   */
  it("falls back to (buyer_id, post_id) and grants access on that row", async () => {
    db = createMockClient((op: Op) => {
      // No row for THIS session id — the abandoned first attempt owns the pair.
      if (op.table === "purchases" && op.kind === "select") {
        if (op.filters.session_id) return { data: null, error: null };
        if (op.filters.buyer_id === "buyer_1" && op.filters.post_id === "post_1") {
          return { data: { id: "purchase_from_first_attempt" }, error: null };
        }
      }
      if (op.table === "purchases" && op.kind === "update") {
        return { data: { id: "purchase_from_first_attempt" }, error: null };
      }
      if (op.table === "profiles" && op.kind === "select") {
        return { data: { total_earnings_cents: 0 }, error: null };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "select") {
        return { data: null, error: null };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "insert") {
        return { data: { id: "ledger_checkout_1" }, error: null };
      }
      if (op.table === "credit_purchase_earnings") {
        return { data: true, error: null };
      }
      return undefined;
    });

    constructEventImpl = () => ({
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: productSession() },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(webhookRequest());
    expect(res.status).toBe(200);

    const updates = db.opsFor("purchases").filter((o) => o.kind === "update");
    const grant = updates.find(
      (o) => (o.payload as any)?.access_granted === true && o.filters.id === "purchase_from_first_attempt"
    );
    expect(grant).toBeDefined();
  });

  it("does not silently return null when the insert loses a race", async () => {
    // Neither lookup finds a row, the insert conflicts, and the row appears on
    // re-read. The handler must resolve it rather than skipping fulfilment.
    let pairLookups = 0;
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") {
        if (op.filters.session_id) return { data: null, error: null };
        if (op.filters.buyer_id) {
          pairLookups += 1;
          // First (pre-insert) lookup misses; the post-conflict re-read hits.
          return pairLookups === 1
            ? { data: null, error: null }
            : { data: { id: "raced_row" }, error: null };
        }
      }
      if (op.table === "purchases" && op.kind === "insert") {
        return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
      }
      if (op.table === "purchases" && op.kind === "update") return { data: { id: "raced_row" }, error: null };
      if (op.table === "profiles" && op.kind === "select") {
        return { data: { total_earnings_cents: 0 }, error: null };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "select") {
        return { data: null, error: null };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "insert") {
        return { data: { id: "ledger_checkout_2" }, error: null };
      }
      if (op.table === "credit_purchase_earnings") {
        return { data: true, error: null };
      }
      return undefined;
    });

    constructEventImpl = () => ({
      id: "evt_2",
      type: "checkout.session.completed",
      data: { object: productSession() },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(webhookRequest());
    expect(res.status).toBe(200);

    const recovered = db
      .opsFor("purchases")
      .filter((o) => o.kind === "update")
      .find((o) => o.filters.id === "raced_row" && (o.payload as any)?.access_granted === true);
    expect(recovered).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CN-05 — a refund must not be undone
// ---------------------------------------------------------------------------

describe("CN-05: refunded purchases are never re-granted", () => {
  /**
   * Reverts to: the purchases update carried no status guard while the orders
   * update beside it did, so a payment_intent.succeeded landing after a refund
   * put the row back to paid with access_granted true.
   */
  it("guards the purchases write in payment_intent.succeeded", async () => {
    db = createMockClient(() => undefined);
    constructEventImpl = () => ({
      id: "evt_3",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_refunded",
          amount_received: 10000,
          currency: "usd",
          metadata: { order_id: "order_9", buyer_user_id: "buyer_1" },
        },
      },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(webhookRequest());

    const write = db
      .opsFor("purchases")
      .find((o) => o.kind === "update" && (o.payload as any)?.access_granted === true);
    expect(write).toBeDefined();
    expect(write!.notFilters).toContainEqual({
      column: "status",
      op: "in",
      value: purchaseTerminalFilter(),
    });
  });

  it("keeps only refunded purchases terminal so retriable failures can recover", () => {
    expect([...PURCHASE_TERMINAL_STATUSES]).toEqual(["refunded"]);
    expect(purchaseTerminalFilter()).toBe('("refunded")');
  });
});

// ---------------------------------------------------------------------------
// CN-03 — installment plans must stop
// ---------------------------------------------------------------------------

describe("CN-03: a completed installment plan stops billing", () => {
  /**
   * Reverts to: the handler flipped the purchase to 'complete' and never told
   * Stripe to stop, so the subscription kept charging monthly forever.
   */
  it("cancels the subscription once paid_count reaches target_months", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") {
        if (op.columns === "paid_count, target_months, status") {
          return {
            data: { paid_count: 3, target_months: 3, status: "complete" },
            error: null,
          };
        }
        return {
          data: { id: "p1", product_id: "prod_1", creator_id: "creator_1", paid_count: 2, target_months: 3, fulfillment_url: "x" },
          error: null,
        };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "select") {
        return { data: null, error: null };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "insert") {
        return { data: { id: "ledger_1" }, error: null };
      }
      if (op.table === "credit_payment_fee_ledger_earnings") {
        return { data: true, error: null };
      }
      return undefined;
    });

    constructEventImpl = () => ({
      id: "evt_4",
      type: "invoice.payment_succeeded",
      data: { object: { subscription: "sub_123", payment_intent: "pi_x", amount_paid: 3300, metadata: {} } },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(webhookRequest());

    expect(subscriptionsUpdate).toHaveBeenCalledWith("sub_123", { cancel_at_period_end: true });
  });

  it("keeps billing while the plan is still running", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") {
        if (op.columns === "paid_count, target_months, status") {
          return {
            data: { paid_count: 1, target_months: 3, status: "active" },
            error: null,
          };
        }
        return {
          data: { id: "p1", product_id: "prod_1", creator_id: "creator_1", paid_count: 0, target_months: 3, fulfillment_url: "x" },
          error: null,
        };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "select") {
        return { data: null, error: null };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "insert") {
        return { data: { id: "ledger_2" }, error: null };
      }
      if (op.table === "credit_payment_fee_ledger_earnings") {
        return { data: true, error: null };
      }
      return undefined;
    });

    constructEventImpl = () => ({
      id: "evt_5",
      type: "invoice.payment_succeeded",
      data: { object: { subscription: "sub_123", payment_intent: "pi_x", amount_paid: 3300, metadata: {} } },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(webhookRequest());

    expect(subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("asks Stripe to retry when the completed plan cannot be canceled", async () => {
    subscriptionsUpdate.mockRejectedValueOnce(new Error("stripe down"));
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") {
        if (op.columns === "paid_count, target_months, status") {
          return {
            data: { paid_count: 6, target_months: 3, status: "complete" },
            error: null,
          };
        }
        return {
          data: { id: "p1", product_id: "prod_1", creator_id: "creator_1", paid_count: 5, target_months: 3, fulfillment_url: "x" },
          error: null,
        };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "select") {
        return { data: null, error: null };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "insert") {
        return { data: { id: "ledger_3" }, error: null };
      }
      if (op.table === "credit_payment_fee_ledger_earnings") {
        return { data: true, error: null };
      }
      return undefined;
    });

    constructEventImpl = () => ({
      id: "evt_6",
      type: "invoice.payment_succeeded",
      data: { object: { subscription: "sub_123", payment_intent: "pi_x", amount_paid: 100, metadata: {} } },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(webhookRequest());
    // Earnings and paid_count are claimed atomically now, so retrying cannot
    // count or credit this invoice twice and is safer than ongoing billing.
    expect(res.status).toBe(500);
  });
});
