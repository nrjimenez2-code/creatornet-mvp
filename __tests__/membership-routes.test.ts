import { NextRequest } from "next/server";
import { membershipFixture, membershipTestContext as context } from "../test-support/membership-fixtures";
let mockUser: { id: string } | null, mockReady = true;
const mockQuote = jest.fn(), mockAccept = jest.fn(), mockConfirm = jest.fn(), mockAuth = jest.fn(async () => mockUser);
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: () => mockAuth() }));
jest.mock("@/lib/membershipServer", () => ({ membershipCheckoutReady: () => mockReady, membershipServerContext: () => context }));
jest.mock("@/lib/membershipRuntime", () => ({ createMembershipRuntime: () => ({ quote: mockQuote, acceptAndPrepare: mockAccept, confirmFirst: mockConfirm }) }));
import { GET } from "@/app/api/memberships/quote/route";
import { POST as checkout } from "@/app/api/memberships/checkout/route";
import { POST as confirm } from "@/app/api/memberships/[membershipId]/confirm/route";
const originalEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks(); mockReady = true; mockUser = { id: membershipFixture().a.buyer_id };
  process.env = { ...originalEnv, CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY: "true" };
  mockQuote.mockResolvedValue(membershipFixture().quote); mockAccept.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/synthetic" });
  mockConfirm.mockResolvedValue({ firstPaymentRecorded: false, accessGranted: false });
});
afterAll(() => { process.env = originalEnv; });
const body = () => { const f = membershipFixture(); return { product_id: f.a.product_id, post_id: f.a.post_id,
  consent: { accepted: true, version: f.a.terms.version, fingerprint: f.a.fingerprint } }; };
const request = (value: unknown = body(), origin = context.siteOrigin) => new NextRequest(context.siteOrigin + "/api/memberships/checkout",
  { method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(value) });
test("steps 1/4: quote uses verified buyer and selected IDs, not browser price or identity", async () => {
  const f = membershipFixture(), response = await GET(new NextRequest(context.siteOrigin + "/api/memberships/quote?" +
    new URLSearchParams({ product_id: f.a.product_id, post_id: f.a.post_id, buyer_id: f.a.creator_id, amount: "1" })));
  expect(response.status).toBe(200); expect(mockQuote).toHaveBeenCalledWith(f.a.buyer_id, f.a.product_id, f.a.post_id);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
test("step 4: checkout forwards exact explicit consent under verified ownership", async () => {
  const value = body(); expect((await checkout(request(value))).status).toBe(200);
  expect(mockAccept).toHaveBeenCalledWith(mockUser!.id, value.product_id, value.post_id, value.consent);
});
test("step 10: disabled checkout does not authenticate or create provider objects", async () => {
  mockReady = false; expect((await checkout(request())).status).toBe(409); expect(mockAuth).not.toHaveBeenCalled(); expect(mockAccept).not.toHaveBeenCalled();
});
test("step 5: unauthenticated checkout is refused", async () => {
  mockUser = null; expect((await checkout(request())).status).toBe(401); expect(mockAccept).not.toHaveBeenCalled();
});
test("step 5: cross-origin checkout is refused", async () => {
  expect((await checkout(request(body(), "https://other.example.invalid"))).status).toBe(403); expect(mockAccept).not.toHaveBeenCalled();
});
test.each(["buyer_id", "amount_cents", "stripe_customer_id", "membership_id"])("steps 1/4: browser override %s is refused", async key => {
  expect((await checkout(request({ ...body(), [key]: "untrusted" }))).status).toBe(409); expect(mockAccept).not.toHaveBeenCalled();
});
test.each([null, false, { accepted: false }, { accepted: true, version: "v1", fingerprint: "bad", extra: true }])(
  "step 4: absent, false or extended consent %p cannot reach payment", async consent => {
    expect((await checkout(request({ ...body(), consent }))).status).toBe(409); expect(mockAccept).not.toHaveBeenCalled();
  });
test("step 8: provider or reservation failure returns review, not a fabricated URL", async () => {
  mockAccept.mockRejectedValueOnce(Error("Private synthetic diagnostic")); const response = await checkout(request());
  expect(response.status).toBe(409); expect(await response.text()).not.toContain("Private synthetic diagnostic");
});
test("step 5: confirmation uses only route identity plus verified user", async () => {
  const f = membershipFixture(); const response = await confirm(request({ buyer_id: f.a.creator_id, paid: true }), { params: Promise.resolve({ membershipId: f.a.id }) });
  expect(response.status).toBe(200); expect(mockConfirm).toHaveBeenCalledWith(f.a.id, f.a.buyer_id);
});
test("step 8: unavailable confirmation is retryable and does not assume payment", async () => {
  mockConfirm.mockRejectedValueOnce(Error("Private synthetic failure")); const f = membershipFixture();
  const response = await confirm(request(), { params: Promise.resolve({ membershipId: f.a.id }) });
  expect(response.status).toBe(503); expect(await response.text()).toContain("Access has not been assumed");
});
