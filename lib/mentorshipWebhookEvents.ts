import type Stripe from "stripe";

/** Minimum platform endpoint coverage for the current card-only mentorship
 * checkout, recurring billing and shared refund/dispute handling. This does
 * not enable events, alter an API version or replace signed delivery proof. */
export const MENTORSHIP_REQUIRED_PLATFORM_EVENTS = [
  "checkout.session.completed", "checkout.session.expired", "payment_intent.succeeded", "payment_intent.payment_failed",
  "charge.refunded", "invoice.payment_succeeded", "invoice.created",
  "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed", "charge.updated",
  "customer.subscription.updated", "customer.subscription.deleted", "invoice.payment_failed",
  "invoice.payment_action_required", "invoice.voided", "invoice.marked_uncollectible",
  "charge.succeeded", "payment_intent.processing", "payment_intent.canceled", "payment_intent.requires_action",
  "refund.created", "refund.updated", "refund.failed", "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated",
] as const satisfies readonly Stripe.Event.Type[];

/** The canonical receiver admits account.updated only through the separately
 * signed connected-account destination. Platform coverage cannot prove this. */
export const MENTORSHIP_REQUIRED_CONNECT_EVENTS = ["account.updated"] as const satisfies readonly Stripe.Event.Type[];

/** Produce an additive release proposal from a freshly retrieved endpoint.
 * The caller independently pins the account and endpoint identity. Never apply
 * a saved proposal without re-reading and comparing the original configuration. */
export function planMentorshipWebhookCoverage(snapshot: unknown, expected: {
  id: string; url: string; livemode: boolean; apiVersion: string;
}) {
  const row = snapshot as Record<string, unknown> | null;
  if (!row || row.object !== "webhook_endpoint" || row.id !== expected.id || row.url !== expected.url ||
    row.livemode !== expected.livemode || row.api_version !== expected.apiVersion || row.status !== "enabled" ||
    !Array.isArray(row.enabled_events) || !row.enabled_events.length ||
    row.enabled_events.some(event => typeof event !== "string" || !/^[a-z_]+(?:\.[a-z_]+)+$/.test(event)) ||
    new Set(row.enabled_events).size !== row.enabled_events.length) throw Error("Webhook endpoint configuration requires review");
  const currentEvents = row.enabled_events as string[];
  const missingEvents = MENTORSHIP_REQUIRED_PLATFORM_EVENTS.filter(event => !currentEvents.includes(event));
  return { endpointId: expected.id, url: expected.url, livemode: expected.livemode, apiVersion: expected.apiVersion,
    currentEvents: [...currentEvents], missingEvents,
    proposedEnabledEvents: [...currentEvents, ...missingEvents], removesExistingEvents: false as const };
}
