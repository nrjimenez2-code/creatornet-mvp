/**
 * Behavioural coverage for the Stripe routes changed by creator-funded
 * processing. These tests invoke the real handlers and inspect the Stripe and
 * database calls they make; the 2.9% + 30c schedule is test data only.
 */

process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";
process.env.NEXT_PUBLIC_SITE_URL = "https://www.creatornet.net";
process.env.CREATOR_PROCESSING_FEE_ENABLED = "true";
process.env.STRIPE_PROCESSING_FEE_BPS = "290";
process.env.STRIPE_PROCESSING_FEE_FIXED_CENTS = "30";
process.env.STRIPE_PROCESSING_FEE_SCHEDULE_VERSION = "test-us-card-v1";
process.env.STRIPE_BILLING_FEE_BPS = "70";

import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";

let db: MockClient;
let stripeEvent: any;
let claimed: "new" | "duplicate" | "busy" | "unrecorded" = "new";

const checkoutCreate = jest.fn();
const checkoutRetrieve = jest.fn();
const checkoutExpire = jest.fn();
const invoiceUpdate = jest.fn();
const subscriptionRetrieve = jest.fn();
const subscriptionUpdate = jest.fn();
const paymentIntentRetrieve = jest.fn();
const disputeRetrieve = jest.fn();
const refundsList = jest.fn();

jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }) }));
jest.mock("@/lib/supabaseServer", () => ({ createServerClient: () => db }));
jest.mock("@/lib/supabaseConnectAuth", () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({ id: "buyer_1" }),
}));
jest.mock("@/lib/creatorStripeConnect", () => ({
  isCreatorSellReady: jest.fn().mockResolvedValue(true),
}));
jest.mock("@/lib/checkoutGuards", () => ({
  INVALID_POST: "__INVALID_POST__",
  resolvePostForProduct: jest.fn().mockResolvedValue("post_1"),
}));
jest.mock("@/lib/stripeClient", () => ({
  getStripe: () => ({
    checkout: {
      sessions: { create: checkoutCreate, retrieve: checkoutRetrieve, expire: checkoutExpire },
    },
    invoices: { update: invoiceUpdate },
    subscriptions: { retrieve: subscriptionRetrieve, update: subscriptionUpdate },
    paymentIntents: { retrieve: paymentIntentRetrieve },
    charges: { retrieve: jest.fn() },
    disputes: { retrieve: disputeRetrieve },
    refunds: { list: refundsList },
    balanceTransactions: { retrieve: jest.fn() },
    webhooks: { constructEvent: () => stripeEvent },
  }),
}));
jest.mock("@/lib/stripeEvents", () => ({
  claimStripeEvent: jest.fn().mockImplementation(async () =>
    claimed === "new"
      ? { status: "new", claimToken: "11111111-1111-4111-8111-111111111111" }
      : { status: claimed }
  ),
  completeStripeEvent: jest.fn().mockResolvedValue(undefined),
  releaseStripeEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/posthogServer", () => ({
  trackServerEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/updateInterestScore", () => ({
  updateInterestScore: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/updatePostMetrics", () => ({
  updatePostMetrics: jest.fn().mockResolvedValue(undefined),
}));

function webhookRequest(): any {
  return {
    headers: { get: (name: string) => (name === "stripe-signature" ? "sig" : null) },
    text: async () => "{}",
  };
}

function checkoutDb(): MockClient {
  let attempt: Record<string, any> | null = null;
  return createMockClient((op: Op) => {
    if (op.table === "products" && op.kind === "select") {
      return {
        data: {
          id: "product_row_1",
          product_id: "product_1",
          title: "Mentorship",
          type: "mentorship",
          amount_cents: 10_000,
          price_cents: null,
          currency: "usd",
          creator_id: "creator_1",
          discord_invite_url: null,
          whop_listing_url: null,
          deliver_url: null,
        },
        error: null,
      };
    }
    if (op.table === "profiles" && op.kind === "select") {
      return { data: { stripe_account_id: "acct_creator" }, error: null };
    }
    if (op.table === "orders" && op.kind === "insert") {
      return { data: { id: "order_1" }, error: null };
    }
    if (op.table === "product_checkout_attempts" && op.kind === "select") {
      return { data: attempt, error: null };
    }
    if (op.table === "product_checkout_attempts" && op.kind === "insert") {
      attempt = { id: "attempt_row_1", ...(op.payload as Record<string, unknown>) };
      return { data: attempt, error: null };
    }
    if (op.table === "product_checkout_attempts" && op.kind === "update") {
      attempt = { ...attempt, ...(op.payload as Record<string, unknown>) };
      return { data: attempt, error: null };
    }
    if (op.table === "purchases" && op.kind === "insert") {
      return { data: { id: "purchase_1" }, error: null };
    }
    return undefined;
  });
}

/**
 * Stateful payment-path double used by retry/race tests. It enforces the same
 * unique rows and compare-and-set filters that coordinate real requests.
 */
function statefulCheckoutDb(): MockClient {
  let attempt: Record<string, any> | null = null;
  let purchase: Record<string, any> | null = null;
  const orders = new Map<string, Record<string, any>>();

  return createMockClient((op: Op) => {
    if (op.table === "products" && op.kind === "select") {
      return {
        data: {
          id: "product_row_1",
          product_id: "product_1",
          title: "Mentorship",
          type: "mentorship",
          amount_cents: 10_000,
          price_cents: null,
          currency: "usd",
          creator_id: "creator_1",
          discord_invite_url: null,
          whop_listing_url: null,
          deliver_url: null,
        },
        error: null,
      };
    }
    if (op.table === "profiles" && op.kind === "select") {
      return { data: { stripe_account_id: "acct_creator" }, error: null };
    }
    if (op.table === "product_checkout_attempts" && op.kind === "select") {
      return { data: attempt, error: null };
    }
    if (op.table === "product_checkout_attempts" && op.kind === "insert") {
      if (attempt) {
        return { data: null, error: { code: "23505", message: "duplicate attempt" } };
      }
      attempt = { id: "attempt_row_1", ...(op.payload as Record<string, unknown>) };
      return { data: attempt, error: null };
    }
    if (op.table === "product_checkout_attempts" && op.kind === "update") {
      const tokenMatches =
        attempt &&
        (!op.filters.id || op.filters.id === attempt.id) &&
        (!op.filters.attempt_key || op.filters.attempt_key === attempt.attempt_key) &&
        (!op.filters.terms_fingerprint ||
          op.filters.terms_fingerprint === attempt.terms_fingerprint);
      if (!tokenMatches) return { data: null, error: null };
      attempt = { ...attempt, ...(op.payload as Record<string, unknown>) };
      return { data: attempt, error: null };
    }
    if (op.table === "orders" && op.kind === "insert") {
      const row = op.payload as Record<string, any>;
      const id = String(row.id);
      if (orders.has(id)) {
        return { data: null, error: { code: "23505", message: "duplicate order" } };
      }
      orders.set(id, { ...row });
      return { data: { id }, error: null };
    }
    if (op.table === "orders" && op.kind === "select") {
      return { data: orders.get(String(op.filters.id)) || null, error: null };
    }
    if (op.table === "orders" && op.kind === "update") {
      const id = String(op.filters.id || "");
      const current = orders.get(id);
      if (current && (!op.filters.status || op.filters.status === current.status)) {
        orders.set(id, { ...current, ...(op.payload as Record<string, unknown>) });
      }
      return { data: current || null, error: null };
    }
    if (op.table === "purchases" && op.kind === "select") {
      return { data: purchase, error: null };
    }
    if (op.table === "purchases" && op.kind === "insert") {
      if (purchase) {
        return { data: null, error: { code: "23505", message: "duplicate purchase" } };
      }
      purchase = { id: "purchase_1", ...(op.payload as Record<string, unknown>) };
      return { data: { id: purchase.id }, error: null };
    }
    if (op.table === "purchases" && op.kind === "update") {
      const statusValues = op.inFilters.find((f) => f.column === "status")?.values;
      const matches =
        purchase &&
        (!op.filters.id || op.filters.id === purchase.id) &&
        (!statusValues || statusValues.includes(purchase.status)) &&
        (!Object.prototype.hasOwnProperty.call(op.filters, "session_id") ||
          op.filters.session_id === purchase.session_id);
      if (!matches) return { data: null, error: null };
      purchase = { ...purchase, ...(op.payload as Record<string, unknown>) };
      return { data: { id: purchase.id }, error: null };
    }
    return undefined;
  });
}

