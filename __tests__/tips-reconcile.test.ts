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

function request(body: { limit?: number; cursor?: string } = { limit: 25 }) {
  return new NextRequest("https://creatornet.net/api/admin/tips/reconcile", {
    method: "POST",
    headers: { origin: "https://creatornet.net", host: "creatornet.net", "content-type": "application/json" },
    body: JSON.stringify(body),
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

test("advances past a finalized tip even when reconciliation changes its updated time", async () => {
  const created = "2026-09-26T01:00:00.000Z";
  tips = [
    { id: "11111111-1111-4111-8111-111111111111", status: "paid", stripe_checkout_session_id: "cs_first",
      stripe_payment_intent_id: null, created_at: created, updated_at: created },
    { id: "22222222-2222-4222-8222-222222222222", status: "paid", stripe_checkout_session_id: "cs_second",
      stripe_payment_intent_id: null, created_at: created, updated_at: "2026-09-26T02:00:00.000Z" },
  ];
  const originalFrom = db.from;
  db.from = (table: string) => {
    if (table !== "tips") return originalFrom(table);
    let field = "", after: { at: string; id: string; field: string } | null = null, limit = 25;
    const query = {
      select: () => query, in: () => query, returns: () => query,
      order: (name: string) => { if (!field) field = name; return query; },
      limit: (value: number) => { limit = value; return query; },
      or: (filter: string) => {
        const match = filter.match(/^(\w+)\.gt\.([^,]+),and\(\w+\.eq\.[^,]+,id\.gt\.([^\)]+)\)$/)!;
        after = { field: match[1], at: match[2], id: match[3] }; return query;
      },
      then: (resolve: (value: unknown) => unknown) => {
        const rows = tips.filter((tip) => !after || String(tip[after.field]) > after.at ||
          (tip[after.field] === after.at && String(tip.id) > after.id))
          .sort((a, b) => String(a[field]).localeCompare(String(b[field])) || String(a.id).localeCompare(String(b.id)))
          .slice(0, limit).map((row) => ({ ...row }));
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return query;
  };
  sessionRetrieve.mockImplementation(async (id: string) => ({ id, status: "complete", payment_status: "paid" }));
  checkoutUpdate.mockImplementation(async (_admin, session) => {
    tips.find((tip) => tip.stripe_checkout_session_id === session.id)!.updated_at = "2026-09-26T03:00:00.000Z";
  });
  const first = await (await POST(request({ limit: 1 }))).json();
  expect(checkoutUpdate.mock.calls[0][1].id).toBe("cs_first");
  await POST(request({ limit: 1, cursor: first.nextCursor }));
  expect(checkoutUpdate.mock.calls[1][1].id).toBe("cs_second");
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
