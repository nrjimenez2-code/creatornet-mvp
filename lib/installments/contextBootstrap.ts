import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAgreementId } from "./agreementStore";
import { readExactContextReservation, type ExactContextReservation } from "./contextReservation";
import type { ExactPaymentContext } from "./paymentContext";

export const CONTEXT_CUSTOMER_BOOTSTRAP_ERROR = "Exact context customer plan requires review";
export const CONTEXT_CUSTOMER_REQUEST_VERSION = "exact-context-customer-request-v1";
export const CONTEXT_CUSTOMER_API_VERSION = "2025-10-29.clover";
export const CONTEXT_CUSTOMER_OPERATION_TABLE = "exact_installment_context_customer_operations_v2";
const metadataKeys = ["installment_collection_version", "installment_plan_id", "booking_id", "buyer_id", "creator_id",
  "context_hash", "terms_hash", "operation_kind"] as const;
export type ExactContextCustomerRequest = Readonly<{
  version: typeof CONTEXT_CUSTOMER_REQUEST_VERSION;
  apiVersion: typeof CONTEXT_CUSTOMER_API_VERSION;
  method: "POST";
  path: "/v1/customers";
  params: Readonly<{ metadata: Readonly<Record<typeof metadataKeys[number], string>> }>;
}>;
export type ExactContextCustomerPlan = Readonly<{
  version: "exact-context-customer-plan-v1";
  reservationId: string;
  context: ExactPaymentContext;
  contextHash: string;
  termsHash: string;
  operationKind: "customer.create";
  request: ExactContextCustomerRequest;
  requestHash: string;
  idempotencyKey: string;
  status: "planned_not_dispatchable";
  providerOperationsAllowed: false;
  accountingOperationsAllowed: false;
  replayAllowed: false;
}>;
export type ExactContextCustomerIntent = ExactContextCustomerPlan & Readonly<{ id: string; createdAt: number }>;

const fail = () => new Error(CONTEXT_CUSTOMER_BOOTSTRAP_ERROR);
function check(value: unknown): asserts value { if (!value) throw fail(); }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
  const proto = Object.getPrototypeOf(value);
  check(proto === Object.prototype || proto === null);
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  check(names.length === keys.length && names.every(name => typeof name === "string" && keys.includes(name)));
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = descriptors[key];
    check(d && "value" in d && d.enumerable);
    snapshot[key] = d.value;
  }
  return snapshot;
}
function uuid(value: unknown): string {
  check(typeof value === "string");
  assertAgreementId(value);
  return value;
}

/** NEW v2-only byte contract; never change/use v1 operationHash serialization.
 * Each ordered scalar becomes lower-case UTF-8 hex; join with '.', then SHA256
 * that ASCII string. SQL uses encode(convert_to(atom,'UTF8'),'hex') in the same
 * order. Framing distinguishes separators, whitespace and empty atoms. Reject
 * NUL/lone surrogates rather than collide through JS UTF-8 replacement or accept
 * a string PostgreSQL JSON cannot represent. Unicode is not normalized. */
function tupleHash(atoms: readonly string[]): string {
  check(atoms.every(atom => typeof atom === "string" && !/[\u0000\uD800-\uDFFF]/u.test(atom)));
  return createHash("sha256").update(atoms.map(atom => Buffer.from(atom, "utf8").toString("hex")).join("."), "utf8").digest("hex");
}
function planFor(r: ExactContextReservation): ExactContextCustomerPlan {
  const c = r.context, t = r.terms, first = t.firstPaymentFeeSchedule, renewal = t.renewalFeeSchedule;
  const contextHash = tupleHash(["cn-exact-v2-context-v1", c.version, c.mode, c.platformAccountId, c.supabaseProjectRef, c.siteOrigin]);
  // Preserve the exact old byte contract. Only a newly versioned reservation
  // uses the consent-bearing tuple; never infer acceptance from old metadata.
  const termsHash = tupleHash([t.serviceMonths !== undefined ? "cn-exact-v2-terms-service-v1" :
    t.purchaseConsentVersion ? "cn-exact-v2-terms-consent-v1" : "cn-exact-v2-terms-v1",
    t.version, t.currency, t.bookingId, t.productId, t.postId, t.buyerId,
    t.creatorId, t.destinationId, t.title, String(t.totalCents), String(t.paymentCount), String(first.enabled),
    String(first.basisPoints), String(first.fixedCents), first.version, String(renewal.enabled),
    String(renewal.basisPoints), String(renewal.fixedCents), renewal.version,
    ...(t.purchaseConsentVersion ? [t.purchaseConsentVersion] : []),
    ...(t.serviceMonths === undefined ? [] : [String(t.serviceMonths)])]);
  const metadata = Object.freeze({ installment_collection_version: t.version, installment_plan_id: r.id,
    booking_id: t.bookingId, buyer_id: t.buyerId, creator_id: t.creatorId, context_hash: contextHash,
    terms_hash: termsHash, operation_kind: "customer.create" });
  const request: ExactContextCustomerRequest = Object.freeze({ version: CONTEXT_CUSTOMER_REQUEST_VERSION,
    apiVersion: CONTEXT_CUSTOMER_API_VERSION, method: "POST", path: "/v1/customers", params: Object.freeze({ metadata }) });
  const requestHash = tupleHash(["cn-exact-v2-customer-request-v1", request.version, request.apiVersion, request.method,
    request.path, ...metadataKeys.flatMap(key => [key, metadata[key]])]);
  const keyHash = tupleHash(["cn-exact-v2-customer-key-v1", "exact_installment_context_reservations_v2",
    CONTEXT_CUSTOMER_OPERATION_TABLE, r.id, contextHash, termsHash, requestHash]);
  return Object.freeze({ version: "exact-context-customer-plan-v1", reservationId: r.id, context: c, contextHash, termsHash,
    operationKind: "customer.create", request, requestHash, idempotencyKey: `cn-exact-v2-customer:${keyHash}`,
    status: "planned_not_dispatchable", providerOperationsAllowed: false, accountingOperationsAllowed: false, replayAllowed: false });
}
function owned(r: ExactContextReservation, actorId: unknown) { check(r.terms.creatorId === uuid(actorId)); }

