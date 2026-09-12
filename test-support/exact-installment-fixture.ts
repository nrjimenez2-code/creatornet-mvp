import type Stripe from "stripe";
import { operationHash, snapshotExactTerms, type BootstrapStep, type ExactAgreement,
  type ExactAgreementStore, type FirstInstallmentReceipt } from "../lib/installments/agreementStore";

/** All IDs, objects and responses are synthetic. No Stripe/Supabase client is
 * constructed, and no environment variables or network connections are used. */
export function exactInstallmentFixture() {
  const terms = snapshotExactTerms({ version: "exact-cents-held-v1", currency: "usd",
    bookingPaymentId: "66666666-6666-4666-8666-666666666666", bookingId: "55555555-5555-4555-8555-555555555555",
    productId: "33333333-3333-4333-8333-333333333333", postId: "44444444-4444-4444-8444-444444444444",
    buyerId: "11111111-1111-4111-8111-111111111111", creatorId: "22222222-2222-4222-8222-222222222222",
    destinationId: "acct_fixture", title: "Synthetic mentorship", previewOrigin: "https://creatornet-test.vercel.app",
    totalCents: 199900, paymentCount: 3,
    firstPaymentFeeSchedule: { enabled: true, basisPoints: 290, fixedCents: 30, version: "synthetic-card" },
    renewalFeeSchedule: { enabled: true, basisPoints: 360, fixedCents: 30, version: "synthetic-billing" },
  });
  const agreement: ExactAgreement = { id: "77777777-7777-4777-8777-777777777777", terms,
    status: "preparing", createdAt: 1801396800, customerId: null, subscriptionId: null, sessionId: null };
  let current = agreement;
  const events: string[] = [];
  const operations = new Map<BootstrapStep, { hash: string; token: string; resultId?: string; busy: boolean }>();
  const receipts: FirstInstallmentReceipt[] = [];
  const store = {
    load: jest.fn(async () => current),
    claim: jest.fn<ReturnType<ExactAgreementStore["claim"]>, Parameters<ExactAgreementStore["claim"]>>(
      async (_id, step, hash, token) => {
        events.push(`claim:${step}`);
        const old = operations.get(step);
        if (old && old.hash !== hash) throw new Error("parameters changed");
        if (old?.resultId) return { status: "complete", resultId: old.resultId };
        if (old?.busy) return { status: "busy" };
        operations.set(step, { hash, token, busy: true });
        return { status: "new" };
      }),
    complete: jest.fn(async (_id: string, step: BootstrapStep, token: string, resultId: string) => {
      events.push(`complete:${step}`);
      const op = operations.get(step);
      if (!op || op.token !== token || !op.busy) throw new Error("claim lost");
      operations.set(step, { ...op, resultId, busy: false });
    }),
    bind: jest.fn(async (_id: string, customerId: string, subscriptionId: string, sessionId: string) => {
      events.push("bind");
      current = { ...current, status: "awaiting_first", customerId, subscriptionId, sessionId };
    }),
    recordFirstReceipt: jest.fn(async (_id: string, receipt: FirstInstallmentReceipt) => {
      if (receipts.length) {
        if (JSON.stringify(receipts[0]) !== JSON.stringify(receipt)) throw new Error("conflicting receipt");
        return false;
      }
      receipts.push(receipt);
      return true;
    }),
  } satisfies ExactAgreementStore;
  const metadata = { installment_collection_version: terms.version, installment_plan_id: agreement.id,
    booking_payment_id: terms.bookingPaymentId };
  const paymentMetadata = { ...metadata, installment_number: "1", installment_subscription_id: "sub_fixture",
    buyer_id: terms.buyerId, creator_id: terms.creatorId, post_id: terms.postId };
  const customer = { id: "cus_fixture", livemode: false, balance: 0, email: null, default_source: null,
    invoice_settings: { default_payment_method: null }, metadata } as unknown as Stripe.Customer;
  const product = { id: "prod_fixture", livemode: false, active: true, metadata } as unknown as Stripe.Product;
  const subscription = { id: "sub_fixture", livemode: false, status: "trialing", customer: customer.id,
    billing_mode: { type: "classic" },
    default_payment_method: null, default_source: null, application_fee_percent: null,
    transfer_data: { destination: terms.destinationId, amount_percent: null }, collection_method: "charge_automatically",
    automatic_tax: { enabled: false }, discounts: [], metadata, pause_collection: null,
    payment_settings: { payment_method_types: ["card"], save_default_payment_method: "off" },
    items: { has_more: false, data: [{ quantity: 1, price: { unit_amount: 66633, currency: "usd",
      product: product.id, recurring: { interval: "month", interval_count: 1 } } }] },
  } as unknown as Stripe.Subscription;
  const session = { id: "cs_test_fixture", livemode: false, mode: "payment", status: "open", payment_status: "unpaid",
    customer: customer.id, currency: "usd", amount_total: 66633, amount_subtotal: 66633,
    total_details: { amount_tax: 0, amount_discount: 0, amount_shipping: 0 }, metadata: paymentMetadata,
    payment_intent: "pi_fixture", url: "https://checkout.stripe.com/synthetic-do-not-use" } as unknown as Stripe.Checkout.Session;
  const pi = { id: "pi_fixture", livemode: false, status: "succeeded", currency: "usd", customer: customer.id,
    amount: 66633, amount_received: 66633, application_fee_amount: 9958,
    transfer_data: { destination: terms.destinationId }, setup_future_usage: "off_session", metadata: paymentMetadata,
    latest_charge: "ch_fixture", payment_method: "pm_fixture", client_secret: "synthetic-never-return" } as unknown as Stripe.PaymentIntent;
  const charge = { id: "ch_fixture", livemode: false, paid: true, captured: true, status: "succeeded",
    payment_intent: pi.id, customer: customer.id, currency: "usd", amount: 66633, amount_captured: 66633,
    payment_method_details: { type: "card" }, created: agreement.createdAt + 60,
    refunded: false, amount_refunded: 0, balance_transaction: "txn_fixture", disputed: false,
    payment_method: "pm_fixture" } as unknown as Stripe.Charge;
  const beforeStripe = (step: BootstrapStep, params: unknown, options: Stripe.RequestOptions) => {
    events.push(`stripe:${step}`);
    const claim = operations.get(step);
    if (!claim?.busy || claim.hash !== operationHash(params)) throw new Error("Stripe called without matching durable claim");
    if (options.idempotencyKey !== `${terms.version}:${agreement.id}:${step}`) throw new Error("Unstable idempotency key");
  };
  const mocks = {
    customers: {
      create: jest.fn(async (p: Stripe.CustomerCreateParams, o: Stripe.RequestOptions) => { beforeStripe("customer", p, o); return customer; }),
      retrieve: jest.fn(async () => customer),
    },
    products: {
      create: jest.fn(async (p: Stripe.ProductCreateParams, o: Stripe.RequestOptions) => { beforeStripe("product", p, o); return product; }),
      retrieve: jest.fn(async () => product),
    },
    subscriptions: {
      create: jest.fn(async (p: Stripe.SubscriptionCreateParams, o: Stripe.RequestOptions) => {
        beforeStripe("subscription", p, o);
        subscription.trial_end = p.trial_end as number;
        subscription.cancel_at = p.cancel_at as number;
        return subscription;
      }),
      retrieve: jest.fn(async () => subscription),
      update: jest.fn(async (id: string, p: Stripe.SubscriptionUpdateParams, o: Stripe.RequestOptions) => {
        beforeStripe("hold", { id, ...p }, o); subscription.pause_collection = { behavior: "keep_as_draft", resumes_at: null };
        return subscription;
      }),
    },
    checkout: { sessions: {
      create: jest.fn(async (p: Stripe.Checkout.SessionCreateParams, o: Stripe.RequestOptions) => {
        beforeStripe("checkout", p, o); session.expires_at = p.expires_at!;
        return session;
      }),
      retrieve: jest.fn(async () => session),
    } },
    paymentIntents: { retrieve: jest.fn(async () => pi) },
    charges: { retrieve: jest.fn(async () => charge) },
  };
  const stripe = mocks as unknown as Pick<Stripe, "customers" | "products" | "subscriptions" | "checkout" | "paymentIntents" | "charges">;
  const env = { CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE: "true", VERCEL_ENV: "preview",
    STRIPE_SECRET_KEY: "sk_test_synthetic_not_a_key", NEXT_PUBLIC_SUPABASE_URL: "https://nwqfofezfzljhxolkycz.supabase.co",
    NEXT_PUBLIC_SITE_URL: terms.previewOrigin };
  return { terms, agreement, store, operations, receipts, events, stripe, mocks, env,
    customer, product, subscription, session, pi, charge,
    args: { agreementId: agreement.id, store, stripe, env, now: () => agreement.createdAt + 1 },
    setAgreement: (changes: Partial<ExactAgreement>) => { current = { ...current, ...changes }; },
    releaseLeases: () => { for (const op of operations.values()) op.busy = false; },
    paid: () => {
      current = { ...current, status: "awaiting_first", customerId: customer.id, subscriptionId: subscription.id, sessionId: session.id };
      session.status = "complete"; session.payment_status = "paid";
    },
  };
}
