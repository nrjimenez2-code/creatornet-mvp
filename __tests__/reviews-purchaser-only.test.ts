/**
 * Purchaser-only reviews (Noah #5).
 *
 * Before this, /api/reviews let any signed-in account review any creator it
 * had never paid, and the page had no way to tell a buyer's review from a
 * stranger's. Both now derive from public.purchases (lib/reviewEligibility.ts):
 * a live row is access_granted=true AND status NOT IN ('refunded','failed').
 *
 * These import and invoke the REAL handler. The purchases responder below
 * applies the handler's own filters to a fixture, so dropping any one filter
 * (buyer, creator, access_granted, or the status exclusion) fails a test here.
 * Mutation-checked: removing the `.not("status", ...)` filter from
 * hasQualifyingPurchase fails "refuses when the only purchase was refunded".
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";

import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";
import { _resetRateLimits } from "@/lib/rateLimit";
import { verifiedReviewerIds } from "@/lib/reviewEligibility";

type PurchaseRow = {
  id: string;
  buyer_id: string;
  creator_id: string;
  access_granted: boolean;
  status: string;
};

let db: MockClient;          // the service-role client
let sessionDb: MockClient;   // the request-scoped client (auth + profiles + reviews)
let authUser: { id: string } | null = { id: "buyer_1" };
let bannedAt: string | null = null;
let purchases: PurchaseRow[] = [];
/** When set, the session client reports this review already exists (update path). */
let existingReviewId: string | null = null;

jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => sessionDb,
  createSupabaseServer: () => sessionDb,
}));

/** Parse the PostgREST list the handler passes to .not("status", "in", "(a,b)"). */
function excludedStatuses(op: Op): string[] {
  return op.notFilters
    .filter((f) => f.column === "status" && f.op === "in")
    .flatMap((f) => f.value.replace(/^\(|\)$/g, "").split(","));
}

/** Apply the handler's own filters to the fixture, the way PostgREST would. */
function matchingPurchases(op: Op): PurchaseRow[] {
  const excluded = excludedStatuses(op);
  const inBuyers = op.inFilters.find((f) => f.column === "buyer_id");
  return purchases.filter((row) => {
    if ("buyer_id" in op.filters && row.buyer_id !== op.filters.buyer_id) return false;
    if ("creator_id" in op.filters && row.creator_id !== op.filters.creator_id) return false;
    if ("access_granted" in op.filters && row.access_granted !== op.filters.access_granted) return false;
    if (inBuyers && !inBuyers.values.includes(row.buyer_id)) return false;
    if (excluded.includes(row.status)) return false;
    return true;
  });
}

function makeAdminDb() {
  return createMockClient((op: Op) => {
    if (op.table === "purchases" && op.kind === "select") {
      const rows = matchingPurchases(op);
      // .maybeSingle() (gate) wants one row or null; the list query wants rows.
      const wantsList = op.columns === "buyer_id";
      return { data: wantsList ? rows : rows[0] ?? null, error: null };
    }
    if (op.kind === "rpc") return { data: [{ avg_rating: 5, review_count: 1 }], error: null };
    return undefined;
  });
}

function makeSessionDb() {
  const c = createMockClient((op: Op) => {
    if (op.table === "profiles" && op.kind === "select") {
      return { data: { banned_at: bannedAt }, error: null };
    }
    if (op.table === "reviews" && op.kind === "select") {
      return { data: existingReviewId ? { id: existingReviewId } : null, error: null };
    }
    if (op.table === "reviews" && op.kind === "insert") {
      return { data: { id: "review_1", ...(op.payload as object) }, error: null };
    }
    if (op.table === "reviews" && op.kind === "update") {
      return { data: { id: existingReviewId, ...(op.payload as object) }, error: null };
    }
    return undefined;
  }) as any;
  c.auth = { getUser: async () => ({ data: { user: authUser }, error: null }) };
  return c as MockClient;
}

function reviewReq(body: unknown, ip = "4.4.4.4") {
  return new Request("https://x/api/reviews", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  }) as any;
}

const VALID_REVIEW = { creator_id: "creator_1", rating: 5, comment: "Great coaching, worth every cent." };

const paid = (over: Partial<PurchaseRow> = {}): PurchaseRow => ({
  id: "p1",
  buyer_id: "buyer_1",
  creator_id: "creator_1",
  access_granted: true,
  status: "paid",
  ...over,
});

const writesAcross = (...clients: MockClient[]) =>
  clients.flatMap((c) => c.ops).filter((o) => o.kind !== "select" && o.kind !== "rpc");

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  _resetRateLimits();
  authUser = { id: "buyer_1" };
  bannedAt = null;
  purchases = [];
  existingReviewId = null;
  db = makeAdminDb();
  sessionDb = makeSessionDb();
});

async function post(body: unknown = VALID_REVIEW) {
  const { POST } = await import("@/app/api/reviews/route");
  return POST(reviewReq(body));
}

