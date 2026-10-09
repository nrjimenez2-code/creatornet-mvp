import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { membershipAccessSeconds, membershipLedgerReady } from "@/lib/membershipAccess";
import { getPaymentDisputeState } from "@/lib/paymentDisputes";

type Purchase = { id: string; buyer_id: string; status: string | null; access_granted: boolean | null; payment_intent_id?: string | null };
export async function isLibraryPurchaseEligible(admin: SupabaseClient, purchase: Purchase, userId: string): Promise<boolean> {
  if (purchase.buyer_id !== userId) return false;
  if (purchase.access_granted === true && !["paid", "active", "complete"].includes(purchase.status ?? "")) return false;
  const dispute = await getPaymentDisputeState(admin, purchase.payment_intent_id);
  if (dispute && !["won", "warning_closed"].includes(dispute.status)) return false;
  return membershipLedgerReady()
    ? await membershipAccessSeconds(admin, purchase.id, userId) > 0
    : purchase.access_granted === true;
}
