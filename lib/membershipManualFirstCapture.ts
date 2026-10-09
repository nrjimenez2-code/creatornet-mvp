import "server-only";
import type Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import { assertMembershipId } from "./membershipAgreement";
import { membershipMetadata, type MembershipRecord } from "./membershipCheckout";
import { creatorFeeMetadata } from "./money";
import { validateExactPaymentContext } from "./installments/paymentContext";
import { inspectServerPaymentIntent, type ServerPaymentContract } from "./serverPaymentConfirmation";
import { inspectPaymentCaptureEvidence } from "./paymentCaptureEvidence";

const check: (value: unknown, message?: string) => asserts value = (value, message) => {
  if (!value) throw Error(message ?? "Monthly manual first capture requires review");
};

/** Provider evidence for the original selected first payment. The caller must
 * independently read the frozen selection, bootstrap journal, bound intent and
 * latest recorded confirmation before invoking this pure inspector. This
 * function cannot dispatch a payment or credit a receipt. */
export function inspectMembershipManualFirstCapture(args: {
  agreement: MembershipRecord;
  contract: ServerPaymentContract;
  contextEvidence: unknown;
  subscriptionId: string;
  binding: { paymentIntentId: string; firstDispatchAt: number };
  confirmationOperationId: string;
  nowSeconds: number;
  data: { paymentIntent: Stripe.PaymentIntent; charge: Stripe.Charge;
    balance: Stripe.BalanceTransaction; paymentMethod: Stripe.PaymentMethod };
}) {
  const { agreement: a, contract: c } = args;
  assertMembershipId(args.confirmationOperationId);
  check(c.kind === "monthly_first" && c.attemptId !== a.id && c.buyerId === a.buyer_id &&
    c.creatorId === a.creator_id && c.productId === a.product_id &&
    c.termsFingerprint === a.fingerprint && c.customerId !== null &&
    /^cus_[A-Za-z0-9]+$/.test(c.customerId) &&
    /^sub_[A-Za-z0-9]+$/.test(args.subscriptionId) &&
    c.destinationId === a.terms.destinationId && c.amountCents === a.monthly_price_cents &&
    a.stripe_checkout_session_id === null &&
    (a.stripe_customer_id === null || a.stripe_customer_id === c.customerId) &&
    (a.stripe_subscription_id === null || a.stripe_subscription_id === args.subscriptionId),
    "Monthly manual first source differs");
  const acceptedAt = Math.floor(Date.parse(a.accepted_at) / 1000);
  const fees = a.terms.firstMonthFees;
  const exact = { version: "exact-payment-context-v1" as const,
    mode: a.terms.paymentContext.mode, platformAccountId: a.terms.paymentContext.stripeAccountId,
    supabaseProjectRef: a.terms.paymentContext.supabaseProjectRef,
    siteOrigin: a.terms.paymentContext.siteOrigin };
  check(isDeepStrictEqual(c.context, validateExactPaymentContext(exact, args.contextEvidence)) &&
    c.acceptedAt === acceptedAt && c.expiresAt === acceptedAt + 23 * 3600 &&
    isDeepStrictEqual(c.processingFees, { enabled: fees.processingFeeEnabled,
      basisPoints: fees.processingFeeBasisPoints, fixedCents: fees.processingFeeFixedCents,
      version: fees.feeScheduleVersion }) &&
    isDeepStrictEqual(c.sourceMetadata, { ...membershipMetadata(a, "manual_first"),
      membership_subscription_id: args.subscriptionId, ...creatorFeeMetadata(fees) }),
    "Monthly manual first contract differs");
  const pi = inspectServerPaymentIntent(c, args.contextEvidence, args.data.paymentIntent,
    args.binding, args.nowSeconds);
  check(pi.status === "succeeded" && pi.id === args.binding.paymentIntentId);
  const capture = inspectPaymentCaptureEvidence({ ...args.data, customerId: c.customerId,
    live: c.context.mode === "live", amountCents: c.amountCents,
    applicationFeeCents: fees.totalCreatorDeductionCents, createdAt: pi.created,
    expiresAt: c.expiresAt, nowSeconds: args.nowSeconds });
  return Object.freeze({ version: "monthly-mentorship-payment-proof-v1" as const,
    paymentContext: a.terms.paymentContext, customerId: c.customerId,
    subscriptionId: args.subscriptionId, checkoutSessionId: null,
    destinationId: c.destinationId, paymentIntentId: pi.id, chargeId: capture.chargeId,
    invoiceId: null, capturedAmountCents: c.amountCents,
    applicationFeeAmountCents: fees.totalCreatorDeductionCents,
    paymentStatus: "succeeded" as const, paymentMethodId: capture.paymentMethodId,
    paidAt: capture.paidAt, balanceTransactionId: capture.balanceTransactionId,
    transferId: capture.transferId, actualStripeFeeCents: capture.actualStripeFeeCents,
    buyerCountry: capture.buyerCountry,
    manualPayment: Object.freeze({ attemptId: c.attemptId,
      confirmationOperationId: args.confirmationOperationId }) });
}
