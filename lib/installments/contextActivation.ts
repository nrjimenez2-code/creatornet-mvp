import "server-only";
import { isDeepStrictEqual } from "node:util";
import type Stripe from "stripe";
import { assertAgreementId } from "./agreementStore";
import { exactActivationDates } from "./activation";
import { installmentMonthBoundary } from "./checkoutPreparation";
import { calculateInstallmentPlan } from "../installmentPlan";
import { hasExpectedFutureEnd } from "./scheduledEnd";
import type { ExactContextReservation } from "./contextReservation";
import type { ExactContextCustomerIntent } from "./contextBootstrap";
import { contextStripeId, type inspectContextFirstCharge } from "./contextCheckout";

export type ContextFirstReceipt = ReturnType<typeof inspectContextFirstCharge>;
export type ContextActivationDependencies = Readonly<{ customerId: string; subscriptionId: string; productId: string; anchor: number }>;
export type ContextActivationState = Readonly<{ status: "running" | "complete"; claimToken: string;
  firstStartedAt: number; leaseUntil: number; authorization: ReturnType<typeof contextActivationAuthorization> }> | null;
function check(value: unknown): asserts value { if (!value) throw new Error("Exact context activation requires review"); }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(value); check(Reflect.ownKeys(ds).length === keys.length);
  for (const key of keys) check(ds[key] && "value" in ds[key] && ds[key].enumerable);
  return value as Record<string, unknown>;
}
export function contextActivationAuthorization(r: ExactContextReservation, receipt: ContextFirstReceipt, itemId: string) {
  contextStripeId(itemId, "si");
  return Object.freeze({ agreementId: r.id, firstPaymentIntentId: receipt.payment_intent_id, firstPaidAt: receipt.paid_at,
    paymentMethodId: receipt.payment_method_id, subscriptionItemId: itemId, ...exactActivationDates(receipt.paid_at, r.terms.paymentCount) });
}
export function readContextActivation(value: unknown, r: ExactContextReservation, receipt: ContextFirstReceipt, itemId: string): ContextActivationState {
  const v = fields(value, ["agreement_id", "payment_method_id", "activation"]);
  check(v.agreement_id === r.id && v.payment_method_id === receipt.payment_method_id);
  if (v.activation === null) return null;
  const a = fields(v.activation, ["agreement_id", "activation_snapshot", "status", "claim_token", "lease_until", "first_started_at", "activated_at"]);
  check(a.agreement_id === r.id && (a.status === "running" || a.status === "complete") && typeof a.claim_token === "string" &&
    typeof a.lease_until === "string" && typeof a.first_started_at === "string");
  assertAgreementId(a.claim_token);
  const start = Date.parse(a.first_started_at), lease = Date.parse(a.lease_until);
  check(Number.isFinite(start) && start >= receipt.paid_at * 1000 && start <= Date.now() && Number.isFinite(lease) && lease > start &&
    (a.status === "running" ? a.activated_at === null : typeof a.activated_at === "string" &&
      Date.parse(a.activated_at) >= start && Date.parse(a.activated_at) <= Date.now()));
  const authorization = contextActivationAuthorization(r, receipt, itemId);
  check(isDeepStrictEqual(a.activation_snapshot, authorization));
  return Object.freeze({ status: a.status, claimToken: a.claim_token, firstStartedAt: start, leaseUntil: lease, authorization });
}

export function contextActivationParams(r: ExactContextReservation, receipt: ContextFirstReceipt): Stripe.SubscriptionUpdateParams {
  const dates = exactActivationDates(receipt.paid_at, r.terms.paymentCount);
  // Same reviewed activation behavior: reuse the captured card, reset only the
  // future trial/anchor, fixed end, no proration and NO removal of the hold.
  return { trial_end: dates.firstRenewalAt, cancel_at: dates.cancelAt, proration_behavior: "none",
    default_payment_method: receipt.payment_method_id, pause_collection: { behavior: "keep_as_draft" },
    payment_settings: { payment_method_types: ["card"], save_default_payment_method: "off" },
    metadata: { installment_activation_version: "first-paid-context-v2" } };
}

export function assertContextActivationCard(pm: Stripe.PaymentMethod, customer: Stripe.Customer | Stripe.DeletedCustomer,
  r: ExactContextReservation, intent: ExactContextCustomerIntent, deps: ContextActivationDependencies, receipt: ContextFirstReceipt) {
  const live = r.context.mode === "live";
  check(pm.object === "payment_method" && pm.id === receipt.payment_method_id && pm.livemode === live && pm.type === "card" && pm.customer === deps.customerId);
  check(customer.object === "customer" && !customer.deleted && customer.id === deps.customerId && customer.livemode === live &&
    customer.balance === 0 && customer.default_source == null && customer.test_clock == null && customer.delinquent === false &&
    (customer.invoice_settings.default_payment_method == null || customer.invoice_settings.default_payment_method === pm.id) &&
    isDeepStrictEqual(customer.metadata, intent.request.params.metadata));
}

