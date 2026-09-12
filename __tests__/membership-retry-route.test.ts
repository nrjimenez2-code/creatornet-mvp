import { NextRequest } from "next/server";
import { membershipTestContext as context } from "../test-support/membership-fixtures";
import { MONTHLY_RETRY_CONSENT_VERSION, MONTHLY_FUTURE_CARD_CONSENT_VERSION } from "@/lib/membershipRetryConsent";
let mockReady = true, mockUser: { id: string } | null;
const mockReview = jest.fn(), mockPay = jest.fn(), mockCheck = jest.fn();
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: async () => mockUser }));
jest.mock("@/lib/membershipRetry", () => ({ ...jest.requireActual("@/lib/membershipRetry"), membershipRetryReady: () => mockReady }));
jest.mock("@/lib/membershipServer", () => ({ membershipServerContext: () => context }));
jest.mock("@/lib/membershipRuntime", () => ({ createMembershipRuntime: () => ({
  reviewRenewalRetry: mockReview, payRenewalRetry: mockPay, checkRenewalRetry: mockCheck }) }));
import { POST } from "@/app/api/memberships/[membershipId]/renewal-retry/route";
const id = "30000000-0000-4000-8000-000000000001", setup = "30000000-0000-4000-8000-000000000002",
  quote = "30000000-0000-4000-8000-000000000003", buyer = "30000000-0000-4000-8000-000000000004";
const ctx = { params: Promise.resolve({ membershipId: id }) };
const request = (body: unknown, origin = context.siteOrigin, query = "") => new NextRequest(context.siteOrigin + "/api/memberships/" + id + "/renewal-retry" + query,
  { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const pay = (future = false) => ({ action: "pay", quoteId: quote, accepted: true, consentVersion: MONTHLY_RETRY_CONSENT_VERSION,
  useFutureCard: future, futureConsentVersion: future ? MONTHLY_FUTURE_CARD_CONSENT_VERSION : null });
beforeEach(() => { jest.clearAllMocks(); mockReady = true; mockUser = { id: buyer };
  [mockReview, mockPay, mockCheck].forEach(fn => fn.mockResolvedValue({ membershipId: id })); });
test("steps 4/5: review uses the authenticated buyer and is not payment authority", async () => {
  const res = await POST(request({ action: "review", setupId: setup }), ctx);
  expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(mockReview).toHaveBeenCalledWith(id, buyer, setup); expect(mockPay).not.toHaveBeenCalled();
});
test.each([false, true])("step 4: exact retry and independent future choice %s are forwarded", async future => {
  expect((await POST(request(pay(future)), ctx)).status).toBe(200);
  expect(mockPay).toHaveBeenCalledWith(id, buyer, quote, MONTHLY_RETRY_CONSENT_VERSION, true, future, future ? MONTHLY_FUTURE_CARD_CONSENT_VERSION : null);
});
test("step 8: status checks an owned original quote without dispatch", async () => {
  expect((await POST(request({ action: "status", quoteId: quote }), ctx)).status).toBe(200);
  expect(mockCheck).toHaveBeenCalledWith(id, buyer, quote); expect(mockPay).not.toHaveBeenCalled();
});
test.each([{ ...pay(), accepted: false }, { ...pay(), consentVersion: "old" }, { ...pay(true), futureConsentVersion: null },
  { ...pay(), futureConsentVersion: MONTHLY_FUTURE_CARD_CONSENT_VERSION }, { ...pay(), buyerId: buyer }, { ...pay(), amount: 1 },
  { ...pay(), payment_method: "pm_other" }, { action: "pay", quoteId: quote }, { action: "review", setupId: setup, invoiceId: "in_other" }, null, []])(
  "steps 4/5: missing consent or client overrides %p cannot dispatch", async body => {
    expect((await POST(request(body), ctx)).status).toBe(400); expect(mockPay).not.toHaveBeenCalled();
  });
test("step 5: missing owner, foreign origin and query overrides are rejected", async () => {
  expect((await POST(request(pay(), "https://other.example.invalid"), ctx)).status).toBe(403);
  expect((await POST(request(pay(), context.siteOrigin, "?invoice=other"), ctx)).status).toBe(400);
  mockUser = null; expect((await POST(request(pay()), ctx)).status).toBe(401); expect(mockPay).not.toHaveBeenCalled();
});
test("step 10: disabled schema blocks private retry API", async () => {
  mockReady = false; expect((await POST(request(pay()), ctx)).status).toBe(503); expect(mockPay).not.toHaveBeenCalled();
});
test("step 8: uncertain failures do not claim that payment was not attempted or expose provider data", async () => {
  mockPay.mockRejectedValueOnce(Error("Synthetic private detail"));
  const res = await POST(request(pay()), ctx), text = await res.text();
  expect(res.status).toBe(503); expect(text).toContain("Check its payment status"); expect(text).not.toContain("Synthetic private detail");
});
