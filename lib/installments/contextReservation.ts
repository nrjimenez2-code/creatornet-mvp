import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAgreementId, operationHash } from "./agreementStore";
import { FIXED_PURCHASE_CONSENT_VERSION } from "./purchaseConsent";
import { readFixedServiceMonths } from "../fixedServiceTerms";
import { calculateInstallmentPlan } from "../installmentPlan";
import type { ProcessingFeeSchedule } from "../money";
import { validateExactPaymentContext, type ExactPaymentContext } from "./paymentContext";

/** Local integration candidate for the unapplied forward proposal. These are
 * blocked reservations, NOT v1 agreements, Checkout contracts or obligations.
 * There is deliberately no claim/bind/issue/pay/credit/activate method. */
export const CONTEXT_RESERVATION_VERSION = "exact-cents-context-v2";
export type ContextReservationTerms = Readonly<{
  version: typeof CONTEXT_RESERVATION_VERSION;
  currency: "usd";
  bookingId: string;
  productId: string;
  postId: string;
  buyerId: string;
  creatorId: string;
  destinationId: string;
  title: string;
  totalCents: number;
  paymentCount: number;
  firstPaymentFeeSchedule: ProcessingFeeSchedule;
  renewalFeeSchedule: ProcessingFeeSchedule;
  purchaseConsentVersion?: typeof FIXED_PURCHASE_CONSENT_VERSION;
  serviceMonths?: number;
}>;
export type ExactContextReservation = Readonly<{
  id: string;
  bookingId: string;
  context: ExactPaymentContext;
  terms: ContextReservationTerms;
  status: "reserved_not_issuable";
  createdAt: number;
  providerOperationsAllowed: false;
}>;

const failure = () => new Error("Exact context reservation requires review");
function check(value: unknown): asserts value { if (!value) throw failure(); }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const names = Reflect.ownKeys(value);
  check(names.length === keys.length && names.every(name => typeof name === "string" && keys.includes(name)));
  const result: Record<string, unknown> = Object.create(null);
  for (const name of keys) {
    const d = Object.getOwnPropertyDescriptor(value, name);
    check(d && "value" in d && d.enumerable);
    result[name] = d.value;
  }
  return result;
}
function uuid(value: unknown): string {
  check(typeof value === "string");
  assertAgreementId(value);
  return value;
}
function feeSnapshot(value: unknown): ProcessingFeeSchedule {
  const f = fields(value, ["enabled", "basisPoints", "fixedCents", "version"]);
  check(typeof f.enabled === "boolean" && typeof f.basisPoints === "number" &&
    Number.isSafeInteger(f.basisPoints) && f.basisPoints >= 0 && f.basisPoints <= 10000 &&
    typeof f.fixedCents === "number" && Number.isSafeInteger(f.fixedCents) && f.fixedCents >= 0 && f.fixedCents <= 99999999 &&
    typeof f.version === "string" && f.version.trim() === f.version && f.version.length > 0 && f.version.length <= 200);
  return Object.freeze({ enabled: f.enabled, basisPoints: f.basisPoints, fixedCents: f.fixedCents, version: f.version });
}
function termsSnapshot(value: unknown): ContextReservationTerms {
  const hasConsent = value !== null && typeof value === "object" && Object.hasOwn(value, "purchaseConsentVersion");
  const hasService = value !== null && typeof value === "object" && Object.hasOwn(value, "serviceMonths");
  const t = fields(value, ["version", "currency", "bookingId", "productId", "postId", "buyerId", "creatorId",
    "destinationId", "title", "totalCents", "paymentCount", "firstPaymentFeeSchedule", "renewalFeeSchedule",
    ...(hasConsent ? ["purchaseConsentVersion"] : []), ...(hasService ? ["serviceMonths"] : [])]);
  check(!hasConsent || t.purchaseConsentVersion === FIXED_PURCHASE_CONSENT_VERSION);
  check(!hasService || hasConsent);
  const serviceMonths = hasService ? readFixedServiceMonths(t.serviceMonths) : undefined;
  check(t.version === CONTEXT_RESERVATION_VERSION && t.currency === "usd" &&
    typeof t.destinationId === "string" && /^acct_[A-Za-z0-9]{1,100}$/.test(t.destinationId) &&
    typeof t.title === "string" && t.title.trim() === t.title && t.title.length > 0 && t.title.length <= 200 &&
    typeof t.totalCents === "number" && typeof t.paymentCount === "number");
  const first = feeSnapshot(t.firstPaymentFeeSchedule), renewal = feeSnapshot(t.renewalFeeSchedule);
  const plan = calculateInstallmentPlan(t.totalCents, t.paymentCount, renewal, first);
  check(plan.payments.every(p => p.amountCents <= 99999999));
  return Object.freeze({ version: CONTEXT_RESERVATION_VERSION, currency: "usd", bookingId: uuid(t.bookingId),
    productId: uuid(t.productId), postId: uuid(t.postId), buyerId: uuid(t.buyerId), creatorId: uuid(t.creatorId),
    destinationId: t.destinationId, title: t.title, totalCents: t.totalCents, paymentCount: t.paymentCount,
    firstPaymentFeeSchedule: first, renewalFeeSchedule: renewal,
    ...(hasConsent ? { purchaseConsentVersion: FIXED_PURCHASE_CONSENT_VERSION } : {}),
    ...(serviceMonths === undefined ? {} : { serviceMonths }) });
}

