import "server-only";
import { isDeepStrictEqual } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { membershipServerContext } from "./membershipServer";

type Env = Record<string, string | undefined>;
const pageSize = 25;
export function membershipAdminReady(env: Env = process.env) {
  return ["ADMIN", "LEDGER_SCHEMA", "WORKER_SCHEMA", "LIFECYCLE_SCHEMA", "PAYOFF_SCHEMA", "MANAGEMENT_SCHEMA"]
    .every(name => env[`CREATOR_MONTHLY_MENTORSHIPS_${name}_READY`] === "true");
}
export function validMembershipAdminCursor(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
type Row = {
  id: string; title: string; payment_context: unknown; monthly_price_cents: number;
  covered_months: number; minimum_months: number; auto_renew: boolean;
  billing_worker_status: string | null; billing_next_attempt_at: string; billing_last_attempt_at: string | null;
  billing_lease_until: string | null; billing_review_at: string | null; financial_hold_at: string | null;
  payoff_hold_at: string | null; renewal_stopped_at: string | null; debit_revoked_at: string | null;
};
type ExitRow = { id: string; agreement_id: string; kind: string; status: string; requested_at: string;
  provider_worker_status: string | null; provider_next_attempt_at: string; provider_last_attempt_at: string | null };

/** Call only after requireAdmin. This reads saved state; it never dispatches a
 * provider operation or infers permission to charge from a due timestamp. */
export async function readMembershipAdminPage(admin: SupabaseClient, cursor: string | null, env: Env = process.env) {
  if (!membershipAdminReady(env) || cursor !== null && !validMembershipAdminCursor(cursor)) throw Error("Monthly review unavailable");
  const context = membershipServerContext(env);
  let query = admin.from("monthly_mentorship_agreements_v1").select(
    "id,title:terms->>title,payment_context:terms->paymentContext,monthly_price_cents,covered_months,minimum_months,auto_renew," +
    "billing_worker_status,billing_next_attempt_at,billing_last_attempt_at,billing_lease_until,billing_review_at," +
    "financial_hold_at,payoff_hold_at,renewal_stopped_at,debit_revoked_at")
    .contains("terms", { paymentContext: context }).order("id", { ascending: true }).limit(pageSize + 1);
  if (cursor) query = query.gt("id", cursor);
  const result = await query.returns<Row[]>();
  if (result.error || !Array.isArray(result.data) || result.data.length > pageSize + 1) throw Error("Monthly review query failed");
  const all = result.data;
  if (all.some((row, i) => !validMembershipAdminCursor(row.id) || !isDeepStrictEqual(row.payment_context, context) ||
    i > 0 && row.id <= all[i - 1].id || cursor !== null && row.id <= cursor)) throw Error("Monthly review context differs");
  const rows = all.slice(0, pageSize);
  const ids = rows.map(row => row.id);
  // At most two exit kinds per agreement; payoff reuses stop_renewal. Read only these
  // already-scoped parents. Never return provider proofs or accepted snapshots.
  const exits = ids.length ? await admin.from("monthly_mentorship_exit_requests_v1")
    .select("id,agreement_id,kind,status,requested_at,provider_worker_status,provider_next_attempt_at,provider_last_attempt_at")
    .in("agreement_id", ids).order("requested_at", { ascending: true }).limit(pageSize * 2 + 1).returns<ExitRow[]>() : { data: [], error: null };
  if (exits.error || !Array.isArray(exits.data) || exits.data.length > pageSize * 2 ||
    exits.data.some(row => !validMembershipAdminCursor(row.id) || !ids.includes(row.agreement_id))) throw Error("Monthly exits query failed");
  return {
    observedAt: new Date().toISOString(), mode: context.mode,
    nextCursor: all.length > pageSize ? rows[rows.length - 1].id : null,
    memberships: rows.map(row => ({
      id: row.id, title: row.title || "Monthly mentorship", monthlyCents: row.monthly_price_cents,
      coveredMonths: row.covered_months, minimumMonths: row.minimum_months, autoRenew: row.auto_renew,
      workerStatus: row.billing_worker_status, nextAttemptAt: row.billing_next_attempt_at,
      lastAttemptAt: row.billing_last_attempt_at, leaseUntil: row.billing_lease_until,
      holds: [row.billing_review_at && "Billing review", row.financial_hold_at && "Financial hold",
        row.payoff_hold_at && "Payoff pending", row.renewal_stopped_at && "Renewal stopped",
        row.debit_revoked_at && "Automatic debits revoked"].filter((value): value is string => !!value),
      exits: exits.data.filter(exit => exit.agreement_id === row.id).map(exit => ({
        id: exit.id, kind: exit.kind, status: exit.status, requestedAt: exit.requested_at,
        workerStatus: exit.provider_worker_status, nextAttemptAt: exit.provider_next_attempt_at,
        lastAttemptAt: exit.provider_last_attempt_at,
      })),
    })),
  };
}
