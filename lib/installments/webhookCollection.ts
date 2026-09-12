import "server-only";
import { assertAgreementId } from "./agreementStore";
import { assertExactInstallmentSandbox } from "./checkoutPreparation";

// These are server configuration acknowledgements, not proof of acceptance.
// Hosted installation and test evidence must be checked before enabling them.
export const EXACT_WEBHOOK_COLLECTION_GATES = Object.freeze([
  "CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_READY",
  "CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY",
  "CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE",
  "CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT",
  "CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY",
  "CREATOR_EXACT_INSTALLMENTS_REFUND_EVENTS_READY",
  "CREATOR_EXACT_INSTALLMENTS_BILLING_STOPS_READY",
  "CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY",
  "CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY",
  "CREATOR_EXACT_INSTALLMENTS_ADMIN_READY",
] as const);

/** New monthly debit permission is limited to at most ten explicitly selected
 * staging agreement UUIDs. The caller supplies a persisted binding, never an
 * ID from event metadata, a browser request, or an invoice amount. This check
 * does NOT replace the collector's current-period, prior-payment, hold, exact
 * fee, customer/card and durable once-only admission checks.
 *
 * Receipt events return false before reading this new configuration: disabling
 * collection (or a malformed allowlist) must not prevent receipt reconciliation.
 * No production environment can pass even with every switch set to true. */
export function canCollectExactWebhookInvoice(args: {
  env: Record<string, string | undefined>;
  eventType: string;
  agreementId: string;
  previewOrigin: string;
}): boolean {
  if (args.eventType !== "invoice.created" ||
    !EXACT_WEBHOOK_COLLECTION_GATES.every(key => args.env[key] === "true")) return false;
  assertExactInstallmentSandbox(args.env, args.previewOrigin);
  assertAgreementId(args.agreementId);
  const raw = args.env.CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_AGREEMENT_IDS;
  if (raw === undefined || raw.trim() === "") return false;
  if (raw.length > 500) throw new Error("Invalid staging collection allowlist");
  const ids = raw.split(",").map(value => value.trim());
  if (ids.length > 10 || new Set(ids).size !== ids.length || ids.some(value =>
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))) {
    throw new Error("Invalid staging collection allowlist");
  }
  return ids.includes(args.agreementId);
}
