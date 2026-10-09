import { NextRequest } from "next/server";
const mockCheckIn = jest.fn(), mockFlush = jest.fn(), mockCollect = jest.fn(), mockRecover = jest.fn();
let mockReady = true;
let mockBuyerReady=false;
const mockBuyerRun=jest.fn();
const mockRefundReady=jest.fn(),mockRefundRead=jest.fn();
jest.mock("@/lib/fullRefundReviewBacklog",()=>({fullRefundReviewReady:()=>mockRefundReady(),readFullRefundReviewBacklog:()=>mockRefundRead()}));
jest.mock("@sentry/nextjs", () => ({ captureCheckIn: (...args: unknown[]) => mockCheckIn(...args), flush: () => mockFlush() }));
jest.mock("@/lib/membershipWorker", () => ({ membershipWorkerReady: () => mockReady, runMembershipBillingWorker: () => mockCollect() }));
jest.mock("@/lib/mentorshipInstallmentWorker",()=>({buyerMentorshipWorkerReady:()=>mockBuyerReady,runBuyerMentorshipBillingWorker:()=>mockBuyerRun()}));
jest.mock("@/lib/membershipExitRecovery", () => ({ membershipExitRecoveryReady: () => mockReady, runMembershipExitRecovery: () => mockRecover() }));
import { GET as collect } from "@/app/api/memberships/collect/route";
import { GET as recover } from "@/app/api/memberships/recover-exits/route";
const original = { ...process.env }, secret = "synthetic-scheduler-secret-32-characters";
const request = (token = secret) => new NextRequest("https://www.creatornet.net/api/memberships/collect", { headers: { authorization: `Bearer ${token}` } });
beforeEach(() => {
  jest.resetAllMocks(); mockReady = true;mockBuyerReady=false;
  process.env = { ...original, VERCEL_ENV: "production", CREATOR_MONTHLY_MENTORSHIPS_MONITORING_READY: "true", CRON_SECRET: secret };
  mockCheckIn.mockReturnValue("id"); mockFlush.mockResolvedValue(true);
  mockCollect.mockResolvedValue({ selected: 1, failed: 1, outcomes: [] });
  mockRecover.mockResolvedValue({ selected: 1, failed: 0, needsReview: 1, outcomes: [] });
});
afterAll(() => { process.env = original; });
test("refund-only attention uses the existing error monitor and a later verified empty snapshot recovers it",async()=>{
  mockReady=false;mockRefundReady.mockReturnValue(true);mockRefundRead.mockResolvedValueOnce({needsReview:1}).mockResolvedValueOnce({needsReview:0});
  expect((await collect(request())).status).toBe(503);expect(mockCheckIn).toHaveBeenLastCalledWith(expect.objectContaining({status:"error"}));
  expect((await collect(request())).status).toBe(200);expect(mockCheckIn).toHaveBeenLastCalledWith(expect.objectContaining({status:"ok"}));
  expect(mockCollect).not.toHaveBeenCalled();expect(mockBuyerRun).not.toHaveBeenCalled();
});
test("buyer-only backoff attention marks the existing collection monitor as error",async()=>{
  mockReady=false;mockBuyerReady=true;mockBuyerRun.mockResolvedValue({selected:0,failed:0,needsReview:1,pending:1});
  expect((await collect(request())).status).toBe(503);expect(mockCollect).not.toHaveBeenCalled();
  expect(mockCheckIn).toHaveBeenCalledTimes(2);expect(mockCheckIn).toHaveBeenLastCalledWith(expect.objectContaining({status:"error",checkInId:"id"}));
});
test.each([collect, recover])("a handled incomplete batch marks the check-in as error", async route => {
  expect((await route(request())).status).toBe(503);
  expect(mockCheckIn).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error", checkInId: "id" }));
});
test.each([collect, recover])("unauthenticated callers cannot create check-ins or run billing", async route => {
  expect((await route(request("wrong"))).status).toBe(401);
  expect(mockCheckIn).not.toHaveBeenCalled(); expect(mockCollect).not.toHaveBeenCalled(); expect(mockRecover).not.toHaveBeenCalled();
});
test.each([collect, recover])("disabled jobs never falsely heartbeat a healthy production schedule", async route => {
  mockReady = false;
  expect((await route(request())).status).toBe(409);
  expect(mockCheckIn).not.toHaveBeenCalled(); expect(mockCollect).not.toHaveBeenCalled(); expect(mockRecover).not.toHaveBeenCalled();
});
