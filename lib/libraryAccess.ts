import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { membershipAccessSeconds, membershipLedgerReady } from "@/lib/membershipAccess";

type Purchase = { id: string; buyer_id: string; status: string | null; access_granted: boolean | null };
export async function isLibraryPurchaseEligible(admin: SupabaseClient, purchase: Purchase, userId: string): Promise<boolean> {
  if (purchase.buyer_id !== userId) return false;
  if (purchase.access_granted === true && !["paid", "active", "complete"].includes(purchase.status ?? "")) return false;
  return membershipLedgerReady()
    ? await membershipAccessSeconds(admin, purchase.id, userId) > 0
    : purchase.access_granted === true;
}
