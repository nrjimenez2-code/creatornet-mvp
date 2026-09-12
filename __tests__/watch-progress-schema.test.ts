process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-placeholder";

import { NextRequest } from "next/server";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";

let db: MockClient;
let user: { id: string } | null;
const savedRow: Record<string, unknown>[] = [];
let failWrites = false;

jest.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      ...db.from(table),
      upsert: async (row: Record<string, unknown>) => {
        savedRow.push(row);
        const allowed = new Set(["user_id", "post_id", "seconds", "updated_at"]);
        return {
          error: failWrites || Object.keys(row).some((key) => !allowed.has(key))
            ? { message: "Unknown progress column" }
            : null,
        };
      },
    }),
  }),
}));
jest.mock("@/lib/supabaseClient", () => ({
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
  }),
}));

beforeEach(() => {
  jest.resetModules();
  user = { id: "buyer-one" };
  savedRow.length = 0;
  failWrites = false;
  db = createMockClient((op) => {
    if (op.table !== "watch_progress") return undefined;
    const allowed = new Set(["user_id", "post_id", "seconds", "updated_at"]);
    if (op.columns?.split(",").some((column) => !allowed.has(column.trim()))) {
      return { data: null, error: { message: "Unknown progress column" } };
    }
    return { data: { seconds: 18, updated_at: "2026-09-04T12:00:00Z" }, error: null };
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function request(body: unknown) {
  return new NextRequest("https://example.invalid/api/watch/progress", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

test("reads the actual schema and scopes progress to the authenticated user", async () => {
  const { GET } = await import("@/app/api/watch/progress/route");
  const response = await GET(new NextRequest("https://example.invalid/api/watch/progress?post_id=post-one&user_id=other-user"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ progress: { seconds: 18, updated_at: "2026-09-04T12:00:00Z" } });
  expect(db.opsFor("watch_progress")[0].filters).toEqual({ user_id: "buyer-one", post_id: "post-one" });
});

test("persists only existing columns and never trusts a supplied user ID", async () => {
  const { POST } = await import("@/app/api/watch/progress/route");
  const response = await POST(request({ post_id: "post-one", user_id: "other-user", seconds: 18, duration: 60, completed: false }));
  expect(response.status).toBe(200);
  expect(savedRow).toEqual([{ user_id: "buyer-one", post_id: "post-one", seconds: 18, updated_at: expect.any(String) }]);
});

test.each([[80, 60, 60], [-5, 60, 0]])("clamps %s seconds to duration %s", async (seconds, duration, expected) => {
  const { POST } = await import("@/app/api/watch/progress/route");
  expect((await POST(request({ post_id: "post-one", seconds, duration }))).status).toBe(200);
  expect(savedRow[0].seconds).toBe(expected);
});

test.each([{ seconds: 2, duration: -10 }, { seconds: 2, duration: 0 }, { seconds: null, duration: 10 }, { seconds: 2, duration: "10" }])("rejects invalid timing without saving: %j", async (timing) => {
  const { POST } = await import("@/app/api/watch/progress/route");
  expect((await POST(request({ post_id: "post-one", ...timing }))).status).toBe(400);
  expect(savedRow).toHaveLength(0);
});

test("signed-out callers cannot read or write progress", async () => {
  user = null;
  const { GET, POST } = await import("@/app/api/watch/progress/route");
  expect((await GET(new NextRequest("https://example.invalid/api/watch/progress?post_id=post-one"))).status).toBe(401);
  expect((await POST(request({ post_id: "post-one", seconds: 2, duration: 60 }))).status).toBe(401);
  expect(db.ops).toHaveLength(0);
  expect(savedRow).toHaveLength(0);
});

test("write failure stays a failure rather than reporting saved progress", async () => {
  failWrites = true;
  const { POST } = await import("@/app/api/watch/progress/route");
  const response = await POST(request({ post_id: "post-one", seconds: 2, duration: 60 }));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Failed to save progress" });
});