function productCheckoutRequest(category?: string) {
  return new Request("https://www.creatornet.net/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "product",
      product_id: "product_1",
      ...(category ? { category } : {}),
    }),
  }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  claimed = "new";
  refundsList.mockReset().mockResolvedValue({ data: [], has_more: false });
  checkoutCreate.mockResolvedValue({
    id: "cs_test_1",
    url: "https://checkout.stripe.test/1",
    payment_intent: "pi_1",
  });
  checkoutRetrieve.mockReset();
  checkoutExpire.mockReset();
  checkoutExpire.mockImplementation(async (session: string) => ({
    id: session,
    status: "expired",
    payment_status: "unpaid",
  }));
  invoiceUpdate.mockResolvedValue({});
  subscriptionUpdate.mockResolvedValue({});
  subscriptionRetrieve.mockResolvedValue({
    metadata: {},
    transfer_data: { destination: "acct_creator" },
  });
  paymentIntentRetrieve.mockResolvedValue({
    id: "pi_recurring_1",
    application_fee_amount: 775,
    latest_charge: {
      id: "ch_recurring_1",
      balance_transaction: { id: "txn_recurring_1", fee: 175 },
    },
  });
  disputeRetrieve.mockResolvedValue({
    id: "dp_1",
    charge: "ch_1",
    payment_intent: "pi_1",
    amount: 4_000,
    currency: "usd",
    status: "needs_response",
  });
});

