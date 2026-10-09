import { NextRequest } from "next/server";
import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";
import { _resetRateLimits } from "@/lib/rateLimit";

const viewerId = "11111111-1111-4111-8111-111111111111";
let db: MockClient;
let banned = false;
let commentOwner = viewerId;
const bump = jest.fn();

jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseServer", () => ({ createServerClient: () => db }));
jest.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: { id: viewerId, banned_at: banned ? "2026-10-09" : null }, error: null,
    }) }) }) }),
  },
}));
jest.mock("@/lib/postCounters", () => ({ bumpPostComments: (...args: unknown[]) => bump(...args) }));

import { GET, POST } from "@/app/api/mobile/posts/[postId]/comments/route";
import { PATCH, DELETE } from "@/app/api/mobile/posts/[postId]/comments/[commentId]/route";

const postContext = { params: Promise.resolve({ postId: "post-A" }) };
const commentContext = (postId = "post-A") => ({ params: Promise.resolve({ postId, commentId: "comment-1" }) });
function request(method: string, suffix = "", body?: unknown, authenticated = true) {
  return new NextRequest(`https://www.creatornet.net/api/mobile/posts/post-A/comments${suffix}`, {
    method,
    headers: {
      Origin: "capacitor://localhost",
      ...(authenticated ? { Authorization: "Bearer mobile-token" } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  process.env.CREATORNET_IOS_API_ENABLED = "true";
  _resetRateLimits();
  banned = false;
  commentOwner = viewerId;
  bump.mockReset().mockResolvedValue({ count: 1 });
  db = createMockClient((op: Op) => {
    if (op.table === "comments" && op.kind === "select" && op.limit === 100) {
      return { data: [{ id: "comment-1", user_id: commentOwner, content: "first", created_at: "2026-10-09" }], error: null };
    }
    if (op.table === "comments" && op.kind === "select") {
      return { data: { id: "comment-1", user_id: commentOwner, post_id: "post-A" }, error: null };
    }
    if (op.table === "comments" && op.kind === "insert") {
      return { data: { id: "comment-2", user_id: viewerId, content: "hello", created_at: "2026-10-09" }, error: null };
    }
    if (op.table === "comments" && op.kind === "update") {
      return { data: { id: "comment-1", user_id: viewerId, content: "edited", created_at: "2026-10-09" }, error: null };
    }
    if (op.table === "profiles" && op.columns === "banned_at") {
      return { data: { banned_at: banned ? "2026-10-09" : null }, error: null };
    }
    if (op.table === "profiles" && op.columns === "id, username, full_name, avatar_url") {
      return { data: op.inFilters.length ? [{ id: viewerId, username: "viewer" }] : { id: viewerId, username: "viewer" }, error: null };
    }
    return undefined;
  });
  db.auth.getUser = async token => ({ data: { user: token === "mobile-token" ? { id: viewerId } : null }, error: null });
});
afterEach(() => { delete process.env.CREATORNET_IOS_API_ENABLED; });

test("anonymous reading works, while a missing or banned account cannot create a comment", async () => {
  expect((await GET(request("GET", "", undefined, false), postContext)).status).toBe(200);
  expect((await POST(request("POST", "", { content: "hello" }, false), postContext)).status).toBe(401);
  banned = true;
  expect((await POST(request("POST", "", { content: "hello" }), postContext)).status).toBe(403);
  expect(db.opsFor("comments").filter(op => op.kind === "insert")).toHaveLength(0);
});

test("a mobile comment is attributed to the verified bearer and edits stay within its post", async () => {
  const created = await POST(request("POST", "", { content: "hello" }), postContext);
  expect(created.status).toBe(200);
  expect(db.opsFor("comments").find(op => op.kind === "insert")?.payload)
    .toMatchObject({ user_id: viewerId, post_id: "post-A", content: "hello" });

  const wrongPost = await PATCH(request("PATCH", "/comment-1", { content: "edited" }), commentContext("post-B"));
  expect(wrongPost.status).toBe(404);
  expect(db.opsFor("comments").filter(op => op.kind === "update")).toHaveLength(0);

  commentOwner = "someone-else";
  expect((await PATCH(request("PATCH", "/comment-1", { content: "edited" }), commentContext())).status).toBe(403);
  expect(db.opsFor("comments").filter(op => op.kind === "update")).toHaveLength(0);
});

test("owner can edit and bodylessly delete a comment with its own post counter", async () => {
  expect((await PATCH(request("PATCH", "/comment-1", { content: "edited" }), commentContext())).status).toBe(200);
  expect((await DELETE(request("DELETE", "/comment-1"), commentContext())).status).toBe(200);
  expect(db.opsFor("comments").filter(op => op.kind === "update")).toHaveLength(1);
  expect(db.opsFor("comments").filter(op => op.kind === "delete")).toHaveLength(1);
  expect(bump).toHaveBeenCalledWith(db, "post-A", -1);
});
