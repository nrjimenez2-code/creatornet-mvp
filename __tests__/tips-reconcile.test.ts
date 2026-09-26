import { NextRequest } from "next/server";
import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";

const sessionRetrieve = jest.fn();
const checkoutUpdate = jest.fn();
let db: MockClient;
let tips: Array<Record<string, unknown>> = [];
let recoveryLookupError = false;

jest.mock("@/lib/admin/server", () => ({
  requireAdmin: async () => ({ admin: db }),
  adminAuthErrorResponse: () => { throw new Error("Unexpected auth failure"); },
}));
jest.mock("@/lib/stripeClient", () => ({
  getStripe: () => ({ checkout: { sessions: { retrieve: sessionRetrieve } } }),
}));
jest.mock("@/lib/tipEvents", () => ({ updateTipFromCheckoutEvent: (...args: unknown[]) => checkoutUpdate(...args) }));
jest.mock("@/lib/paymentRefunds", () => ({ reconcileKnownPaymentRefund: jest.fn() }));
jest.mock("@/lib/paymentDisputes", () => ({ reconcileKnownPaymentDispute: jest.fn() }));
jest.mock("@/lib/tipDisputes", () => ({ reconcileTipDisputeRecovery: jest.fn() }));

import { POST } from "@/app/api/admin/tips/reconcile/route";

beforeEach(() => {
  jest.clearAllMocks();
  tips = [];
  recoveryLookupError = false;
  db = createMockClient((op: Op) => {
    if (op.table === "tips" && op.kind === "select") return { data: tips, error: null };
    if (op.table === "tip_dispute_recoveries" && op.kind === "select") {
      return recoveryLookupError
        ? { data: null, error: { message: "lookup unavailable" } }
        : { data: [], error: null };
    }
    return { data: null, error: null };
  });
});

function request() {
  return new NextRequest("https://creatornet.net/api/admin/tips/reconcile", {
    method: "POST",
    headers: { origin: "https://creatornet.net", host: "creatornet.net", "content-type": "application/json" },
    body: JSON.stringify({ limit: 25 }),
  });
}

test("leaves an open Checkout Session untouched", async () => {
  tips = [{ id: "tip-1", status: "open", stripe_checkout_session_id: "cs_tip", stripe_payment_intent_id: null, updated_at: new Date().toISOString() }];
  sessionRetrieve.mockResolvedValue({ id: "cs_tip", status: "open", payment_status: "unpaid" });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ reconciledCount: 0, skippedCount: 1, failureCount: 0 });
  expect(checkoutUpdate).not.toHaveBeenCalled();
});

test("flags a stale attempt with no Stripe Session for operator review", async () => {
  tips = [{ id: "tip-2", status: "creating", stripe_checkout_session_id: null, stripe_payment_intent_id: null,
    updated_at: new Date(Date.now() - 3 * 60_000).toISOString() }];
  const response = await POST(request());
  expect(await response.json()).toMatchObject({
    reconciledCount: 0, failureCount: 1,
    failures: [{ tipId: "tip-2", code: "missing_checkout_session" }],
  });
  expect(sessionRetrieve).not.toHaveBeenCalled();
});

test("does not report a clean reconciliation when dispute recovery lookup fails", async () => {
  recoveryLookupError = true;
  const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Tip dispute recovery lookup failed." });
  } finally {
    errorLog.mockRestore();
  }
});
