import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  RefundReasonCode,
  RefundResponsibility,
} from "@/lib/refundAllocation";

export type RefundOperationStatus =
  | "pending"
  | "stripe_refund_created"
  | "application_fee_adjusted"
  | "completed"
  | "needs_reconciliation"
  | "failed";

export interface RefundLedgerSource {
  id: string;
  creatorId: string;
  purchaseId: string | null;
  orderId: string | null;
  bookingPaymentId: string | null;
  stripePaymentIntentId: string;
  stripeChargeId: string | null;
  grossAmountCents: number;
  platformFeeCents: number;
  processingFeeCents: number;
  totalCreatorDeductionCents: number;
  creatorNetCents: number;
  actualStripeFeeCents: number | null;
  refundedAmountCents: number;
  currency: string;
  status: string;
}

export interface RefundSourceContext {
  ledger: RefundLedgerSource;
  cumulativeCustomerRefundTargetCents: number;
  applicationFeeRefundTargetCents: number;
}

export interface RefundOperation {
  id: string;
  paymentFeeLedgerId: string;
  creatorId: string;
  stripePaymentIntentId: string;
  stripeChargeId: string;
  stripeApplicationFeeId: string;
  stripeRefundId: string | null;
  stripeApplicationFeeRefundId: string | null;
  requestedRefundAmountCents: number;
  customerRefundAmountCents: number;
  currency: string;
  reasonCode: RefundReasonCode;
  responsibility: RefundResponsibility;
  grossAmountCents: number;
  platformFeeCents: number;
  processingFeeCents: number;
  creatorNetCents: number;
  actualStripeProcessingFeeCents: number | null;
  refundedBeforeCents: number;
  cumulativeCustomerRefundTargetCents: number;
  remainingRefundableCents: number;
  creatorEarningsReversalCents: number;
  creatorBalanceImpactCents: number;
  platformFeeRefundAmountCents: number;
  processingFeeAllocationCents: number;
  allocationRoundingCents: number;
  applicationFeeRefundedBeforeCents: number;
  applicationFeeRefundAmountCents: number;
  applicationFeeRefundTargetCents: number;
  stripeApplicationFeeRefundAmountCents: number | null;
  idempotencyKey: string;
  initiatedBy: string;
  internalNotes: string | null;
  status: RefundOperationStatus;
  stripeRefundStatus: string | null;
  connectedBalanceNegative: boolean | null;
  lastError: string | null;
  reconciliationInfo: Record<string, unknown>;
  attemptCount: number;
  webhookConfirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRefundOperationInput {
  operationId: string;
  paymentFeeLedgerId: string;
  requestedRefundAmountCents: number;
  reasonCode: RefundReasonCode;
  responsibility: RefundResponsibility;
  internalNotes: string | null;
  idempotencyKey: string;
  initiatedBy: string;
  stripeChargeId: string;
  stripeApplicationFeeId: string;
  stripeRefundedAmountCents: number;
  stripeApplicationFeeRefundedCents: number;
  actualStripeProcessingFeeCents: number | null;
}

export type RefundOperationPatch = Partial<{
  stripe_charge_id: string;
  stripe_application_fee_id: string;
  stripe_refund_id: string;
  stripe_application_fee_refund_id: string;
  stripe_application_fee_refund_amount_cents: number;
  actual_stripe_processing_fee_cents: number;
  status: RefundOperationStatus;
  stripe_refund_status: string;
  connected_balance_negative: boolean;
  last_error: string | null;
  reconciliation_info: Record<string, unknown>;
  processing_token: string | null;
  processing_claimed_at: string | null;
  updated_at: string;
}>;

export type RefundClaimResult =
  | "claimed"
  | "busy"
  | "completed"
  | "failed"
  | "missing";

export interface RefundOperationStore {
  getSourceContext(ledgerId: string): Promise<RefundSourceContext>;
  createOperation(input: CreateRefundOperationInput): Promise<RefundOperation>;
  getOperation(operationId: string): Promise<RefundOperation | null>;
  claimOperation(operationId: string, token: string): Promise<RefundClaimResult>;
  updateClaimedOperation(
    operationId: string,
    token: string,
    patch: RefundOperationPatch,
  ): Promise<RefundOperation>;
  getCreatorStripeAccountId(creatorId: string): Promise<string | null>;
}

function cents(value: unknown, label: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  const parsed = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is not a safe integer`);
  return Number(parsed);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${label} is missing`);
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function operationFromRow(value: unknown): RefundOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Refund operation row is invalid");
  }
  const row = value as Record<string, unknown>;
  return {
    id: stringValue(row.id, "refund operation id"),
    paymentFeeLedgerId: stringValue(row.payment_fee_ledger_id, "payment ledger id"),
    creatorId: stringValue(row.creator_id, "creator id"),
    stripePaymentIntentId: stringValue(
      row.stripe_payment_intent_id,
      "Stripe PaymentIntent id",
    ),
    stripeChargeId: stringValue(row.stripe_charge_id, "Stripe charge id"),
    stripeApplicationFeeId: stringValue(
      row.stripe_application_fee_id,
      "Stripe application fee id",
    ),
    stripeRefundId: nullableString(row.stripe_refund_id),
    stripeApplicationFeeRefundId: nullableString(
      row.stripe_application_fee_refund_id,
    ),
    requestedRefundAmountCents: cents(
      row.requested_refund_amount_cents,
      "requested refund",
    )!,
    customerRefundAmountCents: cents(
      row.customer_refund_amount_cents,
      "customer refund",
    )!,
    currency: stringValue(row.currency, "currency"),
    reasonCode: stringValue(row.reason_code, "reason code") as RefundReasonCode,
    responsibility: stringValue(
      row.responsibility,
      "responsibility",
    ) as RefundResponsibility,
    grossAmountCents: cents(row.gross_amount_cents, "gross amount")!,
    platformFeeCents: cents(row.platform_fee_cents, "platform fee")!,
    processingFeeCents: cents(row.processing_fee_cents, "processing fee")!,
    creatorNetCents: cents(row.creator_net_cents, "creator net")!,
    actualStripeProcessingFeeCents: cents(
      row.actual_stripe_processing_fee_cents,
      "actual Stripe fee",
      true,
    ),
    refundedBeforeCents: cents(row.refunded_before_cents, "refunded before")!,
    cumulativeCustomerRefundTargetCents: cents(
      row.cumulative_customer_refund_target_cents,
      "customer refund target",
    )!,
    remainingRefundableCents: cents(
      row.remaining_refundable_cents,
      "remaining refundable",
    )!,
    creatorEarningsReversalCents: cents(
      row.creator_earnings_reversal_cents,
      "creator earnings reversal",
    )!,
    creatorBalanceImpactCents: cents(
      row.creator_balance_impact_cents,
      "creator balance impact",
    )!,
    platformFeeRefundAmountCents: cents(
      row.platform_fee_refund_amount_cents,
      "platform fee refund",
    )!,
    processingFeeAllocationCents: cents(
      row.processing_fee_allocation_cents,
      "processing allocation",
    )!,
    allocationRoundingCents: cents(row.allocation_rounding_cents, "allocation rounding")!,
    applicationFeeRefundedBeforeCents: cents(
      row.application_fee_refunded_before_cents,
      "application fee refunded before",
    )!,
    applicationFeeRefundAmountCents: cents(
      row.application_fee_refund_amount_cents,
      "application fee refund amount",
    )!,
    applicationFeeRefundTargetCents: cents(
      row.application_fee_refund_target_cents,
      "application fee refund target",
    )!,
    stripeApplicationFeeRefundAmountCents: cents(
      row.stripe_application_fee_refund_amount_cents,
      "Stripe application fee refund amount",
      true,
    ),
    idempotencyKey: stringValue(row.idempotency_key, "idempotency key"),
    initiatedBy: stringValue(row.initiated_by, "initiating administrator"),
    internalNotes: nullableString(row.internal_notes),
    status: stringValue(row.status, "refund status") as RefundOperationStatus,
    stripeRefundStatus: nullableString(row.stripe_refund_status),
    connectedBalanceNegative:
      typeof row.connected_balance_negative === "boolean"
        ? row.connected_balance_negative
        : null,
    lastError: nullableString(row.last_error),
    reconciliationInfo:
      row.reconciliation_info && typeof row.reconciliation_info === "object"
        ? (row.reconciliation_info as Record<string, unknown>)
        : {},
    attemptCount: cents(row.attempt_count, "attempt count")!,
    webhookConfirmedAt: nullableString(row.webhook_confirmed_at),
    createdAt: stringValue(row.created_at, "created timestamp"),
    updatedAt: stringValue(row.updated_at, "updated timestamp"),
  };
}

