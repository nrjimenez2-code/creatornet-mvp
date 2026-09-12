import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSafeBookingTarget } from "./bookingUrl";

/** #5: payment access uses the existing purchase/refund/fee ledger. The private
 * target is never copied to a public post, product, Stripe metadata, or list. */
export const paidCallsReady = (env: Record<string, string | undefined> = process.env) =>
  env.CREATOR_PAID_CALLS_SCHEMA_READY === "true" && env.CREATOR_PAID_CALLS_READY === "true";

export function validPaidCallTarget(value: unknown): value is string {
  return isSafeBookingTarget(value) && value.trim().startsWith("https://");
}

function objectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") return value.id;
  return null;
}

export type PaidCallAccess = {
  purchase_id: string; buyer_id: string; creator_id: string; product_id: string;
  session_id: string; payment_intent_id: string; amount_cents: number; currency: string;
  scheduling_url: string; stripe_charge_id: string; total_creator_deduction_cents: number;
};

export async function readPaidCallAccess(admin: SupabaseClient, purchaseId: string, buyerId: string): Promise<PaidCallAccess | null> {
  const { data, error } = await admin.rpc("read_paid_call_access_v1", { p_purchase_id: purchaseId, p_buyer_id: buyerId });
  if (error) throw Error("Paid-call confirmation is temporarily unavailable");
  if (data == null) return null;
  const row = data as PaidCallAccess;
  if (row.purchase_id !== purchaseId || row.buyer_id !== buyerId || !validPaidCallTarget(row.scheduling_url) ||
      !Number.isSafeInteger(row.amount_cents) || row.amount_cents < 50 || row.currency !== "usd" ||
      !row.session_id || !row.payment_intent_id || !row.stripe_charge_id) throw Error("Paid-call access requires review");
  return row;
}

/** Current provider evidence closes the window before a refund/dispute webhook
 * reaches the database. Setup, complete-but-unpaid, and another buyer never pass. */
export async function verifyPaidCallCapture(stripe: Stripe, row: PaidCallAccess): Promise<boolean> {
  const session = await stripe.checkout.sessions.retrieve(row.session_id);
  if (session.mode !== "payment" || session.status !== "complete" || session.payment_status !== "paid" ||
      session.subscription || session.amount_total !== row.amount_cents || session.currency !== row.currency ||
      objectId(session.payment_intent) !== row.payment_intent_id || session.metadata?.buyer_id !== row.buyer_id ||
      session.metadata?.creator_id !== row.creator_id || session.metadata?.product_id !== row.product_id ||
      session.metadata?.product_type !== "call") return false;
  const pi = await stripe.paymentIntents.retrieve(row.payment_intent_id, { expand: ["latest_charge"] });
  const charge = pi.latest_charge;
  return pi.status === "succeeded" && pi.amount_received === row.amount_cents && pi.currency === row.currency &&
    pi.application_fee_amount === row.total_creator_deduction_cents &&
    !!charge && typeof charge !== "string" && charge.id === row.stripe_charge_id && charge.paid && charge.captured &&
    !charge.disputed && !charge.refunded && charge.amount === row.amount_cents && charge.amount_refunded < charge.amount;
}
