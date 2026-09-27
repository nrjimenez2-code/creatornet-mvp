import { NextRequest } from "next/server";
import { createMockClient, type Op } from "./__mocks__/supabaseQueryMock";
import { normalizeHashtag, normalizeHashtags, extractHashtags } from "@/lib/hashtags";

let mockClient: ReturnType<typeof createMockClient>;
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { from: (table: string) => mockClient.from(table) } }));
jest.mock("@/lib/rateLimit", () => ({ allowRequest: () => true, clientKey: () => "test" }));
jest.mock("@/lib/postViewCountsServer", () => ({ enrichPostViewCounts: async (_: unknown, rows: unknown[]) => rows }));
import { GET } from "@/app/api/tag/[hashtag]/route";

type Post = { id: string; created_at: string; creator_id: string; hashtags: string[]; interests: string[]; content: string | null; hidden_at: string | null; removed_at: string | null };
const post = (id: string, extra: Partial<Post> = {}): Post => ({ id, created_at: "2026-09-26T00:00:00Z", creator_id: "creator", hashtags: ["trading"], interests: [], content: null, hidden_at: null, removed_at: null, ...extra });
let rows: Post[];
let hashtagError: object | null;
function respond(op: Op) {
  if (op.table !== "posts") return { data: [], error: null };
  if (op.filters.hashtags && hashtagError) return { data: null, error: hashtagError };
  let result = rows.filter(row => row.hidden_at === null && row.removed_at === null);
  if (op.filters.hashtags) result = result.filter(row => (op.filters.hashtags as string[]).every(tag => row.hashtags.includes(tag)));
  if (op.filters.interests) result = result.filter(row => (op.filters.interests as string[]).every(tag => row.interests.includes(tag)));
  if (op.filters.content) result = result.filter(row => row.content && new RegExp(String(op.filters.content), "i").test(row.content));
  for (const order of [...(op.orders ?? [])].reverse()) result.sort((a, b) => {
    const av = a[order.column as "id" | "created_at"], bv = b[order.column as "id" | "created_at"];
    return (av < bv ? -1 : av > bv ? 1 : 0) * (order.ascending ? 1 : -1);
  });
  return { data: result.slice(0, op.limit), error: null };
}
const call = async (tag = "trading", query = "") => {
  const response = await GET(new NextRequest(`https://creatornet.test/api/tag/${encodeURIComponent(tag)}?${query}`), { params: Promise.resolve({ hashtag: encodeURIComponent(tag) }) });
  return { status: response.status, body: await response.json() };
};
beforeEach(() => { rows = []; hashtagError = null; mockClient = createMockClient(respond); });

test("write and search normalization share the same whole-tag representation", () => {
  expect(normalizeHashtags([" Trading ", "#trading", "TRADING", "#DayTrading", "", "#", null, 7])).toEqual(["trading", "daytrading"]);
  expect(extractHashtags("#Trading #TRADING #DayTrading")).toEqual(["trading", "daytrading"]);
  expect(normalizeHashtags([])).toEqual([]);
  expect(normalizeHashtags(null)).toEqual([]);
  expect(normalizeHashtag(" #Trading ")).toBe("trading");
});

test.each(["trading", "Trading", "#trading", " #TRADING "])("array-only matches for %s use exact contains", async tag => {
  rows = [post("match"), post("substring", { hashtags: ["daytrading"] }), post("empty", { hashtags: [] })];
  const { body } = await call(tag);
  expect(body.items.map((row: Post) => row.id)).toEqual(["match"]);
  expect(body).toMatchObject({ tag: "trading", hasMore: false, nextOffset: 1 });
  expect(mockClient.opsFor("posts")[0].filters.hashtags).toEqual(["trading"]);
});

test("empty input returns the existing response shape without querying", async () => {
  expect((await call(" # ")).body).toEqual({ items: [], tag: "", hasMore: false, nextOffset: 0 });
  expect(mockClient.ops).toEqual([]);
});

test("all sources retain visibility, time/id order and the extra pagination candidate", async () => {
  rows = [post("hidden", { hidden_at: "today" }), post("removed", { removed_at: "today" }), post("visible")];
  expect((await call("trading", "offset=2&limit=3")).body.items).toEqual([]);
  for (const op of mockClient.opsFor("posts")) {
    expect(op.isFilters).toEqual([{ column: "hidden_at", value: null }, { column: "removed_at", value: null }]);
    expect(op.orders).toEqual([{ column: "created_at", ascending: false }, { column: "id", ascending: false }]);
    expect(op.limit).toBe(6);
  }
  expect((await call()).body.items.map((row: Post) => row.id)).toEqual(["visible"]);
});

test("array-only pagination distinguishes exact final boundary from one more row", async () => {
  rows = [post("d"), post("c"), post("b"), post("a")];
  expect((await call("trading", "limit=2")).body).toMatchObject({ hasMore: true, nextOffset: 2 });
  const second = (await call("trading", "offset=2&limit=2")).body;
  expect(second.items.map((row: Post) => row.id)).toEqual(["b", "a"]);
  expect(second).toMatchObject({ hasMore: false, nextOffset: 4 });
  rows.push(post("0"));
  expect((await call("trading", "offset=2&limit=2")).body).toMatchObject({ hasMore: true, nextOffset: 4 });
});

test("caption and interest discovery merge once by ID with stable equal-timestamp pages", async () => {
  rows = [post("d", { content: "#trading", interests: ["Trading"] }), post("c", { hashtags: [], content: "#TRADING" }), post("b", { hashtags: [], interests: ["Trading"] }), post("a")];
  const first = (await call("Trading", "limit=2")).body;
  const second = (await call("Trading", "offset=2&limit=2")).body;
  expect(first.items.map((row: Post) => row.id)).toEqual(["d", "c"]);
  expect(second.items.map((row: Post) => row.id)).toEqual(["b", "a"]);
  expect(first.hasMore).toBe(true);
  expect(second.hasMore).toBe(false);
  expect(first.items[0]).toMatchObject({ creator: null, product_type: null, price_cents: null });
});

test("hashtag PostgREST failure returns the API error instead of caption-only success", async () => {
  rows = [post("caption", { hashtags: [], content: "#trading" })];
  hashtagError = { code: "42883", message: "operator does not exist: text[] ~~* unknown" };
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try { expect(await call()).toEqual({ status: 500, body: { error: "Failed to load tag feed" } }); }
  finally { log.mockRestore(); }
});

test("merged sources preserve Postgres microsecond order before the ID tie-break", async () => {
  rows = [post("z", { created_at: "2026-09-26T00:00:00.123001+00:00" }), post("a", { hashtags: [], content: "#trading", created_at: "2026-09-26T00:00:00.123999+00:00" })];
  expect((await call("trading", "limit=1")).body.items.map((row: Post) => row.id)).toEqual(["a"]);
  expect((await call("trading", "offset=1&limit=1")).body.items.map((row: Post) => row.id)).toEqual(["z"]);
});

test("invalid numeric pagination cannot send NaN to PostgREST", async () => {
  await call("trading", "offset=NaN&limit=Infinity");
  expect(mockClient.opsFor("posts")[0].limit).toBe(13);
});

test("caption discovery matches complete tags and treats regex metacharacters literally", async () => {
  rows = [post("exact", { hashtags: [], content: "try #Trading!" }), post("prefix", { hashtags: [], content: "#tradingtips" }), post("other", { hashtags: [], content: "#daytrading" })];
  expect((await call()).body.items.map((row: Post) => row.id)).toEqual(["exact"]);
  expect((await call(".*")).body.items).toEqual([]);
});
