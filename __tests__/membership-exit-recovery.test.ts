import type { SupabaseClient } from "@supabase/supabase-js";
import { membershipExitRecoveryReady, runMembershipExitRecovery } from "@/lib/membershipExitRecovery";
import { membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
const row = { membership_id: "23000000-0000-4000-8000-000000000001", buyer_id: "23000000-0000-4000-8000-000000000002",
  request_id: "23000000-0000-4000-8000-000000000003", lease_token: "23000000-0000-4000-8000-000000000004" };
function harness() {
  let rows = [{ ...row }]; const env = { ...membershipTestEnv };
  const reconcileExitStop = jest.fn().mockResolvedValue({ status: "provider_stopped", requestId: row.request_id,
    kind: "stop_renewal", providerStopped: true, billingBlocked: true, balanceWaived: false });
  const rpc = jest.fn(async (name: string, params: Record<string, unknown>) => {
    void params; return { error: null as unknown, data: name.startsWith("lease_") ? rows : true as unknown };
  });
  const run = () => runMembershipExitRecovery(env, { admin: { rpc } as unknown as SupabaseClient, context, runtime: { reconcileExitStop } });
  return { env, rpc, reconcileExitStop, run, setRows: (value: typeof rows) => { rows = value; } };
}
test("steps 2/8: recovery uses only the leased existing request and exact completion token", async () => {
  const h = harness(); expect(await h.run()).toMatchObject({ selected: 1, stopped: 1, needsReview: 0, failed: 0 });
  expect(h.reconcileExitStop).toHaveBeenCalledWith(row.membership_id, row.buyer_id, row.request_id);
  expect(h.rpc).toHaveBeenLastCalledWith("finish_monthly_mentorship_exit_work_v1",
    { p_request_id: row.request_id, p_token: row.lease_token, p_context: context, p_status: "provider_stopped" });
});
test("step 2: paused new billing does not pause existing exit recovery", async () => {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY = "false"; h.env.CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY = "false";
  expect(membershipExitRecoveryReady(h.env)).toBe(true); expect((await h.run()).stopped).toBe(1);
});
test.each(["CREATOR_MONTHLY_MENTORSHIPS_EXIT_READY", "CREATOR_MONTHLY_MENTORSHIPS_EXIT_RECOVERY_READY",
  "CREATOR_MONTHLY_MENTORSHIPS_EXIT_RECOVERY_SCHEMA_READY"])("step 10: missing %s blocks recovery before lease or provider work", async key => {
  const h = harness(); h.env[key] = "false"; await expect(h.run()).rejects.toThrow("not enabled"); expect(h.rpc).not.toHaveBeenCalled();
});
test("step 8: provider review is not presented as completed cancellation", async () => {
  const h = harness(); h.reconcileExitStop.mockResolvedValueOnce({ status: "provider_review_required", requestId: row.request_id,
    providerStopped: false, billingBlocked: true, balanceWaived: false });
  expect(await h.run()).toMatchObject({ stopped: 0, needsReview: 1, failed: 0 });
});
test("step 8: runtime failure records retry-required without exposing private provider errors", async () => {
  const h = harness(); h.reconcileExitStop.mockRejectedValueOnce(Error("Private synthetic response"));
  const result = await h.run(); expect(result.failed).toBe(1); expect(JSON.stringify(result)).not.toContain("Private");
  expect(h.rpc).toHaveBeenLastCalledWith("finish_monthly_mentorship_exit_work_v1", expect.objectContaining({ p_status: "retry_required" }));
});
test.each(["membership", "request", "oversize"])("step 8: %s lease duplication/overflow is rejected before dispatch", async kind => {
  const h = harness(), other = { ...row, membership_id: "23000000-0000-4000-8000-000000000005",
    request_id: "23000000-0000-4000-8000-000000000006" };
  h.setRows(kind === "membership" ? [row, { ...other, membership_id: row.membership_id }] :
    kind === "request" ? [row, { ...other, request_id: row.request_id }] : Array.from({ length: 7 }, () => ({ ...row })));
  await expect(h.run()).rejects.toThrow(); expect(h.reconcileExitStop).not.toHaveBeenCalled();
});
test("step 8: unknown completion token is an error, not a silently lost job", async () => {
  const h = harness(); h.rpc.mockImplementation(async name => ({ error: null, data: name.startsWith("lease_") ? [row] : false }));
  await expect(h.run()).rejects.toThrow("completion needs reconciliation");
});
test("step 8: one completion failure cannot return while another provider job is still running", async () => {
  const h = harness(), other = { ...row, membership_id: "23000000-0000-4000-8000-000000000005", request_id: "23000000-0000-4000-8000-000000000006" };
  h.setRows([row, other]); let release!: () => void, finished = false;
  h.reconcileExitStop.mockImplementation(async (_id, _buyer, requestId) => {
    if (requestId === other.request_id) await new Promise<void>(resolve => { release = resolve; });
    return { status: "provider_stopped", requestId, providerStopped: true, billingBlocked: true, balanceWaived: false };
  });
  h.rpc.mockImplementation(async (name, params) => ({ error: name.startsWith("finish_") && params.p_request_id === row.request_id ? Error("Synthetic finish failure") : null,
    data: name.startsWith("lease_") ? [row, other] : true }));
  const running = h.run(); void running.then(() => { finished = true; }, () => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 0)); expect(finished).toBe(false);
  release(); await expect(running).rejects.toThrow("completion needs reconciliation");
});
