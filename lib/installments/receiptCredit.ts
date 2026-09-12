import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { assertAgreementId, type ExactAgreementStore } from "./agreementStore";
import { inspectExactFirstInstallment } from "./firstReceipt";

export type ExactReceiptAudit = Readonly<{
  paymentNumber: number; chargeId: string; balanceTransactionId: string; actualStripeFeeCents: number;
}>;
export interface ExactReceiptCreditStore {
  bindPurchase(agreementId: string, purchaseId: string): Promise<void>;
  recordRefundEvidence(paymentIntentId: string, chargeId: string, gross: number, refunded: number): Promise<void>;
  credit(agreementId: string, audit: ExactReceiptAudit): Promise<boolean>;
  reconcileDispute(paymentIntentId: string): Promise<void>;
}

/** Uses existing refund-state persistence and its cumulative semantics. New
 * receipt credit is a separate RPC, never the old one-time earnings function. */
export function createExactReceiptCreditStore(admin: SupabaseClient): ExactReceiptCreditStore {
  async function rpc(name: string, params: Record<string, unknown>) {
    const { data, error } = await admin.rpc(name, params);
    if (error) throw new Error(`Exact receipt operation failed: ${name}`);
    return data as unknown;
  }
  return {
    async bindPurchase(agreementId, purchaseId) {
      assertAgreementId(agreementId); assertAgreementId(purchaseId);
      await rpc("bind_exact_installment_purchase", { p_agreement_id: agreementId, p_purchase_id: purchaseId });
    },
    async recordRefundEvidence(paymentIntentId, chargeId, gross, refunded) {
      const value = await rpc("record_payment_refund_state", { p_payment_intent_id: paymentIntentId,
        p_charge_id: chargeId, p_charge_amount_cents: gross, p_refunded_amount_cents: refunded });
      const cumulative = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
      if (typeof cumulative !== "number" || !Number.isSafeInteger(cumulative) || cumulative < refunded || cumulative > gross) {
        throw new Error("Invalid cumulative refund evidence response");
      }
    },
    async credit(agreementId, audit) {
      assertAgreementId(agreementId);
      const value = await rpc("credit_exact_installment_receipt", { p_agreement_id: agreementId,
        p_payment_number: audit.paymentNumber, p_charge_id: audit.chargeId,
        p_balance_transaction_id: audit.balanceTransactionId, p_actual_stripe_fee_cents: audit.actualStripeFeeCents });
      if (typeof value !== "boolean") throw new Error("Invalid exact receipt credit response");
      return value;
    },
    async reconcileDispute(paymentIntentId) {
      // 048 keeps the existing audit-only policy but serializes exact receipt
      // replays with dispute events. Never use the legacy read-then-PATCH mirror
      // to overwrite a newer exact observation or hide another open dispute.
      try { await rpc("reconcile_exact_installment_dispute_audit",{p_payment_intent_id:paymentIntentId}); }
      catch { throw new Error("Exact receipt dispute reconciliation failed"); }
    },
  };
}

/** Sandbox integration candidate, not imported by enabled routes. Requires a
 * separately seeded, correctly linked pending purchase; the binding RPC rejects
 * adoption of an existing paid/legacy purchase. This only reconciles a payment
 * already captured by Stripe. It cannot create/pay/refund/cancel any Stripe
 * object. Does NOT activate the monthly schedule or attach fulfillment links.
 * Do not enable Checkout until those lifecycle handlers are also accepted. */
export async function creditVerifiedFirstInstallmentSandbox(args: {
  agreementId: string; sessionId: string; purchaseId: string;
  store: ExactAgreementStore; creditStore: ExactReceiptCreditStore;
  stripe: Pick<Stripe, "checkout" | "paymentIntents" | "charges" | "balanceTransactions">;
  env: Record<string, string | undefined>;
  // A secondary event may locate a candidate agreement, never authorize a
  // different paid Checkout. Recheck both current identities before any write.
  expectedPayment?: Readonly<{ paymentIntentId: string; chargeId: string }>;
}): Promise<Readonly<{ credited: boolean; paymentNumber: 1 }>> {
  assertAgreementId(args.purchaseId);
  if (args.expectedPayment && (!/^pi_[A-Za-z0-9]+$/.test(args.expectedPayment.paymentIntentId) ||
      !/^ch_[A-Za-z0-9]+$/.test(args.expectedPayment.chargeId))) {
    throw new Error("Invalid expected exact first-payment identity");
  }
  const evidence = await inspectExactFirstInstallment(args);
  const { agreement, receipt, chargeId, balanceTransactionId, refundedAmountCents } = evidence;
  if (args.expectedPayment && (receipt.paymentIntentId !== args.expectedPayment.paymentIntentId ||
      chargeId !== args.expectedPayment.chargeId)) {
    throw new Error("Exact first-payment event identity mismatch");
  }
  // The recovery event must not race its dedicated refund/dispute handler into
  // delivery. Keep the original Checkout accounting semantics unchanged; this
  // secondary-event path requires a currently unrefunded, undisputed payment.
  if (args.expectedPayment && (refundedAmountCents !== 0 || evidence.disputed)) {
    throw new Error("Exact first-payment recovery requires review");
  }
  if (!balanceTransactionId || !/^txn_[A-Za-z0-9]+$/.test(balanceTransactionId)) {
    throw new Error("Exact first-payment balance transaction is not available");
  }
  const balance = await args.stripe.balanceTransactions.retrieve(balanceTransactionId);
  const source = typeof balance.source === "string" ? balance.source : balance.source?.id;
  if (balance.id !== balanceTransactionId || source !== chargeId || balance.type !== "charge" ||
      balance.currency !== "usd" || balance.amount !== receipt.amountCents ||
      !Number.isSafeInteger(balance.fee) || balance.fee < 0 || balance.fee > 99999999 ||
      balance.net !== balance.amount - balance.fee) {
    throw new Error("Exact first-payment balance transaction mismatch");
  }
  // Persist evidence before the atomic accounting RPC. A retry may repeat these
  // idempotent steps, but must never construct another payment or another credit.
  await args.store.recordFirstReceipt(agreement.id, receipt);
  await args.creditStore.bindPurchase(agreement.id, args.purchaseId);
  await args.creditStore.recordRefundEvidence(receipt.paymentIntentId, chargeId, receipt.amountCents, refundedAmountCents);
  const credited = await args.creditStore.credit(agreement.id, { paymentNumber: 1, chargeId,
    balanceTransactionId, actualStripeFeeCents: balance.fee });
  await args.creditStore.reconcileDispute(receipt.paymentIntentId);
  return Object.freeze({ credited, paymentNumber: 1 });
}
