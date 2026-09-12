import { NextRequest } from "next/server";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";
import { _resetRateLimits } from "@/lib/rateLimit";
let db: MockClient;
let mockUser: { id: string } | null;
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: async () => mockUser }));
jest.mock("@/lib/supabaseAdmin", () => ({ get supabaseAdmin() { return db; } }));
import { DELETE } from "@/app/api/posts/[postId]/route";
const id = "11111111-1111-4111-8111-111111111111";
const call = (postId = id) => DELETE(new NextRequest(`https://creatornet.net/api/posts/${postId}`, { method: "DELETE" }), { params: Promise.resolve({ postId }) });
beforeEach(() => { _resetRateLimits(); mockUser = { id: "owner" }; db = createMockClient(); });
test("signed out requests cannot write", async () => {
  mockUser = null; expect((await call()).status).toBe(401); expect(db.ops).toHaveLength(0);
});
test("invalid ids cannot write", async () => {
  expect((await call("bad")).status).toBe(400); expect(db.ops).toHaveLength(0);
});
test("missing or another creator's video is rejected with ownership filters on every operation", async () => {
  expect((await call()).status).toBe(404);
  db.ops.forEach(op => expect(op.filters).toMatchObject({ id, creator_id: "owner" }));
});
test("deleting an owned purchased video preserves every media and purchase field", async () => {
  const post = { id, creator_id: "owner", removed_at: null as string | null, video_url: "video", premium_path: "owner/file", product_id: "product" };
  const purchase = { post_id: id, access_granted: true, product_id: "product" };
  db = createMockClient(op => {
    if (op.table !== "posts" || op.kind !== "update") throw Error("Unexpected mutation");
    expect(op.filters).toEqual({ id, creator_id: "owner", removed_at: null });
    expect(Object.keys(op.payload as object)).toEqual(["removed_at"]);
    Object.assign(post, op.payload);
    return { data: { id }, error: null };
  });
  expect((await call()).status).toBe(200);
  expect(post).toEqual({ id, creator_id: "owner", removed_at: expect.any(String), video_url: "video", premium_path: "owner/file", product_id: "product" });
  expect(purchase.access_granted).toBe(true); expect(db.ops).toHaveLength(1);
});
test("retrying a removed own video succeeds without rewriting its timestamp", async () => {
  db = createMockClient(op => op.kind === "select" ? { data: { id, removed_at: "previous" }, error: null } : undefined);
  expect((await call()).status).toBe(200);
  expect(db.ops[0].isFilters).toEqual([{ column: "removed_at", value: null }]);
});
test("database failure does not claim success", async () => {
  db = createMockClient(() => ({ data: null, error: { message: "private details" } }));
  const response = await call(); expect(response.status).toBe(500);
  expect(JSON.stringify(await response.json())).not.toContain("private details");
});
