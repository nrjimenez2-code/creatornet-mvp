import { NextRequest } from "next/server";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
import { productPurchaseTerms, type ConsentProduct } from "@/lib/purchaseConsent";
const buyerId = "12000000-0000-4000-8000-000000000001", creatorId = "12000000-0000-4000-8000-000000000002";
const productId = "12000000-0000-4000-8000-000000000003", postId = "12000000-0000-4000-8000-000000000004";
let mockProduct: ConsentProduct | null, mockUser: { id: string } | null, mockError: boolean;
const mockDb = createMockClient(op => ({ data: op.table === "products" ? mockProduct : null,
  error: mockError ? { message: "Synthetic private database diagnostic" } : null }));
const mockAuth = jest.fn(async () => mockUser);
jest.mock("@supabase/supabase-js", () => ({ createClient: () => mockDb }));
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: () => mockAuth() }));
import { GET } from "@/app/api/purchase-consent/route";
const savedEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...savedEnv, CREATOR_PURCHASE_CONSENT_SCHEMA_READY: "true", CREATOR_PURCHASE_POLICIES_READY: "true",
    CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED: "true" };
  mockDb.ops.length = 0; mockAuth.mockClear(); mockUser = { id: buyerId }; mockError = false;
  mockProduct = { id: productId, creator_id: creatorId, title: "Owned offer", description: "Complete course",
    type: "course", amount_cents: 10000, price_cents: 10000, currency: "usd" };
});
afterAll(() => { process.env = savedEnv; });
const request = (query = `product_id=${productId}`) => GET(new NextRequest(`https://creatornet.example.invalid/api/purchase-consent?${query}`));
test("#6 quote uses authenticated buyer and stored price, ignoring URL identity and price overrides", async () => {
  const response = await request(`product_id=${productId}&buyer_id=${creatorId}&amount_cents=50`);
  expect(response.status).toBe(200); expect(await response.json()).toEqual(productPurchaseTerms(mockProduct!, buyerId, null));
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mockDb.ops.every(op => op.kind === "select")).toBe(true);
});
test.each(["CREATOR_PURCHASE_CONSENT_SCHEMA_READY", "CREATOR_PURCHASE_POLICIES_READY", "CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED"])(
  "#6 quote requires gate %s before authentication or database access", async key => {
    process.env[key] = "false"; expect((await request()).status).toBe(409);
    expect(mockAuth).not.toHaveBeenCalled(); expect(mockDb.ops).toHaveLength(0);
  });
test("#6 quote requires authentication before reading the offer", async () => {
  mockUser = null; expect((await request()).status).toBe(401); expect(mockDb.ops).toHaveLength(0);
});
test("#6 unsafe product identifiers do not reach the database", async () => {
  expect((await request("product_id=bad%28id%29")).status).toBe(400); expect(mockDb.ops).toHaveLength(0);
});
test("#6 a nonexistent or unrelated post cannot be bound to the agreement", async () => {
  expect((await request(`product_id=${productId}&post_id=${postId}`)).status).toBe(400);
});
test("#6 monthly mentorship cannot receive one-time consent", async () => {
  process.env.CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY = "true";
  mockProduct = { ...mockProduct!, type: "mentorship", membership_terms: { version: "monthly-mentorship-v1", minimumMonths: 3, autoRenew: true } };
  expect((await request()).status).toBe(409);
});
test("#6 database errors do not expose diagnostics or fabricate a quote", async () => {
  mockError = true; const response = await request(); expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("private database diagnostic");
});

test("timed quote selects and displays the owned duration only when its schema is ready", async () => {
  process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = "true"; process.env.CREATOR_FIXED_SERVICE_ONE_TIME_READY = "true";
  mockProduct!.fixed_service_months = 10;
  const response = await request(); expect(response.status).toBe(200);
  expect((await response.json()).terms).toMatchObject({ serviceMonths: 10, serviceVersion: "fixed-service-months-v1",
    serviceDescription: "Service: 10 calendar months from the first captured payment, independent of payment count." });
  expect(mockDb.ops.find(op => op.table === "products")?.columns).toContain("fixed_service_months");
});
test("legacy schema quote omits the duration column", async () => {
  delete process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY;
  expect((await request()).status).toBe(200);
  expect(mockDb.ops.find(op => op.table === "products")?.columns).not.toContain("fixed_service_months");
});

