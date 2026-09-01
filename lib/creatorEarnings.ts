// lib/creatorEarnings.ts — paying the creator, exactly once per purchase.
//
// Two separate code paths can finish a sale: the Stripe webhook, and
// /api/confirm-purchase (which the browser calls from /success). Until now only
// the webhook credited the creator — and the webhook has never fired for a
// checkout in production, so `profiles.total_earnings_cents` was 0 for every
// creator on the platform.
//
// Simply calling the old bump helper from both paths would have been worse than
// the bug: it was a read-modify-write with no idempotency, so a sale that ran
// through both paths would have paid the creator TWICE. Migration 018 replaces
// it with an atomic claim in the database (see credit_purchase_earnings), and
// this module is the only way the app is meant to reach it.
//
// Both functions are service-role only. Never call them with a browser client.

import type { SupabaseClient } from "@supabase/supabase-js";
import { splitFee } from "./money";

/**
 * Credit the creator for a purchase, at most once ever.
 *
 * Safe to call from every path that can finish a sale, and safe to call again
 * on a retry — the database decides who wins.
 *
 * @param admin service-role client
 * @param purchaseId the purchases row that was just paid
 * @param grossAmountCents what the buyer paid; the platform fee is taken off
 *   here via the one shared implementation in lib/money.ts
 * @returns true only if THIS call performed the credit
 */
export async function creditPurchaseEarnings(
  admin: SupabaseClient,
  purchaseId: string | null | undefined,
  grossAmountCents: number | null | undefined
): Promise<boolean> {
  if (!purchaseId) return false;

  const { creatorCents } = splitFee(grossAmountCents ?? 0);

  const { data, error } = await admin.rpc("credit_purchase_earnings", {
    p_purchase_id: purchaseId,
    p_creator_amount_cents: creatorCents,
  });

  if (error) {
    // Never fail the buyer's delivery over bookkeeping — they have paid and
    // must get their file. This is loud so it can be reconciled by hand.
    console.error(
      "[earnings] FAILED to credit creator for purchase",
      purchaseId,
      "-- creator is UNPAID for this sale:",
      error.message
    );
    return false;
  }

  if (data === true) {
    console.log("[earnings] credited", creatorCents, "cents for purchase", purchaseId);
  }
  return data === true;
}

/**
 * Give back earnings for a refunded purchase.
 *
 * Reverses the exact amount that was credited, rather than recomputing it, so a
 * later change to the platform fee can never make a refund the wrong size.
 *
 * @returns true only if THIS call performed the reversal
 */
export async function reversePurchaseEarnings(
  admin: SupabaseClient,
  purchaseId: string | null | undefined
): Promise<boolean> {
  if (!purchaseId) return false;

  const { data, error } = await admin.rpc("reverse_purchase_earnings", {
    p_purchase_id: purchaseId,
  });

  if (error) {
    console.error(
      "[earnings] FAILED to reverse earnings for refunded purchase",
      purchaseId,
      "-- creator is still credited for a refunded sale:",
      error.message
    );
    return false;
  }
  return data === true;
}

/**
 * Reverse every purchase attached to a refunded payment intent.
 *
 * The refund path only knows the payment intent, so the rows have to be looked
 * up first. Reversal is idempotent, so a replayed charge.refunded is harmless.
 */
export async function reverseEarningsForPaymentIntent(
  admin: SupabaseClient,
  paymentIntentId: string | null | undefined
): Promise<number> {
  if (!paymentIntentId) return 0;

  const { data, error } = await admin
    .from("purchases")
    .select("id")
    .eq("payment_intent_id", paymentIntentId)
    .not("earnings_credited_at", "is", null);

  if (error) {
    console.error("[earnings] could not look up purchases to reverse:", error.message);
    return 0;
  }

  let reversed = 0;
  for (const row of (data ?? []) as Array<{ id: string }>) {
    if (await reversePurchaseEarnings(admin, row.id)) reversed += 1;
  }
  return reversed;
}