describe("POST /api/reviews is purchaser-only", () => {
  it("refuses a signed-in non-buyer with 403 PURCHASE_REQUIRED and writes nothing", async () => {
    purchases = [];
    const res = await post();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      code: "PURCHASE_REQUIRED",
      error: "Only customers who bought from this creator can leave a review.",
    });
    expect(writesAcross(db, sessionDb)).toHaveLength(0);
    // and it asked the service-role client, scoped to this buyer + creator
    const [gate] = db.opsFor("purchases");
    expect(gate.filters).toMatchObject({ buyer_id: "buyer_1", creator_id: "creator_1", access_granted: true });
  });

  it("refuses when the only purchase was refunded (status flipped, access still true)", async () => {
    purchases = [paid({ status: "refunded" })];
    const res = await post();

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("PURCHASE_REQUIRED");
    expect(writesAcross(db, sessionDb)).toHaveLength(0);
  });

  it("refuses when access was revoked even though status still says paid", async () => {
    purchases = [paid({ access_granted: false })];
    const res = await post();

    expect(res.status).toBe(403);
    expect(writesAcross(db, sessionDb)).toHaveLength(0);
  });

  it("refuses when the buyer's only purchase is from a different creator", async () => {
    purchases = [paid({ creator_id: "creator_other" })];
    const res = await post();

    expect(res.status).toBe(403);
    expect(writesAcross(db, sessionDb)).toHaveLength(0);
  });

  it("lets a buyer with a live purchase through and inserts exactly one review", async () => {
    purchases = [paid()];
    const res = await post();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const inserts = sessionDb.opsFor("reviews").filter((o) => o.kind === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toMatchObject({
      reviewer_id: "buyer_1",
      creator_id: "creator_1",
      rating: 5,
      comment: VALID_REVIEW.comment,
    });
  });

  it("still refuses a banned buyer first, without ever consulting purchases", async () => {
    purchases = [paid()];
    bannedAt = "2026-09-01T00:00:00Z";
    const res = await post();

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ACCOUNT_BANNED");
    expect(db.opsFor("purchases")).toHaveLength(0);
    expect(writesAcross(db, sessionDb)).toHaveLength(0);
  });

  it("does not consult purchases for an invalid body (400 first)", async () => {
    purchases = [paid()];
    const res = await post({ ...VALID_REVIEW, comment: "short" });

    expect(res.status).toBe(400);
    expect(db.opsFor("purchases")).toHaveLength(0);
  });

  it("refuses to EDIT an existing review once the purchase is refunded (no update written)", async () => {
    existingReviewId = "review_old";
    purchases = [paid({ status: "refunded" })];
    const res = await post({ ...VALID_REVIEW, rating: 1, comment: "Changed my mind after the refund." });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("PURCHASE_REQUIRED");
    // The gate runs before the existing-review lookup, so nothing touched reviews.
    expect(sessionDb.opsFor("reviews")).toHaveLength(0);
    expect(writesAcross(db, sessionDb)).toHaveLength(0);
  });

  it("still lets a live buyer UPDATE their existing review", async () => {
    existingReviewId = "review_old";
    purchases = [paid()];
    const res = await post({ ...VALID_REVIEW, rating: 4 });

    expect(res.status).toBe(200);
    const updates = sessionDb.opsFor("reviews").filter((o) => o.kind === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].filters).toMatchObject({ id: "review_old" });
    expect(updates[0].payload).toMatchObject({ reviewer_id: "buyer_1", creator_id: "creator_1", rating: 4 });
    expect(sessionDb.opsFor("reviews").filter((o) => o.kind === "insert")).toHaveLength(0);
  });

  it("fails CLOSED with 503 when the service-role key is missing: no purchase query, no write", async () => {
    purchases = [paid()];
    const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post();

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Reviews are temporarily unavailable" });
      expect(db.opsFor("purchases")).toHaveLength(0);
      expect(sessionDb.opsFor("reviews")).toHaveLength(0);
      expect(writesAcross(db, sessionDb)).toHaveLength(0);
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
      errSpy.mockRestore();
    }
  });

  it("does not consult purchases for a self-review (400 first)", async () => {
    purchases = [paid({ buyer_id: "creator_1" })];
    authUser = { id: "creator_1" };
    const res = await post();

    expect(res.status).toBe(400);
    expect(db.opsFor("purchases")).toHaveLength(0);
  });
});

describe("verifiedReviewerIds (read-time 'Verified Purchase' label)", () => {
  it("labels only reviewers with a live purchase from this creator", async () => {
    purchases = [
      paid({ id: "a", buyer_id: "buyer_live" }),
      paid({ id: "b", buyer_id: "buyer_refunded", status: "refunded" }),
      paid({ id: "c", buyer_id: "buyer_revoked", access_granted: false }),
      paid({ id: "d", buyer_id: "buyer_elsewhere", creator_id: "creator_other" }),
    ];

    const ids = await verifiedReviewerIds(
      db as any,
      "creator_1",
      ["buyer_live", "buyer_refunded", "buyer_revoked", "buyer_elsewhere", "buyer_never"]
    );

    expect([...ids]).toEqual(["buyer_live"]);
  });

  it("does not query at all when there are no reviewers", async () => {
    const ids = await verifiedReviewerIds(db as any, "creator_1", []);
    expect(ids.size).toBe(0);
    expect(db.opsFor("purchases")).toHaveLength(0);
  });
});
