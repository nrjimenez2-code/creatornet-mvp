import "server-only";
import { isSupportedStripeSnapshotVersion } from "../stripeSnapshotVersion";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isDeepStrictEqual } from "node:util";
import { CONTEXT_RESERVATION_VERSION } from "./contextReservation";
import { assertAgreementId } from "./agreementStore";
import { contextStripeId } from "./contextCheckout";
import { exactContextServerConfig } from "./contextServer";
import { createExactContextCheckout, createExactContextFirstCredit, createExactContextActivation,
  createExactContextInvoiceCollection, createExactContextFinancialEvents, createExactContextSubscriptionObservation,
  createExactContextPaymentRecovery, createExactContextBankVerification } from "./contextRuntime";

function check(v: unknown): asserts v { if (!v) throw Error("Context event needs retry or review"); }
type Row = Record<string, unknown>;
function row(v: unknown): Row { check(v && typeof v === "object" && !Array.isArray(v)); return v as Row; }
function id(v: unknown, prefix: string) { return contextStripeId(typeof v === "string" ? v : row(v).id, prefix); }
function hints(v: unknown) {
  const o = row(v), direct = o.metadata == null ? {} : row(o.metadata);
  const parent = o.parent == null ? {} : row(o.parent), details = parent.subscription_details == null ? {} : row(parent.subscription_details);
  const inherited = details.metadata == null ? {} : row(details.metadata);
  const markers = [direct.installment_collection_version, inherited.installment_collection_version].filter(v => v !== undefined);
  if (!markers.includes(CONTEXT_RESERVATION_VERSION)) return null;
  check(markers.every(v => v === CONTEXT_RESERVATION_VERSION));
  const values = [direct.installment_plan_id, inherited.installment_plan_id].filter(v => v !== undefined);
  check(values.length > 0 && values.every(v => v === values[0]) && typeof values[0] === "string");
  assertAgreementId(values[0]); return values[0];
}

/** #2/#3: invoked only inside the existing signed-event claim. No second event
 * lock/table or alternate accounting path. A not-ready result throws, leaving
 * the canonical route to release its claim and return a retryable non-2xx. */
