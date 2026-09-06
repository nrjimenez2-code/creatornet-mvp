/**
 * Reviews are tied to the exact offer the buyer purchased (Noah #5, step 2).
 *
 * v1 (reviews-purchaser-only.test.ts) gated on ANY live purchase from the
 * creator, so someone who bought creator X's $5 clip could review X's $500
 * course. Now a review names post_id, the gate checks a live purchase of
 * THAT post (lib/reviewEligibility.ts hasQualifyingPurchaseForPost), the post
 * must belong to creator_id, and one buyer gets one review per offer.
 *
 * These import and invoke the REAL handler. The purchases responder applies
 * the handler's own filters to a fixture, so dropping the post_id filter from
 * the gate fails "refuses when the buyer bought a DIFFERENT offer".
 * Mutation-checked: see the PR body.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";

import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";
import { _resetRateLimits } from "@/lib/rateLimit";
import {
  isVerifiedPurchase,
  livePurchasesByReviewers,
  viewerPurchasedPosts,
} from "@/lib/reviewEligibility";

type PurchaseRow = {
  id: string;
  buyer_id: string;
  creator_id: string;
  post_id: string;
  access_granted: boolean;
  status: string;
};

type PostRow = { id: string; creator_id: string; title: string | null };

const POSTS: PostRow[] = [
  { id: "post_clip", creator_id: "creator_1", title: "Quick clip" },
  { id: "post_course", creator_id: "creator_1", title: "Full course" },
  { id: "post_untitled", creator_id: "creator_1", title: null },
  { id: "post_other", creator_id: "creator_other", title: "Someone else's offer" },
];

let db: MockClient;          // the service-role client
let sessionDb: MockClient;   // the request-scoped client (auth + profiles + reviews)
let authUser: { id: string } | null = { id: "buyer_1" };
let purchases: PurchaseRow[] = [];
/** reviews that already exist, keyed by `${reviewer_id}:${post_id}`. */
let existingReviews: Record<string, string> = {};

jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => sessionDb,
  createSupabaseServer: () => sessionDb,
}));

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
    if ("post_id" in op.filters && row.post_id !== op.filters.post_id) return false;
    if ("access_granted" in op.filters && row.access_granted !== op.filters.access_granted) return false;
    if (inBuyers && !inBuyers.values.includes(row.buyer_id)) return false;
    if (excluded.includes(row.status)) return false;
    return true;
  });
}

function matchingPosts(op: Op): PostRow[] {
  const inIds = op.inFilters.find((f) => f.column === "id");
  return POSTS.filter((post) => {
    if ("id" in op.filters && post.id !== op.filters.id) return false;
    if ("creator_id" in op.filters && post.creator_id !== op.filters.creator_id) return false;
    if (inIds && !inIds.values.includes(post.id)) return false;
    return true;
  });
}

function makeAdminDb() {
  return createMockClient((op: Op) => {
    if (op.table === "purchases" && op.kind === "select") {
      const rows = matchingPurchases(op);
      const wantsList = op.columns !== "id";
      return { data: wantsList ? rows : rows[0] ?? null, error: null };
    }
    if (op.table === "posts" && op.kind === "select") {
      const rows = matchingPosts(op);
      const wantsList = Boolean(op.inFilters.length);
      return { data: wantsList ? rows : rows[0] ?? null, error: null };
    }
    if (op.kind === "rpc") return { data: [{ avg_rating: 5, review_count: 1 }], error: null };
    return undefined;
  });
}

function makeSessionDb() {
  const c = createMockClient((op: Op) => {
    if (op.table === "profiles" && op.kind === "select") {
      return { data: { banned_at: null }, error: null };
    }
    if (op.table === "reviews" && op.kind === "select") {
      const key = `${op.filters.reviewer_id}:${op.filters.post_id}`;
      const id = existingReviews[key];
      return { data: id ? { id } : null, error: null };
    }
    if (op.table === "reviews" && op.kind === "insert") {
      return { data: { id: "review_new", ...(op.payload as object) }, error: null };
    }
    if (op.table === "reviews" && op.kind === "update") {
      return { data: { id: op.filters.id, ...(op.payload as object) }, error: null };
    }
    return undefined;
  }) as any;
  c.auth = { getUser: async () => ({ data: { user: authUser }, error: null }) };
  return c as MockClient;
}

