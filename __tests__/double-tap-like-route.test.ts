import { NextRequest } from "next/server";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";
import { _resetRateLimits } from "@/lib/rateLimit";
let db: MockClient;
let mockUser: { id: string } | null;
const mockBump = jest.fn();
const mockInterest = jest.fn();
jest.mock("@/lib/supabaseServer", () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: mockUser }, error: null }) } }) }));
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/postCounters", () => ({ bumpPostLikes: (...args: unknown[]) => mockBump(...args) }));
jest.mock("@/lib/updateInterestScore", () => ({ updateInterestScore: (...args: unknown[]) => mockInterest(...args) }));
import { PUT, POST } from "@/app/api/posts/[postId]/like/route";
const call = (method: "PUT" | "POST" = "PUT") => (method === "PUT" ? PUT : POST)(new NextRequest("https://creatornet.net/api/posts/post/like", { method }), { params: Promise.resolve({ postId: "post" }) });
beforeEach(() => { _resetRateLimits(); jest.clearAllMocks(); mockUser = { id: "viewer" }; });

test("repeated like-only requests keep one like and one counter increment", async () => {
  let exists = false;
  let count = 0;
  mockBump.mockImplementation(async (_db, _id, delta) => ({ count: count += delta }));
  db = createMockClient(op => {
    if (op.table === "likes" && op.kind === "select") return { data: exists ? { id: "like" } : null, error: null };
    if (op.table === "likes" && op.kind === "insert") { exists = true; return { data: null, error: null }; }
    if (op.table === "likes" && op.kind === "delete") { exists = false; return { data: null, error: null }; }
    return { data: { likes_count: count, interests: ["art"] }, error: null };
  });
  for (let i = 0; i < 3; i++) expect(await (await call()).json()).toMatchObject({ success: true, liked: true, likes_count: 1 });
  expect(mockBump).toHaveBeenCalledTimes(1);
  expect(mockInterest).toHaveBeenCalledTimes(1);
  expect(db.ops.filter(op => op.kind === "delete")).toHaveLength(0);
  expect(await (await call("POST")).json()).toMatchObject({ liked: false, likes_count: 0 });
});

test("duplicate insert races do not increment counters or interest again", async () => {
  db = createMockClient(op => op.table === "likes"
    ? { data: null, error: op.kind === "insert" ? { message: "duplicate", code: "23505" } : null }
    : { data: { likes_count: 1 }, error: null });
  expect(await (await call()).json()).toMatchObject({ liked: true, likes_count: 1 });
  expect(mockBump).not.toHaveBeenCalled();
  expect(mockInterest).not.toHaveBeenCalled();
});

test("signed out requests cannot create likes", async () => {
  mockUser = null; db = createMockClient();
  expect((await call()).status).toBe(401);
  expect(db.ops).toHaveLength(0);
});
