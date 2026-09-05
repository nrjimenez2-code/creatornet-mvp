import type {
  RefundOperation,
  RefundOperationPatch,
  RefundOperationStore,
} from "@/lib/admin/refund-store";
import { processRefundOperation } from "@/lib/admin/refunds";

function operation(overrides: Partial<RefundOperation> = {}): RefundOperation {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    paymentFeeLedgerId: "22222222-2222-4222-8222-222222222222",
    creatorId: "33333333-3333-4333-8333-333333333333",
    stripePaymentIntentId: "pi_refund",
    stripeChargeId: "ch_refund",
    stripeApplicationFeeId: "fee_refund",
    stripeRefundId: null,
    stripeApplicationFeeRefundId: null,
    requestedRefundAmountCents: 10_000,
    customerRefundAmountCents: 10_000,
    currency: "usd",
    reasonCode: "creator_non_delivery",
    responsibility: "creator",
    grossAmountCents: 10_000,
    platformFeeCents: 1_200,
    processingFeeCents: 320,
    creatorNetCents: 8_480,
    actualStripeProcessingFeeCents: 320,
    refundedBeforeCents: 0,
    cumulativeCustomerRefundTargetCents: 10_000,
    remainingRefundableCents: 0,
    creatorEarningsReversalCents: 8_480,
    creatorBalanceImpactCents: 8_800,
    platformFeeRefundAmountCents: 1_200,
    processingFeeAllocationCents: 320,
    allocationRoundingCents: 0,
    applicationFeeRefundedBeforeCents: 0,
    applicationFeeRefundAmountCents: 1_200,
    applicationFeeRefundTargetCents: 1_200,
    stripeApplicationFeeRefundAmountCents: null,
    idempotencyKey: "browser-refund-key",
    initiatedBy: "44444444-4444-4444-8444-444444444444",
    internalNotes: null,
    status: "pending",
    stripeRefundStatus: null,
    connectedBalanceNegative: null,
    lastError: null,
    reconciliationInfo: {},
    attemptCount: 0,
    webhookConfirmedAt: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

function applyPatch(current: RefundOperation, patch: RefundOperationPatch): RefundOperation {
  return {
    ...current,
    ...(patch.stripe_refund_id !== undefined
      ? { stripeRefundId: patch.stripe_refund_id }
      : {}),
    ...(patch.stripe_application_fee_refund_id !== undefined
      ? { stripeApplicationFeeRefundId: patch.stripe_application_fee_refund_id }
      : {}),
    ...(patch.stripe_application_fee_refund_amount_cents !== undefined
      ? {
          stripeApplicationFeeRefundAmountCents:
            patch.stripe_application_fee_refund_amount_cents,
        }
      : {}),
    ...(patch.actual_stripe_processing_fee_cents !== undefined
      ? { actualStripeProcessingFeeCents: patch.actual_stripe_processing_fee_cents }
      : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.stripe_refund_status !== undefined
      ? { stripeRefundStatus: patch.stripe_refund_status }
      : {}),
    ...(patch.connected_balance_negative !== undefined
      ? { connectedBalanceNegative: patch.connected_balance_negative }
      : {}),
    ...(patch.last_error !== undefined ? { lastError: patch.last_error } : {}),
    ...(patch.reconciliation_info !== undefined
      ? { reconciliationInfo: patch.reconciliation_info }
      : {}),
    updatedAt: new Date().toISOString(),
  };
}

function fakeStore(initial: RefundOperation) {
  let current = initial;
  const store: RefundOperationStore = {
    getSourceContext: jest.fn(),
    createOperation: jest.fn(),
    getOperation: jest.fn(async () => current),
    claimOperation: jest.fn(async () => "claimed"),
    updateClaimedOperation: jest.fn(async (_id, _token, patch) => {
      current = applyPatch(current, patch);
      return current;
    }),
    getCreatorStripeAccountId: jest.fn(async () => "acct_creator"),
  };
  return { store, current: () => current };
}

function fakeStripe(options?: {
  feeRefundFailure?: Error;
  applicationFeeRefunded?: number;
  recoveredFeeRefund?: boolean;
  connectedBalance?: number;
}) {
  const createFeeRefund = jest.fn();
  if (options?.feeRefundFailure) {
    createFeeRefund
      .mockRejectedValueOnce(options.feeRefundFailure)
      .mockResolvedValue({ id: "fr_retry", amount: 1_200 });
  } else {
    createFeeRefund.mockResolvedValue({ id: "fr_created", amount: 1_200 });
  }
  return {
    refunds: {
      create: jest.fn(async () => ({ id: "re_customer", status: "succeeded" })),
      retrieve: jest.fn(async () => ({ id: "re_customer", status: "succeeded" })),
    },
    applicationFees: {
      retrieve: jest.fn(async () => ({
        id: "fee_refund",
        amount: 1_520,
        amount_refunded: options?.applicationFeeRefunded ?? 0,
        refunds: {
          data: options?.recoveredFeeRefund
            ? [
                {
                  id: "fr_recovered",
                  amount: 1_200,
                  metadata: {
                    creatornet_refund_operation_id:
                      "11111111-1111-4111-8111-111111111111",
                  },
                },
              ]
            : [],
        },
      })),
      createRefund: createFeeRefund,
    },
    balance: {
      retrieve: jest.fn(async () => ({
        available: [{ amount: options?.connectedBalance ?? 100 }],
        pending: [],
      })),
    },
  };
}

describe("durable refund processing", () => {
  test("creates the customer refund and separate application-fee refund", async () => {
    const state = fakeStore(operation());
    const stripe = fakeStripe();
    const result = await processRefundOperation(
      state.store,
      stripe as never,
      state.current().id,
    );

    expect(result.disposition).toBe("completed");
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: "pi_refund",
        amount: 10_000,
        reverse_transfer: true,
        refund_application_fee: false,
      }),
      { idempotencyKey: "creatornet:refund:11111111-1111-4111-8111-111111111111:customer" },
    );
    expect(stripe.applicationFees.createRefund).toHaveBeenCalledWith(
      "fee_refund",
      expect.objectContaining({ amount: 1_200 }),
      expect.objectContaining({
        idempotencyKey:
          "creatornet:refund:11111111-1111-4111-8111-111111111111:application-fee:1200",
      }),
    );
  });

  test("a fee-refund failure is retryable without a second customer refund", async () => {
    const state = fakeStore(operation());
    const stripe = fakeStripe({ feeRefundFailure: new Error("temporary failure") });

    const first = await processRefundOperation(
      state.store,
      stripe as never,
      state.current().id,
    );
    expect(first.disposition).toBe("needs_reconciliation");
    expect(state.current().stripeRefundId).toBe("re_customer");

    const second = await processRefundOperation(
      state.store,
      stripe as never,
      state.current().id,
    );
    expect(second.disposition).toBe("completed");
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(stripe.refunds.retrieve).toHaveBeenCalledWith("re_customer");
    expect(stripe.applicationFees.createRefund).toHaveBeenCalledTimes(2);
  });

  test("an already-reached cumulative application-fee target is not refunded twice", async () => {
    const state = fakeStore(operation());
    const stripe = fakeStripe({ applicationFeeRefunded: 1_200 });
    const result = await processRefundOperation(
      state.store,
      stripe as never,
      state.current().id,
    );
    expect(result.disposition).toBe("completed");
    expect(stripe.applicationFees.createRefund).not.toHaveBeenCalled();
  });

  test("a lost fee-refund response recovers the exact Stripe object on retry", async () => {
    const state = fakeStore(operation({
      stripeRefundId: "re_customer",
      status: "needs_reconciliation",
    }));
    const stripe = fakeStripe({
      applicationFeeRefunded: 1_200,
      recoveredFeeRefund: true,
    });

    const result = await processRefundOperation(
      state.store,
      stripe as never,
      state.current().id,
    );

    expect(result.disposition).toBe("completed");
    expect(result.operation.stripeApplicationFeeRefundId).toBe("fr_recovered");
    expect(result.operation.stripeApplicationFeeRefundAmountCents).toBe(1_200);
    expect(stripe.applicationFees.createRefund).not.toHaveBeenCalled();
  });

  test("a connected account negative balance is recorded, never debited", async () => {
    const state = fakeStore(operation());
    const stripe = fakeStripe({ connectedBalance: -500 });
    const result = await processRefundOperation(
      state.store,
      stripe as never,
      state.current().id,
    );
    expect(result.operation.connectedBalanceNegative).toBe(true);
    expect(stripe).not.toHaveProperty("paymentMethods");
  });

  test("pending and definitively failed Stripe refunds do not adjust the fee", async () => {
    for (const refundStatus of ["pending", "failed"] as const) {
      const state = fakeStore(operation());
      const stripe = fakeStripe();
      stripe.refunds.create.mockResolvedValueOnce({
        id: `re_${refundStatus}`,
        status: refundStatus,
      });
      const result = await processRefundOperation(
        state.store,
        stripe as never,
        state.current().id,
      );
      expect(result.disposition).toBe(
        refundStatus === "failed" ? "failed" : "needs_reconciliation",
      );
      expect(stripe.applicationFees.createRefund).not.toHaveBeenCalled();
    }
  });
});
