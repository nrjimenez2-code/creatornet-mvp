import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateInstallmentPlan } from "../installmentPlan";
import type { ProcessingFeeSchedule } from "../money";
import { HELD_INSTALLMENT_VERSION } from "./heldInvoice";

export type ExactAgreementTerms = Readonly<{
  version: typeof HELD_INSTALLMENT_VERSION;
  currency: "usd";
  bookingPaymentId: string;
  bookingId: string;
  productId: string;
  postId: string;
  buyerId: string;
  creatorId: string;
  destinationId: string;
  title: string;
  previewOrigin: string;
  totalCents: number;
  paymentCount: number;
  firstPaymentFeeSchedule: ProcessingFeeSchedule;
  renewalFeeSchedule: ProcessingFeeSchedule;
}>;

export type ExactAgreement = Readonly<{
  id: string;
  terms: ExactAgreementTerms;
  status: "preparing" | "awaiting_first" | "active" | "complete" | "canceled" | "review_required";
  createdAt: number;
  customerId: string | null;
  subscriptionId: string | null;
  sessionId: string | null;
}>;

export type BootstrapStep = "customer" | "product" | "subscription" | "hold" | "checkout";
export type OperationClaim = { status: "new" } | { status: "busy" | "review_required" } |
  { status: "complete"; resultId: string };

export interface ExactAgreementStore {
  load(id: string): Promise<ExactAgreement>;
  claim(id: string, step: BootstrapStep, requestHash: string, token: string): Promise<OperationClaim>;
  complete(id: string, step: BootstrapStep, token: string, resultId: string): Promise<void>;
  bind(id: string, customerId: string, subscriptionId: string, sessionId: string): Promise<void>;
  recordFirstReceipt(id: string, receipt: FirstInstallmentReceipt): Promise<boolean>;
}

export type FirstInstallmentReceipt = Readonly<{
  sessionId: string;
  paymentIntentId: string;
  amountCents: number;
  applicationFeeCents: number;
  paidAt: number;
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function assertAgreementId(id: string) {
  if (!uuid.test(id)) throw new Error("Invalid installment agreement identity");
}

/** Rebuild just the known fields; caller-owned objects and extra fields cannot
 * change a saved agreement or influence a retry's Stripe request parameters. */
export function snapshotExactTerms(value: ExactAgreementTerms): ExactAgreementTerms {
  for (const key of ["bookingPaymentId", "bookingId", "productId", "postId", "buyerId", "creatorId"] as const) {
    assertAgreementId(value[key]);
  }
  if (value.version !== HELD_INSTALLMENT_VERSION || value.currency !== "usd" ||
      !/^acct_[A-Za-z0-9]+$/.test(value.destinationId)) throw new Error("Invalid installment agreement version/currency/destination");
  const origin = new URL(value.previewOrigin);
  if (origin.protocol !== "https:" || !/^[a-z0-9-]+\.vercel\.app$/.test(origin.hostname) ||
      origin.username || origin.password || origin.port || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("Installment agreement requires the trusted Preview origin");
  }
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 200) throw new Error("Invalid installment title");
  const fee = (schedule: ProcessingFeeSchedule) => Object.freeze({ enabled: schedule.enabled,
    basisPoints: schedule.basisPoints, fixedCents: schedule.fixedCents, version: schedule.version });
  const first = fee(value.firstPaymentFeeSchedule);
  const renewal = fee(value.renewalFeeSchedule);
  for (const schedule of [first, renewal]) {
    if (typeof schedule.enabled !== "boolean" || !Number.isSafeInteger(schedule.basisPoints) ||
        schedule.basisPoints < 0 || schedule.basisPoints > 10000 || !Number.isSafeInteger(schedule.fixedCents) ||
        schedule.fixedCents < 0 || schedule.fixedCents > 99999999 ||
        typeof schedule.version !== "string" || !schedule.version.trim()) {
      throw new Error("Invalid installment fee snapshot");
    }
  }
  const plan = calculateInstallmentPlan(value.totalCents, value.paymentCount, renewal, first);
  if (plan.payments.some((p) => p.amountCents > 99999999)) throw new Error("Installment exceeds USD amount limit");
  return Object.freeze({ version: HELD_INSTALLMENT_VERSION, currency: "usd",
    bookingPaymentId: value.bookingPaymentId, bookingId: value.bookingId, productId: value.productId,
    postId: value.postId, buyerId: value.buyerId, creatorId: value.creatorId,
    destinationId: value.destinationId, title: value.title.trim(), previewOrigin: origin.origin,
    totalCents: value.totalCents, paymentCount: value.paymentCount,
    firstPaymentFeeSchedule: first, renewalFeeSchedule: renewal });
}

