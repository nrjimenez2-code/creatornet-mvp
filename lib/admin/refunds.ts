import "server-only";

import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import {
  calculateRefundAllocation,
  isRefundReasonCode,
  isRefundResponsibility,
  reasonMatchesResponsibility,
  type RefundAllocationPreview,
  type RefundReasonCode,
  type RefundResponsibility,
} from "@/lib/refundAllocation";
import type {
  RefundOperation,
  RefundOperationStore,
  RefundSourceContext,
} from "@/lib/admin/refund-store";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INTERNAL_NOTES = 2000;

export class RefundWorkflowError extends Error {
  readonly status: 400 | 404 | 409 | 422;

  constructor(status: 400 | 404 | 409 | 422, message: string) {
    super(message);
    this.name = "RefundWorkflowError";
    this.status = status;
  }
}

export interface RefundRequestInput {
  paymentFeeLedgerId: string;
  amountCents: number;
  reasonCode: RefundReasonCode;
  responsibility: RefundResponsibility;
  internalNotes: string | null;
  idempotencyKey: string;
  expectedRefundedBeforeCents?: number;
  expectedApplicationFeeRefundedBeforeCents?: number;
}

interface StripeRefundContext {
  chargeId: string;
  paymentIntentId: string;
  chargeAmountCents: number;
  chargeRefundedAmountCents: number;
  currency: string;
  applicationFeeId: string;
  applicationFeeAmountCents: number;
  applicationFeeRefundedCents: number;
  actualStripeProcessingFeeCents: number | null;
}

export interface AdminRefundPreview extends RefundAllocationPreview {
  paymentFeeLedgerId: string;
  currency: string;
  grossAmountCents: number;
  actualStripeProcessingFeeCents: number | null;
}

export interface RefundProcessResult {
  operation: RefundOperation;
  disposition: "completed" | "processing" | "needs_reconciliation" | "failed";
}

function stripeObjectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

function feeRefundForOperation(
  applicationFee: Stripe.ApplicationFee,
  operationId: string,
): Stripe.FeeRefund | null {
  return (
    applicationFee.refunds?.data.find(
      (refund) =>
        refund.metadata?.creatornet_refund_operation_id === operationId,
    ) ?? null
  );
}

function safeStripeError(error: unknown): string {
  const candidate =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : "Refund processing failed";
  return candidate
    .replace(/sk_(?:live|test)_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/rk_(?:live|test)_[A-Za-z0-9]+/g, "[redacted]")
    .slice(0, 500) || "Refund processing failed";
}

function validateRefundInput(input: RefundRequestInput): void {
  if (!UUID_PATTERN.test(input.paymentFeeLedgerId)) {
    throw new RefundWorkflowError(400, "Select a valid payment to refund.");
  }
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new RefundWorkflowError(400, "Enter a valid refund amount.");
  }
  if (!isRefundReasonCode(input.reasonCode)) {
    throw new RefundWorkflowError(400, "Select a refund reason.");
  }
  if (!isRefundResponsibility(input.responsibility)) {
    throw new RefundWorkflowError(400, "Select who is responsible for the refund.");
  }
  if (!reasonMatchesResponsibility(input.reasonCode, input.responsibility)) {
    throw new RefundWorkflowError(
      400,
      "The selected reason does not match the selected responsibility.",
    );
  }
  if (
    input.internalNotes !== null &&
    (typeof input.internalNotes !== "string" ||
      input.internalNotes.length > MAX_INTERNAL_NOTES)
  ) {
    throw new RefundWorkflowError(400, "Internal notes are too long.");
  }
  if (
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length < 8 ||
    input.idempotencyKey.length > 200
  ) {
    throw new RefundWorkflowError(400, "The refund request key is invalid.");
  }
}

