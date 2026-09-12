import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { applyRefundEarningsForPaymentIntent } from "@/lib/creatorEarnings";
import { ORDER_REFUNDABLE_STATUSES } from "@/lib/orderStatus";

export type PaymentRefundState = {
  paymentIntentId: string;
  chargeId: string;
  chargeAmountCents: number;
  refundedAmountCents: number;
};

function safeCents(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(parsed) && Number(parsed) >= 0 ? Number(parsed) : null;
}

/**
 * Atomically retain Stripe's cumulative refund state even when the business
 * rows have not been linked to the PaymentIntent yet. The database function
 * uses greatest(previous, incoming), making replayed/out-of-order totals safe.
 */
export async function recordPaymentRefundState(
  admin: SupabaseClient,
  state: PaymentRefundState
): Promise<PaymentRefundState> {
  const { data, error } = await admin.rpc("record_payment_refund_state", {
    p_payment_intent_id: state.paymentIntentId,
    p_charge_id: state.chargeId,
    p_charge_amount_cents: state.chargeAmountCents,
    p_refunded_amount_cents: state.refundedAmountCents,
  });
  if (error) {
    throw new Error(`refund state recording failed: ${error.message}`);
  }

  return {
    ...state,
    refundedAmountCents: safeCents(data) ?? state.refundedAmountCents,
  };
}

export async function getPaymentRefundState(
  admin: SupabaseClient,
  paymentIntentId: string | null | undefined
): Promise<PaymentRefundState | null> {
  if (!paymentIntentId) return null;
  const { data, error } = await admin
    .from("payment_refund_state")
    .select(
      "stripe_payment_intent_id, stripe_charge_id, charge_amount_cents, refunded_amount_cents"
    )
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();
  if (error) {
    throw new Error(`refund state lookup failed: ${error.message}`);
  }
  if (!data) return null;

  const row = data as Record<string, unknown>;
  const chargeAmountCents = safeCents(row.charge_amount_cents);
  const refundedAmountCents = safeCents(row.refunded_amount_cents);
  if (
    typeof row.stripe_payment_intent_id !== "string" ||
    typeof row.stripe_charge_id !== "string" ||
    chargeAmountCents === null ||
    refundedAmountCents === null
  ) {
    throw new Error(`refund state for ${paymentIntentId} is invalid`);
  }

  return {
    paymentIntentId: row.stripe_payment_intent_id,
    chargeId: row.stripe_charge_id,
    chargeAmountCents,
    refundedAmountCents,
  };
}

/** Apply a known cumulative refund to orders, access, earnings, and the ledger. */
export async function applyPaymentRefundState(
  admin: SupabaseClient,
  state: PaymentRefundState
): Promise<void> {
  const now = new Date().toISOString();
  const fullyRefunded =
    state.chargeAmountCents > 0 &&
    state.refundedAmountCents >= state.chargeAmountCents;

  const { data: matchingPurchase, error: purchaseLookupError } = await admin
    .from("purchases")
    .select("subscription_id")
    .eq("payment_intent_id", state.paymentIntentId)
    .maybeSingle();
  if (purchaseLookupError && !/0 rows|No rows/i.test(purchaseLookupError.message)) {
    throw new Error(`refund purchase lookup failed: ${purchaseLookupError.message}`);
  }

  // A purchases row represents the whole installment plan and its
  // payment_intent_id is updated for each paid invoice. Therefore an older
  // installment can only be classified reliably from its immutable ledger row.
  const { data: matchingLedger, error: ledgerLookupError } = await admin
    .from("payment_fee_ledger")
    .select("stripe_invoice_id")
    .eq("stripe_payment_intent_id", state.paymentIntentId)
    .maybeSingle();
  if (ledgerLookupError && !/0 rows|No rows/i.test(ledgerLookupError.message)) {
    throw new Error(`refund ledger lookup failed: ${ledgerLookupError.message}`);
  }
  const recurringInvoiceRefund = Boolean(
    matchingPurchase?.subscription_id || matchingLedger?.stripe_invoice_id
  );

  const orderPatch: Record<string, unknown> = {
    refunded_amount: state.refundedAmountCents,
    updated_at: now,
  };
  if (fullyRefunded) orderPatch.status = "refunded";

  const { error: orderError } = await admin
    .from("orders")
    .update(orderPatch)
    .eq("stripe_payment_intent_id", state.paymentIntentId)
    .in("status", ORDER_REFUNDABLE_STATUSES);
  if (orderError && !/column|does not exist/i.test(orderError.message)) {
    throw new Error(`refund order update failed: ${orderError.message}`);
  }

  // A fully refunded subscription charge is one installment, not the entire
  // plan. Its individual ledger row is reversed without revoking plan access.
  if (fullyRefunded && !recurringInvoiceRefund) {
    const { error: purchaseError } = await admin
      .from("purchases")
      .update({ status: "refunded", access_granted: false })
      .eq("payment_intent_id", state.paymentIntentId);
    if (purchaseError) {
      throw new Error(`refund purchase update failed: ${purchaseError.message}`);
    }
  }

  await applyRefundEarningsForPaymentIntent(
    admin,
    state.paymentIntentId,
    state.refundedAmountCents,
    fullyRefunded,
    true
  );
}