describe("new checkout application fees", () => {
  it("uses the server price and sends 12% plus configured processing to Stripe", async () => {
    db = checkoutDb();
    const { POST } = await import("@/app/api/checkout/route");

    const response = await POST(
      new Request("https://www.creatornet.net/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "product",
          product_id: "product_1",
          creator_id: "attacker_creator",
          buyer_id: "attacker_buyer",
          processing_fee_cents: 1,
        }),
      }) as any,
    );

    expect(response.status).toBe(200);
    const params = checkoutCreate.mock.calls[0][0];
    expect(params.payment_intent_data).toMatchObject({
      application_fee_amount: 1_520,
      transfer_data: { destination: "acct_creator" },
    });
    expect(params.payment_intent_data.metadata).toMatchObject({
      creator_id: "creator_1",
      buyer_id: "buyer_1",
      platform_fee_cents: "1200",
      processing_fee_cents: "320",
      creator_net_cents: "8480",
      processing_fee_bps: "290",
      processing_fee_fixed_cents: "30",
      fee_schedule_version: "test-us-card-v1",
    });

    const order = db.opsFor("orders").find((op) => op.kind === "insert");
    expect(order?.payload).toMatchObject({
      gross_amount: 10_000,
      platform_fee: 1_200,
      processing_fee: 320,
      total_creator_deduction: 1_520,
      creator_amount: 8_480,
    });
  });

  it("fails before Stripe when enabled configuration is missing", async () => {
    const prior = process.env.STRIPE_PROCESSING_FEE_BPS;
    delete process.env.STRIPE_PROCESSING_FEE_BPS;
    try {
      db = checkoutDb();
      const { POST } = await import("@/app/api/checkout/route");
      const response = await POST(
        new Request("https://www.creatornet.net/api/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "product", product_id: "product_1" }),
        }) as any,
      );
      expect(response.status).toBe(500);
      expect(checkoutCreate).not.toHaveBeenCalled();
    } finally {
      process.env.STRIPE_PROCESSING_FEE_BPS = prior;
    }
  });

  it("rejects a refunded prior purchase before creating another Stripe session", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "products" && op.kind === "select") {
        return {
          data: {
            id: "product_row_1",
            product_id: "product_1",
            title: "Mentorship",
            type: "mentorship",
            amount_cents: 10_000,
            price_cents: null,
            currency: "usd",
            creator_id: "creator_1",
            discord_invite_url: null,
            whop_listing_url: null,
            deliver_url: null,
          },
          error: null,
        };
      }
      if (op.table === "profiles" && op.kind === "select") {
        return { data: { stripe_account_id: "acct_creator" }, error: null };
      }
      if (op.table === "purchases" && op.kind === "select") {
        return {
          data: { id: "purchase_refunded", status: "refunded", access_granted: false },
          error: null,
        };
      }
      return undefined;
    });
    const { POST } = await import("@/app/api/checkout/route");
    const response = await POST(
      new Request("https://www.creatornet.net/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "product", product_id: "product_1" }),
      }) as any,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "PURCHASE_ALREADY_EXISTS",
    });
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("reuses the same open product Checkout Session on a sequential retry", async () => {
    db = statefulCheckoutDb();
    const { POST } = await import("@/app/api/checkout/route");

    const first = await POST(productCheckoutRequest());
    const firstBody = await first.json();
    const createdParams = checkoutCreate.mock.calls[0][0];
    checkoutRetrieve.mockResolvedValue({
      id: firstBody.session_id,
      url: firstBody.url,
      mode: "payment",
      status: "open",
      payment_status: "unpaid",
      amount_total: 10_000,
      currency: "usd",
      metadata: createdParams.metadata,
    });

    const second = await POST(productCheckoutRequest());
    const secondBody = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
    expect(secondBody).toMatchObject({
      url: firstBody.url,
      session_id: firstBody.session_id,
      order_id: firstBody.order_id,
      reused: true,
    });
  });

  it("uses one stable Stripe idempotency key for simultaneous identical requests", async () => {
    db = statefulCheckoutDb();
    const session = {
      id: "cs_concurrent",
      url: "https://checkout.stripe.test/concurrent",
      payment_intent: "pi_concurrent",
    };
    let releaseFirst!: (value: typeof session) => void;
    checkoutCreate.mockReset();
    checkoutCreate
      .mockImplementationOnce(
        () => new Promise<typeof session>((resolve) => { releaseFirst = resolve; })
      )
      .mockResolvedValue(session);
    const { POST } = await import("@/app/api/checkout/route");

    const firstPromise = POST(productCheckoutRequest());
    while (checkoutCreate.mock.calls.length < 1) await Promise.resolve();
    const secondPromise = POST(productCheckoutRequest());
    while (checkoutCreate.mock.calls.length < 2) await Promise.resolve();
    releaseFirst(session);
    const responses = await Promise.all([firstPromise, secondPromise]);
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(new Set(bodies.map((body) => body.session_id))).toEqual(new Set([session.id]));
    const keys = checkoutCreate.mock.calls.map((call) => call[1]?.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^creatornet-product-checkout:/);
  });

  it("rotates an expired product session to one new attempt and key", async () => {
    db = statefulCheckoutDb();
    checkoutCreate.mockReset();
    checkoutCreate
      .mockResolvedValueOnce({
        id: "cs_expired",
        url: "https://checkout.stripe.test/expired",
        payment_intent: null,
      })
      .mockResolvedValueOnce({
        id: "cs_replacement",
        url: "https://checkout.stripe.test/replacement",
        payment_intent: null,
      });
    const { POST } = await import("@/app/api/checkout/route");

    const first = await POST(productCheckoutRequest());
    expect(first.status).toBe(200);
    checkoutRetrieve.mockResolvedValue({
      id: "cs_expired",
      url: null,
      mode: "payment",
      status: "expired",
      payment_status: "unpaid",
      amount_total: 10_000,
      currency: "usd",
      metadata: checkoutCreate.mock.calls[0][0].metadata,
    });

    const second = await POST(productCheckoutRequest());
    const body = await second.json();
    const keys = checkoutCreate.mock.calls.map((call) => call[1]?.idempotencyKey);

    expect(second.status).toBe(200);
    expect(body.session_id).toBe("cs_replacement");
    expect(checkoutCreate).toHaveBeenCalledTimes(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("expires a race-losing session and returns only the authoritative URL", async () => {
    db = statefulCheckoutDb();
    const losingSession = {
      id: "cs_loser",
      url: "https://checkout.stripe.test/loser",
      payment_intent: null,
    };
    const winningSession = {
      id: "cs_winner",
      url: "https://checkout.stripe.test/winner",
      payment_intent: null,
    };
    let releaseFirst!: (value: typeof losingSession) => void;
    checkoutCreate.mockReset();
    checkoutCreate
      .mockImplementationOnce(
        () => new Promise<typeof losingSession>((resolve) => { releaseFirst = resolve; })
      )
      .mockResolvedValueOnce(winningSession);
    const { POST } = await import("@/app/api/checkout/route");

    const losingPromise = POST(productCheckoutRequest("first"));
    while (checkoutCreate.mock.calls.length < 1) await Promise.resolve();
    const winningPromise = POST(productCheckoutRequest("second"));
    while (checkoutCreate.mock.calls.length < 2) await Promise.resolve();
    const winningResponse = await winningPromise;
    releaseFirst(losingSession);
    const losingResponse = await losingPromise;
    const winningBody = await winningResponse.json();

    expect(winningResponse.status).toBe(200);
    expect(winningBody.session_id).toBe(winningSession.id);
    expect(losingResponse.status).toBe(500);
    expect(checkoutExpire).toHaveBeenCalledWith(losingSession.id);
  });
});

describe("booking payment links", () => {
  function bookingDb(options: {
    bookingStatus?: string;
    existingPayment?: Record<string, unknown> | null;
  } = {}): MockClient {
    const client = createMockClient((op: Op) => {
      if (op.table === "bookings" && op.kind === "select") {
        return {
          data: {
            id: "booking_1",
            post_id: "post_1",
            buyer_id: "buyer_1",
            creator_id: "creator_1",
            status: options.bookingStatus || "booked",
          },
          error: null,
        };
      }
      if (op.table === "posts" && op.kind === "select") {
        return { data: { id: "post_1", title: "Call", product_id: "product_1" }, error: null };
      }
      if (op.table === "products" && op.kind === "select") {
        return {
          data: {
            id: "product_row_1",
            product_id: "product_1",
            title: "Call",
            amount_cents: 10_000,
            currency: "usd",
          },
          error: null,
        };
      }
      if (op.table === "profiles" && op.kind === "select") {
        return {
          data: { stripe_account_id: "acct_creator", stripe_onboarding_complete: true },
          error: null,
        };
      }
      if (op.table === "booking_payments" && op.kind === "select") {
        return { data: options.existingPayment || null, error: null };
      }
      if (op.table === "booking_payments" && op.kind === "update") {
        return { data: { id: "payment_1" }, error: null };
      }
      return undefined;
    });
    client.auth.getUser = async () => ({ data: { user: { id: "creator_1" } }, error: null });
    return client;
  }

  it("uses the combined amount for a full booking payment", async () => {
    db = bookingDb();
    const { POST } = await import("@/app/api/bookings/[bookingId]/payment-link/route");
    const response = await POST(
      new Request("https://www.creatornet.net/api/bookings/booking_1/payment-link", {
        method: "POST",
        headers: { authorization: "Bearer token", "content-type": "application/json" },
        body: JSON.stringify({ plan_type: "full" }),
      }) as any,
      { params: Promise.resolve({ bookingId: "booking_1" }) },
    );

    expect(response.status).toBe(200);
    const params = checkoutCreate.mock.calls[0][0];
    expect(params.payment_intent_data.application_fee_amount).toBe(1_520);
    expect(params.payment_intent_data.transfer_data.destination).toBe("acct_creator");
    expect(checkoutCreate.mock.calls[0][1]?.idempotencyKey).toMatch(/^booking-payment:/);
  });

  it("reuses an existing live link instead of creating a second Stripe payment path", async () => {
    db = bookingDb({
      existingPayment: {
        id: "payment_existing",
        booking_id: "booking_1",
        plan_type: "full",
        installment_months: null,
        status: "link_sent",
        link_url: "https://checkout.stripe.test/existing",
        stripe_checkout_session_id: "cs_existing",
        stripe_payment_intent_id: null,
        stripe_subscription_id: null,
        amount_total_cents: 10_000,
        installment_amount_cents: null,
        platform_fee_cents: 1_200,
        processing_fee_cents: 320,
        total_creator_deduction_cents: 1_520,
        creator_net_cents: 8_480,
        fee_schedule_version: "test-us-card-v1",
        currency: "usd",
        created_at: "2026-09-03T00:00:00.000Z",
        completed_at: null,
        link_sent_at: "2026-09-03T00:00:00.000Z",
        closer_user_id: "creator_1",
      },
    });
    const { POST } = await import("@/app/api/bookings/[bookingId]/payment-link/route");
    const response = await POST(
      new Request("https://www.creatornet.net/api/bookings/booking_1/payment-link", {
        method: "POST",
        headers: { authorization: "Bearer token", "content-type": "application/json" },
        body: JSON.stringify({ plan_type: "full" }),
      }) as any,
      { params: Promise.resolve({ bookingId: "booking_1" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      url: "https://checkout.stripe.test/existing",
      reused: true,
    });
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("rejects generating another link after the booking is complete", async () => {
    db = bookingDb({ bookingStatus: "completed" });
    const { POST } = await import("@/app/api/bookings/[bookingId]/payment-link/route");
    const response = await POST(
      new Request("https://www.creatornet.net/api/bookings/booking_1/payment-link", {
        method: "POST",
        headers: { authorization: "Bearer token", "content-type": "application/json" },
        body: JSON.stringify({ plan_type: "full" }),
      }) as any,
      { params: Promise.resolve({ bookingId: "booking_1" }) },
    );

    expect(response.status).toBe(409);
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("stores the immutable schedule on an installment subscription", async () => {
    db = bookingDb();
    const { POST } = await import("@/app/api/bookings/[bookingId]/payment-link/route");
    const response = await POST(
      new Request("https://www.creatornet.net/api/bookings/booking_1/payment-link", {
        method: "POST",
        headers: { authorization: "Bearer token", "content-type": "application/json" },
        body: JSON.stringify({ plan_type: "installment", installment_months: 2 }),
      }) as any,
      { params: Promise.resolve({ bookingId: "booking_1" }) },
    );

    expect(response.status).toBe(200);
    const subscriptionData = checkoutCreate.mock.calls[0][0].subscription_data;
    expect(subscriptionData.application_fee_percent).toBe(12);
    expect(subscriptionData.metadata).toMatchObject({
      processing_fee_enabled: "true",
      processing_fee_bps: "360",
      processing_fee_fixed_cents: "30",
      fee_gross_cents: "5000",
      processing_fee_cents: "210",
      creator_net_cents: "4190",
      fee_schedule_version: "test-us-card-v1+billing-70bps",
    });
  });
});

describe("browser purchase confirmation", () => {
  it("does not grant access or credit earnings when Stripe captured the wrong creator deduction", async () => {
    db = createMockClient(() => undefined);
    db.auth.getUser = async () => ({ data: { user: { id: "buyer_1" } }, error: null });
    checkoutRetrieve.mockResolvedValue({
      id: "cs_undercollected",
      status: "complete",
      mode: "payment",
      payment_status: "paid",
      payment_intent: "pi_undercollected_confirm",
      subscription: null,
      amount_total: 10_000,
      currency: "usd",
      metadata: {
        buyer_id: "buyer_1",
        buyer_user_id: "buyer_1",
        creator_id: "creator_1",
        product_id: "product_1",
        post_id: "post_1",
        order_id: "order_1",
        processing_fee_enabled: "true",
        processing_fee_bps: "290",
        processing_fee_fixed_cents: "30",
        fee_schedule_version: "test-us-card-v1",
        fee_gross_cents: "10000",
        platform_fee_cents: "1200",
        processing_fee_cents: "320",
        total_creator_deduction_cents: "1520",
        creator_net_cents: "8480",
      },
    });
    paymentIntentRetrieve.mockResolvedValueOnce({
      id: "pi_undercollected_confirm",
      application_fee_amount: 1_200,
      latest_charge: {
        id: "ch_undercollected_confirm",
        balance_transaction: { id: "txn_undercollected_confirm", fee: 320 },
      },
    });

    const { POST } = await import("@/app/api/confirm-purchase/route");
    const response = await POST(
      new Request("https://www.creatornet.net/api/confirm-purchase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: "cs_undercollected" }),
      }),
    );

    expect(response.status).toBe(500);
    expect(db.opsFor("orders")).toHaveLength(0);
    expect(db.opsFor("purchases")).toHaveLength(0);
    expect(db.opsFor("credit_purchase_earnings")).toHaveLength(0);
  });

  it("polls a subscription purchase without applying one-time payment mutations", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") {
        return {
          data: {
            id: "purchase_subscription",
            status: "processing",
            access_granted: false,
            product_id: "product_1",
            post_id: "post_1",
            creator_id: "creator_1",
          },
          error: null,
        };
      }
      return undefined;
    });
    db.auth.getUser = async () => ({ data: { user: { id: "buyer_1" } }, error: null });
    checkoutRetrieve.mockResolvedValue({
      id: "cs_subscription_pending",
      status: "complete",
      mode: "subscription",
      payment_status: "paid",
      subscription: "sub_1",
      metadata: { buyer_id: "buyer_1" },
    });

    const { POST } = await import("@/app/api/confirm-purchase/route");
    const response = await POST(
      new Request("https://www.creatornet.net/api/confirm-purchase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: "cs_subscription_pending" }),
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      ok: true,
      purchase_id: "purchase_subscription",
      status: "pending",
    });
    expect(db.opsFor("purchases").filter((op) => op.kind === "update")).toHaveLength(0);
    expect(db.opsFor("credit_purchase_earnings")).toHaveLength(0);
    expect(db.opsFor("payment_fee_ledger")).toHaveLength(0);
  });

  it("returns fulfillment only after the invoice webhook activates installment access", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") {
        return {
          data: {
            id: "purchase_subscription_ready",
            status: "active",
            access_granted: true,
            product_id: "product_1",
            post_id: "post_1",
            creator_id: "creator_1",
          },
          error: null,
        };
      }
      if (op.table === "products" && op.kind === "select") {
        return {
          data: {
            id: "product_1",
            product_id: "public_product_1",
            type: "course",
            title: "Course",
            discord_invite_url: "https://discord.test/invite",
            whop_listing_url: null,
          },
          error: null,
        };
      }
      return undefined;
    });
    db.auth.getUser = async () => ({ data: { user: { id: "buyer_1" } }, error: null });
    checkoutRetrieve.mockResolvedValue({
      id: "cs_subscription_ready",
      status: "complete",
      mode: "subscription",
      payment_status: "paid",
      subscription: "sub_1",
      metadata: { buyer_id: "buyer_1" },
    });

    const { POST } = await import("@/app/api/confirm-purchase/route");
    const response = await POST(
      new Request("https://www.creatornet.net/api/confirm-purchase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: "cs_subscription_ready" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      purchase_id: "purchase_subscription_ready",
      status: "paid",
      product: {
        id: "public_product_1",
        discord_invite_url: "https://discord.test/invite",
      },
    });
    expect(db.opsFor("purchases").filter((op) => op.kind === "update")).toHaveLength(0);
    expect(db.opsFor("credit_purchase_earnings")).toHaveLength(0);
  });
});

