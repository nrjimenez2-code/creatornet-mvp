/** @jest-environment node */
import { MONTHLY_MENTORSHIP_VERSION } from "@/lib/membershipTerms";

const mockAuth = jest.fn();
const mockSellReady = jest.fn();
const mockStripeProduct = jest.fn();
const mockStripePrice = jest.fn();
const mockProfileUpsert = jest.fn();
const mockAdminRpc = jest.fn();
const mockQuery = { select: jest.fn(), eq: jest.fn(), order: jest.fn(), insert: jest.fn(), single: jest.fn() };
const mockFrom = jest.fn();
const mockUserDb = { auth: { getUser: mockAuth }, from: mockFrom };
jest.mock("@/lib/supabaseServer", () => ({ createSupabaseServer: async () => mockUserDb }));
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {
  from: () => ({ upsert: (...args: unknown[]) => mockProfileUpsert(...args) }),
  rpc: (...args: unknown[]) => mockAdminRpc(...args),
} }));
jest.mock("@/lib/creatorStripeConnect", () => ({ isCreatorSellReady: (...args: unknown[]) => mockSellReady(...args) }));
jest.mock("@/lib/stripe", () => ({ stripe: {
  products: { create: (...args: unknown[]) => mockStripeProduct(...args) },
  prices: { create: (...args: unknown[]) => mockStripePrice(...args) },
} }));
jest.mock("@/lib/rateLimit", () => ({ allowRequest: () => true, clientKey: () => "local-test", tooManyRequests: jest.fn() }));
jest.mock("@/lib/paidCalls", () => ({ paidCallsReady: () => true, validPaidCallTarget: () => true }));
jest.mock("@/lib/apiError", () => ({ publicMessage: (_label: unknown, _error: unknown, fallback: string) => fallback }));
import { GET, POST } from "@/app/api/products/route";

const creatorId = "00000000-0000-4000-8000-000000000001";
const productId = "00000000-0000-4000-8000-000000000002";
const originalEnv = { ...process.env };
const flags = ["CREATOR_FIXED_SERVICE_SCHEMA_READY", "CREATOR_FIXED_SERVICE_OFFERS_READY",
  "CREATOR_FIXED_SERVICE_CONTEXT_READY", "CREATOR_FIXED_SERVICE_ONE_TIME_READY"] as const;
const enable = () => { for (const flag of flags) process.env[flag] = "true"; };
const request = (overrides: Record<string, unknown> = {}) => new Request("https://creatornet.example/api/products", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Ten-month mentorship", type: "mentorship", price_cents: 1000000, fixed_service_months: 10, ...overrides }),
});
const noProductWrites = () => {
  expect(mockStripeProduct).not.toHaveBeenCalled();
  expect(mockStripePrice).not.toHaveBeenCalled();
  expect(mockProfileUpsert).not.toHaveBeenCalled();
  expect(mockQuery.insert).not.toHaveBeenCalled();
  expect(mockAdminRpc).not.toHaveBeenCalled();
};
beforeEach(() => {
  jest.clearAllMocks();
  for (const flag of flags) delete process.env[flag];
  process.env.CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY = "true";
  process.env.CREATOR_MONTHLY_MENTORSHIPS_READY = "true";
  mockAuth.mockResolvedValue({ data: { user: { id: creatorId, email: "creator@example.test" } }, error: null });
  mockSellReady.mockResolvedValue(true);
  mockStripeProduct.mockResolvedValue({ id: "prod_fixed" });
  mockStripePrice.mockResolvedValue({ id: "price_fixed" });
  mockProfileUpsert.mockResolvedValue({ error: null });
  mockFrom.mockReturnValue(mockQuery);
  mockQuery.select.mockReturnValue(mockQuery);
  mockQuery.eq.mockReturnValue(mockQuery);
  mockQuery.insert.mockReturnValue(mockQuery);
  mockQuery.order.mockResolvedValue({ data: [{ id: productId, fixed_service_months: 10 }], error: null });
  mockQuery.single.mockImplementation(async () => ({
    data: { id: productId, ...mockQuery.insert.mock.calls[0]?.[0]?.[0] }, error: null,
  }));
});
afterEach(() => { process.env = { ...originalEnv }; });