/** State is inspected as returned; no mode/metadata/anchor field is rewritten
 * to fit a v1 validator. Both legal states retain the indefinite payment hold. */
export function inspectContextActivationSubscription(s: Stripe.Subscription, r: ExactContextReservation, intent: ExactContextCustomerIntent,
  deps: ContextActivationDependencies, receipt: ContextFirstReceipt, allowPastDue = false): Readonly<{ itemId: string; activated: boolean }> {
  const live = r.context.mode === "live", now = Math.floor(Date.now() / 1000), t = r.terms;
  const dates = exactActivationDates(receipt.paid_at, t.paymentCount), bootstrapEnd = deps.anchor + 48 * 3600;
  const bootstrapCancel = installmentMonthBoundary(bootstrapEnd, t.paymentCount - 1);
  const activated = s.trial_end === dates.firstRenewalAt && s.billing_cycle_anchor === dates.firstRenewalAt &&
    s.cancel_at === dates.cancelAt && s.default_payment_method === receipt.payment_method_id &&
    s.metadata.installment_activation_version === "first-paid-context-v2";
  const metadata = { ...intent.request.params.metadata, operation_kind: "subscription.create",
    ...(activated ? { installment_activation_version: "first-paid-context-v2" } : {}) };
  check(s.object === "subscription" && s.id === deps.subscriptionId && s.livemode === live && s.customer === deps.customerId &&
    s.billing_mode?.type === "classic" && s.billing_cycle_anchor_config == null && s.schedule == null && s.pending_update == null &&
    s.test_clock == null && s.pause_collection?.behavior === "keep_as_draft" && s.pause_collection.resumes_at == null &&
    hasExpectedFutureEnd(s, activated ? dates.cancelAt : bootstrapCancel, deps.anchor, now, allowPastDue && activated) &&
    s.collection_method === "charge_automatically" && s.default_source == null && s.application_fee_percent == null &&
    s.transfer_data?.destination === t.destinationId && s.transfer_data.amount_percent == null && s.automatic_tax.enabled === false &&
    !s.discounts?.length && !s.default_tax_rates?.length && s.billing_thresholds == null && s.pending_invoice_item_interval == null &&
    s.trial_settings?.end_behavior?.missing_payment_method === "create_invoice" &&
    s.payment_settings?.save_default_payment_method === "off" && isDeepStrictEqual(s.payment_settings.payment_method_types, ["card"]) &&
    isDeepStrictEqual(s.metadata, metadata) && s.items.has_more === false && s.items.data.length === 1);
  if (!activated) check(s.status === "trialing" && s.trial_end === bootstrapEnd && s.cancel_at === bootstrapCancel &&
    s.default_payment_method == null && now < bootstrapEnd && now < dates.firstRenewalAt);
  const item = s.items.data[0], price = item.price;
  contextStripeId(item.id, "si");
  check(item.subscription === s.id && item.quantity === 1 && !item.tax_rates?.length && !item.discounts?.length && item.billing_thresholds == null &&
    price.active === true && price.livemode === live && price.product === deps.productId && price.currency === "usd" &&
    price.unit_amount === calculateInstallmentPlan(t.totalCents, t.paymentCount, t.renewalFeeSchedule, t.firstPaymentFeeSchedule).regularAmountCents &&
    price.recurring?.interval === "month" && price.recurring.interval_count === 1 && price.recurring.usage_type === "licensed" &&
    price.billing_scheme === "per_unit" && price.transform_quantity == null);
  return Object.freeze({ itemId: item.id, activated });
}

export function assertContextBootstrapInvoices(list: Stripe.ApiList<Stripe.Invoice>, r: ExactContextReservation, deps: ContextActivationDependencies) {
  check(list.object === "list" && list.has_more === false && Array.isArray(list.data));
  for (const inv of list.data) check(inv.object === "invoice" && inv.livemode === (r.context.mode === "live") &&
    inv.parent?.subscription_details?.subscription === deps.subscriptionId && inv.customer === deps.customerId && inv.currency === "usd" &&
    inv.total === 0 && inv.subtotal === 0 && inv.amount_due === 0 && inv.amount_paid === 0 && inv.amount_overpaid === 0 && inv.starting_balance === 0 &&
    !inv.pre_payment_credit_notes_amount && !inv.post_payment_credit_notes_amount && !inv.discounts?.length && !inv.total_discount_amounts?.length);
}