async function retrieveStripeRefundContext(
  stripe: Stripe,
  source: RefundSourceContext,
): Promise<StripeRefundContext> {
  const ledger = source.ledger;
  let chargeId = ledger.stripeChargeId;
  if (!chargeId) {
    const paymentIntent = await stripe.paymentIntents.retrieve(
      ledger.stripePaymentIntentId,
      { expand: ["latest_charge"] },
    );
    chargeId = stripeObjectId(paymentIntent.latest_charge);
  }
  if (!chargeId) {
    throw new RefundWorkflowError(
      422,
      "This payment has no refundable Stripe charge attached.",
    );
  }

  const charge = await stripe.charges.retrieve(chargeId, {
    expand: ["application_fee", "balance_transaction"],
  });
  const paymentIntentId = stripeObjectId(charge.payment_intent);
  if (paymentIntentId !== ledger.stripePaymentIntentId) {
    throw new RefundWorkflowError(
      409,
      "The payment record does not match its Stripe charge.",
    );
  }
  if (charge.amount !== ledger.grossAmountCents) {
    throw new RefundWorkflowError(
      409,
      "The stored payment amount does not match Stripe. Review it before refunding.",
    );
  }
  if (charge.currency.toLowerCase() !== ledger.currency.toLowerCase()) {
    throw new RefundWorkflowError(
      409,
      "The stored payment currency does not match Stripe.",
    );
  }

  const applicationFeeId = stripeObjectId(charge.application_fee);
  if (!applicationFeeId) {
    throw new RefundWorkflowError(
      422,
      "This payment has no application fee that CreatorNet can allocate safely.",
    );
  }
  const applicationFee =
    typeof charge.application_fee === "object" && charge.application_fee
      ? charge.application_fee
      : await stripe.applicationFees.retrieve(applicationFeeId);
  if (applicationFee.amount !== ledger.totalCreatorDeductionCents) {
    throw new RefundWorkflowError(
      409,
      "The stored fee split does not match Stripe. Review it before refunding.",
    );
  }

  let actualStripeProcessingFeeCents = ledger.actualStripeFeeCents;
  if (charge.balance_transaction && typeof charge.balance_transaction === "object") {
    actualStripeProcessingFeeCents = charge.balance_transaction.fee;
  } else {
    const balanceTransactionId = stripeObjectId(charge.balance_transaction);
    if (balanceTransactionId) {
      const balanceTransaction = await stripe.balanceTransactions.retrieve(
        balanceTransactionId,
      );
      actualStripeProcessingFeeCents = balanceTransaction.fee;
    }
  }

  return {
    chargeId,
    paymentIntentId,
    chargeAmountCents: charge.amount,
    chargeRefundedAmountCents: charge.amount_refunded,
    currency: charge.currency.toLowerCase(),
    applicationFeeId,
    applicationFeeAmountCents: applicationFee.amount,
    applicationFeeRefundedCents: applicationFee.amount_refunded,
    actualStripeProcessingFeeCents,
  };
}

export async function previewAdminRefund(
  store: RefundOperationStore,
  stripe: Stripe,
  input: RefundRequestInput,
): Promise<AdminRefundPreview> {
  validateRefundInput(input);
  const source = await store.getSourceContext(input.paymentFeeLedgerId);
  if (!source.ledger.stripePaymentIntentId) {
    throw new RefundWorkflowError(422, "This payment is not linked to Stripe.");
  }
  if (source.ledger.status !== "paid" && source.ledger.status !== "refunded") {
    throw new RefundWorkflowError(422, "This payment is not refundable.");
  }

  const stripeContext = await retrieveStripeRefundContext(stripe, source);
  const refundedBeforeCents = Math.max(
    source.ledger.refundedAmountCents,
    source.cumulativeCustomerRefundTargetCents,
    stripeContext.chargeRefundedAmountCents,
  );
  const applicationFeeRefundedBeforeCents = Math.max(
    source.applicationFeeRefundTargetCents,
    stripeContext.applicationFeeRefundedCents,
  );

  let allocation: RefundAllocationPreview;
  try {
    allocation = calculateRefundAllocation({
      grossAmountCents: source.ledger.grossAmountCents,
      platformFeeCents: source.ledger.platformFeeCents,
      processingFeeCents: source.ledger.processingFeeCents,
      creatorNetCents: source.ledger.creatorNetCents,
      refundedBeforeCents,
      applicationFeeRefundedBeforeCents,
      requestedRefundAmountCents: input.amountCents,
      responsibility: input.responsibility,
    });
  } catch (error) {
    throw new RefundWorkflowError(
      422,
      error instanceof Error ? error.message : "The refund cannot be allocated safely.",
    );
  }

  return {
    ...allocation,
    paymentFeeLedgerId: source.ledger.id,
    currency: stripeContext.currency,
    grossAmountCents: stripeContext.chargeAmountCents,
    actualStripeProcessingFeeCents:
      stripeContext.actualStripeProcessingFeeCents,
  };
}

function publicOperationMatchesRequest(
  operation: RefundOperation,
  input: RefundRequestInput,
): boolean {
  return (
    operation.paymentFeeLedgerId === input.paymentFeeLedgerId &&
    operation.requestedRefundAmountCents === input.amountCents &&
    operation.reasonCode === input.reasonCode &&
    operation.responsibility === input.responsibility
  );
}

async function markNeedsReconciliation(
  store: RefundOperationStore,
  operation: RefundOperation,
  token: string,
  error: unknown,
  info: Record<string, unknown> = {},
): Promise<RefundOperation> {
  return store.updateClaimedOperation(operation.id, token, {
    status: "needs_reconciliation",
    last_error: safeStripeError(error),
    reconciliation_info: info,
    processing_token: null,
    processing_claimed_at: null,
  });
}

