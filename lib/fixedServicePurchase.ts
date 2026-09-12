import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "./stripeClient";
import { FIXED_SERVICE_VERSION } from "./fixedServiceTerms";

/** Complete the existing service contract after the ordinary ledger/credit path.
 * Checkout uses automatic card capture, so the successful charge's timestamp
 * is the capture anchor. Never use the session creation time or the current time.
 * Previously accepted purchases remain fulfillable when new sales are paused. */
export async function fulfillFixedServicePurchase(
  admin: SupabaseClient, purchaseId: string, paymentIntentId: string | null,
  metadata: Stripe.Metadata | null | undefined,
) {
  if (!metadata?.fixed_service_version) return;
  if (metadata.fixed_service_version !== FIXED_SERVICE_VERSION || !metadata.purchase_consent_id ||
      !metadata.checkout_attempt_key || !paymentIntentId) throw Error("Fixed service payment binding is missing");
  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  const charge = typeof pi.latest_charge === "string"
    ? await stripe.charges.retrieve(pi.latest_charge) : pi.latest_charge;
  if (pi.id !== paymentIntentId || pi.status !== "succeeded" || pi.capture_method !== "automatic" ||
      !charge || charge.payment_intent !== pi.id || charge.status !== "succeeded" || !charge.paid || !charge.captured ||
      charge.livemode !== pi.livemode || charge.amount_captured !== pi.amount || pi.amount_received !== pi.amount ||
      charge.amount !== pi.amount || charge.currency !== pi.currency || charge.refunded || charge.amount_refunded !== 0 ||
      charge.disputed || !Number.isSafeInteger(charge.created) || charge.created < 1 || charge.created > Date.now() / 1000 ||
      ["fixed_service_version", "purchase_consent_id", "checkout_attempt_key", "order_id", "product_id", "creator_id", "buyer_id"]
        .some(key => !metadata[key] || pi.metadata[key] !== metadata[key])) {
    throw Error("Verified fixed service capture required");
  }
  const result = await admin.rpc("bind_fixed_service_one_time_v1", {
    p_purchase_id: purchaseId, p_consent_id: metadata.purchase_consent_id,
    p_attempt_key: metadata.checkout_attempt_key, p_payment_intent_id: pi.id,
    p_charge_id: charge.id, p_captured_at: charge.created, p_amount_cents: pi.amount, p_currency: pi.currency,
  });
  if (result.error || result.data !== true) throw Error("Fixed service capture could not be bound safely");
}
