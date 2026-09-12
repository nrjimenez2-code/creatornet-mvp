import { NextRequest } from "next/server";
let mockReady = true; const mockRun = jest.fn();
jest.mock("@/lib/membershipExitRecovery", () => ({ membershipExitRecoveryReady: () => mockReady, runMembershipExitRecovery: () => mockRun() }));
import { GET } from "@/app/api/memberships/recover-exits/route";
const oldSecret = process.env.CRON_SECRET, secret = "synthetic-exit-recovery-secret-32-characters";
const request = (authorization = "Bearer " + secret, query = "") => new NextRequest("https://example.invalid/api/memberships/recover-exits" + query,
  { headers: { authorization } });
beforeEach(() => { jest.clearAllMocks(); mockReady = true; process.env.CRON_SECRET = secret; mockRun.mockResolvedValue({ selected: 0 }); });
afterAll(() => { if (oldSecret == null) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret; });
test("step 10: authenticated recovery returns no-store output", async () => {
  const result = await GET(request()); expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("private, no-store"); expect(mockRun).toHaveBeenCalledTimes(1);
});
test("step 10: disabled recovery never runs", async () => {
  mockReady = false; expect((await GET(request())).status).toBe(409); expect(mockRun).not.toHaveBeenCalled();
});
test.each(["", "Bearer wrong", secret])("step 10: invalid recovery credential %s is rejected", async value => {
  expect((await GET(request(value))).status).toBe(401); expect(mockRun).not.toHaveBeenCalled();
});
test("step 10: missing/short scheduler secret is not accepted", async () => {
  process.env.CRON_SECRET = "short"; expect((await GET(request())).status).toBe(503); expect(mockRun).not.toHaveBeenCalled();
});
test.each(["?request_id=x", "?buyer_id=x", "?limit=100"])("step 10: browser-selected recovery target %s is rejected", async query => {
  expect((await GET(request(undefined, query))).status).toBe(400); expect(mockRun).not.toHaveBeenCalled();
});
test("step 8: private recovery error is not leaked", async () => {
  mockRun.mockRejectedValueOnce(Error("Private Stripe details")); const result = await GET(request());
  expect(result.status).toBe(503); expect(await result.text()).not.toContain("Private Stripe");
});