/** Compare a persisted v2-only row to independently supplied server evidence.
 * Old terms are intentionally NOT passed through this parser or relabeled. */
export function readExactContextReservation(row: unknown, contextEvidence: unknown): ExactContextReservation {
  try {
    const r = fields(row, ["id", "booking_id", "context", "terms", "status", "created_at"]);
    check(r.status === "reserved_not_issuable" && typeof r.created_at === "string");
    const context = validateExactPaymentContext(r.context, contextEvidence);
    const terms = termsSnapshot(r.terms);
    const bookingId = uuid(r.booking_id), id = uuid(r.id);
    check(terms.bookingId === bookingId);
    const createdAt = Math.floor(Date.parse(r.created_at) / 1000);
    check(Number.isSafeInteger(createdAt) && createdAt > 0);
    return Object.freeze({ id, bookingId, context, terms, status: "reserved_not_issuable", createdAt,
      providerOperationsAllowed: false });
  } catch { throw failure(); }
}

/** Construct only with fresh independently established server context evidence.
 * No app route currently calls this adapter. The proposed RPC must independently
 * compare an immutable owner pin and validate/lock the real booking. This pure
 * consistency check cannot establish credentials, database identity or consent.
 * No keys, environment reads, provider clients or payment authority are accepted.
 * The empty-pin migration default refuses all reservations until separately
 * approved configuration; even a reserved row remains permanently non-issuable.
 */
export function createExactContextReservationStore(args: {
  admin: SupabaseClient;
  context: unknown;
  contextEvidence: unknown;
}) {
  try {
    // Read evidence once before validation. A stateful caller must not change
    // the retained evidence between its validation and the first RPC.
    const e = fields(args.contextEvidence, ["approvedContext", "vercelEnvironment", "stripeSecretKeyMode", "stripePublishableKeyMode",
      "observedPlatformAccountId", "observedSupabaseProjectRef", "configuredSupabaseUrl", "configuredSiteOrigin"]);
    const context = validateExactPaymentContext(args.context, e);
    const evidence = Object.freeze({ ...e, approvedContext: context });
    const admin = args.admin;
    const selection = "id,booking_id,context,terms,status,created_at";
    function own(row: unknown, actorId: string, bookingId?: string) {
      const r = readExactContextReservation(row, evidence);
      check(r.terms.creatorId === actorId && (!bookingId || r.bookingId === bookingId));
      return r;
    }
    return Object.freeze({
      async reserve(input: { actorId: string; bookingId: string; paymentCount: number;
        firstPaymentFeeSchedule: ProcessingFeeSchedule; renewalFeeSchedule: ProcessingFeeSchedule }) {
        try {
          const actorId = uuid(input.actorId), bookingId = uuid(input.bookingId), count = input.paymentCount;
          check(Number.isInteger(count) && count >= 2 && count <= 24);
          const first = feeSnapshot(input.firstPaymentFeeSchedule), renewal = feeSnapshot(input.renewalFeeSchedule);
          const { data, error } = await admin.rpc("reserve_exact_installment_context_v2", {
            p_booking_id: bookingId, p_actor_id: actorId, p_count: count,
            p_context: context, p_first_fee: first, p_renewal_fee: renewal,
          }).single();
          check(!error && data);
          const r = own(data, actorId, bookingId);
          check(r.terms.paymentCount === count && operationHash(r.terms.firstPaymentFeeSchedule) === operationHash(first) &&
            operationHash(r.terms.renewalFeeSchedule) === operationHash(renewal));
          return r;
        } catch { throw failure(); }
      },
      async load(reservationId: string, actorId: string) {
        try {
          const wantedId = uuid(reservationId), actor = uuid(actorId);
          const { data, error } = await admin.from("exact_installment_context_reservations_v2")
            .select(selection).eq("id", wantedId).maybeSingle();
          check(!error && data);
          const r = own(data, actor);
          check(r.id === wantedId);
          return r;
        } catch { throw failure(); }
      },
    });
  } catch { throw failure(); }
}
