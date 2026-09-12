import type { SupabaseClient } from "@supabase/supabase-js";
import { runMembershipBillingWorker, membershipWorkerReady } from "@/lib/membershipWorker";
import { membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
const row = { id: "18000000-0000-4000-8000-000000000001", buyer_id: "18000000-0000-4000-8000-000000000002",
  creator_id: "18000000-0000-4000-8000-000000000003", lease_token: "18000000-0000-4000-8000-000000000004", needs_activation: false };
function harness() {
  let rows = [{ ...row }]; const env = { ...membershipTestEnv };
  const activate = jest.fn().mockResolvedValue({ status: "activated_held", membershipId: row.id, subscriptionId: "sub_fixture" });
  const collectNext = jest.fn().mockResolvedValue({ status: "recorded", membershipId: row.id, month: 2 });
  const rpc = jest.fn(async (name: string) => ({ data: name === "lease_monthly_mentorship_work_v1" ? rows : true, error: null }));
  const run = () => runMembershipBillingWorker(env, { admin: { rpc } as unknown as SupabaseClient, context, runtime: { activate, collectNext } });
  return { env, rpc, activate, collectNext, run, setRows: (value: typeof rows) => { rows = value; } };
}
test("step 1/10: bounded leased work uses the owned buyer and records completion under its exact token", async () => {
  const h = harness(); expect(await h.run()).toMatchObject({ selected: 1, failed: 0 });
  expect(h.rpc.mock.calls[0]).toEqual(["lease_monthly_mentorship_work_v1", { p_context: context, p_limit: 6 }]);
  expect(h.collectNext).toHaveBeenCalledWith(row.id, row.buyer_id);
  expect(h.rpc.mock.calls[1]).toEqual(["finish_monthly_mentorship_work_v1", { p_id: row.id, p_token: row.lease_token, p_context: context, p_status: "recorded" }]);
});
test("step 1: activation is a separate leased job, not a simultaneous first renewal charge", async () => {
  const h = harness(); h.setRows([{ ...row, needs_activation: true }]); await h.run();
  expect(h.activate).toHaveBeenCalledWith(row.id, row.buyer_id); expect(h.collectNext).not.toHaveBeenCalled();
});
test("step 10: default-off or missing readiness prevents any lease or provider work", async () => {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_WORKER_READY = "false";
  expect(membershipWorkerReady(h.env)).toBe(false); await expect(h.run()).rejects.toThrow("not enabled"); expect(h.rpc).not.toHaveBeenCalled();
});
test("step 8: worker failures are recorded as retry-required, not silently reported as success", async () => {
  const h = harness(); h.collectNext.mockRejectedValueOnce(Error("Private synthetic provider failure"));
  expect(await h.run()).toEqual({ selected: 1, failed: 1, outcomes: [{ membershipId: row.id, status: "retry_required" }] });
  expect(h.rpc.mock.calls[1]).toEqual(["finish_monthly_mentorship_work_v1", { p_id: row.id, p_token: row.lease_token, p_context: context, p_status: "retry_required" }]);
});
test("step 8: duplicate lease identities cannot dispatch two jobs", async () => {
  const h = harness(); h.setRows([{ ...row }, { ...row }]); await expect(h.run()).rejects.toThrow("identity differs");
  expect(h.collectNext).not.toHaveBeenCalled();
});
test("step 10: an empty due queue does not fabricate a membership or payment", async () => {
  const h = harness(); h.setRows([]); expect(await h.run()).toEqual({ selected: 0, failed: 0, outcomes: [] });
  expect(h.collectNext).not.toHaveBeenCalled();
});
test("step 8: a failed completion waits for every other running job before the worker returns", async () => {
  const h = harness(), second = { ...row, id: "18000000-0000-4000-8000-000000000005" };
  h.setRows([{ ...row }, second]);
  h.rpc.mockResolvedValueOnce({ data: [{ ...row }, second], error: null }).mockResolvedValueOnce({ data: false, error: null });
  let releaseSecond: (() => void) | undefined, finished = false;
  h.collectNext.mockImplementation(async (id: string) => {
    if (id === second.id) await new Promise<void>(resolve => { releaseSecond = resolve; });
    return { status: "recorded", membershipId: id, month: 2 };
  });
  const task = h.run().then(() => { finished = true; return null; }, error => { finished = true; return error as Error; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(finished).toBe(false); expect(releaseSecond).toBeDefined(); releaseSecond!();
  expect((await task)?.message).toContain("batch completion needs reconciliation"); expect(finished).toBe(true);
});
