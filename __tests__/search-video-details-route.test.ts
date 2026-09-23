import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";
import { _resetRateLimits } from "@/lib/rateLimit";

let db: MockClient;
jest.mock("@/lib/supabaseAdmin", () => ({ get supabaseAdmin() { return db; } }));
import { POST } from "@/app/api/search/videos/route";

const id = "11111111-1111-4111-8111-111111111111";
const creatorId = "22222222-2222-4222-8222-222222222222";
const call = (ids: unknown) => POST(new Request("https://creatornet.net/api/search/videos", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }),
}));

beforeEach(() => {
  _resetRateLimits();
  db = createMockClient(op => {
    if (op.table === "posts") return { data: [{
      id, creator_id: creatorId, title: "demo", content: "#trading", video_url: "https://example.com/video.mp4",
      active: true,
    }], error: null };
    if (op.table === "profiles") return { data: [{
      id: creatorId, username: "NoahJimenezz", full_name: "Noah Jimenez", avatar_url: "avatar.jpg",
      stripe_account_id: "acct_123", stripe_onboarding_complete: true,
    }], error: null };
    throw new Error(`Unexpected table: ${op.table}`);
  });
});

test("opened video details use bounded, visible server reads and expose only public creator fields", async () => {
  const response = await call([id, id]);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(body.items).toEqual([expect.objectContaining({
    id, title: "demo", creator_username: "NoahJimenezz", creator_name: "Noah Jimenez",
    creator_avatar_url: "avatar.jpg", creator_verified: true,
  })]);
  const postRead = db.opsFor("posts")[0];
  expect(postRead.inFilters).toContainEqual({ column: "id", values: [id] });
  expect(postRead.filters).toMatchObject({ active: true, hidden_at: null, removed_at: null });
  expect(db.opsFor("profiles")[0].inFilters).toContainEqual({ column: "id", values: [creatorId] });
  expect(JSON.stringify(body)).not.toContain("acct_123");
});

test.each([[], Array(9).fill(id), ["bad.id"], [42], "not-an-array"])(
  "invalid ids are rejected before a database read: %p", async ids => {
    expect((await call(ids)).status).toBe(400);
    expect(db.ops).toHaveLength(0);
  }
);

test("database failure returns a retryable error without exposing database details", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  db = createMockClient(() => ({ data: null, error: { message: "private database detail" } }));
  const response = await call([id]);
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain("private database detail");
  log.mockRestore();
});
