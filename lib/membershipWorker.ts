import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertMembershipId, type MembershipPaymentContext } from "./membershipAgreement";
import { membershipCheck as check } from "./membershipCheckout";
import { membershipServerClients } from "./membershipServer";
import type { createMembershipRuntime } from "./membershipRuntime";
type Runtime = Pick<ReturnType<typeof createMembershipRuntime>, "activate" | "collectNext">;
type WorkerDependencies = { admin: SupabaseClient; context: MembershipPaymentContext; runtime: Runtime };
export function membershipWorkerReady(env: Record<string, string | undefined> = process.env) {
  return ["CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_OPERATIONS_SCHEMA_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_COLLECTION_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_WORKER_SCHEMA_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY", "CREATOR_MONTHLY_MENTORSHIPS_RENEWALS_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY", "CREATOR_MONTHLY_MENTORSHIPS_WORKER_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_LIFECYCLE_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_LIFECYCLE_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_PAYMENT_EVENTS_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_PAYMENT_EVENTS_READY"].every(key => env[key] === "true");
}
/** Bounded application concurrency, not a new external scheduler. Deployment
 * still needs separately reviewed scheduling, credentials and monitoring. */
export async function runMembershipBillingWorker(env: Record<string, string | undefined> = process.env, injected?: WorkerDependencies) {
  check(membershipWorkerReady(env), "Monthly billing worker is not enabled");
  let deps = injected;
  if (!deps) {
    const clients = membershipServerClients(env), { createMembershipRuntime } = await import("./membershipRuntime");
    deps = { admin: clients.admin, context: clients.context, runtime: createMembershipRuntime(env, clients) };
  }
  const { admin, context, runtime } = deps;
  const claimed = await admin.rpc("lease_monthly_mentorship_work_v1", { p_context: context, p_limit: 6 });
  check(!claimed.error && Array.isArray(claimed.data) && claimed.data.length <= 6, "Monthly worker lease failed");
  const ids = new Set<string>();
  const rows = claimed.data.map((row: Record<string, unknown>) => {
    assertMembershipId(row.id); assertMembershipId(row.buyer_id); assertMembershipId(row.creator_id); assertMembershipId(row.lease_token);
    check(typeof row.needs_activation === "boolean" && !ids.has(row.id), "Monthly worker lease identity differs"); ids.add(row.id);
    return { id: row.id, buyerId: row.buyer_id, token: row.lease_token, activate: row.needs_activation };
  });
  const settled = await Promise.allSettled(rows.map(async row => {
    let status: string;
    try { status = (row.activate ? await runtime.activate(row.id, row.buyerId) : await runtime.collectNext(row.id, row.buyerId)).status; }
    catch { status = "retry_required"; }
    const finished = await admin.rpc("finish_monthly_mentorship_work_v1", { p_id: row.id, p_token: row.token, p_context: context, p_status: status });
    check(!finished.error && finished.data === true, "Monthly worker completion needs reconciliation");
    return { membershipId: row.id, status };
  }));
  // A failed completion must not abandon other leased jobs still awaiting
  // provider responses. Settle the entire bounded batch before returning 503.
  check(settled.every(result => result.status === "fulfilled"), "Monthly worker batch completion needs reconciliation");
  const outcomes = settled.map(result => { check(result.status === "fulfilled"); return result.value; });
  return { selected: rows.length, failed: outcomes.filter(row => row.status === "retry_required").length, outcomes };
}
