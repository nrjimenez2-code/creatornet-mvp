import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

const monthlyReady = () => process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY === "true";
const fixedReady = () => process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY === "true";
export const membershipLedgerReady = () => monthlyReady() || fixedReady();

function seconds(value: unknown): number {
  if (!value || typeof value !== "object" || !("allowed" in value) || value.allowed !== true ||
      !("maxAgeSeconds" in value) || typeof value.maxAgeSeconds !== "number" ||
      !Number.isInteger(value.maxAgeSeconds) || value.maxAgeSeconds < 1 || value.maxAgeSeconds > 3600) return 0;
  return value.maxAgeSeconds;
}
/** Both timed purchase kinds keep legacy access_granted=false. Disabling their
 * readers therefore cannot turn a bounded service into permanent access. */
export async function membershipAccessSeconds(admin: SupabaseClient, purchaseId: string, buyerId: string): Promise<number> {
  const args = { p_purchase_id: purchaseId, p_buyer_id: buyerId };
  if (fixedReady()) {
    const fixed = await admin.rpc("read_fixed_service_entitlement_v1", args);
    if (fixed.error || !fixed.data || typeof fixed.data !== "object" ||
      typeof fixed.data.applicable !== "boolean") return 0;
    if (fixed.data.applicable || !monthlyReady()) return seconds(fixed.data);
  }
  const result = await admin.rpc("read_monthly_mentorship_entitlement_v1", args);
  return result.error ? 0 : seconds(result.data);
}
