import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export type PaymentDisputeState = {
  disputeId: string;
  paymentIntentId: string;
  chargeId: string;
  disputedAmountCents: number;
  currency: string;
  status: string;
  eventCreated: number;
};

function nonnegativeSafeInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(parsed) && Number(parsed) >= 0 ? Number(parsed) : null;
}

function disputeStateFromRow(row: Record<string, unknown>): PaymentDisputeState | null {
  const disputedAmountCents = nonnegativeSafeInteger(row.disputed_amount_cents);
  const eventCreated = nonnegativeSafeInteger(row.stripe_event_created);
  if (
    typeof row.stripe_dispute_id !== "string" ||
    typeof row.stripe_payment_intent_id !== "string" ||
    typeof row.stripe_charge_id !== "string" ||
    typeof row.currency !== "string" ||
    typeof row.status !== "string" ||
    disputedAmountCents === null ||
    eventCreated === null
  ) {
    return null;
  }
  return {
    disputeId: row.stripe_dispute_id,
    paymentIntentId: row.stripe_payment_intent_id,
    chargeId: row.stripe_charge_id,
    disputedAmountCents,
    currency: row.currency,
    status: row.status,
    eventCreated,
  };
}

/** Persist the newest Stripe view of a dispute without changing creator earnings. */
export async function recordPaymentDisputeState(
  admin: SupabaseClient,
  state: PaymentDisputeState
): Promise<boolean> {
  const { data, error } = await admin.rpc("record_payment_dispute_state", {
    p_dispute_id: state.disputeId,
    p_payment_intent_id: state.paymentIntentId,
    p_charge_id: state.chargeId,
    p_disputed_amount_cents: state.disputedAmountCents,
    p_currency: state.currency,
    p_status: state.status,
    p_event_created: state.eventCreated,
  });
  if (error) {
    throw new Error(`dispute state recording failed: ${error.message}`);
  }
  return data === true;
}

export async function getPaymentDisputeState(
  admin: SupabaseClient,
  paymentIntentId: string | null | undefined
): Promise<PaymentDisputeState | null> {
  if (!paymentIntentId) return null;
  const { data, error } = await admin
    .from("payment_dispute_state")
    .select(
      "stripe_dispute_id, stripe_payment_intent_id, stripe_charge_id, disputed_amount_cents, currency, status, stripe_event_created"
    )
    .eq("stripe_payment_intent_id", paymentIntentId)
    .order("stripe_event_created", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`dispute state lookup failed: ${error.message}`);
  }
  if (!data) return null;
  const state = disputeStateFromRow(data as Record<string, unknown>);
  if (!state) throw new Error(`dispute state for ${paymentIntentId} is invalid`);
  return state;
}

/** Mirror dispute audit state onto the payment ledger; never debit a creator. */
export async function applyPaymentDisputeState(
  admin: SupabaseClient,
  state: PaymentDisputeState
): Promise<boolean> {
  const { data, error } = await admin
    .from("payment_fee_ledger")
    .update({
      stripe_dispute_id: state.disputeId,
      disputed_amount_cents: state.disputedAmountCents,
      dispute_status: state.status,
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_payment_intent_id", state.paymentIntentId)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`dispute ledger update failed: ${error.message}`);
  }
  return Boolean(data?.id);
}

/** Reapply an earlier dispute after a late payment event creates the ledger row. */
export async function reconcileKnownPaymentDispute(
  admin: SupabaseClient,
  paymentIntentId: string | null | undefined
): Promise<boolean> {
  const state = await getPaymentDisputeState(admin, paymentIntentId);
  if (!state) return false;
  return applyPaymentDisputeState(admin, state);
}