describe("webhook purchase identity schema", () => {
  it.each(["checkout insert", "checkout update", "PaymentIntent update"])(
    "%s uses the real buyer columns without the nonexistent user_id alias",
    async (path) => {
      // The schema snapshot and the Sep 4 staging PostgREST error both confirm
      // purchases has buyer_id + buyer_user_id, but no user_id column. Reject
      // that payload as PostgREST does rather than accepting arbitrary fields.
      db = createMockClient((op: Op) => {
        if (op.table === "purchases" && op.kind === "select") {
          if (op.columns === "subscription_id") {
            return { data: { subscription_id: null }, error: null };
          }
          if (op.columns === "id" && path === "checkout update") {
            return { data: { id: "purchase_schema" }, error: null };
          }
          return { data: null, error: null };
        }
        if (op.table === "purchases" && ["insert", "update"].includes(op.kind)) {
          if (Object.prototype.hasOwnProperty.call(op.payload, "user_id")) {
            return {
              data: null,
              error: {
                code: "PGRST204",
                message: "Could not find the 'user_id' column of 'purchases' in the schema cache",
              },
            };
          }
          return { data: { id: "purchase_schema" }, error: null };
        }
        if (op.table === "payment_fee_ledger" && op.kind === "insert") {
          return { data: { id: "ledger_schema" }, error: null };
        }
        if (op.table === "credit_purchase_earnings") {
          return { data: true, error: null };
        }
        return undefined;
      });
      const metadata = {
        buyer_id: "buyer_1",
        buyer_user_id: "buyer_1",
        creator_id: "creator_1",
        product_id: "product_1",
        post_id: "post_1",
        order_id: "order_1",
        processing_fee_enabled: "true",
        processing_fee_bps: "290",
        processing_fee_fixed_cents: "30",
        fee_schedule_version: "test-us-card-v1",
        fee_gross_cents: "10000",
        platform_fee_cents: "1200",
        processing_fee_cents: "320",
        total_creator_deduction_cents: "1520",
        creator_net_cents: "8480",
      };
      paymentIntentRetrieve.mockResolvedValue({
        id: "pi_schema",
        application_fee_amount: 1_520,
        latest_charge: {
          id: "ch_schema",
          balance_transaction: { id: "txn_schema", fee: 320 },
        },
      });
      stripeEvent = {
        id: "evt_schema",
        type: path === "PaymentIntent update" ? "payment_intent.succeeded" : "checkout.session.completed",
        data: {
          object: path === "PaymentIntent update"
            ? { id: "pi_schema", amount: 10_000, amount_received: 10_000, currency: "usd", metadata }
            : {
                id: "cs_schema", mode: "payment", payment_status: "paid",
                amount_total: 10_000, currency: "usd", payment_intent: "pi_schema",
                subscription: null, metadata,
              },
        },
      };

      const { POST } = await import("@/app/api/stripe/webhook/route");
      const response = await POST(webhookRequest());

      expect(response.status).toBe(200);
      const write = db.opsFor("purchases").find((op) =>
        op.kind === (path === "checkout insert" ? "insert" : "update"));
      expect(write?.payload).toMatchObject({ buyer_id: "buyer_1", buyer_user_id: "buyer_1" });
      expect(write?.payload).not.toHaveProperty("user_id");
      expect(db.opsFor("payment_fee_ledger").find((op) => op.kind === "insert")?.payload)
        .toMatchObject({ purchase_id: "purchase_schema", stripe_payment_intent_id: "pi_schema" });
      expect(db.opsFor("credit_purchase_earnings")[0]?.payload)
        .toEqual({ p_purchase_id: "purchase_schema", p_creator_amount_cents: 8_480 });
    },
  );
});

