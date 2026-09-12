import "server-only";

import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { calculateInstallmentPlan } from "../installmentPlan";
import { buildExactInstallmentCheckoutContract } from "./checkoutContract";
import { HELD_INSTALLMENT_VERSION } from "./heldInvoice";
import { operationHash, type BootstrapStep, type ExactAgreementStore } from "./agreementStore";

const STAGING_ORIGIN = "https://nwqfofezfzljhxolkycz.supabase.co";
type Env = Record<string, string | undefined>;

/** Independent gate; never accept a key/project/origin from an HTTP body. */
export function assertExactInstallmentSandbox(env: Env, previewOrigin: string) {
  if (env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE !== "true") {
    throw new Error("Exact installment preparation requires the explicitly enabled isolated Sandbox");
  }
  assertExactInstallmentEnvironment(env,previewOrigin);
}

/** Environment-only check for read-only binding quarantine during a feature
 * pause. It never authorizes preparation, collection, activation or credit. */
export function assertExactInstallmentEnvironment(env: Env, previewOrigin: string) {
  if (env.VERCEL_ENV !== "preview" ||
      !/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY || "") ||
      env.NEXT_PUBLIC_SUPABASE_URL !== STAGING_ORIGIN ||
      (env.SUPABASE_URL && env.SUPABASE_URL !== STAGING_ORIGIN) ||
      env.NEXT_PUBLIC_SITE_URL !== previewOrigin) {
    throw new Error("Exact installment preparation requires the explicitly enabled isolated Sandbox");
  }
  const origin = new URL(previewOrigin);
  if (origin.origin !== previewOrigin || origin.protocol !== "https:" ||
      !origin.hostname.endsWith(".vercel.app")) throw new Error("Invalid exact installment Preview origin");
}

/** Calendar-month arithmetic anchored on the original UTC day, not 30-day
 * approximations. This is bootstrap scheduling only, not paid-through state. */
export function installmentMonthBoundary(anchor: number, months: number): number {
  if (!Number.isSafeInteger(anchor) || anchor <= 0 || !Number.isInteger(months) || months < 0 || months > 24) {
    throw new Error("Invalid installment month boundary");
  }
  const original = new Date(anchor * 1000);
  const end = new Date(anchor * 1000);
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(original.getUTCDate(), lastDay));
  const result = Math.floor(end.getTime() / 1000);
  if (!Number.isSafeInteger(result)) throw new Error("Invalid installment month boundary");
  return result;
}

