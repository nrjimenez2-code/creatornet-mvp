import { NextRequest } from "next/server";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
let mockUser: { id: string } | null = { id: "buyer" }, mockLegacyAllowed = false;
const mockSign = jest.fn(), mockEntitlement = jest.fn();
const mockDb = createMockClient(op => {
  if (op.table === "posts") return { data: { id: "post", creator_id: "creator", premium_path: "creator/file.pdf" }, error: null };
  if (op.table === "purchases") return { data: op.filters.buyer_id === "buyer" &&
    (op.filters.access_granted !== true || mockLegacyAllowed) ? { id: "purchase" } : null, error: null };
  return { data: null, error: null };
});
jest.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: mockDb.from, rpc: mockEntitlement,
  storage: { from: () => ({ createSignedUrl: mockSign }) } }) }));
jest.mock("@/lib/supabaseClient", () => ({ createServerSupabase: async () => ({ auth: { getUser: async () => ({ data: { user: mockUser } }) } }) }));
import { GET } from "@/app/api/watch/[postId]/route";
import { POST } from "@/app/api/premium/access/route";
const saved = process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY;
beforeEach(() => {
  process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = "true";
  mockUser = { id: "buyer" }; mockLegacyAllowed = false; mockDb.ops.length = 0; jest.clearAllMocks();
  mockSign.mockResolvedValue({ data: { signedUrl: "https://storage.example.invalid/signed" }, error: null });
  mockEntitlement.mockResolvedValue({ data: { allowed: true, maxAgeSeconds: 17 }, error: null });
});
afterAll(() => { if (saved === undefined) delete process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY;
  else process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = saved; });
const request = (route: string) => route === "watch" ? GET(new NextRequest("https://site.example.invalid/api/watch/post"), { params: Promise.resolve({ postId: "post" }) }) :
  POST(new NextRequest("https://site.example.invalid/api/premium/access", { method: "POST", body: JSON.stringify({ post_id: "post", buyer_id: "forged" }) }));
describe.each(["watch", "premium"])("step 5: %s entitlement route", route => {
  test("closed unpaid history is excluded before selecting current owned access", async () => {
    expect((await request(route)).status).toBe(200);
    const query = mockDb.ops.find(op => op.table === "purchases");
    expect(JSON.stringify(query)).toContain("kind.is.null,kind.neq.monthly_mentorship_v1,status.is.null,status.neq.canceled");
  });
  test("binds authenticated ownership and caps the signed URL to current paid time", async () => {
    expect((await request(route)).status).toBe(200);
    expect(mockEntitlement).toHaveBeenCalledWith("read_monthly_mentorship_entitlement_v1", { p_purchase_id: "purchase", p_buyer_id: "buyer" });
    expect(mockSign).toHaveBeenCalledWith("creator/file.pdf", 17);
  });
  test.each([{ allowed: false, maxAgeSeconds: 0 }, { allowed: true, maxAgeSeconds: 0 }, { allowed: true, maxAgeSeconds: 3601 }, null])(
    "expired or malformed entitlement %p never gets a signed URL", async data => {
      mockEntitlement.mockResolvedValue({ data, error: null }); expect((await request(route)).status).toBeGreaterThanOrEqual(400);
      expect(mockSign).not.toHaveBeenCalled();
    });
  test("database errors fail closed", async () => {
    mockEntitlement.mockResolvedValue({ data: { allowed: true, maxAgeSeconds: 100 }, error: { message: "Synthetic failure" } });
    expect((await request(route)).status).toBeGreaterThanOrEqual(400); expect(mockSign).not.toHaveBeenCalled();
  });
  test("switching the new reader off cannot expose a monthly purchase through legacy access", async () => {
    process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = "false";
    expect((await request(route)).status).toBeGreaterThanOrEqual(400); expect(mockSign).not.toHaveBeenCalled();
    expect(mockEntitlement).not.toHaveBeenCalled();
  });
  test("legacy paid purchases keep their prior one-hour behavior with the feature off", async () => {
    process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = "false"; mockLegacyAllowed = true;
    expect((await request(route)).status).toBe(200); expect(mockSign).toHaveBeenCalledWith("creator/file.pdf", 3600);
  });
  test("signed-out callers never ask for an entitlement or URL", async () => {
    mockUser = null; expect((await request(route)).status).toBe(401);
    expect(mockEntitlement).not.toHaveBeenCalled(); expect(mockSign).not.toHaveBeenCalled();
  });
});
