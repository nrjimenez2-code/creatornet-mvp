import "server-only";
import { isSupportedStripeSnapshotVersion } from "../stripeSnapshotVersion";
import { operationHash } from "./agreementStore";
import { CONTEXT_RESERVATION_VERSION, readExactContextReservation } from "./contextReservation";
import { assertStripeObjectMatchesExactContext, type ExactPaymentContext } from "./paymentContext";

export const CONTEXT_RECONCILIATION_ERROR = "Exact context event requires review";
export type BlockedContextEventInspection = Readonly<{
  protocol: typeof CONTEXT_RESERVATION_VERSION;
  candidateReservationId: string;
  context: ExactPaymentContext;
  eventId: string;
  eventType: string;
  resourceId: string;
  /** Diagnostic identity only. Not an acquired claim or Stripe idempotency key. */
  observationKey: string;
  disposition: "unbound_reservation";
  providerOperationsAllowed: false;
  accountingOperationsAllowed: false;
  mayAcknowledge: false;
}>;

const fail = () => new Error(CONTEXT_RECONCILIATION_ERROR);
function check(value: unknown): asserts value { if (!value) throw fail(); }
const missing = Symbol("missing");
function own(value: unknown, key: string): unknown {
  check(value && typeof value === "object" && !Array.isArray(value));
  const proto = Object.getPrototypeOf(value);
  check(proto === Object.prototype || proto === null);
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d) { check(!(key in value)); return missing; }
  check("value" in d && d.enumerable);
  return d.value;
}
function empty(value: unknown) { return value === missing || value === null; }
function identity(value: unknown, prefix: string): value is string {
  // Type and mode are independently checked; an opaque ID prefix is not mode
  // evidence. In particular, don't assume production Checkout suffix syntax.
  return typeof value === "string" && value.length <= 200 &&
    value.startsWith(prefix) && /^[A-Za-z0-9_]+$/.test(value) && value.length > prefix.length;
}

const resources: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  "checkout.session.completed": ["checkout.session", "cs_"],
  "checkout.session.expired": ["checkout.session", "cs_"],
  "payment_intent.succeeded": ["payment_intent", "pi_"],
  "payment_intent.payment_failed": ["payment_intent", "pi_"],
  "charge.succeeded": ["charge", "ch_"],
  "charge.updated": ["charge", "ch_"],
  "charge.refunded": ["charge", "ch_"],
  "invoice.created": ["invoice", "in_"],
  "invoice.paid": ["invoice", "in_"],
  "invoice.payment_succeeded": ["invoice", "in_"],
  "invoice.payment_failed": ["invoice", "in_"],
  "invoice.payment_action_required": ["invoice", "in_"],
  "charge.dispute.created": ["dispute", "du_"],
  "charge.dispute.updated": ["dispute", "du_"],
  "charge.dispute.closed": ["dispute", "du_"],
  "charge.dispute.funds_withdrawn": ["dispute", "du_"],
  "charge.dispute.funds_reinstated": ["dispute", "du_"],
  "customer.subscription.created": ["subscription", "sub_"],
  "customer.subscription.updated": ["subscription", "sub_"],
  "customer.subscription.deleted": ["subscription", "sub_"],
  "customer.subscription.paused": ["subscription", "sub_"],
  "customer.subscription.resumed": ["subscription", "sub_"],
});
// Refund objects lack their own livemode in the installed Stripe schema. They
// need a separate fresh charge/intent relationship inspector, not a fabricated
// mode flag or event-only default. Until then refund.* remains unsupported here.

/** Pure inspection of a retrieved snapshot, not a webhook verifier or payment
 * receipt. The runtime must fetch the event itself using the same privately
 * held, account-observed Stripe client; callers cannot establish that provenance
 * by passing an arbitrary object here. Signature verification remains mandatory
 * at any future webhook route. API event snapshots are not fresh charge state.
 *
 * The only current v2 rows are permanently non-issuable reservations: they have
 * no durable request, customer/subscription/Checkout/payment bindings. Even a
 * genuine successful Stripe event with matching metadata CANNOT be adopted,
 * acknowledged as processed, credited, or used to unlock content by this code.
 */
export function inspectContextReservationEvent(args: {
  reservationRow: unknown;
  contextEvidence: unknown;
  eventId: string;
  expectedApiVersion: string;
  event: unknown;
}): BlockedContextEventInspection {
  try {
    const r = readExactContextReservation(args.reservationRow, args.contextEvidence);
    const requestedId = args.eventId, apiVersion = args.expectedApiVersion, event = args.event;
    check(identity(requestedId, "evt_") && typeof apiVersion === "string" &&
      /^\d{4}-\d{2}-\d{2}(?:\.[a-z0-9-]+)?$/.test(apiVersion));
    check(own(event, "object") === "event" && own(event, "id") === requestedId &&
      isSupportedStripeSnapshotVersion(own(event, "api_version"), apiVersion));
    assertStripeObjectMatchesExactContext(r.context, event);
    // This contract is for platform destination charges. A connected-account
    // event or alternate organization authentication context is unsupported;
    // matching the creator destination does not make it a platform event.
    check(empty(own(event, "account")) && empty(own(event, "context")));
    const created = own(event, "created"), type = own(event, "type");
    check(typeof created === "number" && Number.isSafeInteger(created) && created >= r.createdAt);
    check(typeof type === "string" && Object.prototype.hasOwnProperty.call(resources, type));
    const [kind, prefix] = resources[type];
    const object = own(own(event, "data"), "object");
    check(own(object, "object") === kind);
    assertStripeObjectMatchesExactContext(r.context, object);
    const objectId = own(object, "id");
    check(identity(objectId, prefix));
    const transfer = own(object, "transfer_data");
    if (!empty(transfer)) {
      const destination = own(transfer, "destination");
      check((typeof destination === "string" ? destination : own(destination, "id")) === r.terms.destinationId);
    }

    // Hints may reject a candidate, never create a financial relationship.
    const inspectHints = (metadata: unknown) => {
      if (empty(metadata)) return;
      const marker = own(metadata, "installment_collection_version");
      check(marker === missing || marker === CONTEXT_RESERVATION_VERSION);
      const plan = own(metadata, "installment_plan_id");
      check(plan === missing || plan === r.id);
      const booking = own(metadata, "booking_id");
      check(booking === missing || booking === r.bookingId);
      const buyer = own(metadata, "buyer_id"), creator = own(metadata, "creator_id");
      check((buyer === missing || buyer === r.terms.buyerId) && (creator === missing || creator === r.terms.creatorId));
    };
    inspectHints(own(object, "metadata"));
    const parent = own(object, "parent");
    if (!empty(parent)) {
      const details = own(parent, "subscription_details");
      if (!empty(details)) inspectHints(own(details, "metadata"));
    }
    const observationKey = `cn-exact-v2-observe:${operationHash({
      version: "exact-context-event-observation-v1", protocol: CONTEXT_RESERVATION_VERSION,
      table: "exact_installment_context_reservations_v2", context: r.context,
      reservationId: r.id, terms: r.terms, operation: "inspect_unbound_event",
      event: { id: requestedId, type, apiVersion, resourceId: objectId },
    })}`;
    return Object.freeze({ protocol: CONTEXT_RESERVATION_VERSION, candidateReservationId: r.id,
      context: r.context, eventId: requestedId, eventType: type, resourceId: objectId, observationKey,
      disposition: "unbound_reservation", providerOperationsAllowed: false,
      accountingOperationsAllowed: false, mayAcknowledge: false });
  } catch { throw fail(); }
}