function ledgerFromRow(value: unknown): RefundLedgerSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Payment fee ledger row is invalid");
  }
  const row = value as Record<string, unknown>;
  return {
    id: stringValue(row.id, "payment ledger id"),
    creatorId: stringValue(row.creator_id, "creator id"),
    purchaseId: nullableString(row.purchase_id),
    orderId: nullableString(row.order_id),
    bookingPaymentId: nullableString(row.booking_payment_id),
    stripePaymentIntentId: stringValue(
      row.stripe_payment_intent_id,
      "Stripe PaymentIntent id",
    ),
    stripeChargeId: nullableString(row.stripe_charge_id),
    grossAmountCents: cents(row.gross_amount_cents, "gross amount")!,
    platformFeeCents: cents(row.platform_fee_cents, "platform fee")!,
    processingFeeCents: cents(row.processing_fee_cents, "processing fee")!,
    totalCreatorDeductionCents: cents(
      row.total_creator_deduction_cents,
      "total creator deduction",
    )!,
    creatorNetCents: cents(row.creator_net_cents, "creator net")!,
    actualStripeFeeCents: cents(row.actual_stripe_fee_cents, "actual Stripe fee", true),
    refundedAmountCents: cents(row.refunded_amount_cents, "refunded amount")!,
    currency: stringValue(row.currency, "currency").toLowerCase(),
    status: stringValue(row.status, "ledger status"),
  };
}

