import "server-only";

import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateInstallmentPlan } from "../installmentPlan";
import { assertAgreementId, type ExactAgreementStore } from "./agreementStore";
import { installmentMonthBoundary } from "./checkoutPreparation";
import { inspectExactFirstInstallment } from "./firstReceipt";
import { HELD_INSTALLMENT_VERSION } from "./heldInvoice";
import { hasExpectedFutureEnd } from "./scheduledEnd";

export type ExactActivation = Readonly<{
  agreementId: string; firstPaymentIntentId: string; firstPaidAt: number;
  paymentMethodId: string; subscriptionItemId: string; firstRenewalAt: number; cancelAt: number;
}>;
export type ActivationClaim = { status: "busy" | "review_required" } |
  { status: "new" | "complete"; authorization: ExactActivation };
export interface ExactActivationStore {
  claim(agreementId: string, paymentMethodId: string, subscriptionItemId: string, token: string): Promise<ActivationClaim>;
  complete(agreementId: string, token: string): Promise<void>;
}
const id = (v: string | { id: string } | null | undefined) => typeof v === "string" ? v : v?.id;
function requireThat(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Exact installment activation stopped: ${reason}`);
}
function parseAuthorization(value: unknown): ExactActivation {
  requireThat(value && typeof value === "object" && !Array.isArray(value), "invalid authorization");
  const a = value as ExactActivation;
  assertAgreementId(a.agreementId);
  requireThat(/^pi_[A-Za-z0-9]+$/.test(a.firstPaymentIntentId) && /^pm_[A-Za-z0-9]+$/.test(a.paymentMethodId) &&
    /^si_[A-Za-z0-9]+$/.test(a.subscriptionItemId) &&
    [a.firstPaidAt,a.firstRenewalAt,a.cancelAt].every((v) => Number.isSafeInteger(v) && v > 0) &&
    a.firstPaidAt < a.firstRenewalAt && a.firstRenewalAt < a.cancelAt, "invalid authorization fields");
  return Object.freeze({ agreementId: a.agreementId, firstPaymentIntentId: a.firstPaymentIntentId,
    firstPaidAt: a.firstPaidAt, paymentMethodId: a.paymentMethodId, subscriptionItemId: a.subscriptionItemId,
    firstRenewalAt: a.firstRenewalAt, cancelAt: a.cancelAt });
}
export function createExactActivationStore(admin: SupabaseClient): ExactActivationStore {
  return {
    async claim(agreementId, paymentMethodId, subscriptionItemId, token) {
      assertAgreementId(agreementId); assertAgreementId(token);
      const { data, error } = await admin.rpc("claim_exact_installment_activation", {
        p_agreement_id: agreementId, p_payment_method_id: paymentMethodId,
        p_subscription_item_id: subscriptionItemId, p_claim_token: token,
      });
      if (error) throw new Error("Exact installment activation claim failed");
      const result = data as unknown;
      if (result && typeof result === "object" && !Array.isArray(result) && "status" in result) {
        if (result.status === "busy" || result.status === "review_required") return { status: result.status };
        if ((result.status === "new" || result.status === "complete") && "authorization" in result) {
          return { status: result.status, authorization: parseAuthorization(result.authorization) };
        }
      }
      throw new Error("Invalid exact activation claim response");
    },
    async complete(agreementId, token) {
      assertAgreementId(agreementId); assertAgreementId(token);
      const { error } = await admin.rpc("complete_exact_installment_activation", {
        p_agreement_id: agreementId, p_claim_token: token,
      });
      if (error) throw new Error("Exact installment activation completion failed");
    },
  };
}

/** First renewal is one calendar month after capture. Stripe classic trial_end
 * resets its anchor to that renewal date, so subsequent offsets use THAT date.
 * Example: Jan 31 -> Feb 28 -> Mar 28, not a fabricated March 31 invoice.
 * No 30-day approximation, immediate second payment or unbounded renewal. */
export function exactActivationDates(paidAt: number, paymentCount: number) {
  requireThat(Number.isInteger(paymentCount) && paymentCount >= 2 && paymentCount <= 24, "invalid count");
  const firstRenewalAt = installmentMonthBoundary(paidAt, 1);
  return Object.freeze({ firstRenewalAt, cancelAt: installmentMonthBoundary(firstRenewalAt, paymentCount - 1) });
}

/** Sandbox candidate only, not called by enabled routes. Requires an already
 * counted first payment. Selects the card saved by that Checkout on its bound
 * customer; never creates/attaches a card or changes customer-wide defaults.
 * Activation configures future invoice dates while KEEPING COLLECTION HELD.
 * It never calls pay, confirm, resume, refund or creates another subscription.
 * Period expectations are not collection authorization; the later collector
 * still requires its own cancellation-safe invoice/period claim and acceptance.
 */
export async function activateExactInstallmentSandbox(args: {
  agreementId: string; sessionId: string; store: ExactAgreementStore; activationStore: ExactActivationStore;
  stripe: Pick<Stripe, "checkout" | "paymentIntents" | "charges" | "paymentMethods" | "customers" | "subscriptions" | "invoices">;
  env: Record<string,string | undefined>; now?: () => number;
}): Promise<Readonly<{ status: "activated_held"; firstRenewalAt: number; cancelAt: number }>> {
  const evidence = await inspectExactFirstInstallment(args);
  const { agreement: a, receipt, paymentMethodId } = evidence;
  const t = a.terms; const stripe = args.stripe;
  requireThat(evidence.refundedAmountCents === 0 && !evidence.disputed, "first payment requires review");
  requireThat(paymentMethodId && /^pm_[A-Za-z0-9]+$/.test(paymentMethodId) && evidence.cardReuseVerified,
    "captured reusable card identity missing");
  const now = args.now ?? (() => Math.floor(Date.now()/1000));
  const plan = calculateInstallmentPlan(t.totalCents,t.paymentCount,t.renewalFeeSchedule,t.firstPaymentFeeSchedule);
  const expected = exactActivationDates(receipt.paidAt,t.paymentCount);
  const bootstrapEnd = a.createdAt + 48*3600;
  const bootstrapCancel = installmentMonthBoundary(bootstrapEnd,t.paymentCount-1);
  requireThat(now() >= receipt.paidAt, "first payment is future dated");
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  requireThat(pm.id === paymentMethodId && pm.livemode === false && pm.type === "card" && id(pm.customer) === a.customerId,
    "saved card is not attached to this Checkout customer");

  const checkCustomer = async () => {
    const c = await stripe.customers.retrieve(a.customerId!);
    requireThat(!c.deleted && c.livemode === false && c.id === a.customerId && c.balance === 0 &&
      !c.default_source && (!c.invoice_settings.default_payment_method ||
        id(c.invoice_settings.default_payment_method) === paymentMethodId) &&
      c.metadata.installment_plan_id === a.id, "bootstrap customer state changed");
  };
  const checkSubscription = (s: Stripe.Subscription) => {
    requireThat(s.id === a.subscriptionId && s.livemode === false && id(s.customer) === a.customerId &&
      ["trialing","active"].includes(s.status) && s.billing_mode?.type === "classic" &&
      s.billing_cycle_anchor_config == null && s.schedule == null && s.pending_update == null &&
      (hasExpectedFutureEnd(s, bootstrapCancel, a.createdAt, now()) || hasExpectedFutureEnd(s, expected.cancelAt, a.createdAt, now())) &&
      s.pause_collection?.behavior === "keep_as_draft" && s.pause_collection.resumes_at == null &&
      s.collection_method === "charge_automatically" && s.default_source == null &&
      (s.default_payment_method == null || id(s.default_payment_method) === paymentMethodId) &&
      s.application_fee_percent == null && id(s.transfer_data?.destination) === t.destinationId &&
      s.transfer_data?.amount_percent == null && !s.automatic_tax.enabled && !s.discounts?.length &&
      !s.default_tax_rates?.length && s.billing_thresholds == null && s.pending_invoice_item_interval == null &&
      s.metadata.installment_collection_version === HELD_INSTALLMENT_VERSION &&
      s.metadata.installment_plan_id === a.id && s.metadata.booking_payment_id === t.bookingPaymentId &&
      s.items.has_more === false && s.items.data.length === 1, "held subscription identity/settings changed");
    const item = s.items.data[0];
    requireThat(/^si_[A-Za-z0-9]+$/.test(item.id) && item.quantity === 1 && item.subscription === s.id &&
      !item.tax_rates?.length && !item.discounts?.length && item.billing_thresholds == null &&
      item.price.unit_amount === plan.regularAmountCents && item.price.currency === "usd" &&
      item.price.recurring?.interval === "month" && item.price.recurring.interval_count === 1 &&
      item.price.recurring.usage_type === "licensed" && item.price.billing_scheme === "per_unit" &&
      item.price.transform_quantity == null, "monthly subscription item changed");
    return item.id;
  };
  await checkCustomer();
  let sub = await stripe.subscriptions.retrieve(a.subscriptionId!);
  const itemId = checkSubscription(sub);
  const token = randomUUID();
  const claim = await args.activationStore.claim(a.id,paymentMethodId,itemId,token);
  if (claim.status === "busy" || claim.status === "review_required") throw new Error(`Exact activation ${claim.status}`);
  requireThat("authorization" in claim, "missing durable authorization");
  const auth = claim.authorization;
  requireThat(auth.agreementId === a.id && auth.firstPaymentIntentId === receipt.paymentIntentId &&
    auth.firstPaidAt === receipt.paidAt && auth.paymentMethodId === paymentMethodId && auth.subscriptionItemId === itemId &&
    auth.firstRenewalAt === expected.firstRenewalAt && auth.cancelAt === expected.cancelAt, "persisted schedule mismatch");
  const isActivated = (s: Stripe.Subscription) => s.trial_end === auth.firstRenewalAt &&
    s.billing_cycle_anchor === auth.firstRenewalAt && s.cancel_at === auth.cancelAt &&
    id(s.default_payment_method) === paymentMethodId && s.metadata.installment_activation_version === "first-paid-v1" &&
    s.payment_settings?.payment_method_types?.length === 1 && s.payment_settings.payment_method_types[0] === "card" &&
    s.payment_settings.save_default_payment_method === "off";
  if (claim.status === "complete") {
    requireThat(isActivated(sub), "completed Stripe activation changed; review required");
    return Object.freeze({ status: "activated_held", ...expected });
  }

  requireThat(now() < bootstrapEnd && now() < auth.firstRenewalAt, "activation window expired; review required");
  // Fail closed rather than silently voiding or paying any unexpected invoice.
  // The temporary $0 bootstrap invoices never represent an installment receipt.
  const checkInvoices = async () => {
    const invoices = await stripe.invoices.list({ subscription: sub.id, limit: 100 });
    requireThat(invoices.has_more === false, "too many bootstrap invoices to verify");
    for (const inv of invoices.data) requireThat(inv.livemode === false &&
      id(inv.parent?.subscription_details?.subscription) === sub.id && id(inv.customer) === a.customerId &&
      inv.currency === "usd" && inv.total === 0 && inv.subtotal === 0 && inv.amount_due === 0 &&
      inv.amount_paid === 0 && inv.amount_overpaid === 0 && inv.starting_balance === 0 &&
      !inv.pre_payment_credit_notes_amount && !inv.post_payment_credit_notes_amount &&
      !inv.discounts?.length && !inv.total_discount_amounts?.length,
    "nonzero or unexpected bootstrap invoice; reconciliation required");
  };
  await checkInvoices();
  sub = await stripe.subscriptions.retrieve(a.subscriptionId!);
  requireThat(checkSubscription(sub) === itemId, "subscription item changed after claim");
  if (!isActivated(sub)) {
    requireThat(sub.status === "trialing" && sub.trial_end === bootstrapEnd && sub.cancel_at === bootstrapCancel &&
      sub.default_payment_method == null && !sub.metadata.installment_activation_version,
    "not the untouched bootstrap or verified activation");
    await checkCustomer();
    const params: Stripe.SubscriptionUpdateParams = {
      trial_end: auth.firstRenewalAt, cancel_at: auth.cancelAt, proration_behavior: "none",
      default_payment_method: paymentMethodId,
      pause_collection: { behavior: "keep_as_draft" },
      payment_settings: { payment_method_types: ["card"], save_default_payment_method: "off" },
      metadata: { installment_activation_version: "first-paid-v1" },
    };
    sub = await stripe.subscriptions.update(sub.id,params,{
      idempotencyKey: `${HELD_INSTALLMENT_VERSION}:${a.id}:activate-first-paid-v1`,
    });
    requireThat(checkSubscription(sub) === itemId && isActivated(sub), "Stripe did not return the agreed held schedule");
  }
  // Lost API/completion responses retry by inspecting the existing state; they
  // do not attach a second card, advance dates from retry time or resume billing.
  await checkInvoices();
  const finalSubscription = await stripe.subscriptions.retrieve(a.subscriptionId!);
  requireThat(checkSubscription(finalSubscription) === itemId && isActivated(finalSubscription),
    "held schedule changed before local completion");
  await args.activationStore.complete(a.id,token);
  return Object.freeze({ status: "activated_held", ...expected });
}
