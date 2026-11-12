import type { SupabaseClient } from "@supabase/supabase-js";
const mockContext = { mode: "test", stripeAccountId: "acct_fixture" };
jest.mock("@/lib/membershipServer", () => ({ membershipServerContext: () => mockContext }));
import { readMembershipBillingBacklog } from "@/lib/membershipBillingBacklog";
const rpc = jest.fn(), admin = { rpc } as unknown as SupabaseClient;
const env = { CREATOR_MONTHLY_MENTORSHIPS_BACKLOG_SCHEMA_READY: "true" };
const row = { context: mockContext, observedAt: "2026-09-21T01:00:00Z", agreementCount: 100,
  billingDueCount: 50, billingOldestDueAt: "2026-09-21T00:00:00Z", billingReviewCount: 2, financialHoldCount: 1,
  billingRetryCount: 3, billingLeasedCount: 4, exitCount: 5, exitDueCount: 2, exitOldestDueAt: "2026-09-21T00:30:00Z",
  exitReviewCount: 1, exitRetryCount: 1, exitLeasedCount: 1, privateProof: "secret" };
beforeEach(() => { jest.clearAllMocks(); rpc.mockResolvedValue({ data: row, error: null }); });
test("returns a context-scoped global snapshot without private database fields", async () => {
  const data = await readMembershipBillingBacklog(admin, env);
  expect(rpc).toHaveBeenCalledWith("read_monthly_mentorship_billing_backlog_v1", { p_context: mockContext });
  expect(data?.billingDueCount).toBe(50);
  expect(data).not.toHaveProperty("context"); expect(data).not.toHaveProperty("privateProof");
});
test("an unapplied schema is explicitly unavailable, not an empty healthy queue", async () => {
  expect(await readMembershipBillingBacklog(admin, {})).toBeNull(); expect(rpc).not.toHaveBeenCalled();
});
test("database failures remain unavailable", async () => {
  rpc.mockResolvedValue({ data: null, error: { message: "secret" } });
  await expect(readMembershipBillingBacklog(admin, env)).rejects.toThrow("Monthly billing totals unavailable");
});
test.each([{ context: { ...mockContext, mode: "live" } }, { billingDueCount: -1 }, { billingDueCount: 101 },
  { billingDueCount: "50" }, { exitDueCount: 6 }, { billingOldestDueAt: null }, { billingOldestDueAt: "infinity" },
  { billingOldestDueAt: "2026-10-01T00:00:00Z" }, { observedAt: "invalid" }])("rejects inconsistent aggregate %p", async changed => {
  rpc.mockResolvedValue({ data: { ...row, ...changed }, error: null });
  await expect(readMembershipBillingBacklog(admin, env)).rejects.toThrow("unavailable");
});
