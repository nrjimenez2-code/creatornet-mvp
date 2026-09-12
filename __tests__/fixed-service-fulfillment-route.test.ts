import { createMockClient } from "./__mocks__/supabaseQueryMock";
let mockAllowed: boolean, mockError: boolean, mockUser: string, mockLegacy: boolean;
const mockDb = createMockClient(op => {
  if (op.table === "purchases") return { data: { id: "purchase", buyer_id: "buyer", buyer_user_id: "buyer",
    product_id: "product", status: "paid", access_granted: mockLegacy }, error: null };
  if (op.table === "read_fixed_service_entitlement_v1") return { data: { applicable: true, allowed: mockAllowed,
    maxAgeSeconds: mockAllowed ? 10 : 0 }, error: mockError ? { message: "synthetic" } : null };
  if (op.table === "products") return { data: { fulfillment: "FILE", external_url: "https://delivery.example.invalid/owned" }, error: null };
  return undefined;
});
jest.mock("@supabase/supabase-js", () => ({ createClient: () => mockDb }));
jest.mock("@/lib/supabaseServer", () => ({ createServerClient: () => ({ auth: {
  getUser: async () => ({ data: { user: { id: mockUser } }, error: null }),
} }) }));
import { GET } from "@/app/api/purchases/by-session/route";
const saved = { ...process.env };
beforeEach(() => {
  process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = "true";
  delete process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY;
  mockAllowed = true; mockError = false; mockLegacy = false; mockUser = "buyer"; mockDb.ops.length = 0;
});
afterAll(() => { process.env = saved; });
const run = () => GET(new Request("https://creatornet.example.invalid/api/purchases/by-session?session_id=cs_test_Owned"));
test("active timed purchase can obtain its fulfillment through the shared access reader", async () => {
  const response = await run(); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ fulfillment_url: "https://delivery.example.invalid/owned" });
});
test.each(["expired", "reader error", "reader disabled", "another buyer"])("%s cannot get fulfillment URLs", async state => {
  if (state === "expired") mockAllowed = false;
  if (state === "reader error") mockError = true;
  if (state === "reader disabled") process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = "false";
  if (state === "another buyer") mockUser = "another";
  expect((await run()).status).toBe(403); expect(mockDb.ops.some(op => op.table === "products")).toBe(false);
});
test("legacy granted access remains available with both timed readers off", async () => {
  process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = "false"; mockLegacy = true;
  expect((await run()).status).toBe(200);
});
