import type Stripe from "stripe";
import { buildMembershipAgreement } from "@/lib/membershipAgreement";
import { buildMembershipCheckout, membershipBootstrapTimes, membershipMetadata, type MembershipRecord } from "@/lib/membershipCheckout";

export const membershipTestContext = { stripeAccountId: "acct_fixture", mode: "test" as const, apiVersion: "2025-10-29.clover",
  siteOrigin: "https://membership-fixture.vercel.app", supabaseProjectRef: "nwqfofezfzljhxolkycz" };
export const membershipTestEnv: Record<string, string> = {
  CREATOR_PURCHASE_CONSENT_SCHEMA_READY: "true", CREATOR_PURCHASE_POLICIES_READY: "true", CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED: "true",
  CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY: "true",
  CREATOR_MONTHLY_MENTORSHIPS_OPERATIONS_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY: "true",
  CREATOR_MONTHLY_MENTORSHIPS_CHECKOUT_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY: "true",
  CREATOR_MONTHLY_MENTORSHIPS_COLLECTION_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_RENEWALS_READY: "true",
  CREATOR_MONTHLY_MENTORSHIPS_WORKER_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_WORKER_READY: "true",
  CREATOR_MONTHLY_MENTORSHIPS_EXIT_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_EXIT_READY: "true",
  CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_READY: "true",
  CREATOR_MONTHLY_MENTORSHIPS_LIFECYCLE_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_LIFECYCLE_READY: "true",
  CREATOR_MONTHLY_MENTORSHIPS_PAYMENT_EVENTS_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_PAYMENT_EVENTS_READY: "true",
  CREATOR_MONTHLY_MENTORSHIPS_EXIT_RECOVERY_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_EXIT_RECOVERY_READY: "true",
  CREATOR_MONTHLY_MENTORSHIPS_MANAGEMENT_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_MANAGEMENT_READY: "true",
  CREATOR_MONTHLY_MENTORSHIPS_CHECKOUT_RECOVERY_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_CHECKOUT_RECOVERY_READY: "true",
  CREATOR_MONTHLY_MENTORSHIPS_INITIAL_ABANDONMENT_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_INITIAL_ABANDONMENT_READY: "true",
  CREATOR_MONTHLY_MENTORSHIPS_ACTIVATION_RECOVERY_SCHEMA_READY: "true",
  CREATOR_PROCESSING_FEE_ENABLED: "true", STRIPE_PROCESSING_FEE_BPS: "290", STRIPE_PROCESSING_FEE_FIXED_CENTS: "30",
  STRIPE_BILLING_FEE_BPS: "70", STRIPE_PROCESSING_FEE_SCHEDULE_VERSION: "synthetic-fixed-schedule",
};
/** Synthetic provider data, not evidence of a hosted payment or provider acceptance. */
export function membershipFixture(paid = false) {
  const offer = { id: "16000000-0000-4000-8000-000000000001", creator_id: "16000000-0000-4000-8000-000000000002",
    title: "Monthly mentor support", description: "Ongoing questions and support", type: "mentorship", amount_cents: 10000,
    price_cents: 10000, currency: "usd", membership_terms: { version: "monthly-mentorship-v1", minimumMonths: 3, autoRenew: true } };
  const quote = buildMembershipAgreement({ offer, buyerId: "16000000-0000-4000-8000-000000000003",
    postId: "16000000-0000-4000-8000-000000000004", destinationId: "acct_creator", context: membershipTestContext, env: membershipTestEnv });
  const now = Math.floor(Date.now() / 1000);
  const a: MembershipRecord = { id: "16000000-0000-4000-8000-000000000005", purchase_id: "16000000-0000-4000-8000-000000000006",
    buyer_id: quote.agreement.buyerId, creator_id: offer.creator_id, product_id: offer.id, post_id: quote.agreement.postId,
    terms: quote.agreement, fingerprint: quote.fingerprint, accepted_at: new Date((now - 60) * 1000).toISOString(),
    monthly_price_cents: 10000, minimum_months: 3, auto_renew: true, revision: 0, covered_months: 0, anchor_at: null,
    stripe_customer_id: "cus_fixture", stripe_subscription_id: "sub_fixture", stripe_checkout_session_id: "cs_test_fixture",
    financial_hold_at: null, renewal_stopped_at: null, debit_revoked_at: null };
  const p = buildMembershipCheckout(a, a.stripe_customer_id!, a.stripe_subscription_id!), times = membershipBootstrapTimes(a);
  const customer = { id: "cus_fixture", object: "customer", livemode: false, balance: 0, test_clock: null, default_source: null,
    email: null, invoice_settings: { default_payment_method: null }, metadata: membershipMetadata(a, "customer") } as unknown as Stripe.Customer;
  const product = { id: "prod_fixture", object: "product", active: true, livemode: false, default_price: null,
    name: a.terms.title, metadata: membershipMetadata(a, "product") } as unknown as Stripe.Product;
  const subscription = { id: "sub_fixture", object: "subscription", livemode: false, status: "trialing", customer: customer.id,
    billing_mode: { type: "classic" }, trial_end: times.trialEnd, cancel_at: times.cancelAt, cancel_at_period_end: false,
    default_payment_method: null, default_source: null, application_fee_percent: null,
    transfer_data: { destination: a.terms.destinationId }, collection_method: "charge_automatically", automatic_tax: { enabled: false },
    discounts: [], default_tax_rates: [], pending_update: null, schedule: null, test_clock: null,
    metadata: membershipMetadata(a, "subscription"), items: { has_more: false, data: [{ id: "si_fixture", quantity: 1, tax_rates: [], discounts: [],
      price: { id: "price_fixture", active: false, livemode: false, currency: "usd", product: product.id, unit_amount: 10000, billing_scheme: "per_unit",
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } } }] },
    payment_settings: { save_default_payment_method: "off", payment_method_types: ["card"] },
    trial_settings: { end_behavior: { missing_payment_method: "create_invoice" } }, pause_collection: { behavior: "keep_as_draft" },
  } as unknown as Stripe.Subscription;
  const session = { id: "cs_test_fixture", object: "checkout.session", livemode: false, mode: "payment", customer: customer.id,
    currency: "usd", amount_total: 10000, amount_subtotal: 10000, automatic_tax: { enabled: false },
    total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 }, invoice_creation: { enabled: false }, subscription: null, setup_intent: null,
    success_url: p.success_url, cancel_url: p.cancel_url, expires_at: p.expires_at, metadata: p.metadata, payment_method_types: ["card"],
    status: paid ? "complete" : "open", payment_status: paid ? "paid" : "unpaid", payment_intent: paid ? "pi_fixture" : null,
    url: paid ? null : "https://checkout.stripe.com/c/pay/cs_test_fixture" } as unknown as Stripe.Checkout.Session;
  const paymentIntent = { id: "pi_fixture", object: "payment_intent", livemode: false, status: "succeeded", customer: customer.id,
    currency: "usd", amount: 10000, amount_received: 10000, amount_capturable: 0, capture_method: "automatic", setup_future_usage: "off_session",
    application_fee_amount: a.terms.firstMonthFees.totalCreatorDeductionCents, transfer_data: { destination: a.terms.destinationId },
    metadata: p.payment_intent_data!.metadata, payment_method: "pm_fixture", latest_charge: "ch_fixture" } as unknown as Stripe.PaymentIntent;
  const charge = { id: "ch_fixture", object: "charge", payment_intent: paymentIntent.id, livemode: false, customer: customer.id,
    status: "succeeded", paid: true, captured: true, currency: "usd", amount: 10000, amount_captured: 10000,
    application_fee_amount: paymentIntent.application_fee_amount, payment_method: "pm_fixture", payment_method_details: { type: "card" },
    created: now, amount_refunded: 0, refunded: false, disputed: false, balance_transaction: "txn_fixture" } as unknown as Stripe.Charge;
  const balance = { id: "txn_fixture", object: "balance_transaction", source: charge.id, type: "charge", currency: "usd",
    amount: 10000, fee: 320, net: 9680 } as unknown as Stripe.BalanceTransaction;
  return { a, offer, quote, customer, product, subscription, session, paymentIntent, charge, balance };
}