export function operationHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item)
      .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonical(v)]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

type AgreementRow = {
  id: string; terms: ExactAgreementTerms; status: ExactAgreement["status"]; created_at: string;
  stripe_customer_id: string | null; stripe_subscription_id: string | null; stripe_checkout_session_id: string | null;
};
function agreement(row: AgreementRow): ExactAgreement {
  if (!row || typeof row !== "object" || Array.isArray(row) ||
      !["preparing", "awaiting_first", "active", "complete", "canceled", "review_required"].includes(row.status)) {
    throw new Error("Invalid persisted installment agreement");
  }
  assertAgreementId(row.id);
  for (const [value, pattern] of [[row.stripe_customer_id, /^cus_[A-Za-z0-9]+$/],
    [row.stripe_subscription_id, /^sub_[A-Za-z0-9]+$/],
    [row.stripe_checkout_session_id, /^cs_test_[A-Za-z0-9]+$/]] as const) {
    if (value !== null && (typeof value !== "string" || !pattern.test(value))) {
      throw new Error("Invalid persisted installment Stripe identity");
    }
  }
  const createdAt = Math.floor(Date.parse(row.created_at) / 1000);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error("Invalid persisted agreement timestamp");
  return Object.freeze({ id: row.id, terms: snapshotExactTerms(row.terms), status: row.status,
    createdAt, customerId: row.stripe_customer_id, subscriptionId: row.stripe_subscription_id,
    sessionId: row.stripe_checkout_session_id });
}

/** No raw database error objects, credentials, URLs or contact details escape. */
export function createExactAgreementStore(admin: SupabaseClient): ExactAgreementStore & {
  create(actorId: string, terms: ExactAgreementTerms): Promise<ExactAgreement>;
} {
  async function rpc<T>(name: string, args: Record<string, unknown>, singular = false): Promise<T> {
    const request = admin.rpc(name, args);
    // Composite table-row returns require singular representation; scalar
    // JSON/boolean RPCs must retain their native response representation.
    const { data, error } = await (singular ? request.single() : request);
    if (error) throw new Error(`Installment state operation failed: ${name}`);
    return data as T;
  }
  return {
    async create(actorId, terms) {
      assertAgreementId(actorId);
      const saved = snapshotExactTerms(terms);
      if (actorId !== saved.creatorId) throw new Error("Creator ownership required");
      return agreement(await rpc<AgreementRow>("create_exact_installment_agreement", {
        p_id: randomUUID(), p_booking_payment_id: saved.bookingPaymentId, p_actor_id: actorId, p_terms: saved,
      }, true));
    },
    async load(id) {
      assertAgreementId(id);
      const { data, error } = await admin.from("exact_installment_agreements").select("*").eq("id", id).single();
      if (error || !data) throw new Error("Installment agreement unavailable");
      return agreement(data as AgreementRow);
    },
    async claim(id, step, hash, token) {
      const value = await rpc<unknown>("claim_exact_installment_operation", {
        p_agreement_id: id, p_step: step, p_request_hash: hash, p_claim_token: token,
      });
      if (value && typeof value === "object" && !Array.isArray(value) && "status" in value) {
        if (value.status === "new" || value.status === "busy" || value.status === "review_required") {
          return { status: value.status };
        }
        if (value.status === "complete" && "resultId" in value && typeof value.resultId === "string" &&
            /^[a-zA-Z0-9_]{1,100}$/.test(value.resultId)) return { status: "complete", resultId: value.resultId };
      }
      throw new Error("Invalid installment operation claim response");
    },
    complete: (id, step, token, resultId) => rpc<void>("complete_exact_installment_operation", {
      p_agreement_id: id, p_step: step, p_claim_token: token, p_result_id: resultId,
    }),
    bind: (id, customerId, subscriptionId, sessionId) => rpc<void>("bind_exact_installment_checkout", {
      p_agreement_id: id, p_customer_id: customerId, p_subscription_id: subscriptionId, p_session_id: sessionId,
    }),
    async recordFirstReceipt(id, r) {
      const value = await rpc<unknown>("record_exact_installment_first_receipt", {
        p_agreement_id: id, p_session_id: r.sessionId, p_payment_intent_id: r.paymentIntentId,
        p_amount_cents: r.amountCents, p_application_fee_cents: r.applicationFeeCents,
        p_paid_at: new Date(r.paidAt * 1000).toISOString(),
      });
      if (typeof value !== "boolean") throw new Error("Invalid installment receipt response");
      return value;
    },
  };
}