function reviewReq(body: unknown, ip = "5.5.5.5") {
  return new Request("https://x/api/reviews", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  }) as any;
}

const VALID_REVIEW = {
  creator_id: "creator_1",
  post_id: "post_course",
  rating: 5,
  comment: "The course was worth every cent.",
};

const paid = (over: Partial<PurchaseRow> = {}): PurchaseRow => ({
  id: "p1",
  buyer_id: "buyer_1",
  creator_id: "creator_1",
  post_id: "post_course",
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
  purchases = [];
  existingReviews = {};
  db = makeAdminDb();
  sessionDb = makeSessionDb();
});

async function post(body: unknown = VALID_REVIEW) {
  const { POST } = await import("@/app/api/reviews/route");
  return POST(reviewReq(body));
}

describe("POST /api/reviews is per offer", () => {
  it("400s without post_id, before consulting purchases or posts", async () => {
    purchases = [paid()];
    const { post_id: _omitted, ...noPost } = VALID_REVIEW;
    void _omitted;
    const res = await post(noPost);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("post_id is required");
    expect(db.ops).toHaveLength(0);
    expect(writesAcross(db, sessionDb)).toHaveLength(0);
  });

  it("400s on a post_id that is not a safe id (it goes into a PostgREST filter)", async () => {
    purchases = [paid()];
    const res = await post({ ...VALID_REVIEW, post_id: "post_course,creator_id.eq.x)" });

    expect(res.status).toBe(400);
    expect(db.ops).toHaveLength(0);
  });

  it("400s when the post belongs to a different creator, without consulting purchases", async () => {
    purchases = [paid({ post_id: "post_other", creator_id: "creator_other" })];
    const res = await post({ ...VALID_REVIEW, post_id: "post_other" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("post_id does not belong to this creator");
    expect(db.opsFor("purchases")).toHaveLength(0);
    expect(writesAcross(db, sessionDb)).toHaveLength(0);
  });

  it("400s when the post does not exist", async () => {
    purchases = [paid({ post_id: "post_gone" })];
    const res = await post({ ...VALID_REVIEW, post_id: "post_gone" });

    expect(res.status).toBe(400);
    expect(db.opsFor("purchases")).toHaveLength(0);
  });

  it("refuses when the buyer bought a DIFFERENT offer from the same creator (the case v1 allowed)", async () => {
    // Bought the clip, trying to review the course.
    purchases = [paid({ post_id: "post_clip" })];
    const res = await post({ ...VALID_REVIEW, post_id: "post_course" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      code: "PURCHASE_REQUIRED",
      error: "Only customers who bought this offer can leave a review.",
    });
    expect(writesAcross(db, sessionDb)).toHaveLength(0);
    // the gate asked about this buyer + this post, not just this creator
    const [gate] = db.opsFor("purchases");
    expect(gate.filters).toMatchObject({ buyer_id: "buyer_1", post_id: "post_course", access_granted: true });
  });

  it("refuses when the purchase of that offer was refunded", async () => {
    purchases = [paid({ status: "refunded" })];
    const res = await post();

    expect(res.status).toBe(403);
    expect(writesAcross(db, sessionDb)).toHaveLength(0);
  });

  it("201s and inserts one review carrying post_id when they bought that offer", async () => {
    purchases = [paid()];
    const res = await post();

    expect(res.status).toBe(201);
    expect((await res.json()).success).toBe(true);

    const inserts = sessionDb.opsFor("reviews").filter((o) => o.kind === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toMatchObject({
      reviewer_id: "buyer_1",
      creator_id: "creator_1",
      post_id: "post_course",
      rating: 5,
    });
    expect(sessionDb.opsFor("reviews").filter((o) => o.kind === "update")).toHaveLength(0);
  });

  it("a second submit for the SAME offer updates instead of inserting (200)", async () => {
    purchases = [paid()];
    existingReviews = { "buyer_1:post_course": "review_course" };
    const res = await post({ ...VALID_REVIEW, rating: 3, comment: "Changed my mind after week two." });

    expect(res.status).toBe(200);
    const lookup = sessionDb.opsFor("reviews").find((o) => o.kind === "select")!;
    expect(lookup.filters).toEqual({ reviewer_id: "buyer_1", post_id: "post_course" });

    const updates = sessionDb.opsFor("reviews").filter((o) => o.kind === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].filters).toMatchObject({ id: "review_course" });
    expect(updates[0].payload).toMatchObject({ post_id: "post_course", rating: 3 });
    expect(sessionDb.opsFor("reviews").filter((o) => o.kind === "insert")).toHaveLength(0);
  });

  it("a review of a SECOND offer from the same creator inserts a new row (per offer, not per creator)", async () => {
    purchases = [paid({ id: "p1", post_id: "post_clip" }), paid({ id: "p2", post_id: "post_course" })];
    existingReviews = { "buyer_1:post_clip": "review_clip" };
    const res = await post({ ...VALID_REVIEW, post_id: "post_course" });

    expect(res.status).toBe(201);
    const inserts = sessionDb.opsFor("reviews").filter((o) => o.kind === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toMatchObject({ post_id: "post_course" });
    expect(sessionDb.opsFor("reviews").filter((o) => o.kind === "update")).toHaveLength(0);
  });
});

describe("viewerPurchasedPosts (what the form offers)", () => {
  it("lists each live-purchased post of this creator once, with its title", async () => {
    purchases = [
      paid({ id: "a", post_id: "post_clip" }),
      paid({ id: "b", post_id: "post_clip" }),                        // bought twice
      paid({ id: "c", post_id: "post_course", status: "refunded" }),  // refunded: gone
      paid({ id: "d", post_id: "post_untitled" }),
      paid({ id: "e", post_id: "post_other", creator_id: "creator_other" }),
    ];

    const offers = await viewerPurchasedPosts(db as any, "buyer_1", "creator_1");

    expect(offers).toEqual([
      { post_id: "post_clip", title: "Quick clip" },
      { post_id: "post_untitled", title: "Untitled offer" },
    ]);
    // the posts lookup is scoped to this creator, even if purchases lied
    const postsOp = db.opsFor("posts")[0];
    expect(postsOp.filters).toMatchObject({ creator_id: "creator_1" });
  });

  it("drops a purchase whose post is no longer this creator's", async () => {
    // purchases.creator_id says creator_1 but the post belongs to someone else
    purchases = [paid({ post_id: "post_other" })];
    const offers = await viewerPurchasedPosts(db as any, "buyer_1", "creator_1");
    expect(offers).toEqual([]);
  });

  it("returns [] without a posts query when nothing was bought", async () => {
    const offers = await viewerPurchasedPosts(db as any, "buyer_1", "creator_1");
    expect(offers).toEqual([]);
    expect(db.opsFor("posts")).toHaveLength(0);
  });
});

describe("Verified Purchase label is per offer", () => {
  it("labels a per-offer review only when the reviewer bought THAT post; legacy rows use the creator rule", async () => {
    purchases = [
      paid({ id: "a", buyer_id: "buyer_clip", post_id: "post_clip" }),
      paid({ id: "b", buyer_id: "buyer_refunded", post_id: "post_course", status: "refunded" }),
    ];
    const live = await livePurchasesByReviewers(db as any, "creator_1", [
      "buyer_clip",
      "buyer_refunded",
      "buyer_never",
    ]);

    // bought the clip: the clip review is verified, a course review is not
    expect(isVerifiedPurchase(live, "buyer_clip", "post_clip")).toBe(true);
    expect(isVerifiedPurchase(live, "buyer_clip", "post_course")).toBe(false);
    // legacy row (post_id null): any live purchase from the creator (v1 rule)
    expect(isVerifiedPurchase(live, "buyer_clip", null)).toBe(true);
    expect(isVerifiedPurchase(live, "buyer_refunded", null)).toBe(false);
    expect(isVerifiedPurchase(live, "buyer_refunded", "post_course")).toBe(false);
    expect(isVerifiedPurchase(live, "buyer_never", null)).toBe(false);
  });

  it("does not query at all when there are no reviewers", async () => {
    const live = await livePurchasesByReviewers(db as any, "creator_1", []);
    expect(live).toEqual([]);
    expect(db.opsFor("purchases")).toHaveLength(0);
  });
});
