import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripeClient";

/**
 * Stop admitting payment on every still-open attempt in the selected scope.
 * Stripe remains authoritative if a payment won the race; a later success
 * event may still finalize a locally canceled attempt for correct accounting.
 */
export async function expireOpenTipSessions(
  admin: SupabaseClient,
  scope: { postId?: string; creatorId?: string },
): Promise<void> {
  if (!scope.postId && !scope.creatorId) throw new Error("Tip expiry scope is required.");
  const stripe = getStripe();
  let afterId: string | null = null;
  for (;;) {
    let query = admin.from("tips").select("id,stripe_checkout_session_id")
      .in("status", ["creating", "open"]);
    if (scope.postId) query = query.eq("post_id", scope.postId);
    if (scope.creatorId) query = query.eq("creator_id", scope.creatorId);
    if (afterId) query = query.gt("id", afterId);
    const attempts = await query.order("id", { ascending: true }).limit(100);
    if (attempts.error) throw new Error(`Open tip lookup failed: ${attempts.error.message}`);
    const rows = attempts.data ?? [];
    for (const attempt of rows) {
      let expired = !attempt.stripe_checkout_session_id;
      if (attempt.stripe_checkout_session_id) {
        try {
          await stripe.checkout.sessions.expire(attempt.stripe_checkout_session_id);
          expired = true;
        } catch {
          // The Session may already be paid, expired, or asynchronously processing.
        }
      }
      if (!expired) continue;
      const { error } = await admin.from("tips").update({
        status: "canceled", canceled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", attempt.id).in("status", ["creating", "open"]);
      if (error) throw new Error(`Tip attempt cancellation failed: ${error.message}`);
    }
    if (rows.length < 100) break;
    afterId = rows[rows.length - 1].id;
  }
}
