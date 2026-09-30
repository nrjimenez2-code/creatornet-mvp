import { createMockClient } from "./__mocks__/supabaseQueryMock";
let mockAdmin: ReturnType<typeof createMockClient>;
let mockBanned = false;
let mockDropProduct = false;
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { from: (table: string) => mockAdmin.from(table) } }));
jest.mock("@/lib/supabaseServer", () => ({ createSupabaseServer: () => ({ auth: { getUser: async () => ({ data: { user: { id: "creator" } }, error: null }) } }) }));
jest.mock("@/lib/bannedUser", () => ({ isUserBanned: async () => mockBanned, bannedResponse: () => new Response("Banned", { status: 403 }) }));
jest.mock("@/lib/creatorStripeConnect", () => ({ isCreatorSellReady: async () => true }));
jest.mock("@/lib/rateLimit", () => ({ allowRequest: () => true, clientKey: () => "test" }));
jest.mock("@/lib/r2", () => ({ r2KeyFromPublicUrl: () => null }));
import { POST } from "@/app/api/posts/route";
const product = "22222222-2222-4222-8222-222222222222";
const request = (data: Record<string, unknown>) => POST(new Request("https://creatornet.test/api/posts", { method: "POST", body: JSON.stringify({ video_url: "https://example.test/video.mp4", classification_version: 1, ...data }) }));
beforeEach(() => {
  mockBanned = false; mockDropProduct = false;
  mockAdmin = createMockClient(op => {
    if (op.table === "profiles") return { data: { bio: "Learn guitar", tagline: "", interests: ["investing"] }, error: null };
    if (op.table === "products") return { data: { id: product, creator_id: "creator", title: "Learn programming", active: true }, error: null };
    if (op.table === "posts") return { data: { id: "post", product_id: null }, error: mockDropProduct && mockAdmin.opsFor("posts").length === 1 ? { message: "posts_product_fk" } : null };
    return { data: null, error: null };
  });
});
const inserted = () => (mockAdmin.opsFor("posts")[0].payload as Record<string, unknown>[])[0];
test("recomputes hashtags and labels on the server, ignoring client-supplied metadata", async () => {
  expect((await request({ content: "#SMMA #smma", hashtags: ["fabricated"], interests: ["investing"], topics: ["made up"] })).status).toBe(200);
  expect(inserted()).toMatchObject({ classification_version: 1, hashtags: ["smma"], interests: ["content creation & marketing"], topics: ["smma", "marketing"] });
});
test("empty title and caption still publish and can use public profile fallback", async () => {
  expect((await request({ title: "", content: "" })).status).toBe(200);
  expect(inserted()).toMatchObject({ title: null, content: null, interests: ["arts, design & hobbies"], topics: ["music"], hashtags: [] });
});
test("only server-verified linked offer text contributes", async () => {
  expect((await request({ product_id: product })).status).toBe(200);
  expect(inserted().interests).toEqual(["technology & ai"]);
  expect(mockAdmin.opsFor("products")[0].filters).toEqual({ product_id: product });
});
test("a foreign product cannot provide classification context", async () => {
  mockAdmin = createMockClient(op => ({ data: op.table === "products" ? { id: product, creator_id: "someone-else", title: "Learn programming" } : op.table === "posts" ? { id: "post" } : null, error: null }));
  expect((await request({ product_id: product })).status).toBe(200);
  expect(inserted()).toMatchObject({ product_id: null, interests: [], topics: [] });
});
test("a free post retry removes labels from the product that could not be linked", async () => {
  mockDropProduct = true;
  expect((await request({ product_id: product })).status).toBe(200);
  const retried = (mockAdmin.opsFor("posts")[1].payload as Record<string, unknown>[])[0];
  expect(retried).toMatchObject({ product_id: null, interests: ["arts, design & hobbies"], topics: ["music"] });
});
test.each([{ classification_version: 2 }, { classification_version: null }, { content: "x".repeat(301) }, { content: 42 }])("rejects invalid feature submissions before insertion", async body => {
  expect((await request(body)).status).toBe(400); expect(mockAdmin.opsFor("posts")).toHaveLength(0);
});
test("banned creators cannot publish automatic posts", async () => {
  mockBanned = true; expect((await request({})).status).toBe(403); expect(mockAdmin.ops).toHaveLength(0);
});
test("unmarked legacy submissions retain their metadata contract and avoid profile reads", async () => {
  const response = await POST(new Request("https://creatornet.test/api/posts", { method: "POST", body: JSON.stringify({ video_url: "https://example.test/v.mp4", interests: ["Entrepreneurship"], topics: ["Custom topic"], hashtags: ["#OldTag"] }) }));
  expect(response.status).toBe(200);
  expect(inserted()).toMatchObject({ interests: ["business & entrepreneurship"], topics: ["custom topic"], hashtags: ["oldtag"] });
  expect(inserted()).not.toHaveProperty("classification_version");
  expect(mockAdmin.opsFor("profiles")).toHaveLength(0);
});
