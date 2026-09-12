import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertMembershipId, type MembershipPaymentContext } from "./membershipAgreement";
import { membershipCheck as check } from "./membershipCheckout";
import { membershipExitReady } from "./membershipExit";
import type { createMembershipRuntime } from "./membershipRuntime";
type Runtime = Pick<ReturnType<typeof createMembershipRuntime>, "reconcileExitStop">;
type Dependencies = { admin: SupabaseClient; context: MembershipPaymentContext; runtime: Runtime };
export function membershipExitRecoveryReady(env: Record<string, string | undefined> = process.env) {
  return membershipExitReady(env) && env.CREATOR_MONTHLY_MENTORSHIPS_EXIT_RECOVERY_SCHEMA_READY === "true" &&
    env.CREATOR_MONTHLY_MENTORSHIPS_EXIT_RECOVERY_READY === "true";
}
export async function runMembershipExitRecovery(env: Record<string, string | undefined> = process.env, injected?: Dependencies) {
  check(membershipExitRecoveryReady(env), "Monthly exit recovery is not enabled");
  let deps = injected;
  if (!deps) {
    const { membershipServerClients } = await import("./membershipServer"), { createMembershipRuntime } = await import("./membershipRuntime");
    const clients = membershipServerClients(env);
    deps = { admin: clients.admin, context: clients.context, runtime: createMembershipRuntime(env, clients) };
  }
  const { admin, context, runtime } = deps;
  const selected = await admin.rpc("lease_monthly_mentorship_exit_work_v1", { p_context: context, p_limit: 6 });
  check(!selected.error && Array.isArray(selected.data) && selected.data.length <= 6, "Monthly exit recovery lease failed");
  const memberships = new Set<string>(), requests = new Set<string>();
  const rows = selected.data.map((row: Record<string, unknown>) => {
    assertMembershipId(row.membership_id); assertMembershipId(row.buyer_id); assertMembershipId(row.request_id); assertMembershipId(row.lease_token);
    check(!memberships.has(row.membership_id) && !requests.has(row.request_id), "Duplicate exit recovery lease");
    memberships.add(row.membership_id); requests.add(row.request_id);
    return { membershipId: row.membership_id, buyerId: row.buyer_id, requestId: row.request_id, token: row.lease_token };
  });
  const settled = await Promise.allSettled(rows.map(async row => {
    let status: "provider_stopped" | "provider_review_required" | "retry_required";
    try {
      const result = await runtime.reconcileExitStop(row.membershipId, row.buyerId, row.requestId);
      check(result.requestId === row.requestId && ["provider_stopped", "provider_review_required"].includes(result.status) &&
        result.billingBlocked === true && result.balanceWaived === false &&
        result.providerStopped === (result.status === "provider_stopped"), "Monthly exit recovery result differs");
      status = result.status;
    } catch { status = "retry_required"; }
    const saved = await admin.rpc("finish_monthly_mentorship_exit_work_v1", { p_request_id: row.requestId, p_token: row.token, p_context: context, p_status: status });
    check(!saved.error && saved.data === true, "Monthly exit recovery completion needs reconciliation");
    return { membershipId: row.membershipId, requestId: row.requestId, status };
  }));
  // Never return while another leased provider operation is still running.
  check(settled.every(result => result.status === "fulfilled"), "Monthly exit recovery completion needs reconciliation");
  const outcomes = settled.map(result => { check(result.status === "fulfilled"); return result.value; });
  return { selected: rows.length, stopped: outcomes.filter(r => r.status === "provider_stopped").length,
    needsReview: outcomes.filter(r => r.status === "provider_review_required").length,
    failed: outcomes.filter(r => r.status === "retry_required").length, outcomes };
}
