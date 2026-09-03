import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripeClient";
import type { CreatorFeeBreakdown } from "@/lib/money";
import { reconcileKnownPaymentDispute } from "@/lib/paymentDisputes";

export type StripeFeeDetails = {
  chargeId: string;
  balanceTransactionId: string;
  actualStripeFeeCents: number;
  applicationFeeAmountCents: number | null;
};

export type PaymentFeeLedgerInput = {
  breakdown: CreatorFeeBreakdown;
  currency: string;
  creatorId: string;
  purchaseId?: string | null;
  orderId?: string | null;
  bookingPaymentId?: string | null;
  checkoutSessionId?: string | null;
  paymentIntentId?: string | null;
  invoiceId?: string | null;
  stripeFee?: StripeFeeDetails | null;
  status?: "pending" | "paid" | "failed" | "refunded";
};

/**
 * Creator-funded processing is real only if Stripe captured the exact combined
 * application fee that CreatorNet calculated. Call this before access, earnings,
 * or paid-state mutations; a mismatch must remain visible and retryable.
 */
export function assertConfiguredApplicationFee(
  label: string,
  breakdown: CreatorFeeBreakdown,
  stripeFee: StripeFeeDetails | null
): void {
  if (
    breakdown.processingFeeEnabled &&
    stripeFee?.applicationFeeAmountCents !== breakdown.totalCreatorDeductionCents
  ) {
    throw new Error(
      `${label} application fee mismatch: expected ${breakdown.totalCreatorDeductionCents}, received ${stripeFee?.applicationFeeAmountCents ?? "none"}`
    );
  }
}

function ledgerPayload(input: PaymentFeeLedgerInput, includeStatus = true) {
  const actual = input.stripeFee?.actualStripeFeeCents ?? null;
  return {
    creator_id: input.creatorId,
    // Events arrive out of order and carry different subsets. Omitted linkage
    // fields must not erase values a previous event already recorded.
    ...(input.purchaseId ? { purchase_id: input.purchaseId } : {}),
    ...(input.orderId ? { order_id: input.orderId } : {}),
    ...(input.bookingPaymentId ? { booking_payment_id: input.bookingPaymentId } : {}),
    ...(input.checkoutSessionId
      ? { stripe_checkout_session_id: input.checkoutSessionId }
      : {}),
    ...(input.paymentIntentId
      ? { stripe_payment_intent_id: input.paymentIntentId }
      : {}),
    ...(input.invoiceId ? { stripe_invoice_id: input.invoiceId } : {}),
    ...(input.stripeFee
      ? {
          stripe_charge_id: input.stripeFee.chargeId,
          stripe_balance_transaction_id: input.stripeFee.balanceTransactionId,
        }
      : {}),
    gross_amount_cents: input.breakdown.grossAmountCents,
    platform_fee_cents: input.breakdown.platformFeeCents,
    processing_fee_cents: input.breakdown.processingFeeCents,
    total_creator_deduction_cents: input.breakdown.totalCreatorDeductionCents,
    creator_net_cents: input.breakdown.creatorNetCents,
    ...(actual === null
      ? {}
      : {
          actual_stripe_fee_cents: actual,
          processing_fee_variance_cents: input.breakdown.processingFeeCents - actual,
        }),
    currency: input.currency.toLowerCase(),
    fee_schedule_version: input.breakdown.feeScheduleVersion,
    ...(includeStatus ? { status: input.status ?? "paid" } : {}),
    updated_at: new Date().toISOString(),
  };
}

async function reconcileDisputeAfterLedgerWrite(
  admin: SupabaseClient,
  paymentIntentId: string | null | undefined,
  required: boolean
) {
  try {
    await reconcileKnownPaymentDispute(admin, paymentIntentId);
  } catch (error: unknown) {
    console.error(
      "[fees] dispute reconciliation failed:",
      error instanceof Error ? error.message : error
    );
    if (required) throw error;
  }
}

/**
 * Record one captured Stripe payment without changing creator earnings.
 * Existing one-time purchases continue to use credit_purchase_earnings;
 * subscription invoices explicitly opt into the ledger credit RPC below.
 */