describe("installment, failure, refund, and duplicate webhooks", () => {
  it("acknowledges an installment checkout without treating its missing PaymentIntent fee as a mismatch", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "insert") {
        return { data: { id: "purchase_installment" }, error: null };
      }
      return undefined;
    });
    stripeEvent = {
      id: "evt_installment_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_installment",
          mode: "subscription",
          payment_status: "paid",
          amount_total: 5_000,
          currency: "usd",
          subscription: "sub_installment",
          payment_intent: null,
          metadata: {
            booking_payment_id: "bp_installment",
            booking_id: "booking_1",
            product_id: "product_1",
            creator_id: "creator_1",
            buyer_id: "buyer_1",
            plan_type: "installment",
            processing_fee_enabled: "true",
            processing_fee_bps: "290",
            processing_fee_fixed_cents: "30",
            fee_schedule_version: "test-us-card-v1",
            fee_gross_cents: "5000",
            platform_fee_cents: "600",
            processing_fee_cents: "175",
            total_creator_deduction_cents: "775",
            creator_net_cents: "4225",
          },
        },
      },
    };

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(paymentIntentRetrieve).not.toHaveBeenCalled();
    expect(db.opsFor("purchases").find((op) => op.kind === "insert")?.payload).toMatchObject({
      subscription_id: "sub_installment",
      status: "processing",
      paid_count: 0,
    });
    expect(db.opsFor("booking_payments")[0]?.payload).not.toHaveProperty("status");
    expect(db.opsFor("bookings")).toHaveLength(0);
  });

  it("sets an exact per-invoice amount and recalculates a changed future invoice", async () => {
    db = createMockClient(() => undefined);
    const scheduleMetadata = {
      booking_payment_id: "bp_1",
      booking_id: "booking_1",
      creator_id: "creator_1",
      plan_type: "installment",
      processing_fee_enabled: "true",
      processing_fee_bps: "290",
      processing_fee_fixed_cents: "30",
      fee_schedule_version: "test-us-card-v1",
      fee_gross_cents: "10000",
      platform_fee_cents: "1200",
      processing_fee_cents: "320",
      total_creator_deduction_cents: "1520",
      creator_net_cents: "8480",
    };
    subscriptionRetrieve.mockResolvedValue({
      metadata: scheduleMetadata,
      transfer_data: { destination: "acct_creator" },
    });
    stripeEvent = {
      id: "evt_invoice_1",
      type: "invoice.created",
      data: { object: { id: "in_1", amount_due: 5_000, subscription: "sub_1", metadata: {} } },
    };

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(invoiceUpdate).toHaveBeenCalledWith(
      "in_1",
      expect.objectContaining({
        application_fee_amount: 775,
        transfer_data: { destination: "acct_creator" },
        metadata: expect.objectContaining({
          fee_gross_cents: "5000",
          platform_fee_cents: "600",
          processing_fee_cents: "175",
          creator_net_cents: "4225",
        }),
      }),
    );
  });

  it("acknowledges a claimed duplicate without applying the invoice twice", async () => {
    claimed = "duplicate";
    db = createMockClient(() => undefined);
    stripeEvent = {
      id: "evt_duplicate",
      type: "invoice.created",
      data: { object: { id: "in_duplicate", amount_due: 5_000 } },
    };
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());
    expect(response.status).toBe(200);
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it("fails closed when the event idempotency claim cannot be recorded", async () => {
    claimed = "unrecorded";
    db = createMockClient(() => undefined);
    stripeEvent = {
      id: "evt_unrecorded",
      type: "invoice.created",
      data: { object: { id: "in_unrecorded", amount_due: 5_000 } },
    };
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());
    expect(response.status).toBe(500);
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it("returns a retryable error while another delivery still owns the event", async () => {
    claimed = "busy";
    db = createMockClient(() => undefined);
    stripeEvent = {
      id: "evt_busy",
      type: "invoice.created",
      data: { object: { id: "in_busy", amount_due: 5_000 } },
    };
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());
    expect(response.status).toBe(500);
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it("records and credits a paid recurring invoice using the current payments shape", async () => {
    const scheduleMetadata = {
      booking_payment_id: "bp_1",
      booking_id: "booking_1",
      creator_id: "creator_1",
      product_id: "product_1",
      plan_type: "installment",
      plan_months: "3",
      processing_fee_enabled: "true",
      processing_fee_bps: "290",
      processing_fee_fixed_cents: "30",
      fee_schedule_version: "test-us-card-v1",
      fee_gross_cents: "5000",
      platform_fee_cents: "600",
      processing_fee_cents: "175",
      total_creator_deduction_cents: "775",
      creator_net_cents: "4225",
    };
    subscriptionRetrieve.mockResolvedValue({
      metadata: scheduleMetadata,
      transfer_data: { destination: "acct_creator" },
    });
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") {
        return {
          data: {
            id: "purchase_1",
            product_id: "product_1",
            creator_id: "creator_1",
            paid_count: 0,
            target_months: 3,
            fulfillment_url: "https://example.test/access",
          },
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
    stripeEvent = {
      id: "evt_invoice_paid_1",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_paid_1",
          amount_paid: 5_000,
          currency: "usd",
          parent: {
            subscription_details: {
              subscription: "sub_1",
              metadata: scheduleMetadata,
            },
          },
          payments: {
            data: [
              {
                id: "inpay_1",
                status: "paid",
                is_default: true,
                payment: { type: "payment_intent", payment_intent: "pi_recurring_1" },
              },
            ],
          },
          metadata: scheduleMetadata,
        },
      },
    };

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());
    expect(response.status).toBe(200);

    const ledgerInsert = db.opsFor("payment_fee_ledger").find((op) => op.kind === "insert");
    expect(ledgerInsert?.payload).toMatchObject({
      stripe_invoice_id: "in_paid_1",
      stripe_payment_intent_id: "pi_recurring_1",
      gross_amount_cents: 5_000,
      platform_fee_cents: 600,
      processing_fee_cents: 175,
      creator_net_cents: 4_225,
      actual_stripe_fee_cents: 175,
      processing_fee_variance_cents: 0,
    });
    expect(db.opsFor("credit_payment_fee_ledger_earnings")[0]?.payload).toEqual({
      p_ledger_id: "ledger_1",
    });
    const purchaseUpdate = db.opsFor("purchases").find((op) => op.kind === "update");
    expect(purchaseUpdate?.payload).not.toHaveProperty("paid_count");
    expect(purchaseUpdate?.payload).not.toHaveProperty("status");
  });

  it("advances a zero-dollar installment without inventing a Stripe charge or fee", async () => {
    const subscriptionSchedule = {
      booking_payment_id: "bp_zero",
      booking_id: "booking_zero",
      creator_id: "creator_1",
      product_id: "product_1",
      plan_type: "installment",
      plan_months: "3",
      processing_fee_enabled: "true",
      processing_fee_bps: "290",
      processing_fee_fixed_cents: "30",
      fee_schedule_version: "test-us-card-v1",
      fee_gross_cents: "5000",
      platform_fee_cents: "600",
      processing_fee_cents: "175",
      total_creator_deduction_cents: "775",
      creator_net_cents: "4225",
    };
    const zeroInvoiceMetadata = {
      ...subscriptionSchedule,
      fee_gross_cents: "0",
      platform_fee_cents: "0",
      processing_fee_cents: "0",
      total_creator_deduction_cents: "0",
      creator_net_cents: "0",
    };
    subscriptionRetrieve.mockResolvedValue({
      metadata: subscriptionSchedule,
      transfer_data: { destination: "acct_creator" },
    });
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") {
        return {
          data: {
            id: "purchase_zero",
            product_id: "product_1",
            creator_id: "creator_1",
            paid_count: 1,
            target_months: 3,
            fulfillment_url: "https://example.test/access",
          },
          error: null,
        };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "select") {
        return { data: null, error: null };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "insert") {
        return { data: { id: "ledger_zero" }, error: null };
      }
      if (op.table === "credit_payment_fee_ledger_earnings") {
        return { data: true, error: null };
      }
      return undefined;
    });
    stripeEvent = {
      id: "evt_invoice_zero",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_zero",
          amount_paid: 0,
          application_fee_amount: 0,
          currency: "usd",
          parent: {
            subscription_details: {
              subscription: "sub_zero",
              metadata: subscriptionSchedule,
            },
          },
          payments: { data: [] },
          metadata: zeroInvoiceMetadata,
        },
      },
    };

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(paymentIntentRetrieve).not.toHaveBeenCalled();
    expect(
      db.opsFor("payment_fee_ledger").find((op) => op.kind === "insert")?.payload,
    ).toMatchObject({
      stripe_invoice_id: "in_zero",
      gross_amount_cents: 0,
      platform_fee_cents: 0,
      processing_fee_cents: 0,
      creator_net_cents: 0,
    });
    expect(
      db.opsFor("payment_fee_ledger").find((op) => op.kind === "insert")?.payload,
    ).not.toHaveProperty("stripe_payment_intent_id");
    expect(db.opsFor("credit_payment_fee_ledger_earnings")[0]?.payload).toEqual({
      p_ledger_id: "ledger_zero",
    });
  });

  it("fails closed when a paid installment did not receive the configured application fee", async () => {
    const scheduleMetadata = {
      booking_payment_id: "bp_1",
      booking_id: "booking_1",
      creator_id: "creator_1",
      product_id: "product_1",
      plan_type: "installment",
      plan_months: "3",
      processing_fee_enabled: "true",
      processing_fee_bps: "290",
      processing_fee_fixed_cents: "30",
      fee_schedule_version: "test-us-card-v1",
      fee_gross_cents: "5000",
      platform_fee_cents: "600",
      processing_fee_cents: "175",
      total_creator_deduction_cents: "775",
      creator_net_cents: "4225",
    };
    paymentIntentRetrieve.mockResolvedValueOnce({
      id: "pi_undercollected",
      application_fee_amount: 600,
      latest_charge: {
        id: "ch_undercollected",
        balance_transaction: { id: "txn_undercollected", fee: 175 },
      },
    });
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") {
        return {
          data: {
            id: "purchase_1",
            product_id: "product_1",
            creator_id: "creator_1",
            paid_count: 0,
            target_months: 3,
            fulfillment_url: "https://example.test/access",
          },
          error: null,
        };
      }
      return undefined;
    });
    stripeEvent = {
      id: "evt_invoice_undercollected",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_undercollected",
          amount_paid: 5_000,
          currency: "usd",
          subscription: "sub_1",
          payment_intent: "pi_undercollected",
          metadata: scheduleMetadata,
        },
      },
    };
    subscriptionRetrieve.mockResolvedValue({
      metadata: scheduleMetadata,
      transfer_data: { destination: "acct_creator" },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());
    expect(response.status).toBe(500);
    expect(db.opsFor("purchases").filter((op) => op.kind === "update")).toHaveLength(0);
    expect(db.opsFor("payment_fee_ledger").filter((op) => op.kind === "insert")).toHaveLength(0);
  });

  it("keeps a retriable failed PaymentIntent from canceling or revoking a paid purchase", async () => {
    db = createMockClient(() => undefined);
    stripeEvent = {
      id: "evt_failed",
      type: "payment_intent.payment_failed",
      data: { object: { id: "pi_failed", metadata: { order_id: "order_1" } } },
    };
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());
    expect(response.status).toBe(200);
    expect(db.opsFor("credit_purchase_earnings")).toHaveLength(0);
    expect(db.opsFor("credit_payment_fee_ledger_earnings")).toHaveLength(0);
    expect(db.opsFor("orders")).toHaveLength(0);
    const purchaseFailure = db.opsFor("purchases").find((op) => op.kind === "update");
    expect(purchaseFailure?.payload).toEqual({ status: "failed", access_granted: false });
    expect(purchaseFailure?.inFilters).toContainEqual({
      column: "status",
      values: ["pending", "processing", "failed"],
    });
  });

  it("records disputes for audit without debiting creator earnings", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "record_payment_dispute_state" && op.kind === "rpc") {
        return { data: true, error: null };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "update") {
        return { data: { id: "ledger_1" }, error: null };
      }
      return undefined;
    });
    stripeEvent = {
      id: "evt_dispute_1",
      created: 1_788_000_000,
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_1",
          charge: "ch_1",
          payment_intent: "pi_1",
          amount: 4_000,
          currency: "usd",
          status: "needs_response",
        },
      },
    };

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());
    expect(response.status).toBe(200);
    expect(db.opsFor("record_payment_dispute_state")[0]?.payload).toMatchObject({
      p_dispute_id: "dp_1",
      p_payment_intent_id: "pi_1",
      p_disputed_amount_cents: 4_000,
      p_status: "needs_response",
    });
    expect(db.opsFor("payment_fee_ledger")[0]?.payload).toMatchObject({
      stripe_dispute_id: "dp_1",
      disputed_amount_cents: 4_000,
      dispute_status: "needs_response",
    });
    expect(db.opsFor("credit_purchase_earnings")).toHaveLength(0);
    expect(db.opsFor("credit_payment_fee_ledger_earnings")).toHaveLength(0);
    expect(db.opsFor("apply_purchase_refund_earnings")).toHaveLength(0);
  });

  it("does not let a generic succeeded event regress an installment purchase", async () => {
    db = createMockClient((op: Op) => {
      if (
        op.table === "payment_fee_ledger" &&
        op.kind === "select" &&
        op.columns === "stripe_invoice_id"
      ) {
        return { data: { stripe_invoice_id: "in_installment" }, error: null };
      }
      return undefined;
    });
    stripeEvent = {
      id: "evt_installment_pi_succeeded",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_installment",
          amount: 5_000,
          amount_received: 5_000,
          currency: "usd",
          metadata: {},
        },
      },
    };

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());
    expect(response.status).toBe(200);
    expect(db.opsFor("purchases").filter((op) => op.kind === "update")).toHaveLength(0);
    expect(db.opsFor("payment_fee_ledger").filter((op) => op.kind === "insert")).toHaveLength(0);
  });

  it("credits a one-time purchase when payment_intent.succeeded is the first completion path", async () => {
    paymentIntentRetrieve.mockResolvedValueOnce({
      id: "pi_one_time",
      application_fee_amount: 1_520,
      latest_charge: {
        id: "ch_one_time",
        balance_transaction: { id: "txn_one_time", fee: 320 },
      },
    });
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") {
        return { data: { subscription_id: null }, error: null };
      }
      if (op.table === "purchases" && op.kind === "update") {
        return { data: { id: "purchase_one_time" }, error: null };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "select") {
        return { data: null, error: null };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "insert") {
        return { data: { id: "ledger_one_time" }, error: null };
      }
      if (op.table === "credit_purchase_earnings") {
        return { data: true, error: null };
      }
      return undefined;
    });
    stripeEvent = {
      id: "evt_pi_one_time",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_one_time",
          amount: 10_000,
          amount_received: 10_000,
          currency: "usd",
          metadata: {
            order_id: "order_one_time",
            creator_id: "creator_1",
            buyer_id: "buyer_1",
            processing_fee_enabled: "true",
            processing_fee_bps: "290",
            processing_fee_fixed_cents: "30",
            fee_schedule_version: "test-us-card-v1",
            fee_gross_cents: "10000",
            platform_fee_cents: "1200",
            processing_fee_cents: "320",
            total_creator_deduction_cents: "1520",
            creator_net_cents: "8480",
          },
        },
      },
    };

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(db.opsFor("credit_purchase_earnings")[0]?.payload).toEqual({
      p_purchase_id: "purchase_one_time",
      p_creator_amount_cents: 8_480,
    });
    expect(
      db.opsFor("payment_fee_ledger").find((op) => op.kind === "insert")?.payload,
    ).toMatchObject({
      purchase_id: "purchase_one_time",
      stripe_payment_intent_id: "pi_one_time",
    });
  });

  it("preserves disabled 12%-only settlement when Stripe fee audit data is unavailable", async () => {
    paymentIntentRetrieve.mockRejectedValueOnce(new Error("temporary Stripe read failure"));
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") {
        return { data: { subscription_id: null }, error: null };
      }
      if (op.table === "purchases" && op.kind === "update") {
        return { data: { id: "purchase_legacy" }, error: null };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "select") {
        return { data: null, error: null };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "insert") {
        return { data: { id: "ledger_legacy" }, error: null };
      }
      if (op.table === "credit_purchase_earnings") {
        return { data: true, error: null };
      }
      return undefined;
    });
    stripeEvent = {
      id: "evt_pi_legacy",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_legacy",
          amount: 10_000,
          amount_received: 10_000,
          currency: "usd",
          metadata: {
            order_id: "order_legacy",
            creator_id: "creator_1",
            buyer_id: "buyer_1",
            processing_fee_enabled: "false",
            processing_fee_bps: "0",
            processing_fee_fixed_cents: "0",
            fee_schedule_version: "platform-only-v1",
            fee_gross_cents: "10000",
            platform_fee_cents: "1200",
            processing_fee_cents: "0",
            total_creator_deduction_cents: "1200",
            creator_net_cents: "8800",
          },
        },
      },
    };

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(db.opsFor("credit_purchase_earnings")[0]?.payload).toEqual({
      p_purchase_id: "purchase_legacy",
      p_creator_amount_cents: 8_800,
    });
    const ledger = db.opsFor("payment_fee_ledger").find((op) => op.kind === "insert")
      ?.payload as Record<string, unknown>;
    expect(ledger).toMatchObject({ processing_fee_cents: 0 });
    expect(ledger).not.toHaveProperty("actual_stripe_fee_cents");
  });

  it("cancels only open records when Checkout actually expires", async () => {
    db = createMockClient(() => undefined);
    stripeEvent = {
      id: "evt_expired",
      type: "checkout.session.expired",
      data: {
        object: {
          id: "cs_expired",
          metadata: { order_id: "order_expired", booking_payment_id: "bp_expired" },
        },
      },
    };

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());
    expect(response.status).toBe(200);
    expect(db.opsFor("orders")).toHaveLength(2);
    for (const orderUpdate of db.opsFor("orders")) {
      expect(orderUpdate.payload).toMatchObject({ status: "canceled" });
      expect(orderUpdate.inFilters).toContainEqual({
        column: "status",
        values: ["created"],
      });
    }
    expect(db.opsFor("purchases")[0]?.inFilters).toContainEqual({
      column: "status",
      values: ["pending", "processing", "failed"],
    });
    expect(db.opsFor("booking_payments")[0]?.payload).toMatchObject({ status: "expired" });
    expect(db.opsFor("credit_purchase_earnings")).toHaveLength(0);
  });

  it.each([
    ["partial", 2_500, 10_000],
    ["full", 10_000, 10_000],
  ])("passes Stripe's cumulative %s refund to both idempotent accounting RPCs", async (_kind, refunded, gross) => {
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") {
        return { data: [{ id: "purchase_1", subscription_id: null }], error: null };
      }
      if (op.table === "payment_fee_ledger" && op.kind === "select") {
        return { data: [{ id: "ledger_1" }], error: null };
      }
      if (op.table === "record_payment_refund_state" && op.kind === "rpc") {
        const payload = op.payload as { p_refunded_amount_cents: number };
        return { data: payload.p_refunded_amount_cents, error: null };
      }
      if (op.kind === "rpc") return { data: 0, error: null };
      return undefined;
    });
    stripeEvent = {
      id: `evt_refund_${refunded}`,
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: "pi_1",
          amount_refunded: refunded,
          amount: gross,
        },
      },
    };
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());
    expect(response.status).toBe(200);
    expect(db.opsFor("apply_purchase_refund_earnings")[0]?.payload).toEqual({
      p_purchase_id: "purchase_1",
      p_refunded_gross_cents: refunded,
    });
    expect(db.opsFor("apply_payment_fee_ledger_refund")[0]?.payload).toEqual({
      p_ledger_id: "ledger_1",
      p_refunded_gross_cents: refunded,
    });
  });

  it.each(["new", "duplicate"] as const)("confirms an unexpanded %s refund event without creating another refund", async (claimStatus) => {
    claimed = claimStatus;
    db = createMockClient((op: Op) => {
      if (op.table === "payment_refund_state") {
        return { data: { stripe_payment_intent_id: "pi_1", stripe_charge_id: "ch_1",
          charge_amount_cents: 10000, refunded_amount_cents: 3333 }, error: null };
      }
      if (op.table === "refund_operations" && op.kind === "select") {
        return { data: [{ id: "operation_1", stripe_refund_id: null,
          customer_refund_amount_cents: 3333, cumulative_customer_refund_target_cents: 3333 }], error: null };
      }
      if (op.table === "record_payment_refund_state") return { data: 3333, error: null };
      return undefined;
    });
    refundsList.mockResolvedValue({ data: [{ id: "re_exact", amount: 3333,
      payment_intent: "pi_1", charge: "ch_1", status: "succeeded",
      metadata: { creatornet_refund_operation_id: "operation_1" } }], has_more: false });
    stripeEvent = { id: "evt_confirm", type: "charge.refunded", data: { object: {
      id: "ch_1", payment_intent: "pi_1", amount: 10000, amount_refunded: 3333,
    } } };
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());
    expect(response.status).toBe(200);
    expect(refundsList).toHaveBeenCalledWith({ charge: "ch_1", limit: 100 });
    const markers = db.opsFor("refund_operations").filter(op => op.kind === "update");
    expect(markers).toHaveLength(1);
    expect(markers[0].payload).toMatchObject({ webhook_confirmed_at: expect.any(String) });
    if (claimStatus === "duplicate") {
      expect(await response.json()).toMatchObject({ duplicate: true });
      expect(db.ops.filter(op => op.kind === "rpc")).toHaveLength(0);
      expect(db.opsFor("purchases")).toHaveLength(0);
      expect(db.opsFor("orders")).toHaveLength(0);
      const { completeStripeEvent, releaseStripeEvent } = await import("@/lib/stripeEvents");
      expect(completeStripeEvent).not.toHaveBeenCalled();
      expect(releaseStripeEvent).not.toHaveBeenCalled();
    }
  });

  it("asks Stripe to retry a duplicate confirmation lookup failure without releasing its completed claim", async () => {
    claimed = "duplicate";
    db = createMockClient(() => ({ data: null, error: { message: "temporary database error" } }));
    stripeEvent = { id: "evt_confirm", type: "charge.refunded", data: { object: {
      id: "ch_1", payment_intent: "pi_1", amount: 10000, amount_refunded: 3333,
    } } };
    const { POST } = await import("@/app/api/stripe/webhook/route");
    expect((await POST(webhookRequest())).status).toBe(500);
    const { releaseStripeEvent } = await import("@/lib/stripeEvents");
    expect(releaseStripeEvent).not.toHaveBeenCalled();
    expect(db.ops.filter(op => op.kind === "update" || op.kind === "rpc")).toHaveLength(0);
  });

  it("does not confirm a duplicate against a different charge's persisted state", async () => {
    claimed = "duplicate";
    db = createMockClient(() => ({ data: { stripe_payment_intent_id: "pi_1", stripe_charge_id: "ch_other",
      charge_amount_cents: 10000, refunded_amount_cents: 3333 }, error: null }));
    stripeEvent = { id: "evt_confirm", type: "charge.refunded", data: { object: {
      id: "ch_1", payment_intent: "pi_1", amount: 10000, amount_refunded: 3333,
    } } };
    const { POST } = await import("@/app/api/stripe/webhook/route");
    expect((await POST(webhookRequest())).status).toBe(200);
    expect(refundsList).not.toHaveBeenCalled();
    expect(db.opsFor("refund_operations")).toHaveLength(0);
  });

  it("reverses a refunded installment only through its invoice ledger", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "record_payment_refund_state" && op.kind === "rpc") {
        return { data: 5_000, error: null };
      }
      if (op.table === "purchases" && op.kind === "select") {
        if (op.columns === "subscription_id") {
          return { data: { subscription_id: "sub_1" }, error: null };
        }
        if (op.columns === "id, subscription_id") {
          return {
            data: [{ id: "subscription_purchase", subscription_id: "sub_1" }],
            error: null,
          };
        }
      }
      if (op.table === "payment_fee_ledger" && op.kind === "select") {
        if (op.columns === "stripe_invoice_id") {
          return { data: { stripe_invoice_id: "in_1" }, error: null };
        }
        if (op.columns === "id") {
          return { data: [{ id: "installment_ledger" }], error: null };
        }
      }
      if (op.kind === "rpc") return { data: 0, error: null };
      return undefined;
    });
    stripeEvent = {
      id: "evt_refunded_installment",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_installment",
          payment_intent: "pi_installment",
          amount_refunded: 5_000,
          amount: 5_000,
        },
      },
    };

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(webhookRequest());
    expect(response.status).toBe(200);
    expect(db.opsFor("purchases").filter((op) => op.kind === "update")).toHaveLength(0);
    expect(db.opsFor("apply_purchase_refund_earnings")).toHaveLength(0);
    expect(db.opsFor("apply_payment_fee_ledger_refund")[0]?.payload).toEqual({
      p_ledger_id: "installment_ledger",
      p_refunded_gross_cents: 5_000,
    });
  });

  it("retains an early refund and reapplies it after the purchase rows exist", async () => {
    let rowsReady = false;
    const savedRefund = {
      stripe_payment_intent_id: "pi_early_refund",
      stripe_charge_id: "ch_early_refund",
      charge_amount_cents: 10_000,
      refunded_amount_cents: 2_500,
    };

    db = createMockClient((op: Op) => {
      if (op.table === "record_payment_refund_state" && op.kind === "rpc") {
        return { data: savedRefund.refunded_amount_cents, error: null };
      }
      if (op.table === "payment_refund_state" && op.kind === "select") {
        return { data: savedRefund, error: null };
      }
      if (op.table === "purchases" && op.kind === "select") {
        if (op.columns === "subscription_id") {
          return { data: rowsReady ? { subscription_id: null } : null, error: null };
        }
        if (op.columns === "id, subscription_id") {
          return {
            data: rowsReady
              ? [{ id: "purchase_late", subscription_id: null }]
              : [],
            error: null,
          };
        }
      }
      if (op.table === "payment_fee_ledger" && op.kind === "select") {
        if (op.columns === "stripe_invoice_id") {
          return { data: rowsReady ? { stripe_invoice_id: null } : null, error: null };
        }
        if (op.columns === "id") {
          return { data: rowsReady ? [{ id: "ledger_late" }] : [], error: null };
        }
      }
      if (op.kind === "rpc") return { data: 0, error: null };
      return undefined;
    });
    stripeEvent = {
      id: "evt_early_refund",
      type: "charge.refunded",
      data: {
        object: {
          id: savedRefund.stripe_charge_id,
          payment_intent: savedRefund.stripe_payment_intent_id,
          amount_refunded: savedRefund.refunded_amount_cents,
          amount: savedRefund.charge_amount_cents,
        },
      },
    };

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const firstResponse = await POST(webhookRequest());
    expect(firstResponse.status).toBe(200);
    expect(db.opsFor("record_payment_refund_state")).toHaveLength(1);
    expect(db.opsFor("apply_purchase_refund_earnings")).toHaveLength(0);

    rowsReady = true;
    const { reconcileKnownPaymentRefund } = await import("@/lib/paymentRefunds");
    await reconcileKnownPaymentRefund(db as any, savedRefund.stripe_payment_intent_id);

    expect(db.opsFor("apply_purchase_refund_earnings").at(-1)?.payload).toEqual({
      p_purchase_id: "purchase_late",
      p_refunded_gross_cents: 2_500,
    });
    expect(db.opsFor("apply_payment_fee_ledger_refund").at(-1)?.payload).toEqual({
      p_ledger_id: "ledger_late",
      p_refunded_gross_cents: 2_500,
    });
  });
});
