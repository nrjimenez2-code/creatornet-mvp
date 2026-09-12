import "server-only";

import type Stripe from "stripe";
import { calculateInstallmentPlan } from "../installmentPlan";
import { creatorFeeMetadata, type ProcessingFeeSchedule } from "../money";
import { HELD_INSTALLMENT_VERSION } from "./heldInvoice";
import { FIXED_PURCHASE_CONSENT_TEXT, FIXED_PURCHASE_CONSENT_VERSION } from "./purchaseConsent";
import { fixedServiceDescription } from "../fixedServiceTerms";

export type ExactCheckoutContractInput = Readonly<{
  planId: string;
  bookingPaymentId: string;
  bookingId: string;
  postId: string;
  productId: string;
  buyerId: string;
  creatorId: string;
  destinationId: string;
  customerId: string;
  subscriptionId: string;
  totalCents: number;
  paymentCount: number;
  title: string;
  /** Trusted deployment origin, NOT the request's Host/Origin header. */
  previewOrigin: string;
  firstPaymentFeeSchedule: ProcessingFeeSchedule;
  renewalFeeSchedule: ProcessingFeeSchedule;
}>;

/**
 * Request-building layer only, not an independently enabled checkout path. The
 * gated booking service first persists the immutable agreement and verifies an indefinitely
 * held subscription for a new no-card Customer, then bind the returned Session
 * id atomically to that agreement. Never reuse this for existing subscriptions.
 *
 * The first payment uses an integer application fee on hosted Checkout, while
 * subsequent monthly invoices use heldInvoice.ts. No subscription percentage,
 * trial in the customer offer, extra buyer fee, or rounded purchase total.
 */
export function buildExactInstallmentCheckoutContract(
  input: ExactCheckoutContractInput,
  heldSubscription: Stripe.Subscription,
): Stripe.Checkout.SessionCreateParams {
  const a = input;
  const stop = (message: string): never => { throw new Error(`Exact installment checkout stopped: ${message}`); };
  for (const value of [a.planId, a.bookingPaymentId, a.bookingId, a.postId, a.productId,
    a.buyerId, a.creatorId, a.destinationId, a.customerId, a.subscriptionId]) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) stop("invalid identity");
  }
  const origin = new URL(a.previewOrigin);
  if (origin.protocol !== "https:" || !origin.hostname.endsWith(".vercel.app") ||
    origin.username || origin.password || origin.port || origin.search || origin.hash ||
    origin.pathname !== "/") stop("only a trusted Vercel Preview origin is supported");
  if (heldSubscription.livemode !== false) stop("live mode is not enabled");
  const customer = typeof heldSubscription.customer === "string"
    ? heldSubscription.customer : heldSubscription.customer.id;
  const destination = typeof heldSubscription.transfer_data?.destination === "string"
    ? heldSubscription.transfer_data.destination : heldSubscription.transfer_data?.destination.id;
  if (heldSubscription.id !== a.subscriptionId || customer !== a.customerId || destination !== a.destinationId ||
    heldSubscription.metadata.installment_collection_version !== HELD_INSTALLMENT_VERSION ||
    heldSubscription.metadata.installment_plan_id !== a.planId ||
    heldSubscription.metadata.booking_payment_id !== a.bookingPaymentId) stop("subscription agreement mismatch");
  if (heldSubscription.pause_collection?.behavior !== "keep_as_draft" ||
    heldSubscription.pause_collection.resumes_at != null || heldSubscription.status !== "trialing" ||
    heldSubscription.application_fee_percent != null || heldSubscription.transfer_data?.amount_percent != null ||
    !Number.isSafeInteger(heldSubscription.cancel_at) || !heldSubscription.cancel_at ||
    !Number.isSafeInteger(heldSubscription.trial_end) || !heldSubscription.trial_end ||
    heldSubscription.cancel_at <= heldSubscription.trial_end) stop("bootstrap collection hold is not ready");
  const plan = calculateInstallmentPlan(a.totalCents, a.paymentCount, a.renewalFeeSchedule, a.firstPaymentFeeSchedule);
  if (plan.payments.some((payment) => payment.amountCents > 99999999)) stop("payment exceeds Stripe's USD amount limit");
  const first = plan.payments[0];
  const metadata = {
    installment_collection_version: HELD_INSTALLMENT_VERSION,
    installment_plan_id: a.planId,
    installment_number: "1",
    installment_subscription_id: a.subscriptionId,
    booking_payment_id: a.bookingPaymentId,
    booking_id: a.bookingId, post_id: a.postId, product_id: a.productId,
    buyer_id: a.buyerId, creator_id: a.creatorId,
    creator_stripe_account_id: a.destinationId,
    plan_type: "installment", plan_months: String(a.paymentCount),
    installment_total_cents: String(a.totalCents),
    ...creatorFeeMetadata(first.fees),
  };
  return buildFixedTotalCheckoutPayload({ ...a, origin: origin.origin }, metadata);
}

