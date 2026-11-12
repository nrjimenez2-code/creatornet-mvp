import "server-only";
import { isDeepStrictEqual } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { membershipServerContext } from "./membershipServer";

const counts = ["agreementCount", "billingDueCount", "billingReviewCount", "financialHoldCount", "billingRetryCount",
  "billingLeasedCount", "exitCount", "exitDueCount", "exitReviewCount", "exitRetryCount", "exitLeasedCount"] as const;
type Counts = Record<typeof counts[number], number>;
export type MembershipBillingBacklog = Counts & {
  observedAt: string; billingOldestDueAt: string | null; exitOldestDueAt: string | null;
};
/** Call after admin authorization. A read-only database snapshot, never authority
 * to collect a payment or retry a provider operation. Null means not configured;
 * errors must remain visibly unavailable rather than becoming zero counts. */
export async function readMembershipBillingBacklog(admin: SupabaseClient, env: Record<string, string | undefined> = process.env): Promise<MembershipBillingBacklog | null> {
  if (env.CREATOR_MONTHLY_MENTORSHIPS_BACKLOG_SCHEMA_READY !== "true") return null;
  try {
    const context = membershipServerContext(env);
    const { data, error } = await admin.rpc("read_monthly_mentorship_billing_backlog_v1", { p_context: context });
    if (error || !data || typeof data !== "object" || Array.isArray(data) || !isDeepStrictEqual(data.context, context)) throw Error();
    if (counts.some(key => !Number.isSafeInteger(data[key]) || data[key] < 0) ||
      typeof data.observedAt !== "string" || !Number.isFinite(Date.parse(data.observedAt))) throw Error();
    for (const key of counts.filter(key => key.startsWith("billing") || key === "financialHoldCount"))
      if (data[key] > data.agreementCount) throw Error();
    for (const key of counts.filter(key => key.startsWith("exit"))) if (data[key] > data.exitCount) throw Error();
    for (const [count, oldest] of [["billingDueCount", "billingOldestDueAt"], ["exitDueCount", "exitOldestDueAt"]] as const) {
      if (data[count] === 0 ? data[oldest] !== null : typeof data[oldest] !== "string" ||
        !Number.isFinite(Date.parse(data[oldest])) || Date.parse(data[oldest]) > Date.parse(data.observedAt)) throw Error();
    }
    return { ...Object.fromEntries(counts.map(key => [key, data[key]])) as Counts,
      observedAt: data.observedAt, billingOldestDueAt: data.billingOldestDueAt, exitOldestDueAt: data.exitOldestDueAt };
  } catch { throw Error("Monthly billing totals unavailable"); }
}
