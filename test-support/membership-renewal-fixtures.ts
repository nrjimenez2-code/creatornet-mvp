import type Stripe from "stripe";
import { membershipFixture } from "./membership-fixtures";
import { MEMBERSHIP_PAYMENT_PROOF_VERSION, membershipMonthBoundary } from "@/lib/membershipAgreement";
import { membershipActivationParams, membershipRenewalPeriod } from "@/lib/membershipRenewal";
export function membershipRenewalFixture(anchor?: number, coveredMonths = 1) {
  const f = membershipFixture(true), now = new Date();
  f.a.anchor_at = anchor ?? Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 12) / 1000;
  f.a.covered_months = coveredMonths; f.a.revision = coveredMonths + 1;
  f.a.accepted_at = new Date((f.a.anchor_at - 60) * 1000).toISOString();
  const proof = { version: MEMBERSHIP_PAYMENT_PROOF_VERSION, customerId: f.a.stripe_customer_id, subscriptionId: f.a.stripe_subscription_id,
    checkoutSessionId: f.a.stripe_checkout_session_id, destinationId: f.a.terms.destinationId, paymentContext: f.a.terms.paymentContext,
    capturedAmountCents: 10000, applicationFeeAmountCents: f.a.terms.firstMonthFees.totalCreatorDeductionCents,
    paymentStatus: "succeeded", paymentMethodId: "pm_fixture", paidAt: f.a.anchor_at, paymentIntentId: "pi_fixture" };
  const activation = membershipActivationParams(f.a, proof), p = membershipRenewalPeriod(f.a);
  f.subscription.status = "active"; f.subscription.trial_end = membershipMonthBoundary(f.a.anchor_at, 1);
  f.subscription.billing_cycle_anchor = f.subscription.trial_end; f.subscription.cancel_at = null;
  f.subscription.default_payment_method = "pm_fixture"; f.subscription.metadata = activation.metadata as Stripe.Metadata;
  f.customer.delinquent = false;
  const paymentMethod = { id: "pm_fixture", object: "payment_method", type: "card", customer: f.customer.id, livemode: false } as unknown as Stripe.PaymentMethod;
  const line = { id: "il_fixture", object: "line_item", amount: 10000, currency: "usd", quantity: 1, discount_amounts: [], discounts: [], taxes: [],
    period: { start: p.providerStart, end: p.providerEnd },
    parent: { type: "subscription_item_details", subscription_item_details: { subscription: f.subscription.id, subscription_item: "si_fixture", proration: false } },
    pricing: { type: "price_details", price_details: { price: "price_fixture", product: f.product.id } } } as unknown as Stripe.InvoiceLineItem;
  const invoice = { id: "in_fixture", object: "invoice", customer: f.customer.id, livemode: false,
    parent: { subscription_details: { subscription: f.subscription.id } }, billing_reason: "subscription_cycle", collection_method: "charge_automatically",
    auto_advance: false, currency: "usd", subtotal: 10000, total: 10000, amount_due: 10000, amount_paid: 0, amount_remaining: 10000,
    amount_overpaid: 0, amount_shipping: 0, starting_balance: 0, ending_balance: null, automatic_tax: { enabled: false }, discounts: [],
    total_discount_amounts: [], total_taxes: [], pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, status: "draft",
    lines: { data: [line], has_more: false }, application_fee_amount: null, transfer_data: { destination: "acct_creator" },
    payment_settings: { payment_method_types: ["card"] }, metadata: {}, default_payment_method: null, attempt_count: 0,
  } as unknown as Stripe.Invoice;
  const invoicePayment = { id: "inpay_fixture", object: "invoice_payment", invoice: invoice.id, is_default: true, livemode: false, currency: "usd",
    amount_requested: 10000, amount_paid: null, status: "open", payment: { type: "payment_intent", payment_intent: "pi_renewal" } } as unknown as Stripe.InvoicePayment;
  f.paymentIntent.id = "pi_renewal"; f.paymentIntent.status = "requires_payment_method"; f.paymentIntent.amount_received = 0;
  f.paymentIntent.latest_charge = null; f.paymentIntent.payment_method = null; f.paymentIntent.payment_method_types = ["card"];
  f.paymentIntent.application_fee_amount = f.a.terms.recurringMonthFees.totalCreatorDeductionCents;
  f.charge.id = "ch_renewal"; f.charge.payment_intent = f.paymentIntent.id; f.charge.application_fee_amount = f.paymentIntent.application_fee_amount;
  f.balance.source = f.charge.id; f.balance.fee = 390; f.balance.net = 9610;
  function capture() {
    invoice.status = "paid"; invoice.amount_paid = 10000; invoice.amount_remaining = 0; invoice.attempt_count = 1;
    invoicePayment.status = "paid"; invoicePayment.amount_paid = 10000;
    f.paymentIntent.status = "succeeded"; f.paymentIntent.amount_received = 10000; f.paymentIntent.latest_charge = f.charge.id;
    f.paymentIntent.payment_method = "pm_fixture"; f.charge.created = Math.floor(Date.now() / 1000);
  }
  return { ...f, proof, period: p, paymentMethod, invoice, invoicePayment, capture };
}
