import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";
import { loadFeedOffers } from "@/lib/feedOffers";
import { mapFeedV3Rows } from "@/lib/feedV3";
let db: MockClient;
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { from: (table: string) => db.from(table) } }));
import { GET } from "@/app/api/posts/feed-offers/route";
const terms = { version: "monthly-mentorship-v1", minimumMonths: 3, autoRenew: true };
const product = { id: "product", product_id: "alias", creator_id: "creator", type: "mentorship", active: true,
  amount_cents: 9900, price_cents: 5000, membership_terms: terms };
const saved = { ...process.env }, originalFetch = global.fetch;
let products: Record<string, unknown>[], postProduct: string | null, extraPosts: Record<string, unknown>[], error: boolean;
beforeEach(() => {
  process.env.CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY = "true";
  delete process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY;
  products = [product]; postProduct = "alias"; extraPosts = []; error = false;
  db = createMockClient(op => {
    if (error) return { data: null, error: { message: "unavailable" } };
    if (op.table === "posts") return { data: [{ id: "post", product_id: postProduct, creator_id: "creator" }, ...extraPosts], error: null };
    if (op.table === "products") return { data: products.map(p => Object.fromEntries(Object.entries(p).filter(([key]) => op.columns!.split(",").includes(key)))), error: null };
    return undefined;
  });
});
afterAll(() => { process.env = saved; global.fetch = originalFetch; });
const request = () => GET(new Request("https://site.invalid/api/posts/feed-offers?ids=post"));
test.each([[false, false], [false, true], [true, false], [true, true]])("schema columns monthly=%s fixed=%s", async (monthly, fixed) => {
  process.env.CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY = String(monthly);
  process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = String(fixed);
  const response = await request(); expect(response.status).toBe(200);
  for (const query of db.opsFor("products")) {
    expect(query.columns!.includes("membership_terms")).toBe(monthly);
    expect(query.columns!.includes("fixed_service_months")).toBe(fixed);
  }
  expect((await response.json()).offers.post.monthlyTerms).toEqual(monthly ? terms : null);
});
test("real route enriches RPC mapping with canonical identity, current monthly price and validated terms", async () => {
  global.fetch = jest.fn(async () => request()) as typeof fetch;
  const [post] = await loadFeedOffers(mapFeedV3Rows([{ post_id: "post", creator_id: "creator", product_id: "alias",
    price_cents: 123, poster_url: "poster.jpg" }]));
  expect(post).toMatchObject({ product_id: "product", price_cents: 9900, monthlyTerms: terms, purchaseOptionsReady: true });
  expect(db.opsFor("posts")[0].filters).toMatchObject({ hidden_at: null, removed_at: null });
  expect(db.opsFor("products").map(op => op.inFilters[0].column)).toEqual(["id", "product_id"]);
});
test("direct ID wins over an alias collision", async () => {
  products = [{ ...product, id: "wrong", product_id: "alias", membership_terms: null }, { ...product, id: "alias" }];
  expect((await (await request()).json()).offers.post.productId).toBe("alias");
});
test.each(["book", "tip", "none"])("a mixed batch cannot attach a null-alias product to an unlinked %s post", async action => {
  postProduct = null;
  extraPosts = [{ id: "paid", product_id: "product", creator_id: "creator" }];
  products = [{ ...product, product_id: null, type: "video", membership_terms: null }];
  const mixedRequest = () => GET(new Request("https://site.invalid/api/posts/feed-offers?ids=post,paid"));
  const offers = (await (await mixedRequest()).json()).offers;
  expect(offers.post).toBeNull();
  expect(offers.paid).toMatchObject({ productId: "product", linkedProductId: "product" });
  global.fetch = jest.fn(async () => mixedRequest()) as typeof fetch;
  const [post, paid] = await loadFeedOffers(mapFeedV3Rows([
    { post_id: "post", creator_id: "creator", product_id: null, price_cents: null, poster_url: "poster.jpg",
      allow_booking: action === "book", booking_url: action === "book" ? "https://booking.invalid" : null,
      tips_available: action === "tip" },
    { post_id: "paid", creator_id: "creator", product_id: "product", price_cents: 9900, poster_url: "paid.jpg" },
  ]));
  expect(post).toMatchObject({ product_id: null, price_cents: 0, purchaseOptionsReady: false,
    allow_booking: action === "book", tips_enabled: action === "tip" });
  expect(paid).toMatchObject({ product_id: "product", price_cents: 9900, purchaseOptionsReady: true });
});
test("the client rejects unsolicited purchase metadata for an unlinked post", async () => {
  global.fetch = jest.fn(async () => Response.json({ offers: { post: {
    productId: "product", linkedProductId: null, creatorId: "creator", productType: "video",
    priceCents: 9900, monthlyTerms: null,
  } } })) as typeof fetch;
  const [post] = await loadFeedOffers(mapFeedV3Rows([{ post_id: "post", creator_id: "creator", product_id: null,
    poster_url: "poster.jpg", allow_booking: true, booking_url: "https://booking.invalid" }]));
  expect(post).toMatchObject({ product_id: null, price_cents: 0, purchaseOptionsReady: false,
    allow_booking: true, booking_url: "https://booking.invalid" });
});
test.each([
  { membership_terms: { ...terms, minimumMonths: 0 } },
  { membership_terms: { ...terms, extra: true } },
  { type: "course" }, { active: false }, { creator_id: "other" }, { fixed_service_months: 3 },
  { amount_cents: 1, price_cents: 0 }, { amount_cents: 1.5, price_cents: 0 }, { amount_cents: 0, price_cents: 0 },
])("invalid/conflicting/unowned offer remains blocked: %p", async changes => {
  process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = "true";
  products = [{ ...product, ...changes }];
  expect((await (await request()).json()).offers.post).toBeNull();
});
test("ordinary fixed installment mentorship keeps the feed price and has no monthly terms", async () => {
  products = [{ ...product, membership_terms: null, plan_months: 3 }];
  global.fetch = jest.fn(async () => request()) as typeof fetch;
  const [post] = await loadFeedOffers(mapFeedV3Rows([{ post_id: "post", creator_id: "creator", product_id: "alias", price_cents: 12000, poster_url: "poster" }]));
  expect(post).toMatchObject({ price_cents: 12000, monthlyTerms: null, purchaseOptionsReady: true });
});
test.each(["read-error", "missing", "identity", "malformed"])("metadata %s never falls back to ordinary Buy", async mode => {
  const post = mapFeedV3Rows([{ post_id: "post", creator_id: "creator", product_id: "alias", poster_url: "poster", allow_booking: true, booking_url: "booking" }]);
  error = mode === "read-error";
  global.fetch = jest.fn(async () => mode === "read-error" ? request() : Response.json({ offers: mode === "missing" ? {} : {
    post: { productId: "product", linkedProductId: mode === "identity" ? "different" : "alias", creatorId: "creator", productType: "mentorship",
      monthlyTerms: mode === "malformed" ? { bad: true } : terms },
  } })) as typeof fetch;
  expect((await loadFeedOffers(post))[0]).toMatchObject({ monthlyTerms: null, purchaseOptionsReady: false, allow_booking: true, booking_url: "booking" });
});
test("oversized batches never query storage", async () => {
  const response = await GET(new Request("https://site.invalid/?ids=" + Array.from({ length: 101 }, (_, i) => i).join(",")));
  expect(response.status).toBe(400); expect(db.ops).toHaveLength(0);
});