test.each(flags)("POST rejects a timed offer before writes when %s is not ready", async flag => {
  enable(); delete process.env[flag];
  const response = await POST(request());
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("FIXED_SERVICE_HELD");
  noProductWrites();
});
test.each([0, -1, 1.5, "10", "", true, {}, [], 2147483647])("POST rejects malformed duration %p before writes", async value => {
  enable();
  expect((await POST(request({ fixed_service_months: value }))).status).toBe(400);
  noProductWrites();
});
test.each([49, 50.5, 100000000])("a timed offer rejects invalid total cents %s before Stripe", async value => {
  enable();
  expect((await POST(request({ price_cents: value }))).status).toBe(400);
  noProductWrites();
});
test.each([0, 2.5, 25])("payment count %s is checked separately from service length", async value => {
  enable();
  expect((await POST(request({ plan_months: value }))).status).toBe(400);
  noProductWrites();
});
test.each([1, 4, 10])("saves ten service months with %s payments without dividing the total price", async count => {
  enable();
  const response = await POST(request({ plan_months: count }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.product).toMatchObject({ id: productId, fixed_service_months: 10, price_cents: 1000000, plan_months: count });
  expect(mockQuery.insert).toHaveBeenCalledWith([expect.objectContaining({
    creator_id: creatorId, fixed_service_months: 10, plan_months: count, price_cents: 1000000, amount_cents: 1000000,
  })]);
  expect(mockStripePrice).toHaveBeenCalledWith({ product: "prod_fixed", unit_amount: 1000000, currency: "usd" });
});
test("accepts more service months than the installment payment-count cap", async () => {
  enable();
  const response = await POST(request({ fixed_service_months: 25, plan_months: 4 }));
  expect(response.status).toBe(200);
  expect((await response.json()).product.fixed_service_months).toBe(25);
});
test("refuses to mix monthly service and fixed duration", async () => {
  enable();
  const membership_terms = { version: MONTHLY_MENTORSHIP_VERSION, minimumMonths: 3, autoRenew: true };
  expect((await POST(request({ membership_terms }))).status).toBe(400);
  noProductWrites();
});
test("refuses fixed duration on a standalone paid call", async () => {
  enable();
  expect((await POST(request({ type: "call", scheduling_url: "https://scheduler.example/paid" }))).status).toBe(400);
  noProductWrites();
});
test.each([undefined, null])("legacy duration %s does not require or write the absent schema column", async value => {
  const response = await POST(request({ fixed_service_months: value }));
  expect(response.status).toBe(200);
  expect(mockQuery.insert.mock.calls[0][0][0]).not.toHaveProperty("fixed_service_months");
  expect(mockQuery.select.mock.calls[0][0]).not.toContain("fixed_service_months");
});
test("authentication and creator Connect readiness remain mandatory", async () => {
  enable();
  mockAuth.mockResolvedValueOnce({ data: { user: null }, error: null });
  expect((await POST(request())).status).toBe(401);
  mockSellReady.mockResolvedValueOnce(false);
  expect((await POST(request())).status).toBe(403);
  noProductWrites();
});
test("GET reads durable duration with schema ready even when creation is stopped", async () => {
  process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = "true";
  const response = await GET();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.items[0].fixed_service_months).toBe(10);
  expect(body.capabilities.fixedServiceDuration).toBe(false);
  expect(mockQuery.select.mock.calls[0][0]).toContain("fixed_service_months");
  expect(mockQuery.eq).toHaveBeenCalledWith("creator_id", creatorId);
});
test("GET avoids the new column before schema readiness", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(mockQuery.select.mock.calls[0][0]).not.toContain("fixed_service_months");
  expect((await response.json()).capabilities.fixedServiceDuration).toBe(false);
});
test("GET advertises creation only after every purchase-path gate is ready", async () => {
  enable();
  expect((await (await GET()).json()).capabilities.fixedServiceDuration).toBe(true);
});
