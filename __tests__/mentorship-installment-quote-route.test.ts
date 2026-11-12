import { NextRequest } from "next/server";
const mockAuth = jest.fn(), mockResolvePost = jest.fn(), mockCreateClient = jest.fn();
let mockReady = true;
jest.mock("@supabase/supabase-js", () => ({ createClient: (...args: unknown[]) => mockCreateClient(...args) }));
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: () => mockAuth() }));
jest.mock("@/lib/checkoutGuards", () => ({ INVALID_POST: "invalid-post", resolvePostForProduct: (...args: unknown[]) => mockResolvePost(...args) }));
jest.mock("@/lib/mentorshipInstallmentOptions", () => ({ ...jest.requireActual("@/lib/mentorshipInstallmentOptions"), mentorshipInstallmentOffersReady: () => mockReady }));
jest.mock("@/lib/purchasePolicies", () => ({ ...jest.requireActual("@/lib/purchasePolicies"), purchasePoliciesActive: () => true }));
jest.mock("@/lib/money", () => ({ ...jest.requireActual("@/lib/money"),
  getProcessingFeeSchedule: () => ({ enabled: true, basisPoints: 290, fixedCents: 30, version: "synthetic" }),
  getSubscriptionProcessingFeeSchedule: () => ({ enabled: true, basisPoints: 360, fixedCents: 30, version: "synthetic-recurring" }),
}));
import { GET } from "@/app/api/installments/quote/route";
const productId = "00000000-0000-4000-8000-000000000001", buyerId = "00000000-0000-4000-8000-000000000002";
const product = { id: productId, creator_id: "00000000-0000-4000-8000-000000000003", title: "Mentorship", type: "mentorship",
  amount_cents: 10001, price_cents: 10001, currency: "usd", membership_terms: null, fixed_service_months: 10, installment_options: [3], active: true };
const mockQuery = { select: jest.fn(), eq: jest.fn(), returns: jest.fn(), maybeSingle: jest.fn() };
const oldEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks(); mockReady = true; process.env.CREATOR_PROCESSING_FEE_ENABLED = "true";
  mockAuth.mockResolvedValue({ id: buyerId }); mockResolvePost.mockResolvedValue("post");
  mockCreateClient.mockReturnValue({ from: () => mockQuery });
  mockQuery.select.mockReturnValue(mockQuery); mockQuery.eq.mockReturnValue(mockQuery); mockQuery.returns.mockReturnValue(mockQuery);
  mockQuery.maybeSingle.mockResolvedValue({ data: product, error: null });
});
afterAll(() => { process.env = oldEnv; });
const request = (extra = "") => new NextRequest(`https://example.invalid/api/installments/quote?product_id=${productId}&payment_count=3${extra}`);
test("returns the authenticated buyer's server-priced quote with no caching", async () => {
  const response = await GET(request());
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await response.json()).terms).toMatchObject({ buyerId, amountCents: 10001, serviceMonths: 10, paymentCount: 3 });
  expect(mockQuery.eq).toHaveBeenCalledWith("id", productId);
});
test("unauthenticated quote requests never read products", async () => {
  mockAuth.mockResolvedValue(null); expect((await GET(request())).status).toBe(401); expect(mockCreateClient).not.toHaveBeenCalled();
});
test("disabled checkout never reads products", async () => {
  mockReady = false; expect((await GET(request())).status).toBe(409); expect(mockCreateClient).not.toHaveBeenCalled();
});
test.each(["&amount_cents=1", "&buyer_id=forged", "&payment_count=6", "&fees=0"])("rejects browser overrides %s before database access", async extra => {
  expect((await GET(request(extra))).status).toBe(400); expect(mockCreateClient).not.toHaveBeenCalled();
});
test("post mismatch does not produce a quote", async () => {
  mockResolvePost.mockResolvedValue("invalid-post"); expect((await GET(request())).status).toBe(400);
});
test("removing the approved count prevents a stale buyer selection", async () => {
  mockQuery.maybeSingle.mockResolvedValue({ data: { ...product, installment_options: [2] }, error: null });
  expect((await GET(request())).status).toBe(409);
});
