import { NextRequest } from "next/server";
const mockReady = jest.fn(), mockRun = jest.fn();
const mockBuyerReady=jest.fn(),mockBuyerRun=jest.fn();
const mockRefundReady=jest.fn(),mockRefundRead=jest.fn();
jest.mock("@/lib/fullRefundReviewBacklog",()=>({fullRefundReviewReady:()=>mockRefundReady(),readFullRefundReviewBacklog:()=>mockRefundRead()}));
jest.mock("@/lib/mentorshipInstallmentWorker",()=>({buyerMentorshipWorkerReady:()=>mockBuyerReady(),runBuyerMentorshipBillingWorker:()=>mockBuyerRun()}));
jest.mock("@/lib/membershipWorker", () => ({ membershipWorkerReady: () => mockReady(), runMembershipBillingWorker: () => mockRun() }));
import { GET } from "@/app/api/memberships/collect/route";
const originalEnv = { ...process.env }, secret = "synthetic-worker-secret-not-a-credential";
beforeEach(() => { jest.resetAllMocks(); process.env = { ...originalEnv, CRON_SECRET: secret }; mockReady.mockReturnValue(true); mockRun.mockResolvedValue({ selected: 0, failed: 0, outcomes: [] }); });
afterAll(() => { process.env = originalEnv; });
const request = (token = secret, query = "") => GET(new NextRequest("https://membership-fixture.vercel.app/api/memberships/collect" + query,
  { headers: { authorization: "Bearer " + token } }));

test("refund-only monitoring survives collection rollback and reports persistent attention",async()=>{
  mockReady.mockReturnValue(false);mockRefundReady.mockReturnValue(true);mockRefundRead.mockResolvedValue({needsReview:1,events:2});
  const response=await request();expect(response.status).toBe(503);expect(await response.json()).toMatchObject({needsReview:1,refundReview:{needsReview:1,events:2}});
  expect(mockRun).not.toHaveBeenCalled();expect(mockBuyerRun).not.toHaveBeenCalled();
});
test("refund-only monitoring retains scheduler authentication and selection restrictions",async()=>{
  mockReady.mockReturnValue(false);mockRefundReady.mockReturnValue(true);
  expect((await request("wrong")).status).toBe(401);expect((await request(secret,"?attempt=foreign")).status).toBe(400);expect(mockRefundRead).not.toHaveBeenCalled();
});
test("unavailable refund backlog cannot report healthy zero counts",async()=>{
  mockRefundReady.mockReturnValue(true);mockRefundRead.mockRejectedValue(Error("private provider identifiers"));
  const response=await request();expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain("private provider");
});
test("step 10: configured authenticated scheduler request invokes the bounded worker without caching", async () => {
  const response = await request(); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mockRun).toHaveBeenCalledTimes(1);
});
test("step 10: wrong scheduler token cannot reach database or payment work", async () => {
  expect((await request("wrong")).status).toBe(401); expect(mockRun).not.toHaveBeenCalled();
});
test("step 10: disabled worker and missing strong secret both fail before dispatch", async () => {
  mockReady.mockReturnValueOnce(false); expect((await request()).status).toBe(409);
  process.env.CRON_SECRET = "short"; expect((await request()).status).toBe(503); expect(mockRun).not.toHaveBeenCalled();
});
test("step 10: URL selection overrides cannot choose a buyer, price, invoice or membership", async () => {
  expect((await request(secret, "?membership_id=untrusted&amount=1")).status).toBe(400); expect(mockRun).not.toHaveBeenCalled();
});
test("step 10: partial worker failure is non-successful and does not hide retry-required work", async () => {
  mockRun.mockResolvedValueOnce({ selected: 1, failed: 1, outcomes: [{ status: "retry_required" }] }); expect((await request()).status).toBe(503);
});
test("buyer-only readiness uses the same authenticated schedule without running disabled memberships",async()=>{
  mockReady.mockReturnValue(false);mockBuyerReady.mockReturnValue(true);mockBuyerRun.mockResolvedValue({selected:1,failed:0,needsReview:0,pending:0});
  expect((await request()).status).toBe(200);expect(mockRun).not.toHaveBeenCalled();expect(mockBuyerRun).toHaveBeenCalledTimes(1);
});
test("persistent buyer review reports error even when no new work was leased",async()=>{
  mockBuyerReady.mockReturnValue(true);mockBuyerRun.mockResolvedValue({selected:0,failed:0,needsReview:1,pending:1});
  expect((await request()).status).toBe(503);
});
test("both workers settle before a thrown membership failure returns",async()=>{
  mockBuyerReady.mockReturnValue(true);mockRun.mockRejectedValue(Error("private"));let finished=false;
  mockBuyerRun.mockImplementation(async()=>{await new Promise(resolve=>setTimeout(resolve,10));finished=true;return {failed:0,needsReview:0};});
  const response=await request();expect(response.status).toBe(503);expect(finished).toBe(true);expect(JSON.stringify(await response.json())).not.toContain("private");
});
test("buyer readiness does not bypass authentication or server-owned selection",async()=>{
  mockReady.mockReturnValue(false);mockBuyerReady.mockReturnValue(true);
  expect((await request("wrong")).status).toBe(401);expect((await request(secret,"?buyer_id=foreign")).status).toBe(400);
  expect(mockBuyerRun).not.toHaveBeenCalled();
});
