import { NextRequest } from "next/server";
const mockReady = jest.fn(), mockRun = jest.fn();
jest.mock("@/lib/membershipWorker", () => ({ membershipWorkerReady: () => mockReady(), runMembershipBillingWorker: () => mockRun() }));
import { GET } from "@/app/api/memberships/collect/route";
const originalEnv = { ...process.env }, secret = "synthetic-worker-secret-not-a-credential";
beforeEach(() => { jest.resetAllMocks(); process.env = { ...originalEnv, CRON_SECRET: secret }; mockReady.mockReturnValue(true); mockRun.mockResolvedValue({ selected: 0, failed: 0, outcomes: [] }); });
afterAll(() => { process.env = originalEnv; });
const request = (token = secret, query = "") => GET(new NextRequest("https://membership-fixture.vercel.app/api/memberships/collect" + query,
  { headers: { authorization: "Bearer " + token } }));
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
