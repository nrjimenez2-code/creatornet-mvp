import "server-only";
import type Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import { assertAgreementId } from "./agreementStore";
import { calculateInstallmentPlan } from "../installmentPlan";
import { installmentMonthBoundary } from "./checkoutPreparation";
import type { ExactContextReservation } from "./contextReservation";
import { CONTEXT_CUSTOMER_API_VERSION, type ExactContextCustomerIntent } from "./contextBootstrap";

export type HeldBootstrapStage = "product" | "subscription" | "hold";
export type HeldBootstrapDependencies = Readonly<{ customerId: string; productId: string | null; subscriptionId: string | null }>;
export type HeldBootstrapRequest = Readonly<{ apiVersion: typeof CONTEXT_CUSTOMER_API_VERSION; method: "POST";
  path: string; params: Stripe.ProductCreateParams | Stripe.SubscriptionCreateParams | Stripe.SubscriptionUpdateParams }>;
export type HeldBootstrapAttempt = Readonly<{ id: string; reservation_id: string; stage: HeldBootstrapStage;
  anchor_seconds: number; claimed_at: string; request: HeldBootstrapRequest; idempotency_key: string }>;
export type HeldBootstrapBinding = Readonly<{ step_id: string; provider_id: string; request_id: string; bound_at: string }>;
export type HeldBootstrapDispatch = Readonly<{ claimed: boolean; attempt: HeldBootstrapAttempt | null; binding: HeldBootstrapBinding | null }>;
const fail = () => new Error("Exact held bootstrap requires review");
function check(value: unknown): asserts value { if (!value) throw fail(); }
const id = (value: unknown, prefix: string): string => {
  check(typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9]{1,196}$`).test(value)); return value;
};
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(value).length === keys.length);
  for (const key of keys) check(ds[key] && "value" in ds[key] && ds[key].enumerable);
  return value as Record<string, unknown>;
}
function metadata(intent: ExactContextCustomerIntent, stage: HeldBootstrapStage) {
  // The hold changes only pause_collection, so the subscription retains its
  // creation metadata. No existing v1 object is relabeled or adopted.
  return { ...intent.request.params.metadata, operation_kind: `${stage}.create` };
}

/** Same amounts/calendar and no-card trial->indefinite hold used by the existing
 * reviewed preparation. Only context and durable dependency identities differ.
 * No Checkout, payment, invoice collection or entitlement is constructed here. */
export function buildContextHeldRequest(r: ExactContextReservation, intent: ExactContextCustomerIntent,
  stage: HeldBootstrapStage, anchor: number, deps: HeldBootstrapDependencies): HeldBootstrapRequest {
  check(r.id === intent.reservationId && Number.isSafeInteger(anchor) && anchor >= r.createdAt);
  id(deps.customerId, "cus");
  const base = { apiVersion: CONTEXT_CUSTOMER_API_VERSION, method: "POST" } as const;
  if (stage === "product") return { ...base, path: "/v1/products", params: { name: `${r.terms.title} installments`, metadata: metadata(intent, stage) } };
  id(deps.productId, "prod");
  if (stage === "hold") return { ...base, path: `/v1/subscriptions/${id(deps.subscriptionId, "sub")}`,
    params: { pause_collection: { behavior: "keep_as_draft" } } };
  check(stage === "subscription");
  const t = r.terms, plan = calculateInstallmentPlan(t.totalCents, t.paymentCount, t.renewalFeeSchedule, t.firstPaymentFeeSchedule);
  const trialEnd = anchor + 48 * 3600;
  return { ...base, path: "/v1/subscriptions", params: {
    customer: deps.customerId,
    items: [{ quantity: 1, price_data: { currency: "usd", product: deps.productId!, unit_amount: plan.regularAmountCents,
      recurring: { interval: "month" } } }],
    trial_end: trialEnd, cancel_at: installmentMonthBoundary(trialEnd, t.paymentCount - 1), proration_behavior: "none",
    billing_mode: { type: "classic" }, collection_method: "charge_automatically",
    transfer_data: { destination: t.destinationId },
    payment_settings: { payment_method_types: ["card"], save_default_payment_method: "off" },
    trial_settings: { end_behavior: { missing_payment_method: "create_invoice" } }, metadata: metadata(intent, stage),
  } };
}

export function readContextHeldDispatch(value: unknown, r: ExactContextReservation, intent: ExactContextCustomerIntent,
  stage: HeldBootstrapStage, deps: HeldBootstrapDependencies): HeldBootstrapDispatch {
  const result = fields(value, ["claimed", "attempt", "binding"]);
  check(typeof result.claimed === "boolean");
  let attempt: HeldBootstrapAttempt | null = null, binding: HeldBootstrapBinding | null = null;
  if (result.attempt !== null) {
    const a = fields(result.attempt, ["id", "reservation_id", "stage", "anchor_seconds", "claimed_at", "request", "idempotency_key"]);
    check(typeof a.id === "string"); assertAgreementId(a.id);
    check(a.reservation_id === r.id && a.stage === stage && typeof a.anchor_seconds === "number" &&
      typeof a.claimed_at === "string" && Number.isFinite(Date.parse(a.claimed_at)) &&
      Date.parse(a.claimed_at) >= a.anchor_seconds * 1000 &&
      Date.parse(a.claimed_at) < (a.anchor_seconds + 24 * 3600 - 31 * 60) * 1000);
    const expected = buildContextHeldRequest(r, intent, stage, a.anchor_seconds, deps);
    check(isDeepStrictEqual(a.request, expected) &&
      a.idempotency_key === `cn-exact-v2-held:${a.id}:${intent.contextHash}:${intent.termsHash}`);
    attempt = Object.freeze({ ...a, request: expected }) as HeldBootstrapAttempt;
  }
  if (result.binding !== null) {
    const b = fields(result.binding, ["step_id", "provider_id", "request_id", "bound_at"]);
    check(attempt && b.step_id === attempt.id && typeof b.bound_at === "string" &&
      Date.parse(b.bound_at) >= Date.parse(attempt.claimed_at) && Date.parse(b.bound_at) <= Date.parse(attempt.claimed_at) + 60_000);
    id(b.provider_id, stage === "product" ? "prod" : "sub"); id(b.request_id, "req");
    if (stage === "hold") check(b.provider_id === deps.subscriptionId);
    binding = Object.freeze({ ...b }) as HeldBootstrapBinding;
  }
  check(!result.claimed || (attempt && !binding));
  return Object.freeze({ claimed: result.claimed, attempt, binding });
}

/** Validates a fresh known-object response, not just its metadata. Customers
 * are retrieved only by the durable 060 binding; attached defaults, credit,
 * email or a test clock invalidate this still-unpaid bootstrap. */
export function assertContextBootstrapCustomer(c: Stripe.Customer | Stripe.DeletedCustomer,
  intent: ExactContextCustomerIntent, customerId: string) {
  check(c.object === "customer" && !c.deleted && c.id === customerId && c.livemode === (intent.context.mode === "live") &&
    c.balance === 0 && c.email === null && c.default_source === null && c.invoice_settings?.default_payment_method === null &&
    c.test_clock === null && c.delinquent === false && isDeepStrictEqual(c.metadata, intent.request.params.metadata));
}
export function assertContextHeldObject(object: Stripe.Product | Stripe.Subscription, r: ExactContextReservation,
  intent: ExactContextCustomerIntent, attempt: HeldBootstrapAttempt, deps: HeldBootstrapDependencies,
  knownId: string | null, requireHold: boolean | null) {
  const stage = attempt.stage, live = r.context.mode === "live";
  check(object.livemode === live && (knownId === null || object.id === knownId));
  id(object.id, stage === "product" ? "prod" : "sub");
  if (knownId === null) check(Number.isSafeInteger(object.created) &&
    object.created >= Math.floor(Date.parse(attempt.claimed_at) / 1000) && object.created <= Math.floor(Date.now() / 1000));
  if (stage === "product") {
    check(object.object === "product");
    const p = object as Stripe.Product;
    check(p.active === true && p.name === `${r.terms.title} installments` && p.default_price === null &&
      isDeepStrictEqual(p.metadata, metadata(intent, "product"))); return;
  }
  check(object.object === "subscription"); const s = object as Stripe.Subscription;
  const expected = buildContextHeldRequest(r, intent, "subscription", attempt.anchor_seconds, deps).params as Stripe.SubscriptionCreateParams;
  const price = s.items?.data?.[0]?.price;
  check(s.status === "trialing" && s.billing_mode?.type === "classic" && s.customer === deps.customerId &&
    s.trial_end === expected.trial_end && s.cancel_at === expected.cancel_at && s.cancel_at_period_end === false &&
    s.default_payment_method === null && s.default_source === null && s.application_fee_percent === null &&
    s.transfer_data?.destination === r.terms.destinationId && s.transfer_data.amount_percent == null &&
    s.collection_method === "charge_automatically" && s.automatic_tax?.enabled === false && s.discounts?.length === 0 &&
    s.default_tax_rates?.length === 0 && s.pending_update === null && s.schedule === null && s.test_clock === null &&
    isDeepStrictEqual(s.metadata, metadata(intent, "subscription")) && s.items?.has_more === false && s.items.data.length === 1 &&
    s.items.data[0].quantity === 1 && s.items.data[0].tax_rates?.length === 0 && s.items.data[0].discounts?.length === 0 &&
    price?.active === true && price.livemode === live && price.currency === "usd" && price.product === deps.productId &&
    price.unit_amount === expected.items![0].price_data!.unit_amount && price.billing_scheme === "per_unit" &&
    price.recurring?.interval === "month" && price.recurring.interval_count === 1 && price.recurring.usage_type === "licensed" &&
    s.payment_settings?.save_default_payment_method === "off" &&
    isDeepStrictEqual(s.payment_settings.payment_method_types, ["card"]) &&
    s.trial_settings?.end_behavior?.missing_payment_method === "create_invoice");
  const held = s.pause_collection?.behavior === "keep_as_draft" && s.pause_collection.resumes_at == null;
  check(requireHold === null ? s.pause_collection === null || held : requireHold ? held : s.pause_collection === null);
}

/** Compare the installed SDK's actual form to the whole saved request. Arrays
 * must retain indices and extra/duplicate fields never pass. Not a dispatcher. */
export function exactHeldFormMatches(body: string, params: HeldBootstrapRequest["params"] | Stripe.Checkout.SessionCreateParams): boolean {
  const expected: Array<[string, string]> = [];
  function visit(value: unknown, path: string) {
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}[${key}]` : key);
    } else { check(typeof value === "string" || typeof value === "number" || typeof value === "boolean"); expected.push([path, String(value)]); }
  }
  visit(params, ""); const actual = [...new URLSearchParams(body).entries()];
  return actual.length === expected.length && expected.every(([key, value]) => actual.filter(([k, v]) => k === key && v === value).length === 1);
}
