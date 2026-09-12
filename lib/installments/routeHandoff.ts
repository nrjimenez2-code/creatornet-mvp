import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createExactAgreementStore } from "./agreementStore";
import { createExactReceiptCreditStore } from "./receiptCredit";
import { createExactActivationStore } from "./activation";
import { createExactInvoiceStore } from "./invoiceStore";
import { createExactPurchaseLifecycleStore } from "./purchaseLifecycle";
import { createExactRefundEventStore } from "./refundEvent";
import { createExactLifecycleStore } from "./lifecycleEvents";
import { createExactPaymentRecoveryStore } from "./paymentRecovery";
import { createExactPaymentRetryStore } from "./paymentRetryStore";
import { createExactEventBindingStore, dispatchExactInstallmentEventSandbox } from "./eventBridge";
import { handoffContextInstallmentEvent } from "./contextEventRoute";

/** Called ONLY after the canonical route's signature verification and event
 * claim. Return true bypasses ALL legacy payment handlers. Errors release the
 * existing event claim and ask Stripe to retry; they are not successful ACKs.
 *
 * New collection is default-off, invoice.created only, and further restricted
 * inside the bridge to persisted, explicitly allowlisted staging agreements.
 * Existing collection flags alone cannot enable HTTP payment. Receipt events
 * never receive new debit permission, even with the new gate configured.
 */
export async function handoffExactInstallmentWebhook(args: {
  event: Stripe.Event; admin: SupabaseClient; stripe: Stripe;
  env: Record<string, string | undefined>;
}): Promise<boolean> {
  if (await handoffContextInstallmentEvent(args)) return true;
  const result = await dispatchExactInstallmentEventSandbox({ verifiedEvent: args.event,
    bindings: createExactEventBindingStore(args.admin), store: createExactAgreementStore(args.admin),
    creditStore: createExactReceiptCreditStore(args.admin), activationStore: createExactActivationStore(args.admin),
    invoiceStore: createExactInvoiceStore(args.admin), lifecycleStore: createExactPurchaseLifecycleStore(args.admin),
    refundStore: createExactRefundEventStore(args.admin),
    lifecycleEventStore: createExactLifecycleStore(args.admin),
    recoveryStore: createExactPaymentRecoveryStore(args.admin),
    retryStore: args.env.CREATOR_EXACT_INSTALLMENTS_RETRY_READY === "true" ? createExactPaymentRetryStore(args.admin) : undefined,
    stripe: args.stripe, env: { ...args.env, CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT:
      args.event.type === "invoice.created" && args.env.CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_READY === "true" &&
      args.env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT === "true" ? "true" : "false" } });
  if (!result.handled) return false;
  if (!["first_credited_held", "first_already_activated", "bootstrap_zero", "separate_receipt_handler",
    "credited", "already_credited", "refund_reconciled", "lifecycle_observed", "lifecycle_review_recorded", "payment_recovery_recorded"].includes(result.disposition)) {
    throw new Error("Exact installment processing is held; retry or review required");
  }
  // lifecycle_review_recorded acknowledges a DURABLE audit/hold only. It does
  // not mean the dispute/cancellation is resolved or that a payment completed.
  // payment_recovery_recorded likewise acknowledges a durable classified hold,
  // not a customer verification, successful retry, debt waiver or automatic unhold.
  return true;
}