const stripeId = (v: string | { id: string } | null | undefined) => typeof v === "string" ? v : v?.id;
function requireThat(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Exact installment preparation stopped: ${reason}`);
}

/**
 * Staging integration candidate only: checkoutLink calls this behind separate
 * environment, schema, publication and booking-allowlist gates. Those must not
 * be enabled until the hosted acceptance plan is approved. This preparation
 * layer does not publish a URL, mark a booking paid, grant access,
 * attach a card, pay an invoice, resume collection or change an existing plan.
 *
 * Each creation is durably claimed before Stripe. Lost responses reuse the same
 * parameters/key only within the DB's conservative 20-hour window. A completed
 * operation is always retrieved, never recreated after Stripe key expiration.
 */
export async function prepareExactCheckoutSandbox(args: {
  agreementId: string;
  store: ExactAgreementStore;
  stripe: Pick<Stripe, "customers" | "products" | "subscriptions" | "checkout">;
  env: Env;
  now?: () => number;
}): Promise<Readonly<{ sessionId: string; subscriptionId: string; status: "prepared_unpublished" }>> {
  const { store, stripe } = args;
  const a = await store.load(args.agreementId);
  const t = a.terms;
  assertExactInstallmentSandbox(args.env, t.previewOrigin);
  requireThat(a.status === "preparing", "agreement is not a new preparation");
  const now = args.now ?? (() => Math.floor(Date.now() / 1000));
  const expiresAt = a.createdAt + 24 * 3600;
  const trialEnd = a.createdAt + 48 * 3600;
  const cancelAt = installmentMonthBoundary(trialEnd, t.paymentCount - 1);
  const plan = calculateInstallmentPlan(t.totalCents, t.paymentCount, t.renewalFeeSchedule, t.firstPaymentFeeSchedule);
  const metadata = { installment_collection_version: HELD_INSTALLMENT_VERSION,
    installment_plan_id: a.id, booking_payment_id: t.bookingPaymentId };

  async function step<T extends { id: string }>(name: BootstrapStep, params: unknown,
    create: (key: string) => Promise<T>, retrieve: (id: string) => Promise<T>, validate: (value: T) => void): Promise<T> {
    // No fresh/continued bootstrap late enough to outlive Checkout or the
    // temporary no-card trial. A reviewer must reconcile an aged attempt.
    requireThat(now() >= a.createdAt && now() < expiresAt - 31 * 60, "preparation window expired; review required");
    const fresh = await store.load(a.id);
    requireThat(fresh.status === "preparing" && operationHash(fresh.terms) === operationHash(t), "agreement state changed");
    const token = randomUUID();
    const claim = await store.claim(a.id, name, operationHash(params), token);
    if (claim.status === "busy" || claim.status === "review_required") throw new Error(`Installment operation ${claim.status}`);
    if (claim.status === "complete") {
      const result = await retrieve(claim.resultId);
      validate(result);
      return result;
    }
    requireThat(claim.status === "new", "operation was not claimed");
    const result = await create(`${HELD_INSTALLMENT_VERSION}:${a.id}:${name}`);
    validate(result);
    await store.complete(a.id, name, token, result.id);
    return result;
  }

  const customerParams: Stripe.CustomerCreateParams = { metadata };
  const checkCustomer = (c: Stripe.Customer | Stripe.DeletedCustomer) => {
    requireThat(!c.deleted && c.livemode === false && c.balance === 0 && !c.email &&
      !c.default_source && !c.invoice_settings.default_payment_method &&
      c.metadata.installment_plan_id === a.id, "customer is not the isolated no-card bootstrap customer");
  };
  const customer = await step("customer", customerParams,
    (key) => stripe.customers.create(customerParams, { idempotencyKey: key }),
    (id) => stripe.customers.retrieve(id), checkCustomer);
  const productParams: Stripe.ProductCreateParams = { name: `${t.title} installments`, metadata };
  const product = await step("product", productParams,
    (key) => stripe.products.create(productParams, { idempotencyKey: key }),
    (id) => stripe.products.retrieve(id), (p) => {
      requireThat(p.livemode === false && p.active && p.metadata.installment_plan_id === a.id,
        "product identity mismatch");
    });

  const subscriptionParams: Stripe.SubscriptionCreateParams = {
    customer: customer.id,
    items: [{ quantity: 1, price_data: { currency: "usd", product: product.id,
      unit_amount: plan.regularAmountCents, recurring: { interval: "month" } } }],
    trial_end: trialEnd, cancel_at: cancelAt, proration_behavior: "none",
    billing_mode: { type: "classic" },
    collection_method: "charge_automatically", transfer_data: { destination: t.destinationId },
    payment_settings: { payment_method_types: ["card"], save_default_payment_method: "off" },
    trial_settings: { end_behavior: { missing_payment_method: "create_invoice" } },
    metadata,
  };
  const checkSubscription = (s: Stripe.Subscription) => {
    requireThat(s.livemode === false && s.status === "trialing" && s.billing_mode?.type === "classic" && stripeId(s.customer) === customer.id &&
      s.trial_end === trialEnd && s.cancel_at === cancelAt && s.metadata.installment_plan_id === a.id &&
      s.metadata.booking_payment_id === t.bookingPaymentId &&
      s.metadata.installment_collection_version === HELD_INSTALLMENT_VERSION &&
      !s.default_payment_method && !s.default_source && s.application_fee_percent == null &&
      stripeId(s.transfer_data?.destination) === t.destinationId && s.transfer_data?.amount_percent == null &&
      s.collection_method === "charge_automatically" && !s.automatic_tax.enabled && !s.discounts.length &&
      s.payment_settings?.payment_method_types?.length === 1 && s.payment_settings.payment_method_types[0] === "card" &&
      s.payment_settings.save_default_payment_method === "off" &&
      s.items.has_more === false && s.items.data.length === 1 && s.items.data[0].quantity === 1 &&
      s.items.data[0].price.unit_amount === plan.regularAmountCents &&
      s.items.data[0].price.currency === "usd" && stripeId(s.items.data[0].price.product) === product.id &&
      s.items.data[0].price.recurring?.interval === "month" && s.items.data[0].price.recurring?.interval_count === 1,
    "subscription bootstrap mismatch");
  };
  const subscription = await step("subscription", subscriptionParams,
    (key) => stripe.subscriptions.create(subscriptionParams, { idempotencyKey: key }),
    (id) => stripe.subscriptions.retrieve(id), checkSubscription);
  const holdParams: Stripe.SubscriptionUpdateParams = { pause_collection: { behavior: "keep_as_draft" } };
  const checkHold = (s: Stripe.Subscription) => {
    checkSubscription(s);
    requireThat(s.pause_collection?.behavior === "keep_as_draft" && s.pause_collection.resumes_at == null,
      "indefinite collection hold missing");
  };
  await step("hold", { id: subscription.id, ...holdParams },
    (key) => stripe.subscriptions.update(subscription.id, holdParams, { idempotencyKey: key }),
    (id) => stripe.subscriptions.retrieve(id), checkHold);
  // Fresh reads before creating a payable session; a saved operation result
  // alone is not proof that the hold or no-card bootstrap still exists.
  checkCustomer(await stripe.customers.retrieve(customer.id));
  const held = await stripe.subscriptions.retrieve(subscription.id);
  checkHold(held);
  const checkoutParams: Stripe.Checkout.SessionCreateParams = {
    ...buildExactInstallmentCheckoutContract({ ...t, planId: a.id,
      customerId: customer.id, subscriptionId: subscription.id }, held), expires_at: expiresAt,
  };
  const checkout = await step("checkout", checkoutParams,
    (key) => stripe.checkout.sessions.create(checkoutParams, { idempotencyKey: key }),
    (id) => stripe.checkout.sessions.retrieve(id), (s) => {
      requireThat(s.livemode === false && s.status === "open" && s.mode === "payment" &&
        s.payment_status === "unpaid" && stripeId(s.customer) === customer.id &&
        s.currency === "usd" && s.amount_total === plan.payments[0].amountCents && s.expires_at === expiresAt &&
        s.metadata?.installment_plan_id === a.id && s.metadata.installment_subscription_id === subscription.id &&
        s.metadata.booking_payment_id === t.bookingPaymentId, "checkout identity/amount/state mismatch");
    });
  checkHold(await stripe.subscriptions.retrieve(subscription.id));
  await store.bind(a.id, customer.id, subscription.id, checkout.id);
  return Object.freeze({ sessionId: checkout.id, subscriptionId: subscription.id, status: "prepared_unpublished" });
}
