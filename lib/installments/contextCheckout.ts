import "server-only";
import { isDeepStrictEqual } from "node:util";
import type Stripe from "stripe";
import { assertAgreementId } from "./agreementStore";
import { calculateInstallmentPlan } from "../installmentPlan";
import { creatorFeeMetadata } from "../money";
import { buildFixedTotalCheckoutPayload } from "./checkoutContract";
import { fixedServiceEndAt } from "../fixedServiceTerms";
import { CONTEXT_CUSTOMER_API_VERSION, type ExactContextCustomerIntent } from "./contextBootstrap";
import type { ExactContextReservation } from "./contextReservation";

export type ContextCheckoutDependencies = Readonly<{ customerId: string; subscriptionId: string; anchor: number }>;
export type ContextCheckoutRequest = Readonly<{ apiVersion: typeof CONTEXT_CUSTOMER_API_VERSION; method: "POST";
  path: "/v1/checkout/sessions"; params: Stripe.Checkout.SessionCreateParams }>;
export type ContextCheckoutAttempt = Readonly<{ id: string; reservation_id: string; claimed_at: string;
  request: ContextCheckoutRequest; idempotency_key: string }>;
export type ContextCheckoutBinding = Readonly<{ attempt_id: string; session_id: string; request_id: string; bound_at: string }>;
export type ContextCheckoutState = Readonly<{ claimed: boolean; attempt: ContextCheckoutAttempt | null; binding: ContextCheckoutBinding | null }>;
const fail = () => new Error("Exact context Checkout requires review");
function check(value: unknown): asserts value { if (!value) throw fail(); }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(value); check(Reflect.ownKeys(ds).length === keys.length);
  for (const key of keys) check(ds[key] && "value" in ds[key] && ds[key].enumerable);
  return value as Record<string, unknown>;
}
export function contextStripeId(value: unknown, prefix: string): string {
  // Opaque syntax is a type/length check, not test/live evidence.
  check(typeof value === "string" && value.length <= 200 && value.startsWith(prefix + "_") &&
    value.length > prefix.length + 1 && /^[A-Za-z0-9_]+$/.test(value)); return value;
}
export function buildContextCheckoutRequest(r: ExactContextReservation, intent: ExactContextCustomerIntent,
  deps: ContextCheckoutDependencies): ContextCheckoutRequest {
  check(r.id === intent.reservationId && Number.isSafeInteger(deps.anchor) && deps.anchor >= r.createdAt);
  contextStripeId(deps.customerId, "cus"); contextStripeId(deps.subscriptionId, "sub");
  if (r.terms.serviceMonths !== undefined) fixedServiceEndAt(deps.anchor + 24 * 3600, r.terms.serviceMonths);
  const t = r.terms, first = calculateInstallmentPlan(t.totalCents, t.paymentCount, t.renewalFeeSchedule, t.firstPaymentFeeSchedule).payments[0];
  const metadata = { ...intent.request.params.metadata, operation_kind: "checkout.create", installment_number: "1",
    installment_subscription_id: deps.subscriptionId, post_id: t.postId, product_id: t.productId,
    creator_stripe_account_id: t.destinationId, plan_type: "installment", plan_months: String(t.paymentCount),
    installment_total_cents: String(t.totalCents), ...creatorFeeMetadata(first.fees) };
  return { apiVersion: CONTEXT_CUSTOMER_API_VERSION, method: "POST", path: "/v1/checkout/sessions", params: {
    ...buildFixedTotalCheckoutPayload({ ...t, customerId: deps.customerId, origin: r.context.siteOrigin }, metadata, t.purchaseConsentVersion, t.serviceMonths),
    expires_at: deps.anchor + 24 * 3600,
  } };
}
export function readContextCheckoutState(value: unknown, r: ExactContextReservation, intent: ExactContextCustomerIntent,
  deps: ContextCheckoutDependencies): ContextCheckoutState {
  const state = fields(value, ["claimed", "attempt", "binding"]); check(typeof state.claimed === "boolean");
  let attempt: ContextCheckoutAttempt | null = null, binding: ContextCheckoutBinding | null = null;
  if (state.attempt !== null) {
    const a = fields(state.attempt, ["id", "reservation_id", "claimed_at", "request", "idempotency_key"]);
    check(typeof a.id === "string"); assertAgreementId(a.id);
    const request = buildContextCheckoutRequest(r, intent, deps);
    check(a.reservation_id === r.id && typeof a.claimed_at === "string" && Date.parse(a.claimed_at) >= deps.anchor * 1000 &&
      Date.parse(a.claimed_at) < (deps.anchor + 24 * 3600 - 31 * 60) * 1000 && isDeepStrictEqual(a.request, request) &&
      a.idempotency_key === `cn-exact-v2-checkout:${a.id}:${intent.contextHash}:${intent.termsHash}`);
    attempt = Object.freeze({ ...a, request }) as ContextCheckoutAttempt;
  }
  if (state.binding !== null) {
    const b = fields(state.binding, ["attempt_id", "session_id", "request_id", "bound_at"]);
    check(attempt && b.attempt_id === attempt.id && typeof b.bound_at === "string" &&
      Date.parse(b.bound_at) >= Date.parse(attempt.claimed_at) && Date.parse(b.bound_at) <= Date.parse(attempt.claimed_at) + 60_000);
    contextStripeId(b.session_id, "cs"); contextStripeId(b.request_id, "req"); binding = Object.freeze({ ...b }) as ContextCheckoutBinding;
  }
  check(!state.claimed || (attempt && !binding)); return Object.freeze({ claimed: state.claimed, attempt, binding });
}

