import "server-only";
import { isSupportedStripeSnapshotVersion } from "../stripeSnapshotVersion";
import { isDeepStrictEqual } from "node:util";
import type Stripe from "stripe";
import { assertAgreementId } from "./agreementStore";
import { readExactContextReservation } from "./contextReservation";
import { readExactContextCustomerIntent } from "./contextBootstrap";
import { contextStripeId } from "./contextCheckout";
import { readContextFirstReceipt } from "./contextInvoice";
import { readContextActivation, inspectContextActivationSubscription } from "./contextActivation";
import { parseExactLifecycleRead, classifyExactSubscriptionLifecycle } from "./lifecycleEvents";
import type { ExactPaymentContext, ExactPaymentContextEvidence } from "./paymentContext";

function check(v: unknown): asserts v { if (!v) throw Error("Context subscription observation requires review"); }
function fields(v: unknown, keys: string[]): Record<string, unknown> {
  check(v && typeof v === "object" && !Array.isArray(v)); const ds = Object.getOwnPropertyDescriptors(v);
  check(Reflect.ownKeys(ds).length === keys.length && keys.every(k => ds[k] && "value" in ds[k] && ds[k].enumerable));
  return v as Record<string, unknown>;
}
const eventTypes = ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "customer.subscription.paused", "customer.subscription.resumed"];

/** Post-first-credit, audit/fencing only; no provider mutation or balance/access
 * policy. The private runtime retrieves actual account-bound event/state. */