/** Reapply an earlier refund after a late payment/checkout event writes links. */
export async function reconcileKnownPaymentRefund(
  admin: SupabaseClient,
  paymentIntentId: string | null | undefined
): Promise<boolean> {
  const state = await getPaymentRefundState(admin, paymentIntentId);
  if (!state) return false;
  await applyPaymentRefundState(admin, state);
  return true;
}

/**
 * Confirm exact successful refunds only after their cumulative business state
 * has been applied. Modern charge.refunded events do not embed a refunds list.
 * Fetch the charge's Refund objects, including older pages, instead of assuming
 * that optional expansion is present. This changes markers, never money.
 */
export async function confirmAdminRefundWebhookDelivery(
  admin: SupabaseClient,
  stripe: Stripe,
  state: PaymentRefundState,
): Promise<void> {
  const { data, error: lookupError } = await admin
    .from("refund_operations")
    .select("id, stripe_refund_id, customer_refund_amount_cents, cumulative_customer_refund_target_cents")
    .eq("stripe_payment_intent_id", state.paymentIntentId)
    .is("webhook_confirmed_at", null);
  if (lookupError) {
    throw new Error(`admin refund confirmation lookup failed: ${lookupError.message}`);
  }
  const operations = ((data ?? []) as Record<string, unknown>[]).filter((row) => {
    const target = safeCents(row.cumulative_customer_refund_target_cents);
    return typeof row.id === "string" && target !== null &&
      target > 0 && target <= state.refundedAmountCents;
  });
  if (operations.length === 0) return;

  const refunds: Stripe.Refund[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page: Stripe.ApiList<Stripe.Refund> = await stripe.refunds.list({
      charge: state.chargeId,
      limit: 100,
      ...(cursor ? { starting_after: cursor } : {}),
    });
    refunds.push(...page.data);
    if (!page.has_more) break;
    cursor = page.data.at(-1)?.id;
    if (!cursor || seenCursors.has(cursor)) {
      throw new Error("Stripe refund pagination did not advance");
    }
    seenCursors.add(cursor);
  } while (cursor);

  const objectId = (value: string | { id: string } | null) =>
    typeof value === "string" ? value : value?.id;
  const now = new Date().toISOString();
  for (const operation of operations) {
    const refund = refunds.find((candidate) =>
      /^re_[a-zA-Z0-9]+$/.test(candidate.id) &&
      candidate.status === "succeeded" &&
      objectId(candidate.charge) === state.chargeId &&
      objectId(candidate.payment_intent) === state.paymentIntentId &&
      candidate.amount === safeCents(operation.customer_refund_amount_cents) &&
      (operation.stripe_refund_id
        ? candidate.id === operation.stripe_refund_id
        : candidate.metadata?.creatornet_refund_operation_id === operation.id),
    );
    if (!refund) continue;

    // Stripe may deliver before the request worker persists stripe_refund_id.
    // Exact operation metadata + payment + amount identify that early refund.
    // The guarded update tolerates the worker saving the SAME ID concurrently,
    // but never overwrites a different refund or an existing confirmation.
    const { error } = await admin
      .from("refund_operations")
      .update({ webhook_confirmed_at: now, updated_at: now })
      .eq("id", operation.id)
      .eq("stripe_payment_intent_id", state.paymentIntentId)
      .eq("customer_refund_amount_cents", refund.amount)
      .is("webhook_confirmed_at", null)
      .or(`stripe_refund_id.is.null,stripe_refund_id.eq.${refund.id}`);
    if (error) {
      throw new Error(`admin refund webhook confirmation failed: ${error.message}`);
    }
  }
}
