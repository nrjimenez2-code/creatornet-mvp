import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripeClient";
import { retrieveStripeFeeDetails } from "@/lib/paymentFeeLedger";
import { reconcileKnownPaymentRefund } from "@/lib/paymentRefunds";
import { reconcileKnownPaymentDispute } from "@/lib/paymentDisputes";
import { TIP_COLUMNS, TIP_METADATA_VERSION, tipMetadata, type TipRow } from "@/lib/tips";
import { reconcileKnownTipDisputeRecovery } from "@/lib/tipDisputes";

function id(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

async function loadTip(admin: SupabaseClient, tipId: string): Promise<TipRow> {
  const { data, error } = await admin.from("tips").select(TIP_COLUMNS).eq("id", tipId).maybeSingle();
  if (error || !data) throw new Error(`Tip ${tipId} could not be loaded.`);
  return data as unknown as TipRow;
}

function validateMetadata(tip: TipRow, metadata: Stripe.Metadata | null | undefined) {
  if (metadata?.payment_kind !== "video_tip" ||
      metadata?.creatornet_payment_version !== TIP_METADATA_VERSION ||
      metadata?.tip_id !== tip.id || metadata?.post_id !== tip.post_id ||
      metadata?.creator_id !== tip.creator_id || metadata?.tipper_id !== tip.tipper_id ||
      metadata?.checkout_terms_fingerprint !== tip.terms_fingerprint) {
    throw new Error(`Tip ${tip.id} metadata differs from its frozen terms.`);
  }
  const expected = tipMetadata(tip);
  for (const [key, value] of Object.entries(expected)) {
    if (metadata[key] !== value) {
      throw new Error(`Tip ${tip.id} fee metadata differs from its frozen terms.`);
    }
  }
}

function expectedLiveMode(): boolean {
  const mode = /^(?:sk|rk)_(test|live)_/.exec(process.env.STRIPE_SECRET_KEY || "")?.[1];
  if (!mode) throw new Error("Stripe mode is not configured for tip verification.");
  return mode === "live";
}

export async function finalizeTipPayment(
  admin: SupabaseClient,
  tipId: string,
  sessionId?: string | null,
): Promise<void> {
  const stripe = getStripe();
  const tip = await loadTip(admin, tipId);
  const expectedSessionId = sessionId || tip.stripe_checkout_session_id;
  if (!expectedSessionId) throw new Error(`Tip ${tip.id} has no Checkout Session.`);
  const session = await stripe.checkout.sessions.retrieve(expectedSessionId);
  validateMetadata(tip, session.metadata);
  if (session.livemode !== expectedLiveMode() || session.client_reference_id !== tip.id ||
      session.mode !== "payment" || session.payment_status !== "paid" ||
      session.amount_total !== Number(tip.gross_amount_cents) || session.currency !== tip.currency) {
    throw new Error(`Tip ${tip.id} Checkout Session is not valid paid evidence.`);
  }
  const paymentIntentId = id(session.payment_intent);
  if (!paymentIntentId) throw new Error(`Tip ${tip.id} has no PaymentIntent.`);
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
  validateMetadata(tip, pi.metadata);
  if (pi.livemode !== session.livemode || pi.status !== "succeeded" ||
      pi.amount !== Number(tip.gross_amount_cents) ||
      pi.currency !== tip.currency || pi.application_fee_amount !== Number(tip.total_creator_deduction_cents) ||
      id(pi.transfer_data?.destination) !== tip.stripe_destination_account_id) {
    throw new Error(`Tip ${tip.id} PaymentIntent differs from its frozen terms.`);
  }
  const stripeFee = await retrieveStripeFeeDetails(pi.id);
  if (stripeFee && stripeFee.applicationFeeAmountCents !== Number(tip.total_creator_deduction_cents)) {
    throw new Error(`Tip ${tip.id} application fee differs from its frozen terms.`);
  }
  const chargeId = id(pi.latest_charge);
  if (!chargeId || stripeFee && stripeFee.chargeId !== chargeId) {
    throw new Error(`Tip ${tip.id} charge linkage differs from its PaymentIntent.`);
  }
  const charge = await stripe.charges.retrieve(chargeId);
  if (charge.livemode !== session.livemode || id(charge.payment_intent) !== pi.id ||
      charge.amount !== Number(tip.gross_amount_cents) || charge.currency !== tip.currency ||
      (charge.application_fee_amount != null && charge.application_fee_amount !== Number(tip.total_creator_deduction_cents))) {
    throw new Error(`Tip ${tip.id} charge differs from its frozen terms.`);
  }
  const { data, error } = await admin.rpc("finalize_video_tip", {
    p_tip_id: tip.id, p_session_id: session.id, p_payment_intent_id: pi.id,
    p_charge_id: chargeId, p_balance_transaction_id: stripeFee?.balanceTransactionId ?? null,
    p_actual_stripe_fee_cents: stripeFee?.actualStripeFeeCents ?? null,
  });
  if (error) throw new Error(`Tip finalization failed: ${error.message}`);
  void data;
  await reconcileKnownPaymentRefund(admin, pi.id);
  await reconcileKnownPaymentDispute(admin, pi.id);
  await reconcileKnownTipDisputeRecovery(admin, stripe, pi.id);
}

export async function updateTipFromCheckoutEvent(
  admin: SupabaseClient,
  session: Stripe.Checkout.Session,
  eventType: string,
): Promise<boolean> {
  const tipId = session.metadata?.tip_id;
  if (session.metadata?.payment_kind !== "video_tip" || !tipId) return false;
  const tip = await loadTip(admin, tipId);
  validateMetadata(tip, session.metadata);
  if (session.client_reference_id !== tip.id ||
      (tip.stripe_checkout_session_id && tip.stripe_checkout_session_id !== session.id)) {
    throw new Error(`Tip ${tip.id} Checkout event linkage differs.`);
  }
  if (session.status === "open" && eventType !== "checkout.session.expired") {
    throw new Error(`Tip ${tip.id} Checkout Session is still open.`);
  }
  if (eventType === "checkout.session.async_payment_failed") {
    const { error } = await admin.from("tips").update({
      status: "failed", failure_code: "async_payment_failed", failed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", tipId).in("status", ["creating", "open", "processing", "failed"]);
    if (error) throw error;
    return true;
  }
  if (eventType === "checkout.session.expired") {
    const { error } = await admin.from("tips").update({
      status: "canceled", canceled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", tipId).in("status", ["creating", "open"]);
    if (error) throw error;
    return true;
  }
  if (session.payment_status === "paid") await finalizeTipPayment(admin, tipId, session.id);
  else {
    const { error } = await admin.from("tips").update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", tipId).in("status", ["creating", "open", "processing"]);
    if (error) throw error;
  }
  return true;
}

export async function updateTipFromPaymentIntentEvent(
  admin: SupabaseClient,
  pi: Stripe.PaymentIntent,
  succeeded: boolean,
): Promise<boolean> {
  const tipId = pi.metadata?.tip_id;
  if (pi.metadata?.payment_kind !== "video_tip" || !tipId) return false;
  const tip = await loadTip(admin, tipId);
  validateMetadata(tip, pi.metadata);
  if (pi.amount !== Number(tip.gross_amount_cents) || pi.currency !== tip.currency ||
      id(pi.transfer_data?.destination) !== tip.stripe_destination_account_id ||
      pi.application_fee_amount !== Number(tip.total_creator_deduction_cents)) {
    throw new Error(`Tip ${tip.id} PaymentIntent event differs from frozen terms.`);
  }
  if (succeeded) await finalizeTipPayment(admin, tipId);
  else {
    const code = pi.last_payment_error?.code || "payment_failed";
    const { error } = await admin.from("tips").update({
      status: "failed", failure_code: String(code).slice(0, 80), failed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", tipId).in("status", ["creating", "open", "processing", "failed"]);
    if (error) throw error;
  }
  return true;
}
