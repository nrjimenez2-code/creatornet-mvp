import "server-only";
import type Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import { creatorFeeMetadata } from "./money";
import { membershipMonthBoundary, MEMBERSHIP_PAYMENT_PROOF_VERSION } from "./membershipAgreement";
import { membershipCheck as check, membershipStripeId as sid, membershipMetadata, type MembershipRecord } from "./membershipCheckout";
export const MEMBERSHIP_RENEWAL_VERSION = "monthly-held-renewals-v1";
export type MembershipFirstProof = { paymentMethodId: string; paidAt: number; paymentIntentId: string };
export function readMembershipFirstProof(a: MembershipRecord, value: unknown): MembershipFirstProof {
  check(value && typeof value === "object"); const p = value as Record<string, unknown>;
  check(p.version === MEMBERSHIP_PAYMENT_PROOF_VERSION && p.customerId === a.stripe_customer_id && p.subscriptionId === a.stripe_subscription_id &&
    p.checkoutSessionId === a.stripe_checkout_session_id && p.destinationId === a.terms.destinationId &&
    isDeepStrictEqual(p.paymentContext, a.terms.paymentContext) && p.capturedAmountCents === a.monthly_price_cents &&
    p.applicationFeeAmountCents === a.terms.firstMonthFees.totalCreatorDeductionCents && p.paymentStatus === "succeeded" &&
    p.paidAt === a.anchor_at && Number.isSafeInteger(p.paidAt) && Number(p.paidAt) > 0);
  return { paymentMethodId: sid(p.paymentMethodId, "pm"), paidAt: Number(p.paidAt), paymentIntentId: sid(p.paymentIntentId, "pi") };
}
export function membershipRenewalPeriod(a: MembershipRecord, month = a.covered_months + 1) {
  check(Number.isSafeInteger(a.anchor_at) && Number(a.anchor_at) > 0 && Number.isSafeInteger(month) && month >= 2 &&
    (a.auto_renew || month <= a.minimum_months), "No agreed renewal period");
  const firstRenewal = membershipMonthBoundary(a.anchor_at!, 1);
  // Stripe's held invoice cadence can start on a short-month-clamped date.
  // It is NOT authority to debit earlier or shorten the accepted service month.
  return { month, start: membershipMonthBoundary(a.anchor_at!, month - 1), end: membershipMonthBoundary(a.anchor_at!, month),
    providerStart: membershipMonthBoundary(firstRenewal, month - 2), providerEnd: membershipMonthBoundary(firstRenewal, month - 1) };
}
export function membershipActivationParams(a: MembershipRecord, proof: MembershipFirstProof): Stripe.SubscriptionUpdateParams {
  check(a.covered_months >= 1 && proof.paidAt === a.anchor_at); sid(proof.paymentMethodId, "pm");
  return { trial_end: membershipMonthBoundary(proof.paidAt, 1),
    cancel_at: a.auto_renew ? "" : membershipMonthBoundary(proof.paidAt, a.minimum_months),
    proration_behavior: "none", default_payment_method: proof.paymentMethodId, pause_collection: { behavior: "keep_as_draft" },
    payment_settings: { payment_method_types: ["card"], save_default_payment_method: "off" },
    metadata: { ...membershipMetadata(a, "subscription"), creatornet_membership_activation: MEMBERSHIP_RENEWAL_VERSION } };
}
export function assertMembershipActivated(s: Stripe.Subscription, a: MembershipRecord, productId: string, proof: MembershipFirstProof) {
  const expected = membershipActivationParams(a, proof), item = s.items?.data?.[0], price = item?.price;
  check(s.object === "subscription" && s.id === a.stripe_subscription_id && s.livemode === (a.terms.paymentContext.mode === "live") &&
    s.customer === a.stripe_customer_id && ["trialing", "active"].includes(s.status) && s.billing_mode?.type === "classic" &&
    s.trial_end === expected.trial_end && s.billing_cycle_anchor === expected.trial_end &&
    s.cancel_at === (a.auto_renew ? null : expected.cancel_at) && !s.cancel_at_period_end && s.default_payment_method === proof.paymentMethodId &&
    s.default_source == null && s.application_fee_percent == null && s.transfer_data?.destination === a.terms.destinationId &&
    s.transfer_data.amount_percent == null && s.collection_method === "charge_automatically" && s.pause_collection?.behavior === "keep_as_draft" &&
    s.pause_collection.resumes_at == null && !s.automatic_tax.enabled && !s.discounts?.length && !s.default_tax_rates?.length &&
    s.pending_update == null && s.schedule == null && s.test_clock == null && s.billing_cycle_anchor_config == null &&
    isDeepStrictEqual(s.metadata, expected.metadata) && s.items.has_more === false && s.items.data.length === 1 &&
    // Activation retains the original inline price, whose active flag may be false.
    item.quantity === 1 && !item.tax_rates?.length && !item.discounts?.length && typeof price.active === "boolean" &&
    price.livemode === s.livemode && price.currency === "usd" && price.product === productId && price.unit_amount === a.monthly_price_cents &&
    price.billing_scheme === "per_unit" && price.transform_quantity == null && price.recurring?.interval === "month" &&
    price.recurring.interval_count === 1 && price.recurring.usage_type === "licensed" &&
    s.payment_settings != null && s.payment_settings.save_default_payment_method === "off" && isDeepStrictEqual(s.payment_settings.payment_method_types, ["card"]));
  return sid(item.id, "si");
}
export function membershipInvoiceMetadata(a: MembershipRecord, month: number) {
  const p = membershipRenewalPeriod(a, month);
  return { ...membershipMetadata(a, "renewal"), membership_subscription_id: a.stripe_subscription_id!,
    membership_month: String(month), membership_collection_version: MEMBERSHIP_RENEWAL_VERSION,
    service_period_start: String(p.start), service_period_end: String(p.end),
    provider_period_start: String(p.providerStart), provider_period_end: String(p.providerEnd), ...creatorFeeMetadata(a.terms.recurringMonthFees) };
}
export function membershipInvoiceConfiguration(a: MembershipRecord, proof: MembershipFirstProof, month: number): Stripe.InvoiceUpdateParams {
  return { auto_advance: false, application_fee_amount: a.terms.recurringMonthFees.totalCreatorDeductionCents,
    transfer_data: { destination: a.terms.destinationId }, default_payment_method: proof.paymentMethodId,
    payment_settings: { payment_method_types: ["card"] }, metadata: membershipInvoiceMetadata(a, month) };
}
export function membershipInvoicePayParams(proof: MembershipFirstProof): Stripe.InvoicePayParams {
  return { payment_method: proof.paymentMethodId, off_session: true, forgive: false, paid_out_of_band: false };
}
export function assertMembershipInvoice(inv: Stripe.Invoice, a: MembershipRecord, proof: MembershipFirstProof, month: number,
  productId: string, phase: "held" | "configured" | "paid", itemId?: string) {
  const p = membershipRenewalPeriod(a, month), line = inv.lines?.data?.[0], parent = line?.parent?.subscription_item_details;
  const configured = phase !== "held", paid = phase === "paid";
  sid(inv.id, "in");
  check(inv.object === "invoice" && inv.livemode === (a.terms.paymentContext.mode === "live") && inv.customer === a.stripe_customer_id &&
    inv.parent?.subscription_details?.subscription === a.stripe_subscription_id && inv.billing_reason === "subscription_cycle" &&
    inv.collection_method === "charge_automatically" && inv.auto_advance === false && inv.currency === "usd" &&
    inv.subtotal === a.monthly_price_cents && inv.total === a.monthly_price_cents && inv.amount_due === a.monthly_price_cents &&
    inv.amount_paid === (paid ? a.monthly_price_cents : 0) && inv.amount_remaining === (paid ? 0 : a.monthly_price_cents) &&
    inv.amount_overpaid === 0 && inv.starting_balance === 0 && (inv.ending_balance == null || inv.ending_balance === 0) &&
    inv.amount_shipping === 0 && !inv.automatic_tax.enabled && !inv.discounts?.length && !inv.total_discount_amounts?.length &&
    !inv.total_taxes?.length && inv.pre_payment_credit_notes_amount === 0 && inv.post_payment_credit_notes_amount === 0 &&
    (paid ? inv.status === "paid" : ["draft", "open"].includes(inv.status || "")) &&
    inv.lines.has_more === false && inv.lines.data.length === 1 && line.amount === a.monthly_price_cents && line.currency === "usd" &&
    line.quantity === 1 && !line.discount_amounts?.length && !line.discounts?.length && !line.taxes?.length &&
    line.parent?.type === "subscription_item_details" && parent?.subscription === a.stripe_subscription_id && parent.proration === false &&
    (!itemId || parent.subscription_item === itemId) && line.pricing?.type === "price_details" &&
    line.pricing.price_details?.product === productId &&
    (configured ? line.period.start === p.start && line.period.end === p.end :
      line.period.start === p.providerStart && line.period.end === p.providerEnd || line.period.start === p.start && line.period.end === p.end));
  // Invoice-level Connect fields are not exposed by the installed Invoice
  // contract. Exact fee/destination are mandatory on the real PaymentIntent
  // before debit and again on captured payment evidence, never inferred here.
  if (configured) check(inv.default_payment_method === proof.paymentMethodId && isDeepStrictEqual(inv.payment_settings.payment_method_types, ["card"]) &&
    isDeepStrictEqual(inv.metadata, membershipInvoiceMetadata(a, month)));
  return sid(line.id, "il");
}
export function inspectMembershipRenewalCapture(a: MembershipRecord, proof: MembershipFirstProof, month: number,
  inv: Stripe.Invoice, link: Stripe.InvoicePayment, pi: Stripe.PaymentIntent, charge: Stripe.Charge, balance: Stripe.BalanceTransaction,
  collectionRequestId: string) {
  const live = a.terms.paymentContext.mode === "live", fee = a.terms.recurringMonthFees.totalCreatorDeductionCents;
  const p = membershipRenewalPeriod(a, month);
  check(link.object === "invoice_payment" && link.invoice === inv.id && link.livemode === live && link.is_default === true &&
    link.currency === "usd" && link.amount_requested === a.monthly_price_cents && link.amount_paid === a.monthly_price_cents &&
    link.status === "paid" && link.payment.type === "payment_intent" && sid(link.payment.payment_intent, "pi") === pi.id);
  check(pi.object === "payment_intent" && pi.livemode === live && pi.status === "succeeded" && pi.customer === a.stripe_customer_id &&
    pi.amount === a.monthly_price_cents && pi.amount_received === pi.amount && pi.amount_capturable === 0 && pi.currency === "usd" &&
    pi.application_fee_amount === fee && pi.transfer_data?.destination === a.terms.destinationId && pi.transfer_data.amount == null &&
    pi.payment_method === proof.paymentMethodId && ["automatic", "automatic_async"].includes(pi.capture_method));
  check(charge.object === "charge" && charge.id === sid(pi.latest_charge, "ch") && charge.payment_intent === pi.id &&
    charge.customer === a.stripe_customer_id && charge.livemode === live && charge.currency === "usd" && charge.status === "succeeded" &&
    charge.paid && charge.captured && charge.amount === a.monthly_price_cents && charge.amount_captured === charge.amount &&
    charge.application_fee_amount === fee && charge.payment_method === proof.paymentMethodId && charge.payment_method_details?.type === "card" &&
    Number.isSafeInteger(charge.created) && charge.created >= p.start && charge.created <= Math.floor(Date.now() / 1000) &&
    Number.isSafeInteger(charge.amount_refunded) && charge.amount_refunded >= 0 && charge.amount_refunded <= charge.amount && typeof charge.disputed === "boolean");
  check(balance.object === "balance_transaction" && balance.id === sid(charge.balance_transaction, "txn") && balance.source === charge.id &&
    balance.type === "charge" && balance.currency === "usd" && balance.amount === charge.amount && Number.isSafeInteger(balance.fee) &&
    balance.fee >= 0 && balance.fee <= charge.amount && balance.net === balance.amount - balance.fee && /^req_[A-Za-z0-9]+$/.test(collectionRequestId));
  return { period: p, stripeFee: { chargeId: charge.id, balanceTransactionId: balance.id, actualStripeFeeCents: balance.fee, applicationFeeAmountCents: fee },
    providerProof: { version: MEMBERSHIP_PAYMENT_PROOF_VERSION, paymentContext: a.terms.paymentContext, customerId: a.stripe_customer_id,
      subscriptionId: a.stripe_subscription_id, checkoutSessionId: a.stripe_checkout_session_id, destinationId: a.terms.destinationId,
      paymentIntentId: pi.id, chargeId: charge.id, invoiceId: inv.id, capturedAmountCents: charge.amount, applicationFeeAmountCents: fee,
      paymentStatus: "succeeded", paymentMethodId: proof.paymentMethodId, paidAt: charge.created, collectionRequestId,
      providerPeriodStart: p.providerStart, providerPeriodEnd: p.providerEnd } };
}
