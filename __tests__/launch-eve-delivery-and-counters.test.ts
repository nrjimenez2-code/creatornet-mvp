/**
 * Behavioural tests for the delivery and counter fixes. Like
 * launch-eve-money-path.test.ts these import and invoke the real handlers, and
 * each was checked to FAIL when its fix is reverted.
 */

process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";
process.env.NEXT_PUBLIC_SITE_URL = "https://www.creatornet.net";

import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";
import { purchaseTerminalFilter } from "@/lib/orderStatus";

let db: MockClient;
let authUser: { id: string } | null = { id: "buyer_1" };
let retrieveImpl: () => any;
const bumpPostComments = jest.fn().mockResolvedValue({ count: 3, usedFallback: false });

jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: authUser } }) } }),
  createSupabaseServer: () => ({ auth: { getUser: async () => ({ data: { user: authUser } }) } }),
}));
jest.mock("@/lib/stripeClient", () => ({
  getStripe: () => ({ checkout: { sessions: { retrieve: async () => retrieveImpl() } } }),
}));
jest.mock("@/lib/postCounters", () => ({ bumpPostComments: (...a: unknown[]) => bumpPostComments(...a) }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  authUser = { id: "buyer_1" };
  bumpPostComments.mockResolvedValue({ count: 3, usedFallback: false });
});

// ---------------------------------------------------------------------------
// CN-02 / CN-26 — /success must actually deliver, and must book the revenue
// ---------------------------------------------------------------------------