export async function handoffContextInstallmentEvent(args: {
  event: Stripe.Event; admin: SupabaseClient; stripe: Stripe; env: Record<string, string | undefined>;
}): Promise<boolean> {
  const { event, admin, stripe, env } = args;
  let object = row(event.data.object), hint = hints(object);
  if (env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY !== "true") {
    check(hint === null); return false;
  }
  let kind: "session" | "subscription" | "intent", providerId: string;
  const subscriptionEvent = event.type.startsWith("customer.subscription.");
  const invoiceEvent = event.type.startsWith("invoice.");
  const financialEvent = event.type === "charge.refunded" || event.type.startsWith("refund.") || event.type.startsWith("charge.dispute.");
  if (object.object === "checkout.session") { kind = "session"; providerId = id(object.id, "cs"); }
  else if (subscriptionEvent) { kind = "subscription"; providerId = id(object.id, "sub"); }
  else if (invoiceEvent) {
    const parent = object.parent == null ? {} : row(object.parent), details = parent.subscription_details == null ? {} : row(parent.subscription_details);
    if (!details.subscription) { check(hint === null); return false; }
    kind = "subscription"; providerId = id(details.subscription, "sub");
  } else if (object.object === "payment_intent") { kind = "intent"; providerId = id(object.id, "pi"); }
  else if (["charge", "refund", "dispute"].includes(String(object.object))) {
    kind = "intent";
    if (!object.payment_intent) {
      const chargeId = object.object === "charge" ? id(object.id, "ch") : id(object.charge, "ch");
      const charge = await stripe.charges.retrieve(chargeId);
      check(charge.id === chargeId && charge.livemode === event.livemode);
      object = { ...object, payment_intent: charge.payment_intent };
    }
    if (!object.payment_intent) { check(hint === null); return false; }
    providerId = id(object.payment_intent, "pi");
  } else { check(hint === null); return false; }
  const resolve = async () => {
    const result = await admin.rpc("resolve_exact_context_event_v2", { p_kind: kind, p_provider_id: providerId, p_hint: hint });
    check(!result.error); return result.data === null ? null : row(result.data);
  };
  let binding = await resolve();
  // First-charge and refund notifications may omit metadata and precede the
  // receipt. A fresh PI hint only locates a candidate; payment proof below or
  // the retry boundary still decides whether anything may be acknowledged.
  if (!binding && kind === "intent") {
    const pi = await stripe.paymentIntents.retrieve(providerId);
    check(pi.id === providerId && pi.livemode === event.livemode); hint = hints(pi);
    if (hint) binding = await resolve();
  }
  if (!binding) { check(hint === null); return false; }
  const config = exactContextServerConfig(env);
  check(event.livemode === (config.approvedContext.mode === "live") && event.account == null &&
    (event as unknown as Row).context == null && isSupportedStripeSnapshotVersion(event.api_version, config.expectedApiVersion) &&
    isDeepStrictEqual(binding.context, config.approvedContext));
  const reservationId = String(binding.reservationId), actorId = String(binding.creatorId), buyerId = String(binding.buyerId);
  assertAgreementId(reservationId); assertAgreementId(actorId); assertAgreementId(buyerId);
  check(typeof binding.firstCredited === "boolean");
  if (kind === "session") check(binding.sessionId === providerId);
  if (kind === "subscription") check(binding.subscriptionId === providerId);
  if (object.customer != null) check(id(object.customer, "cus") === binding.customerId);
  const firstCandidate = kind === "session" || binding.paymentNumber === 1 || kind === "intent" && binding.paymentNumber === null;
  if (firstCandidate && (event.type === "checkout.session.expired" || event.type === "payment_intent.payment_failed")) {
    const observed = await createExactContextCheckout(config).inspectUnpaidCheckout(reservationId, actorId);
    if ("receipt" in observed) {
      // A delayed failure can follow actual success. Until that captured first
      // payment is credited, preserve the existing retry boundary.
      check(binding.firstCredited && (kind === "session" ? observed.receipt.session_id === providerId : observed.receipt.payment_intent_id === providerId));
    } else {
      check(observed.status === "checkout_unpaid_observed" && binding.firstCredited === false);
      check(kind === "session" ? observed.sessionId === providerId && observed.sessionStatus === "expired" : observed.paymentIntentId === providerId);
    }
    return true; // Observation only: no new link, charge, cancel, credit or access.
  }
  if (invoiceEvent && ["invoice.created", "invoice.paid", "invoice.payment_succeeded"].includes(event.type)) {
    const bootstrap = await createExactContextCheckout(config).inspectBootstrapInvoice(reservationId, actorId, id(object.id, "in"));
    if (bootstrap.status === "bootstrap_zero") return true; // No installment credit or access.
  }
  const firstSignal = event.type === "checkout.session.completed" || event.type === "payment_intent.succeeded" ||
    event.type === "charge.succeeded" || event.type === "charge.updated";
  if (firstSignal && firstCandidate) {
    const proof = await createExactContextCheckout(config).inspectFirstPayment(reservationId, actorId);
    check("receipt" in proof);
    check(kind === "session" ? proof.receipt.session_id === providerId : proof.receipt.payment_intent_id === providerId);
    const credited = await createExactContextFirstCredit(config).creditFirstPayment(reservationId, actorId);
    check(credited.status === "first_payment_fulfilled");
    const activated = await createExactContextActivation(config).activateHeld(reservationId, actorId);
    check(activated.status === "activated_held"); return true;
  }
  // This is deliberately before any invoice collection, refund/lifecycle
  // observation or success ACK. Same event ID can retry after first credit.
  check(binding.firstCredited === true);
  if (financialEvent) {
    const result = await createExactContextFinancialEvents(config).reconcileEvent(reservationId, actorId, event.id);
    check(["refund_reconciled", "lifecycle_observed", "lifecycle_review_recorded"].includes(result.status)); return true;
  }
  if (subscriptionEvent) {
    const result = await createExactContextSubscriptionObservation(config).observeSubscription(reservationId, actorId, event.id);
    check(["lifecycle_observed", "lifecycle_review_recorded"].includes(result.status)); return true;
  }
  if (invoiceEvent) {
    const invoiceId = id(object.id, "in");
    if (["invoice.payment_failed", "invoice.payment_action_required", "invoice.voided", "invoice.marked_uncollectible"].includes(event.type)) {
      const result = await createExactContextPaymentRecovery(config).recoverInvoice(reservationId, actorId, invoiceId, event.id);
      check("status" in result && result.status === "payment_recovery_recorded"); return true;
    }
    const collection = createExactContextInvoiceCollection(config);
    if (event.type === "invoice.created") {
      check(env.CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_READY === "true");
      const result = await collection.collectInvoice(reservationId, actorId, invoiceId);
      check(result.status === "credited" || result.status === "already_credited"); return true;
    }
    if (event.type === "invoice.paid" || event.type === "invoice.payment_succeeded") {
      // This existing observer selects the original or separately admitted
      // replacement-card receipt and settles an existing recovery hold. It
      // cannot issue another payment or infer payment from a browser result.
      const result = await createExactContextBankVerification(config).observeInvoice(reservationId, buyerId, invoiceId, event.id);
      check(result.status === "credited" || result.status === "already_credited" ||
        result.status === "payment_recovery_recorded" && result.outcome === "paid_accounted"); return true;
    }
  }
  if (firstSignal && binding.invoiceId) {
    const result = await createExactContextBankVerification(config).checkPayment(reservationId, buyerId, id(binding.invoiceId, "in"));
    check(result.status === "credited" || result.status === "already_credited"); return true;
  }
  // Known but not yet supported event: hold, never return false to legacy.
  throw Error("Context event needs retry or review");
}
