import type Stripe from "stripe";
import { mentorshipInstallmentQuote } from "../lib/mentorshipInstallmentQuote";
import { installmentMonthBoundary } from "../lib/installments/checkoutPreparation";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function buyerBootstrapFixture(anchor = Date.parse("2026-09-20T18:00:00Z") / 1000) {
  const context = { version: "exact-payment-context-v1" as const, mode: "test" as const, platformAccountId: "acct_platform",
    supabaseProjectRef: "abcdefghijklmnopqrst", siteOrigin: "https://synthetic-mentorship.vercel.app" };
  const fees = { enabled: true, basisPoints: 290, fixedCents: 30, version: "synthetic-card" };
  const quote = mentorshipInstallmentQuote({ buyerId: id(1), postId: id(4), paymentCount: 3, firstPaymentFees: fees, renewalFees: fees,
    product: { id: id(3), creator_id: id(2), type: "mentorship", title: "Ten months of mentorship", price_cents: 10001,
      currency: "usd", fixed_service_months: 10, installment_options: [3] } });
  const reservation = { id: id(5), requestId: id(6), attemptId: id(7), buyerId: id(1), productId: id(3), postId: id(4),
    destinationId: "acct_creator", acceptedAt: new Date((anchor - 10) * 1000).toISOString(), ...quote,
    status: "reserved" as const, providerOperationsAllowed: false as const };
  const metadata = { creatornet_installment_version: quote.terms.installmentVersion, creatornet_installment_reservation_id: id(5),
    creatornet_installment_request_id: id(6), buyer_id: id(1), creator_id: id(2), product_id: id(3), post_id: id(4),
    terms_fingerprint: quote.fingerprint, payment_mode: "test", platform_account_id: "acct_platform",
    supabase_project_ref: context.supabaseProjectRef, site_origin: context.siteOrigin };
  const customer = { object: "customer", id: "cus_owned", livemode: false, balance: 0, delinquent: false, default_source: null,
    invoice_settings: { default_payment_method: null }, test_clock: null, metadata: { ...metadata, operation_kind: "customer.create" } } as unknown as Stripe.Customer;
  const subscription = { object: "subscription", id: "sub_owned", livemode: false, customer: "cus_owned", status: "trialing",
    billing_mode: { type: "classic" }, trial_end: anchor + 48 * 3600, cancel_at: installmentMonthBoundary(anchor + 48 * 3600, 2),
    cancel_at_period_end: false, pause_collection: { behavior: "keep_as_draft" }, default_payment_method: null, default_source: null,
    application_fee_percent: null, transfer_data: { destination: "acct_creator" }, collection_method: "charge_automatically",
    automatic_tax: { enabled: false }, discounts: [], default_tax_rates: [], pending_update: null, schedule: null, test_clock: null,
    metadata: { ...metadata, operation_kind: "subscription.create" },
    items: { has_more: false, data: [{ id:"si_owned",subscription:"sub_owned",quantity: 1, tax_rates: [], discounts: [], price: { active: false, livemode: false, currency: "usd",
      product: "prod_owned", unit_amount: 3333, billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } } }] },
    payment_settings: { save_default_payment_method: "off", payment_method_types: ["card"] },
    trial_settings: { end_behavior: { missing_payment_method: "create_invoice" } } } as unknown as Stripe.Subscription;
  return { reservation, context, customer, subscription, nowSeconds: anchor + 60,
    dependencies: { customerId: "cus_owned", subscriptionId: "sub_owned", productId: "prod_owned", anchorSeconds: anchor },
    contextEvidence: { approvedContext: context, vercelEnvironment: "preview", stripeSecretKeyMode: "test", stripePublishableKeyMode: "test",
      observedPlatformAccountId: "acct_platform", observedSupabaseProjectRef: context.supabaseProjectRef,
      configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`, configuredSiteOrigin: context.siteOrigin } };
}