async function connectedBalanceState(
  store: RefundOperationStore,
  stripe: Stripe,
  operation: RefundOperation,
): Promise<{ negative: boolean | null; info: Record<string, unknown> }> {
  const connectedAccountId = await store.getCreatorStripeAccountId(
    operation.creatorId,
  );
  if (!connectedAccountId) {
    return {
      negative: null,
      info: { balance_check: "creator_connected_account_not_recorded" },
    };
  }
  try {
    const balance = await stripe.balance.retrieve(
      {},
      { stripeAccount: connectedAccountId },
    );
    const negative = [...balance.available, ...balance.pending].some(
      (entry) => entry.amount < 0,
    );
    return {
      negative,
      info: {
        balance_check: "completed",
        connected_account: connectedAccountId,
      },
    };
  } catch (error) {
    return {
      negative: null,
      info: {
        balance_check: "unavailable",
        balance_check_error: safeStripeError(error),
      },
    };
  }
}

/**
 * Resume a durable operation from its last confirmed Stripe step. Customer and
 * application-fee calls use separate stable idempotency keys. The database
 * claim serializes all operations for one ledger, preventing two cumulative
 * application-fee adjustments from racing each other.
 */
export async function processRefundOperation(
  store: RefundOperationStore,
  stripe: Stripe,
  operationId: string,
): Promise<RefundProcessResult> {
  const token = randomUUID();
  const claim = await store.claimOperation(operationId, token);
  const current = await store.getOperation(operationId);
  if (!current) throw new RefundWorkflowError(404, "Refund operation not found.");
  if (claim === "busy") return { operation: current, disposition: "processing" };
  if (claim === "completed") {
    return { operation: current, disposition: "completed" };
  }
  if (claim === "failed") return { operation: current, disposition: "failed" };
  if (claim === "missing") throw new RefundWorkflowError(404, "Refund operation not found.");

  let operation = current;
  try {
    let refund: Stripe.Refund;
    if (operation.stripeRefundId) {
      refund = await stripe.refunds.retrieve(operation.stripeRefundId);
    } else {
      refund = await stripe.refunds.create(
        {
          payment_intent: operation.stripePaymentIntentId,
          amount: operation.customerRefundAmountCents,
          reverse_transfer: true,
          refund_application_fee: false,
          ...(operation.reasonCode === "duplicate_charge"
            ? { reason: "duplicate" as const }
            : {}),
          metadata: {
            creatornet_refund_operation_id: operation.id,
            responsibility: operation.responsibility,
            reason_code: operation.reasonCode,
          },
        },
        { idempotencyKey: `creatornet:refund:${operation.id}:customer` },
      );
    }

    operation = await store.updateClaimedOperation(operation.id, token, {
      stripe_refund_id: refund.id,
      stripe_refund_status: refund.status ?? "unknown",
      status: "stripe_refund_created",
      last_error: null,
    });

    if (refund.status === "failed" || refund.status === "canceled") {
      operation = await store.updateClaimedOperation(operation.id, token, {
        status: "failed",
        last_error: `Stripe refund finished with status ${refund.status}`,
        processing_token: null,
        processing_claimed_at: null,
      });
      return { operation, disposition: "failed" };
    }
    if (refund.status !== "succeeded") {
      operation = await markNeedsReconciliation(
        store,
        operation,
        token,
        `Stripe refund is ${refund.status ?? "pending"}`,
        { customer_refund_status: refund.status ?? "unknown" },
      );
      return { operation, disposition: "needs_reconciliation" };
    }

    const applicationFee = await stripe.applicationFees.retrieve(
      operation.stripeApplicationFeeId,
    );
    // A later cumulative operation can legitimately have moved Stripe beyond
    // this older operation's target. In that case this operation already needs
    // no additional fee refund; never try to "undo" the later allocation.
    const feeRefundNeeded = Math.max(
      0,
      operation.applicationFeeRefundTargetCents - applicationFee.amount_refunded,
    );
    let feeRefundId = operation.stripeApplicationFeeRefundId;
    let feeRefundCreatedAmount = operation.stripeApplicationFeeRefundAmountCents;
    if (!feeRefundId && operation.applicationFeeRefundAmountCents > 0) {
      // If Stripe accepted the prior fee-refund request but the response was
      // lost before we persisted it, the application fee's embedded refund
      // list lets the retry recover the exact object created for this operation.
      const recoveredFeeRefund = feeRefundForOperation(applicationFee, operation.id);
      if (recoveredFeeRefund) {
        feeRefundId = recoveredFeeRefund.id;
        feeRefundCreatedAmount = recoveredFeeRefund.amount;
      }
    }
    if (feeRefundNeeded > 0) {
      const feeRefund = await stripe.applicationFees.createRefund(
        operation.stripeApplicationFeeId,
        {
          amount: feeRefundNeeded,
          metadata: {
            creatornet_refund_operation_id: operation.id,
            responsibility: operation.responsibility,
          },
        },
        {
          idempotencyKey:
            `creatornet:refund:${operation.id}:application-fee:` +
            operation.applicationFeeRefundTargetCents,
        },
      );
      feeRefundId = feeRefund.id;
      feeRefundCreatedAmount = feeRefund.amount;
    }

    operation = await store.updateClaimedOperation(operation.id, token, {
      ...(feeRefundId ? { stripe_application_fee_refund_id: feeRefundId } : {}),
      ...(feeRefundCreatedAmount !== null
        ? {
            stripe_application_fee_refund_amount_cents:
              feeRefundCreatedAmount,
          }
        : {}),
      status: "application_fee_adjusted",
      last_error: null,
    });

    const balanceState = await connectedBalanceState(store, stripe, operation);
    operation = await store.updateClaimedOperation(operation.id, token, {
      status: "completed",
      connected_balance_negative:
        balanceState.negative === null ? undefined : balanceState.negative,
      reconciliation_info: balanceState.info,
      last_error: null,
      processing_token: null,
      processing_claimed_at: null,
    });
    return { operation, disposition: "completed" };
  } catch (error) {
    try {
      operation = await markNeedsReconciliation(
        store,
        operation,
        token,
        error,
        {
          last_confirmed_status: operation.status,
          retry_safe: true,
        },
      );
    } catch (recordError) {
      console.error("[admin:refund] failed to record reconciliation state:", recordError);
      throw error;
    }
    return { operation, disposition: "needs_reconciliation" };
  }
}