/** Derives a specific metadata-only request from an immutable v2 reservation.
 * No email/name/address/card/source/payment_method/test_clock or arbitrary Stripe
 * parameters are accepted. This plan is NOT a request-dispatch permission. */
export function buildExactContextCustomerPlan(args: {
  reservationRow: unknown; contextEvidence: unknown; actorId: string;
}): ExactContextCustomerPlan {
  try {
    const r = readExactContextReservation(args.reservationRow, args.contextEvidence);
    owned(r, args.actorId);
    return planFor(r);
  } catch { throw fail(); }
}

const rowKeys = ["id", "reservation_id", "context", "context_hash", "terms_hash", "operation_kind", "request",
  "request_hash", "idempotency_key", "status", "created_at"] as const;
function readAgainstPlan(value: unknown, plan: ExactContextCustomerPlan, reservationCreatedAt: number): ExactContextCustomerIntent {
  const row = fields(value, rowKeys);
  const context = fields(row.context, ["version", "mode", "platformAccountId", "supabaseProjectRef", "siteOrigin"]);
  for (const key of ["version", "mode", "platformAccountId", "supabaseProjectRef", "siteOrigin"] as const) check(context[key] === plan.context[key]);
  const request = fields(row.request, ["version", "apiVersion", "method", "path", "params"]);
  for (const key of ["version", "apiVersion", "method", "path"] as const) check(request[key] === plan.request[key]);
  const params = fields(request.params, ["metadata"]), metadata = fields(params.metadata, metadataKeys);
  for (const key of metadataKeys) check(metadata[key] === plan.request.params.metadata[key]);
  check(row.reservation_id === plan.reservationId && row.context_hash === plan.contextHash && row.terms_hash === plan.termsHash &&
    row.operation_kind === plan.operationKind && row.request_hash === plan.requestHash && row.idempotency_key === plan.idempotencyKey &&
    row.status === "planned_not_dispatchable" && typeof row.created_at === "string");
  const createdAt = Date.parse(row.created_at);
  check(Number.isSafeInteger(createdAt) && createdAt > 0 && createdAt >= reservationCreatedAt * 1000);
  // Return fresh validated expected snapshots, never the mutable RPC payload.
  return Object.freeze({ ...plan, id: uuid(row.id), createdAt: Math.floor(createdAt / 1000) });
}

/** The durable row must match our independently derived whole request/context/
 * terms, not just a caller-supplied hash. Legacy/missing/partial rows never turn
 * into permission or absence that could trigger an alternate creation path. */
export function readExactContextCustomerIntent(args: {
  intentRow: unknown; reservationRow: unknown; contextEvidence: unknown; actorId: string;
}): ExactContextCustomerIntent {
  try {
    const r = readExactContextReservation(args.reservationRow, args.contextEvidence);
    owned(r, args.actorId);
    return readAgainstPlan(args.intentRow, planFor(r), r.createdAt);
  } catch { throw fail(); }
}

/** Prospective storage adapter for unapplied SQL, not wired to existing routes.
 * SQL derives the request/hashes from the owned immutable reservation and pin;
 * the RPC accepts no request, key or hash input. A retry of this DATABASE plan
 * call is not a Stripe replay. There is deliberately no claim, dispatch, lease,
 * provider result binding, completion or financial operation in this interface.
 *
 * Stripe may prune idempotency results after >=24h; reusing such a key can create
 * another object. planned createdAt is NOT first dispatch time, and a stored key
 * never proves an uncertain request is safe to resend. Future dispatch/recovery
 * requires a separate approved durable-attempt/reconciliation contract.
 */
export function createExactContextCustomerIntentStore(args: {
  admin: SupabaseClient; reservationRow: unknown; contextEvidence: unknown;
}) {
  try {
    const r = readExactContextReservation(args.reservationRow, args.contextEvidence);
    const plan = planFor(r), admin = args.admin;
    return Object.freeze({
      async plan(actorId: string): Promise<ExactContextCustomerIntent> {
        try {
          owned(r, actorId);
          const { data, error } = await admin.rpc("plan_exact_customer_operation_v2", {
            p_reservation_id: r.id, p_actor_id: actorId, p_context: plan.context,
          }).single();
          check(!error && data);
          return readAgainstPlan(data, plan, r.createdAt);
        } catch { throw fail(); }
      },
      async load(actorId: string): Promise<ExactContextCustomerIntent> {
        try {
          owned(r, actorId);
          // Reservation identity is known even if the planning response (and
          // generated operation ID) was lost. This never retries plan/dispatch.
          // PostgREST GET stringifies argument values with String(value), so the
          // JSONB context must be encoded explicitly; POST retains an object.
          const { data, error } = await admin.rpc("read_exact_customer_operation_v2", {
            p_reservation_id: r.id, p_actor_id: actorId, p_context: JSON.stringify(plan.context),
          }, { get: true }).single();
          check(!error && data);
          return readAgainstPlan(data, plan, r.createdAt);
        } catch { throw fail(); }
      },
    });
  } catch { throw fail(); }
}
