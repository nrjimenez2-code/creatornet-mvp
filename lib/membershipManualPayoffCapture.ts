import "server-only";
import type Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import { assertMembershipId } from "./membershipAgreement";
import type { MembershipRecord } from "./membershipCheckout";
import { membershipPayoffMetadata, MEMBERSHIP_PAYOFF_PROOF_VERSION,
  type MembershipPayoffRecord } from "./membershipPayoff";
import { validateExactPaymentContext } from "./installments/paymentContext";
import { inspectServerPaymentIntent, type ServerPaymentContract } from "./serverPaymentConfirmation";
import { inspectPaymentCaptureEvidence } from "./paymentCaptureEvidence";

const check: (value: unknown, message?: string) => asserts value = (value, message) => {
  if (!value) throw Error(message ?? "Monthly manual payoff capture requires review");
};

/** Independent evidence for a captured original manual payoff intent. This
 * pure inspector cannot admit money, write accounting or grant access. */
export function inspectMembershipManualPayoffCapture(args: {
  agreement: MembershipRecord;
  payoff: MembershipPayoffRecord;
  contract: ServerPaymentContract;
  contextEvidence: unknown;
  binding: { paymentIntentId: string; firstDispatchAt: number };
  confirmationOperationId: string;
  nowSeconds: number;
  data: { paymentIntent: Stripe.PaymentIntent; charge: Stripe.Charge;
    balance: Stripe.BalanceTransaction; paymentMethod: Stripe.PaymentMethod };
}) {
  const { agreement: a, payoff: p, contract: c } = args;
  assertMembershipId(args.confirmationOperationId);
  check(c.kind === "monthly_payoff" && c.attemptId !== a.id &&
    c.buyerId === a.buyer_id && c.creatorId === a.creator_id && c.productId === a.product_id &&
    c.termsFingerprint === p.fingerprint && c.customerId === a.stripe_customer_id &&
    c.destinationId === a.terms.destinationId && c.amountCents === p.terms.amountCents &&
    p.agreement_id === a.id && p.buyer_id === a.buyer_id &&
    p.status === "accepted" && p.checkout_request === null && p.checkout_dispatched_at === null &&
    p.stripe_checkout_session_id === null && p.ledger_id === null && p.provider_proof === null &&
    a.stripe_subscription_id !== null && a.covered_months === p.terms.firstUnpaidMonth - 1,
    "Monthly manual payoff source differs");
  const acceptedAt = Math.floor(Date.parse(p.accepted_at) / 1000), fees = p.terms.fees;
  const exact = { version: "exact-payment-context-v1" as const,
    mode: a.terms.paymentContext.mode, platformAccountId: a.terms.paymentContext.stripeAccountId,
    supabaseProjectRef: a.terms.paymentContext.supabaseProjectRef,
    siteOrigin: a.terms.paymentContext.siteOrigin };
  check(isDeepStrictEqual(c.context, validateExactPaymentContext(exact, args.contextEvidence)) &&
    c.acceptedAt === acceptedAt && c.expiresAt === Math.min(acceptedAt + 23 * 3600, p.terms.periodEnd) &&
    isDeepStrictEqual(c.processingFees, { enabled: fees.processingFeeEnabled,
      basisPoints: fees.processingFeeBasisPoints, fixedCents: fees.processingFeeFixedCents,
      version: fees.feeScheduleVersion }) &&
    isDeepStrictEqual(c.sourceMetadata, membershipPayoffMetadata(a, p)),
    "Monthly manual payoff contract differs");
  const pi = inspectServerPaymentIntent(c, args.contextEvidence, args.data.paymentIntent,
    args.binding, args.nowSeconds);
  check(pi.status === "succeeded" && pi.id === args.binding.paymentIntentId);
  const capture = inspectPaymentCaptureEvidence({ ...args.data, customerId: c.customerId,
    live: c.context.mode === "live", amountCents: c.amountCents,
    applicationFeeCents: fees.totalCreatorDeductionCents, createdAt: pi.created,
    expiresAt: c.expiresAt, nowSeconds: args.nowSeconds });
  return Object.freeze({ version: MEMBERSHIP_PAYOFF_PROOF_VERSION,
    paymentContext: a.terms.paymentContext, payoffId: p.id, payoffFingerprint: p.fingerprint,
    customerId: c.customerId, subscriptionId: a.stripe_subscription_id,
    checkoutSessionId: null, destinationId: c.destinationId,
    paymentIntentId: pi.id, chargeId: capture.chargeId,
    capturedAmountCents: c.amountCents,
    applicationFeeAmountCents: fees.totalCreatorDeductionCents,
    paymentStatus: "succeeded" as const, paymentMethodId: capture.paymentMethodId,
    paidAt: capture.paidAt, periodStart: p.terms.periodStart,
    periodEnd: p.terms.periodEnd, balanceTransactionId: capture.balanceTransactionId,
    transferId: capture.transferId, actualStripeFeeCents: capture.actualStripeFeeCents,
    buyerCountry: capture.buyerCountry,
    manualPayment: Object.freeze({ attemptId: c.attemptId,
      confirmationOperationId: args.confirmationOperationId }) });
}