export async function createAndProcessAdminRefund(
  store: RefundOperationStore,
  stripe: Stripe,
  initiatedBy: string,
  input: RefundRequestInput,
): Promise<RefundProcessResult> {
  validateRefundInput(input);
  const source = await store.getSourceContext(input.paymentFeeLedgerId);
  const stripeContext = await retrieveStripeRefundContext(stripe, source);
  const refundedBeforeCents = Math.max(
    source.ledger.refundedAmountCents,
    source.cumulativeCustomerRefundTargetCents,
    stripeContext.chargeRefundedAmountCents,
  );
  const applicationFeeRefundedBeforeCents = Math.max(
    source.applicationFeeRefundTargetCents,
    stripeContext.applicationFeeRefundedCents,
  );

  if (
    input.expectedRefundedBeforeCents !== undefined &&
    input.expectedRefundedBeforeCents !== refundedBeforeCents
  ) {
    throw new RefundWorkflowError(
      409,
      "This payment changed after the preview. Review the refund again.",
    );
  }
  if (
    input.expectedApplicationFeeRefundedBeforeCents !== undefined &&
    input.expectedApplicationFeeRefundedBeforeCents !==
      applicationFeeRefundedBeforeCents
  ) {
    throw new RefundWorkflowError(
      409,
      "This payment's fee allocation changed after the preview. Review it again.",
    );
  }

  const operation = await store.createOperation({
    operationId: randomUUID(),
    paymentFeeLedgerId: input.paymentFeeLedgerId,
    requestedRefundAmountCents: input.amountCents,
    reasonCode: input.reasonCode,
    responsibility: input.responsibility,
    internalNotes: input.internalNotes?.trim() || null,
    idempotencyKey: input.idempotencyKey,
    initiatedBy,
    stripeChargeId: stripeContext.chargeId,
    stripeApplicationFeeId: stripeContext.applicationFeeId,
    stripeRefundedAmountCents: stripeContext.chargeRefundedAmountCents,
    stripeApplicationFeeRefundedCents:
      stripeContext.applicationFeeRefundedCents,
    actualStripeProcessingFeeCents:
      stripeContext.actualStripeProcessingFeeCents,
  });
  if (!publicOperationMatchesRequest(operation, input)) {
    throw new RefundWorkflowError(
      409,
      "That refund request key was already used for different refund details.",
    );
  }
  return processRefundOperation(store, stripe, operation.id);
}

export function publicRefundOperation(operation: RefundOperation) {
  return {
    id: operation.id,
    status: operation.status,
    stripeRefundStatus: operation.stripeRefundStatus,
    customerRefundCents: operation.customerRefundAmountCents,
    creatorBalanceImpactCents: operation.creatorBalanceImpactCents,
    platformFeeRefundCents: operation.platformFeeRefundAmountCents,
    processingFeeAllocationCents: operation.processingFeeAllocationCents,
    responsibility: operation.responsibility,
    remainingRefundableCents: operation.remainingRefundableCents,
    connectedBalanceNegative: operation.connectedBalanceNegative,
    webhookConfirmed: operation.webhookConfirmedAt !== null,
  };
}