export function createSupabaseRefundStore(admin: SupabaseClient): RefundOperationStore {
  return {
    async getSourceContext(ledgerId) {
      const [ledgerResult, operationResult] = await Promise.all([
        admin
          .from("payment_fee_ledger")
          .select(
            "id, creator_id, purchase_id, order_id, booking_payment_id, stripe_payment_intent_id, stripe_charge_id, gross_amount_cents, platform_fee_cents, processing_fee_cents, total_creator_deduction_cents, creator_net_cents, actual_stripe_fee_cents, refunded_amount_cents, currency, status",
          )
          .eq("id", ledgerId)
          .maybeSingle(),
        admin
          .from("refund_operations")
          .select(
            "cumulative_customer_refund_target_cents, application_fee_refund_target_cents, status",
          )
          .eq("payment_fee_ledger_id", ledgerId)
          .neq("status", "failed"),
      ]);
      if (ledgerResult.error) {
        throw new Error(`Refund source lookup failed: ${ledgerResult.error.message}`);
      }
      if (!ledgerResult.data) throw new Error("Refundable payment not found");
      if (operationResult.error) {
        throw new Error(`Refund reservation lookup failed: ${operationResult.error.message}`);
      }

      const ledger = ledgerFromRow(ledgerResult.data);
      let customerTarget = ledger.refundedAmountCents;
      let applicationFeeTarget = 0;
      for (const raw of operationResult.data ?? []) {
        const row = raw as Record<string, unknown>;
        customerTarget = Math.max(
          customerTarget,
          cents(
            row.cumulative_customer_refund_target_cents,
            "reserved customer refund",
          )!,
        );
        applicationFeeTarget = Math.max(
          applicationFeeTarget,
          cents(
            row.application_fee_refund_target_cents,
            "reserved application fee refund",
          )!,
        );
      }
      return {
        ledger,
        cumulativeCustomerRefundTargetCents: customerTarget,
        applicationFeeRefundTargetCents: applicationFeeTarget,
      };
    },

    async createOperation(input) {
      const { data, error } = await admin.rpc("create_refund_operation", {
        p_operation_id: input.operationId,
        p_payment_fee_ledger_id: input.paymentFeeLedgerId,
        p_requested_refund_amount_cents: input.requestedRefundAmountCents,
        p_reason_code: input.reasonCode,
        p_responsibility: input.responsibility,
        p_internal_notes: input.internalNotes,
        p_idempotency_key: input.idempotencyKey,
        p_initiated_by: input.initiatedBy,
        p_stripe_charge_id: input.stripeChargeId,
        p_stripe_application_fee_id: input.stripeApplicationFeeId,
        p_stripe_refunded_amount_cents: input.stripeRefundedAmountCents,
        p_stripe_application_fee_refunded_cents:
          input.stripeApplicationFeeRefundedCents,
        p_actual_stripe_processing_fee_cents:
          input.actualStripeProcessingFeeCents,
      });
      if (error) throw new Error(`Refund reservation failed: ${error.message}`);
      return operationFromRow(data);
    },

    async getOperation(operationId) {
      const { data, error } = await admin
        .from("refund_operations")
        .select("*")
        .eq("id", operationId)
        .maybeSingle();
      if (error) throw new Error(`Refund operation lookup failed: ${error.message}`);
      return data ? operationFromRow(data) : null;
    },

    async claimOperation(operationId, token) {
      const { data, error } = await admin.rpc("claim_refund_operation", {
        p_operation_id: operationId,
        p_processing_token: token,
        p_lease_seconds: 300,
      });
      if (error) throw new Error(`Refund operation claim failed: ${error.message}`);
      if (
        data !== "claimed" &&
        data !== "busy" &&
        data !== "completed" &&
        data !== "failed" &&
        data !== "missing"
      ) {
        throw new Error("Refund operation claim returned an invalid state");
      }
      return data;
    },

    async updateClaimedOperation(operationId, token, patch) {
      const { data, error } = await admin
        .from("refund_operations")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", operationId)
        .eq("processing_token", token)
        .select("*")
        .maybeSingle();
      if (error) throw new Error(`Refund operation update failed: ${error.message}`);
      if (!data) throw new Error("Refund operation processing lease was lost");
      return operationFromRow(data);
    },

    async getCreatorStripeAccountId(creatorId) {
      const { data, error } = await admin
        .from("profiles")
        .select("stripe_account_id")
        .eq("id", creatorId)
        .maybeSingle<{ stripe_account_id: string | null }>();
      if (error) throw new Error(`Creator Stripe account lookup failed: ${error.message}`);
      return data?.stripe_account_id ?? null;
    },
  };
}

export const refundOperationFromRowForTests = operationFromRow;
