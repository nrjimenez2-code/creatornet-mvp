import { NextRequest } from "next/server";
import {
  createMockClient,
  type MockClient,
  type Op,
} from "./__mocks__/supabaseQueryMock";
let db: MockClient;
let actor = "user:viewer";
let expired = false;
let banned = false;
let ids: string[] = [];
let hidden = new Set<string>();
const auth = {
  auth: {
    getUser: async () => ({ data: { user: { id: "viewer" } }, error: null }),
  },
  rpc: jest.fn(),
};
jest.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return db;
  },
}));
jest.mock("@/lib/supabaseServer", () => ({ createServerClient: () => auth }));
import { GET } from "@/app/api/feed/route";
import { POST } from "@/app/api/feed-events/route";
function respond(op: Op) {
  if (op.table === "discover_sessions_v1")
    return {
      data:
        op.filters.actor === actor
          ? {
              post_ids: ids,
              audiences: {},
              expires_at: new Date(
                Date.now() + (expired ? -1000 : 3600000),
              ).toISOString(),
            }
          : null,
      error: null,
    };
  if (op.table === "posts")
    return {
      data: (op.inFilters[0]?.values ?? []).map((id) => ({
        id,
        creator_id: "creator",
        title: String(id),
        poster_url: "https://example.test/p.jpg",
        hidden_at: hidden.has(String(id)) ? "2026-09-12" : null,
      })),
      error: null,
    };
  if (op.table === "profiles")
    return {
      data: [
        {
          id: "creator",
          username: "creator",
          banned_at: banned ? "2026-09-12" : null,
        },
      ],
      error: null,
    };
  return { data: [], error: null };
}
beforeEach(() => {
  process.env.DISCOVER_V4_ENABLED = "true";
  actor = "user:viewer";
  expired = false;
  banned = false;
  hidden = new Set();
  ids = Array.from({ length: 2005 }, (_, i) => "p" + i);
  db = createMockClient(respond);
});
afterAll(() => {
  delete process.env.DISCOVER_V4_ENABLED;
});
const request = (query: string) =>
  new NextRequest("https://example.test/api/feed?session=existing&" + query);
test("pagination crosses the old 2000 cap and keeps snapshot order", async () => {
  let response = await GET(request("offset=1998&limit=5"));
  let body = await response.json();
  expect(response.status).toBe(200);
  expect(body.items.map((p: { post_id: string }) => p.post_id)).toEqual([
    "p1998",
    "p1999",
    "p2000",
    "p2001",
    "p2002",
  ]);
  expect(body.nextOffset).toBe(2003);
  expect(body.hasMore).toBe(true);
  response = await GET(request("offset=2003&limit=5"));
  body = await response.json();
  expect(body.items.map((p: { post_id: string }) => p.post_id)).toEqual([
    "p2003",
    "p2004",
  ]);
  expect(body.hasMore).toBe(false);
  expect(
    db.opsFor("posts").every((op) => op.inFilters[0].values.length <= 5),
  ).toBe(true);
});
test("sessions cannot be read by another viewer or after expiration", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    actor = "user:someone-else";
    expect((await GET(request("offset=0"))).status).toBe(503);
    actor = "user:viewer";
    expired = true;
    expect((await GET(request("offset=0"))).status).toBe(503);
  } finally {
    log.mockRestore();
  }
});
test("moderation is rechecked, and empty removed pages do not strand later results", async () => {
  ids = ["p1", "p2", "p3"];
  hidden = new Set(["p1", "p2"]);
  const body = await (await GET(request("offset=0&limit=2"))).json();
  expect(body.items.map((p: { post_id: string }) => p.post_id)).toEqual(["p3"]);
  expect(body.nextOffset).toBe(3);
  banned = true;
  expect((await (await GET(request("offset=0&limit=2"))).json()).items).toEqual(
    [],
  );
});
test("invalid offsets and fabricated commercial events are rejected", async () => {
  expect((await GET(request("offset=-1"))).status).toBe(400);
  expect((await GET(request("offset=NaN"))).status).toBe(400);
  const response = await POST(
    new NextRequest("https://example.test/api/feed-events", {
      method: "POST",
      body: JSON.stringify({
        session: "existing",
        postId: "p1",
        kind: "purchase",
        amount_cents: 999999,
      }),
    }),
  );
  expect(response.status).toBe(400);
  expect(db.opsFor("discover_events_v1")).toHaveLength(0);
});
