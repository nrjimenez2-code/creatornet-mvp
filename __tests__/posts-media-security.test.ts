import { createMockClient } from "./__mocks__/supabaseQueryMock";
let mockAdmin: ReturnType<typeof createMockClient>;
const mockHead = jest.fn();
const mockPrefix = jest.fn();
const mockDelete = jest.fn();
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { from: (table: string) => mockAdmin.from(table) } }));
jest.mock("@/lib/supabaseServer", () => ({ createSupabaseServer: () => ({ auth: { getUser: async () => ({ data: { user: { id: "creator" } }, error: null }) } }) }));
jest.mock("@/lib/bannedUser", () => ({ isUserBanned: async () => false }));
jest.mock("@/lib/creatorStripeConnect", () => ({ isCreatorSellReady: async () => true }));
jest.mock("@/lib/premiumReadiness", () => ({ premiumSchemaReady: () => false, premiumPostingReady: () => false }));
jest.mock("@/lib/rateLimit", () => ({ allowRequest: () => true, clientKey: () => "test" }));
jest.mock("@/lib/r2", () => ({
  r2KeyFromPublicUrl: (url: string) => url.startsWith("https://media.test/") ? url.slice("https://media.test/".length).split("?")[0] : null,
  headR2Object: (...args: unknown[]) => mockHead(...args), readR2ObjectPrefix: (...args: unknown[]) => mockPrefix(...args),
  deleteR2Object: (...args: unknown[]) => mockDelete(...args),
}));
import { POST } from "@/app/api/posts/route";
const url = (key: string) => "https://media.test/" + key;
const request = (video = "videos/creator/123.mp4", poster?: string) => POST(new Request("https://app.test/api/posts", { method: "POST", body: JSON.stringify({ video_url: url(video), ...(poster ? { poster_url: url(poster) } : {}) }) }));
beforeEach(() => {
  jest.clearAllMocks();
  mockAdmin = createMockClient(op => ({ data: op.table === "posts" ? { id: "post", product_id: null } : null, error: null }));
  mockHead.mockImplementation(async (key: string) => ({ size: 16, contentType: key.startsWith("videos/") ? "video/mp4" : "image/jpeg" }));
  mockPrefix.mockImplementation(async (key: string) => key.startsWith("videos/") ? new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]) : new Uint8Array([255, 216, 255, ...Array(13).fill(0)]));
});
test.each([
  ["videos/victim/123.mp4", undefined], ["thumbnails/victim/123.jpg", undefined],
  ["videos/creator/123.mp4", "videos/victim/123.mp4"],
  ["videos/creator/123.mp4", "thumbnails/victim/123.jpg"],
  ["videos/creator/123.mp4", "videos/creator/123.mp4"],
  ["videos/creator/../victim.mp4", undefined], ["videos/creator/123.mp4?x=1", undefined],
])("rejects wrong owner/folder or noncanonical path before all storage calls: %s %s", async (video, poster) => {
  expect((await request(video, poster)).status).toBe(400);
  expect(mockHead).not.toHaveBeenCalled(); expect(mockPrefix).not.toHaveBeenCalled(); expect(mockDelete).not.toHaveBeenCalled();
  expect(mockAdmin.opsFor("posts")).toHaveLength(0);
});
test("accepts verified own video and thumbnail", async () => {
  expect((await request("videos/creator/123.mp4", "thumbnails/creator/123.jpg")).status).toBe(200);
  expect(mockHead).toHaveBeenCalledTimes(2); expect(mockPrefix).toHaveBeenCalledTimes(2); expect(mockDelete).not.toHaveBeenCalled();
});
test.each(["head", "prefix", "short", "mime", "bytes", "oversize"])("rejects unavailable or invalid %s without deleting media", async kind => {
  if (kind === "head") mockHead.mockResolvedValue(null);
  if (kind === "prefix") mockPrefix.mockResolvedValue(null);
  if (kind === "short") mockPrefix.mockResolvedValue(new Uint8Array(4));
  if (kind === "mime") mockHead.mockResolvedValue({ size: 16, contentType: "text/html" });
  if (kind === "oversize") mockHead.mockResolvedValue({ size: 501 * 1024 * 1024, contentType: "video/mp4" });
  if (kind === "bytes") mockPrefix.mockResolvedValue(new Uint8Array([255, 216, 255, ...Array(13).fill(0)]));
  expect((await request()).status).toBe(413);
  expect(mockDelete).not.toHaveBeenCalled(); expect(mockAdmin.opsFor("posts")).toHaveLength(0);
});
