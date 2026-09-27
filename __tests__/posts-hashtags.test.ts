import { createMockClient } from "./__mocks__/supabaseQueryMock";
let mockAdmin: ReturnType<typeof createMockClient>;
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { from: (table: string) => mockAdmin.from(table) } }));
jest.mock("@/lib/supabaseServer", () => ({ createSupabaseServer: () => ({ auth: { getUser: async () => ({ data: { user: { id: "creator" } }, error: null }) } }) }));
jest.mock("@/lib/bannedUser", () => ({ isUserBanned: async () => false }));
jest.mock("@/lib/creatorStripeConnect", () => ({ isCreatorSellReady: async () => true }));
jest.mock("@/lib/rateLimit", () => ({ allowRequest: () => true, clientKey: () => "test" }));
jest.mock("@/lib/r2", () => ({ r2KeyFromPublicUrl: () => null }));
import { POST } from "@/app/api/posts/route";

test.each([
  [[" Trading ", "#TRADING", "daytrading", "", null, 4], ["trading", "daytrading"]],
  [[], []],
  [undefined, null],
])("the post creation route stores canonical arrays: %j", async (hashtags, expected) => {
  mockAdmin = createMockClient(op => ({ data: op.table === "posts" ? { id: "post", product_id: null } : null, error: null }));
  const response = await POST(new Request("https://creatornet.test/api/posts", { method: "POST", body: JSON.stringify({ video_url: "https://example.test/video.mp4", hashtags }) }));
  expect(response.status).toBe(200);
  expect(mockAdmin.opsFor("posts")[0].payload).toEqual([expect.objectContaining({ hashtags: expected })]);
});