export function assertContextCheckoutSession(s: Stripe.Checkout.Session, r: ExactContextReservation,
  attempt: ContextCheckoutAttempt, deps: ContextCheckoutDependencies, expectedId: string | null, paid: boolean | "observe_unpaid") {
  const p = attempt.request.params, gross = p.line_items![0].price_data!.unit_amount!;
  contextStripeId(s.id, "cs");
  check(s.object === "checkout.session" && (expectedId === null || s.id === expectedId) && s.livemode === (r.context.mode === "live") &&
    s.customer === deps.customerId && s.mode === "payment" &&
    (paid === "observe_unpaid" ? s.status === "open" || s.status === "expired" : s.status === (paid ? "complete" : "open")) &&
    s.payment_status === (paid === true ? "paid" : "unpaid") && s.currency === "usd" && s.amount_subtotal === gross && s.amount_total === gross &&
    s.total_details?.amount_discount === 0 && s.total_details.amount_tax === 0 && s.total_details.amount_shipping === 0 &&
    s.automatic_tax?.enabled === false && s.allow_promotion_codes === false && s.invoice_creation?.enabled === false &&
    s.subscription === null && s.setup_intent === null && s.payment_link === null && s.recovered_from === null &&
    s.expires_at === p.expires_at && s.success_url === p.success_url && s.cancel_url === p.cancel_url &&
    isDeepStrictEqual(s.payment_method_types, ["card"]) && isDeepStrictEqual(s.metadata, p.metadata) &&
    isDeepStrictEqual(s.custom_text?.submit, p.custom_text?.submit) &&
    s.consent_collection?.payment_method_reuse_agreement?.position === "auto" && Number.isSafeInteger(s.created) &&
    s.created >= Math.floor(Date.parse(attempt.claimed_at) / 1000) && s.created <= Math.floor(Date.now() / 1000));
  if (r.terms.purchaseConsentVersion) {
    check(p.consent_collection?.terms_of_service === "required" && s.consent_collection?.terms_of_service === "required");
    if (paid === true) check(s.consent?.terms_of_service === "accepted");
  }
  if (paid === true || paid === "observe_unpaid" && s.payment_intent !== null) contextStripeId(s.payment_intent, "pi");
  else check(s.payment_intent === null);
}

/** Already-captured first payment only. The caller retrieves every object with
 * the same independently observed account/mode client and known relationship.
 * A passed receipt is not collection/credit/access authority or legal approval. */
export function inspectContextFirstCharge(r: ExactContextReservation, attempt: ContextCheckoutAttempt,
  deps: ContextCheckoutDependencies, session: Stripe.Checkout.Session, pi: Stripe.PaymentIntent, charge: Stripe.Charge,
  balance: Stripe.BalanceTransaction) {
  const p = attempt.request.params, gross = p.line_items![0].price_data!.unit_amount!, fee = p.payment_intent_data!.application_fee_amount!;
  const live = r.context.mode === "live";
  if (r.terms.purchaseConsentVersion) {
    check(p.consent_collection?.terms_of_service === "required" && session.consent_collection?.terms_of_service === "required" &&
      session.consent?.terms_of_service === "accepted");
  }
  check(pi.object === "payment_intent" && pi.id === session.payment_intent && pi.livemode === live && pi.status === "succeeded" &&
    pi.currency === "usd" && pi.customer === deps.customerId && pi.amount === gross && pi.amount_received === gross &&
    pi.application_fee_amount === fee && pi.transfer_data?.destination === r.terms.destinationId && pi.transfer_data.amount == null &&
    pi.setup_future_usage === "off_session" && isDeepStrictEqual(pi.metadata, p.payment_intent_data!.metadata));
  contextStripeId(pi.payment_method, "pm");
  check(charge.object === "charge" && charge.id === pi.latest_charge && charge.payment_intent === pi.id && charge.customer === deps.customerId &&
    charge.livemode === live && charge.status === "succeeded" && charge.paid === true && charge.captured === true && charge.currency === "usd" &&
    charge.amount === gross && charge.amount_captured === gross && charge.application_fee_amount === fee &&
    charge.payment_method_details?.type === "card" && charge.payment_method === pi.payment_method &&
    charge.refunded === false && charge.amount_refunded === 0 && charge.disputed === false &&
    Number.isSafeInteger(charge.created) && charge.created >= session.created && charge.created <= Math.floor(Date.now() / 1000));
  // Balance transactions have no livemode. Their known captured-charge source
  // and the same authenticated account establish this relationship instead.
  check(balance.object === "balance_transaction" && balance.id === charge.balance_transaction && balance.source === charge.id &&
    balance.type === "charge" && balance.currency === "usd" && balance.amount === gross && Number.isSafeInteger(balance.fee) &&
    balance.fee >= 0 && balance.fee <= 99999999 && balance.net === balance.amount - balance.fee);
  return Object.freeze({ session_id: session.id, payment_intent_id: pi.id, charge_id: charge.id, balance_transaction_id: balance.id,
    payment_method_id: pi.payment_method as string, amount_cents: gross, application_fee_cents: fee,
    actual_stripe_fee_cents: balance.fee, paid_at: charge.created,
    ...(r.terms.purchaseConsentVersion ? { purchase_consent_version: r.terms.purchaseConsentVersion } : {}) });
}