describe("CN-02: confirm-purchase grants access", () => {
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

  /**
   * Reverts to: updateFields set status='paid' and nothing else. Both premium
   * gates require access_granted, which only the (never-fired) webhook set — so
   * a buyer whose payment was confirmed here still got a 402 on the download.
   */
  it("sets access_granted for a paid one-time session", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") return { data: { id: "p1" }, error: null };
      if (op.table === "purchases" && op.kind === "update") {
        return { data: { id: "p1", status: "paid" }, error: null };
      }
      return undefined;
    });
    retrieveImpl = () => paidSession;

    const { POST } = await import("@/app/api/confirm-purchase/route");
    const res = await POST(new Request("https://x/api/confirm-purchase", {
      method: "POST",
      body: JSON.stringify({ session_id: "cs_test_1" }),
    }));
    expect(res.status).toBe(200);

    const upd = db.opsFor("purchases").find((o) => o.kind === "update");
    expect(upd).toBeDefined();
    expect((upd!.payload as any).access_granted).toBe(true);
  });

  it("does NOT grant access for a subscription session", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") return { data: { id: "p1" }, error: null };
      if (op.table === "purchases" && op.kind === "update") return { data: { id: "p1" }, error: null };
      return undefined;
    });
    retrieveImpl = () => ({ ...paidSession, mode: "subscription", subscription: "sub_1" });

    const { POST } = await import("@/app/api/confirm-purchase/route");
    await POST(new Request("https://x/api/confirm-purchase", {
      method: "POST",
      body: JSON.stringify({ session_id: "cs_test_1" }),
    }));

    const upd = db.opsFor("purchases").find((o) => o.kind === "update");
    expect((upd!.payload as any).access_granted).toBe(false);
  });

  it("carries the terminal-status guard so a refunded buyer cannot re-grant themselves", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") return { data: { id: "p1" }, error: null };
      if (op.table === "purchases" && op.kind === "update") return { data: { id: "p1" }, error: null };
      return undefined;
    });
    retrieveImpl = () => paidSession;

    const { POST } = await import("@/app/api/confirm-purchase/route");
    await POST(new Request("https://x/api/confirm-purchase", {
      method: "POST",
      body: JSON.stringify({ session_id: "cs_test_1" }),
    }));

    const upd = db.opsFor("purchases").find((o) => o.kind === "update");
    expect(upd!.notFilters).toContainEqual({
      column: "status",
      op: "in",
      value: purchaseTerminalFilter(),
    });
  });

  /**
   * Reverts to: this route never touched `orders`. Every figure on the admin
   * commerce dashboard comes from orders with status='paid', so the founder's
   * revenue view read $0 while purchases recorded real sales.
   */
  it("finalizes the order so the admin dashboard shows the revenue", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "purchases" && op.kind === "select") return { data: { id: "p1" }, error: null };
      if (op.table === "purchases" && op.kind === "update") return { data: { id: "p1" }, error: null };
      return undefined;
    });
    retrieveImpl = () => paidSession;

    const { POST } = await import("@/app/api/confirm-purchase/route");
    await POST(new Request("https://x/api/confirm-purchase", {
      method: "POST",
      body: JSON.stringify({ session_id: "cs_test_1" }),
    }));

    const orderUpd = db.opsFor("orders").find((o) => o.kind === "update");
    expect(orderUpd).toBeDefined();
    expect(orderUpd!.filters.id).toBe("order_1");
    const p = orderUpd!.payload as any;
    expect(p.status).toBe("paid");
    expect(p.gross_amount).toBe(10000);
    // 12% of $100.00, split by lib/money.
    expect(p.platform_fee).toBe(1200);
    expect(p.creator_amount).toBe(8800);
    // ...and only from an open status, so a refund is never dragged back to paid.
    expect(orderUpd!.inFilters).toContainEqual({ column: "status", values: ["created"] });
  });

  it("still refuses a session belonging to someone else", async () => {
    db = createMockClient(() => undefined);
    retrieveImpl = () => ({ ...paidSession, metadata: { ...paidSession.metadata, buyer_user_id: "someone_else" } });

    const { POST } = await import("@/app/api/confirm-purchase/route");
    const res = await POST(new Request("https://x/api/confirm-purchase", {
      method: "POST",
      body: JSON.stringify({ session_id: "cs_test_1" }),
    }));
    expect(res.status).toBe(403);
    expect(db.opsFor("purchases").filter((o) => o.kind === "update")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CN-09 — a comment delete must not touch another post's counter
// ---------------------------------------------------------------------------

describe("CN-09: deleting a comment only affects its own post", () => {
  function req() {
    return { } as any;
  }

  /**
   * Reverts to: the ownership check selected only (id, user_id) and the
   * decrement used the URL's postId. Deleting your own comment on post A via
   * /api/posts/<B>/comments/<id> decremented post B's counter.
   */
  it("refuses when the comment belongs to a different post", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "comments" && op.kind === "select") {
        return { data: { id: "c1", user_id: "buyer_1", post_id: "post_A" }, error: null };
      }
      return undefined;
    });

    const { DELETE } = await import("@/app/api/posts/[postId]/comments/[commentId]/route");
    const res = await DELETE(req(), { params: Promise.resolve({ postId: "post_B", commentId: "c1" }) });

    expect(res.status).toBe(404);
    expect(bumpPostComments).not.toHaveBeenCalled();
    expect(db.opsFor("comments").filter((o) => o.kind === "delete")).toHaveLength(0);
  });

  it("decrements the comment's own post when the URL matches", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "comments" && op.kind === "select") {
        return { data: { id: "c1", user_id: "buyer_1", post_id: "post_A" }, error: null };
      }
      return undefined;
    });

    const { DELETE } = await import("@/app/api/posts/[postId]/comments/[commentId]/route");
    const res = await DELETE(req(), { params: Promise.resolve({ postId: "post_A", commentId: "c1" }) });

    expect(res.status).toBe(200);
    expect(bumpPostComments).toHaveBeenCalledWith(expect.anything(), "post_A", -1);
  });

  it("still refuses someone else's comment", async () => {
    db = createMockClient((op: Op) => {
      if (op.table === "comments" && op.kind === "select") {
        return { data: { id: "c1", user_id: "another_user", post_id: "post_A" }, error: null };
      }
      return undefined;
    });

    const { DELETE } = await import("@/app/api/posts/[postId]/comments/[commentId]/route");
    const res = await DELETE(req(), { params: Promise.resolve({ postId: "post_A", commentId: "c1" }) });

    expect(res.status).toBe(403);
    expect(bumpPostComments).not.toHaveBeenCalled();
  });
});