export async function recordPaymentFeeLedger(
  admin: SupabaseClient,
  input: PaymentFeeLedgerInput,
  required = false
): Promise<string | null> {
  const lookup = input.paymentIntentId
    ? { column: "stripe_payment_intent_id", value: input.paymentIntentId }
    : input.invoiceId
      ? { column: "stripe_invoice_id", value: input.invoiceId }
      : input.checkoutSessionId
        ? { column: "stripe_checkout_session_id", value: input.checkoutSessionId }
        : null;

  if (!lookup) {
    if (required) throw new Error("A Stripe payment identifier is required for the fee ledger.");
    return null;
  }

  const { data: existing, error: findError } = await admin
    .from("payment_fee_ledger")
    .select("id, status")
    .eq(lookup.column, lookup.value)
    .maybeSingle();

  if (findError) {
    console.error("[fees] ledger lookup failed:", findError.message);
    if (required) throw new Error(`Payment fee ledger lookup failed: ${findError.message}`);
    return null;
  }

  const payload = ledgerPayload(input);
  if (existing?.id) {
    // A late succeeded/completed event must never move a refunded ledger row
    // back to paid. Refund RPCs own status transitions after insertion.
    const updatePayload = ledgerPayload(input, false);
    const { error } = await admin
      .from("payment_fee_ledger")
      .update(updatePayload)
      .eq("id", existing.id);
    if (error) {
      console.error("[fees] ledger update failed:", error.message);
      if (required) throw new Error(`Payment fee ledger update failed: ${error.message}`);
      return null;
    }
    await reconcileDisputeAfterLedgerWrite(
      admin,
      input.paymentIntentId,
      required
    );
    return existing.id as string;
  }

  const { data: inserted, error } = await admin
    .from("payment_fee_ledger")
    .insert({ ...payload, created_at: new Date().toISOString() })
    .select("id")
    .maybeSingle();

  if (error) {
    // A checkout and PaymentIntent event can race. Re-read the row protected by
    // the unique Stripe identifiers instead of creating a second earning.
    if (/duplicate|unique/i.test(error.message)) {
      const { data: raced, error: raceLookupError } = await admin
        .from("payment_fee_ledger")
        .select("id")
        .eq(lookup.column, lookup.value)
        .maybeSingle();
      if (raceLookupError) {
        console.error("[fees] ledger race lookup failed:", raceLookupError.message);
        if (required) {
          throw new Error(`Payment fee ledger race lookup failed: ${raceLookupError.message}`);
        }
      }
      const racedId = (raced?.id as string | undefined) ?? null;
      if (racedId) {
        // Preserve the identifiers supplied by the losing event. Without this,
        // a Checkout/PaymentIntent race can permanently omit the session or
        // invoice link even though the duplicate charge itself was prevented.
        const { error: raceUpdateError } = await admin
          .from("payment_fee_ledger")
          .update(ledgerPayload(input, false))
          .eq("id", racedId);
        if (raceUpdateError) {
          console.error("[fees] ledger race update failed:", raceUpdateError.message);
          if (required) {
            throw new Error(`Payment fee ledger race update failed: ${raceUpdateError.message}`);
          }
        }
      }
      if (!racedId && required) {
        throw new Error("Payment fee ledger duplicate could not be resolved.");
      }
      await reconcileDisputeAfterLedgerWrite(
        admin,
        input.paymentIntentId,
        required
      );
      return racedId;
    }
    console.error("[fees] ledger insert failed:", error.message);
    if (required) throw new Error(`Payment fee ledger insert failed: ${error.message}`);
    return null;
  }

  const insertedId = (inserted?.id as string | undefined) ?? null;
  if (!insertedId && required) {
    throw new Error("Payment fee ledger insert returned no id.");
  }
  if (insertedId) {
    await reconcileDisputeAfterLedgerWrite(
      admin,
      input.paymentIntentId,
      required
    );
  }
  return insertedId;
}

/** Exactly-once internal earnings credit for recurring invoice payments. */
export async function creditLedgerEarnings(
  admin: SupabaseClient,
  ledgerId: string | null | undefined,
  required = false
): Promise<boolean> {
  if (!ledgerId) {
    if (required) throw new Error("Payment fee ledger id is required for earnings credit.");
    return false;
  }
  const { data, error } = await admin.rpc("credit_payment_fee_ledger_earnings", {
    p_ledger_id: ledgerId,
  });
  if (error) {
    console.error("[fees] recurring earnings credit failed:", error.message);
    if (required) throw new Error(`Recurring earnings credit failed: ${error.message}`);
    return false;
  }
  return data === true;
}

/**
 * Retrieve Stripe's final platform balance-transaction fee. This is audit data
 * only; it never retroactively changes a creator's configured deduction.
 */
export async function retrieveStripeFeeDetails(
  paymentIntentId: string | null | undefined,
  required = false
): Promise<StripeFeeDetails | null> {
  if (!paymentIntentId) {
    if (required) throw new Error("PaymentIntent id is required for Stripe fee reconciliation.");
    return null;
  }

  try {
    const stripe = getStripe();
    // Test doubles from older suites may intentionally expose only the method
    // being exercised. Treat that the same as temporarily unavailable audit data.
    if (!stripe.paymentIntents?.retrieve) {
      if (required) throw new Error("Stripe PaymentIntent retrieval is unavailable.");
      return null;
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge.balance_transaction"],
    });
    let charge = paymentIntent.latest_charge;
    if (!charge) {
      if (required) throw new Error(`PaymentIntent ${paymentIntentId} has no latest charge.`);
      return null;
    }
    if (typeof charge === "string") {
      charge = await stripe.charges.retrieve(charge, {
        expand: ["balance_transaction"],
      });
    }

    const balanceTransaction = (charge as Stripe.Charge).balance_transaction;
    if (!balanceTransaction) {
      if (required) {
        throw new Error(`PaymentIntent ${paymentIntentId} has no balance transaction yet.`);
      }
      return null;
    }
    const expanded =
      typeof balanceTransaction === "string"
        ? await stripe.balanceTransactions.retrieve(balanceTransaction)
        : balanceTransaction;

    return {
      chargeId: (charge as Stripe.Charge).id,
      balanceTransactionId: expanded.id,
      actualStripeFeeCents: expanded.fee,
      applicationFeeAmountCents: paymentIntent.application_fee_amount,
    };
  } catch (error: unknown) {
    if (required) throw error;
    console.warn(
      "[fees] Stripe fee reconciliation unavailable:",
      error instanceof Error ? error.message : error
    );
    return null;
  }
}
