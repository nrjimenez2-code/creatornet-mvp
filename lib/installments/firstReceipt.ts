import "server-only";

import type Stripe from "stripe";
import { calculateInstallmentPlan } from "../installmentPlan";
import { HELD_INSTALLMENT_VERSION } from "./heldInvoice";
import { assertExactInstallmentSandbox } from "./checkoutPreparation";
import type { ExactAgreement, ExactAgreementStore, FirstInstallmentReceipt } from "./agreementStore";

const id = (v: string | { id: string } | null | undefined) => typeof v === "string" ? v : v?.id;
function requireThat(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Exact installment receipt stopped: ${reason}`);
}

type FirstPaymentInput = {
  agreementId: string;
  sessionId: string;
  store: ExactAgreementStore;
  stripe: Pick<Stripe, "checkout" | "paymentIntents" | "charges">;
  env: Record<string, string | undefined>;
};

/** Read-only evidence shared by receipt recording and the new credit adapter.
 * Returns only selected server-internal fields, never raw Stripe objects. */
export async function inspectExactFirstInstallment(args: FirstPaymentInput): Promise<Readonly<{
  agreement: ExactAgreement; receipt: FirstInstallmentReceipt; chargeId: string;
  balanceTransactionId: string | null; refundedAmountCents: number;
  paymentMethodId: string | null; cardReuseVerified: boolean; disputed: boolean;
}>> {
  const a = await args.store.load(args.agreementId);
  const t = a.terms;
  assertExactInstallmentSandbox(args.env, t.previewOrigin);
  requireThat(["awaiting_first", "active", "complete"].includes(a.status) &&
    a.sessionId === args.sessionId && a.customerId && a.subscriptionId, "agreement is not bound to this Checkout");
  const first = calculateInstallmentPlan(t.totalCents, t.paymentCount,
    t.renewalFeeSchedule, t.firstPaymentFeeSchedule).payments[0];
  const checkMetadata = (meta: Stripe.Metadata | null) => {
    requireThat(meta?.installment_collection_version === HELD_INSTALLMENT_VERSION &&
      meta.installment_plan_id === a.id && meta.installment_number === "1" &&
      meta.installment_subscription_id === a.subscriptionId && meta.booking_payment_id === t.bookingPaymentId &&
      meta.buyer_id === t.buyerId && meta.creator_id === t.creatorId && meta.post_id === t.postId,
    "payment metadata identity mismatch");
  };
  const session = await args.stripe.checkout.sessions.retrieve(args.sessionId);
  requireThat(session.id === a.sessionId && session.livemode === false && session.mode === "payment" &&
    session.status === "complete" && session.payment_status === "paid" && id(session.customer) === a.customerId &&
    session.currency === "usd" && session.amount_total === first.amountCents &&
    session.amount_subtotal === first.amountCents && !session.total_details?.amount_tax &&
    !session.total_details?.amount_discount && !session.total_details?.amount_shipping, "Checkout is not an exact paid first installment");
  checkMetadata(session.metadata);
  const paymentIntentId = id(session.payment_intent);
  requireThat(paymentIntentId, "first PaymentIntent missing");
  const pi = await args.stripe.paymentIntents.retrieve(paymentIntentId);
  requireThat(pi.id === paymentIntentId && pi.livemode === false && pi.status === "succeeded" &&
    pi.currency === "usd" && id(pi.customer) === a.customerId &&
    pi.amount === first.amountCents && pi.amount_received === first.amountCents &&
    pi.application_fee_amount === first.fees.totalCreatorDeductionCents &&
    id(pi.transfer_data?.destination) === t.destinationId && pi.transfer_data?.amount == null &&
    pi.setup_future_usage === "off_session", "actual first payment amount/fee/destination mismatch");
  checkMetadata(pi.metadata);
  const chargeId = id(pi.latest_charge);
  requireThat(chargeId, "captured charge missing");
  const charge = await args.stripe.charges.retrieve(chargeId);
  requireThat(charge.id === chargeId && charge.livemode === false && charge.paid === true &&
    charge.captured === true && charge.status === "succeeded" && id(charge.payment_intent) === pi.id &&
    id(charge.customer) === a.customerId && charge.currency === "usd" && charge.amount === first.amountCents &&
    charge.amount_captured === first.amountCents && charge.payment_method_details?.type === "card" &&
    Number.isSafeInteger(charge.created) && charge.created >= a.createdAt,
  "captured card charge identity mismatch");
  const receipt = Object.freeze({ sessionId: session.id, paymentIntentId: pi.id,
    amountCents: first.amountCents, applicationFeeCents: first.fees.totalCreatorDeductionCents, paidAt: charge.created });
  requireThat(Number.isSafeInteger(charge.amount_refunded) && charge.amount_refunded >= 0 &&
    charge.amount_refunded <= charge.amount && charge.refunded === (charge.amount_refunded === charge.amount),
  "invalid captured refund state");
  return Object.freeze({ agreement: a, receipt, chargeId: charge.id,
    balanceTransactionId: id(charge.balance_transaction) ?? null, refundedAmountCents: charge.amount_refunded,
    paymentMethodId: id(pi.payment_method) ?? null,
    cardReuseVerified: !!id(pi.payment_method) && charge.payment_method === id(pi.payment_method),
    disputed: charge.disputed !== false });
}

/** Verify a bound payment and write only an immutable receipt. This function
 * still does not activate collection, credit earnings or grant access. */
export async function recordVerifiedFirstInstallment(args: FirstPaymentInput): Promise<Readonly<{
  recorded: boolean; receipt: FirstInstallmentReceipt;
}>> {
  const { agreement, receipt } = await inspectExactFirstInstallment(args);
  const recorded = await args.store.recordFirstReceipt(agreement.id, receipt);
  // Never return client secrets, card/customer details or the raw Stripe response.
  return Object.freeze({ recorded, receipt });
}