export async function observeContextSubscription(args: {
  reservationId: string; actorId: string; eventId: string; context: ExactPaymentContext; stripe: Stripe; apiVersion: string;
  evidence(): Promise<ExactPaymentContextEvidence>; fresh(): void;
  rpc(name: "read_exact_context_subscription_v2" | "observe_exact_context_subscription_v2", params: object): Promise<unknown>;
  get<T>(path: string, read: () => Promise<T>): Promise<T>;
}) {
  const { reservationId, actorId, eventId, context, stripe, get } = args;
  assertAgreementId(reservationId); assertAgreementId(actorId); contextStripeId(eventId, "evt");
  const base = { p_reservation_id: reservationId, p_actor_id: actorId, p_context: context };
  async function read() {
    const evidence = await args.evidence(); args.fresh();
    const v = fields(await args.rpc("read_exact_context_subscription_v2", base), ["reservation", "operation", "dependencies",
      "firstReceipt", "activation", "lifecycle", "createdAt", "agreementStatus"]);
    const r = readExactContextReservation(v.reservation, evidence); check(r.id === reservationId && r.terms.creatorId === actorId);
    const intent = readExactContextCustomerIntent({ intentRow: v.operation, reservationRow: v.reservation, contextEvidence: evidence, actorId });
    check(intent.request.apiVersion === args.apiVersion);
    const d = fields(v.dependencies, ["customerId", "subscriptionId", "productId", "anchor"]);
    const deps = { customerId: contextStripeId(d.customerId, "cus"), subscriptionId: contextStripeId(d.subscriptionId, "sub"),
      productId: contextStripeId(d.productId, "prod"), anchor: Number(d.anchor) };
    check(Number.isSafeInteger(d.anchor) && deps.anchor >= r.createdAt && deps.anchor <= Math.floor(Date.now() / 1000));
    const receipt = readContextFirstReceipt(v.firstReceipt, r), lifecycle = parseExactLifecycleRead(v.lifecycle, r.id);
    const activation = readContextActivation(v.activation, r, receipt, lifecycle.basis.activation?.subscriptionItemId ?? "si_NotActivated");
    check(isDeepStrictEqual(activation?.authorization ?? null, lifecycle.basis.activation) &&
      (activation?.status ?? null) === lifecycle.basis.activationStatus && v.agreementStatus === lifecycle.basis.agreementStatus &&
      Number.isSafeInteger(v.createdAt) && Number(v.createdAt) >= r.createdAt && Number(v.createdAt) <= Math.floor(Date.now() / 1000));
    return { r, intent, deps, receipt, lifecycle, activation, createdAt: Number(v.createdAt) };
  }
  const state = await read(), { r, intent, deps, receipt, lifecycle, activation } = state;
  const event = await get(`/v1/events/${eventId}`, () => stripe.events.retrieve(eventId));
  check(event.object === "event" && event.id === eventId && isSupportedStripeSnapshotVersion(event.api_version, args.apiVersion) && event.livemode === (context.mode === "live") &&
    event.account == null && (event as unknown as { context?: unknown }).context == null && eventTypes.includes(event.type) &&
    Number.isSafeInteger(event.created) && event.created >= r.createdAt && event.created <= Math.floor(Date.now() / 1000));
  const object = event.data.object as Stripe.Subscription;
  check(object.object === "subscription" && object.id === deps.subscriptionId && object.livemode === event.livemode &&
    contextStripeId(object.customer, "cus") === deps.customerId);
  const locator = { id: eventId, type: event.type, subscriptionId: deps.subscriptionId, customerId: deps.customerId,
    created: event.created, livemode: event.livemode };
  const sub = await get(`/v1/subscriptions/${deps.subscriptionId}`, () => stripe.subscriptions.retrieve(deps.subscriptionId));
  check(sub.object === "subscription" && sub.id === deps.subscriptionId && sub.livemode === (context.mode === "live") &&
    contextStripeId(sub.customer, "cus") === deps.customerId);
  const disposition = classifyExactSubscriptionLifecycle(sub, lifecycle.basis, state.createdAt, Math.floor(Date.now() / 1000), () => {
    try {
      const inspected = inspectContextActivationSubscription(sub, r, intent, deps, receipt);
      // Between first credit and activation (or while that claim is running),
      // the original fully held bootstrap is expected. A completed activation
      // cannot be silently rolled back to it or adopted from a new item/card.
      return inspected.activated ? activation !== null && inspected.itemId === activation.authorization.subscriptionItemId : activation?.status !== "complete";
    } catch { return false; } // Owned schedule drift is durably fenced, not ACKed as normal.
  });
  const statuses = ["trialing", "active", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"];
  const timestamp = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const behavior = sub.pause_collection?.behavior;
  const details = { status: statuses.includes(sub.status) ? sub.status : "unknown", cancelAt: timestamp(sub.cancel_at),
    canceledAt: timestamp(sub.canceled_at), endedAt: timestamp(sub.ended_at),
    pauseBehavior: behavior == null ? null : ["keep_as_draft", "void", "mark_uncollectible"].includes(behavior) ? behavior : "unknown" };
  const fresh = await read();
  check(isDeepStrictEqual({ r, intent, deps, receipt, createdAt: state.createdAt },
    { r: fresh.r, intent: fresh.intent, deps: fresh.deps, receipt: fresh.receipt, createdAt: fresh.createdAt }));
  // Retain the original revision/basis. The SQL compare-and-swap prevents an
  // older read overwriting a concurrent observation/activation/stop/completion.
  await args.evidence(); args.fresh();
  const saved = fields(await args.rpc("observe_exact_context_subscription_v2", { ...base, p_event: locator, p_read: lifecycle,
    p_disposition: disposition, p_details: details }), ["reservationId", "eventId", "saved"]);
  check(saved.reservationId === reservationId && saved.eventId === eventId && typeof saved.saved === "boolean");
  return Object.freeze({ version: "exact-context-subscription-observation-v1" as const, reservationId, eventId,
    status: !saved.saved ? "reconciliation_required" as const : disposition === "review_required" ? "lifecycle_review_recorded" as const : "lifecycle_observed" as const,
    disposition, providerOperationsAllowed: false as const, collectionAllowed: false as const, publicationAllowed: false as const });
}