/** Shared request payload only; the callers above and in the context adapter
 * must validate their own durable identities, mode and fresh collection hold.
 * This does not dispatch, publish, create an agreement or relax the v1 guard.
 * Keeping a single payload preserves the existing fee/disclosure/Buy behavior. */
export function buildFixedTotalCheckoutPayload(a: Pick<ExactCheckoutContractInput,
  "customerId" | "destinationId" | "totalCents" | "paymentCount" | "title" | "firstPaymentFeeSchedule" | "renewalFeeSchedule"> &
  { origin: string }, metadata: Record<string, string>,
  purchaseConsentVersion?: typeof FIXED_PURCHASE_CONSENT_VERSION, serviceMonths?: number): Stripe.Checkout.SessionCreateParams {
  if (purchaseConsentVersion !== undefined && purchaseConsentVersion !== FIXED_PURCHASE_CONSENT_VERSION) {
    throw new Error("Unsupported fixed purchase consent version");
  }
  if (serviceMonths !== undefined && !purchaseConsentVersion) throw new Error("Timed service requires versioned purchase consent");
  const serviceText = serviceMonths === undefined ? "" : fixedServiceDescription(serviceMonths) + " ";
  const plan = calculateInstallmentPlan(a.totalCents, a.paymentCount, a.renewalFeeSchedule, a.firstPaymentFeeSchedule);
  if (plan.payments.some(p => p.amountCents > 99999999)) throw new Error("Checkout payment exceeds USD amount limit");
  const first = plan.payments[0], money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const remaining = plan.payments.slice(1).map(payment => money(payment.amountCents)).join(", ");
  const scheduleText = `${money(first.amountCents)} today, then ${remaining} in monthly payments. ` +
    `${a.paymentCount} payments total: ${money(a.totalCents)} USD. No automatic renewal after the final payment.`;
  return {
    mode: "payment",
    adaptive_pricing: { enabled: false },
    automatic_tax: { enabled: false },
    allow_promotion_codes: false,
    invoice_creation: { enabled: false },
    customer: a.customerId,
    payment_method_types: ["card"],
    line_items: [{ quantity: 1, price_data: {
      currency: "usd", unit_amount: first.amountCents,
      product_data: { name: a.title.trim().slice(0, 200) || "CreatorNet installment plan", description: scheduleText },
    } }],
    payment_intent_data: {
      application_fee_amount: first.fees.totalCreatorDeductionCents,
      transfer_data: { destination: a.destinationId },
      setup_future_usage: "off_session",
      metadata,
    },
    consent_collection: { payment_method_reuse_agreement: { position: "auto" },
      ...(purchaseConsentVersion ? { terms_of_service: "required" as const } : {}) },
    // Keep Stripe's default linked Terms checkbox. Its configured merchant
    // Terms URL and the policy review remain separate release prerequisites.
    custom_text: { submit: { message: purchaseConsentVersion
      ? `${scheduleText} ${serviceText}${FIXED_PURCHASE_CONSENT_TEXT}`
      : `${scheduleText} By paying, you authorize use of this card for these scheduled installments, subject to the applicable cancellation and refund terms.` } },
    metadata,
    success_url: `${a.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${a.origin}/dashboard`,
  };
}
