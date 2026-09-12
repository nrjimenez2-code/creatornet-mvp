import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAgreementId, snapshotExactTerms } from "./agreementStore";
import { assertExactInstallmentEnvironment } from "./checkoutPreparation";
import type { ExactAdminPage } from "./adminView";
import { isDeepStrictEqual } from "node:util";
import { CONTEXT_RESERVATION_VERSION, readExactContextReservation, type ContextReservationTerms } from "./contextReservation";
import { exactContextServerConfig } from "./contextServer";
import { createExactContextRuntime, createExactContextBillingStop } from "./contextRuntime";
import { createExactAgreementStore } from "./agreementStore";
import { HELD_INSTALLMENT_VERSION } from "./heldInvoice";
import { createExactBillingStopStore, stopExactInstallmentBillingSandbox } from "./billingStop";
import { getStripe } from "../stripeClient";

type Env = Record<string, string | undefined>;

/** Context and legacy controls retain separate default-off readiness gates. */
export function exactAdminEnabled(env: Env): boolean {
  try {
    if (env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_ADMIN_READY === "true" &&
      env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY === "true") { exactContextServerConfig(env); return true; }
    assertExactInstallmentEnvironment(env, env.NEXT_PUBLIC_SITE_URL || "");
    return [env.CREATOR_EXACT_INSTALLMENTS_ADMIN_READY, env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY,
      env.CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY, env.CREATOR_EXACT_INSTALLMENTS_BILLING_STOPS_READY,
      env.CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY].every(v => v === "true");
  } catch { return false; }
}

const validId = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  try { assertAgreementId(v); return true; } catch { return false; }
};

export function parseExactStopInput(body: unknown): { agreementId: string; requestId: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => !["agreementId", "requestId", "confirmation"].includes(k)) ||
    !validId(b.agreementId) || !validId(b.requestId) || b.confirmation !== "STOP_FUTURE_BILLING") return null;
  return { agreementId: b.agreementId, requestId: b.requestId };
}

/** Caller must have passed requireAdmin. Read only, bounded keyset pagination.
 * A failed/malformed query is never reported as an empty/safe review queue. */
export async function readExactAdminPage(admin: SupabaseClient, actorId: string, cursor: string | null,
  env: Env): Promise<ExactAdminPage> {
  if (!exactAdminEnabled(env)) throw new Error("Exact installment admin unavailable");
  assertAgreementId(actorId);
  if (cursor !== null) assertAgreementId(cursor);
  const legacy = exactAdminEnabled({ ...env, CREATOR_EXACT_INSTALLMENTS_CONTEXT_ADMIN_READY: "false" });
  const context = env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_ADMIN_READY === "true" &&
    env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY === "true";
  const versions = [...(legacy ? [HELD_INSTALLMENT_VERSION] : []), ...(context ? [CONTEXT_RESERVATION_VERSION] : [])];
  let query = admin.from("exact_installment_agreements")
    .select("id,terms,status,purchase_id").in("terms->>version", versions).order("id").limit(26);
  if (cursor) query = query.gt("id", cursor);
  const { data, error } = await query;
  if (error || !Array.isArray(data)) throw new Error("Installment review unavailable");
  const rows = data.slice(0, 25);
  for (const row of rows) assertAgreementId(row.id);
  if (!rows.length) return { plans: [], nextCursor: null };
  const ids = rows.map(r => r.id as string);
  const contextTerms = new Map<string, ContextReservationTerms>();
  const contextIds = rows.filter(r => r.terms?.version === CONTEXT_RESERVATION_VERSION).map(r => r.id as string);
  if (contextIds.length) {
    if (!context) throw Error("Context admin unavailable");
    const config = exactContextServerConfig(env), evidence = await createExactContextRuntime(config).observeContext();
    const result = await admin.from("exact_installment_context_reservations_v2")
      .select("id,booking_id,context,terms,status,created_at").in("id", contextIds);
    if (result.error || !Array.isArray(result.data) || result.data.length !== contextIds.length) throw Error("Context admin binding unavailable");
    for (const raw of result.data) {
      const r = readExactContextReservation(raw, evidence.contextEvidence), a = rows.find(v => v.id === r.id);
      if (!a || !isDeepStrictEqual(a.terms, { ...r.terms, bookingPaymentId: a.terms.bookingPaymentId }) ||
        !validId(a.terms.bookingPaymentId)) throw Error("Context admin terms differ");
      contextTerms.set(r.id, r.terms);
    }
  }
  const [holds, stops, recoveries] = await Promise.all([
    admin.from("exact_installment_collection_holds").select("agreement_id,reason,request_id,requested_by")
      .in("agreement_id", ids).limit(1001),
    admin.from("exact_installment_billing_stops").select("agreement_id,request_id,actor_id,status")
      .in("agreement_id", ids).limit(26),
    admin.from("exact_installment_payment_recoveries").select("agreement_id,outcome,observed_at")
      .in("agreement_id", ids).limit(1001),
  ]);
  if ([holds, stops, recoveries].some(r => r.error || !Array.isArray(r.data)) ||
    holds.data!.length >= 1000 || recoveries.data!.length >= 1000 || stops.data!.length > 25) {
    throw new Error("Installment review incomplete");
  }
  for (const result of [holds, stops, recoveries]) {
    if (result.data!.some(r => !ids.includes(r.agreement_id))) throw new Error("Installment review identity differs");
  }
  const plans = rows.map(row => {
    if (!versions.includes(row.terms?.version)) throw Error("Unknown installment review protocol");
    const t = contextTerms.get(row.id) ?? snapshotExactTerms(row.terms);
    if (t.version === HELD_INSTALLMENT_VERSION) assertExactInstallmentEnvironment(env, t.previewOrigin);
    if (!['preparing', 'awaiting_first', 'active', 'complete', 'canceled', 'review_required'].includes(row.status) ||
      row.purchase_id !== null && !validId(row.purchase_id)) throw new Error("Invalid installment review state");
    const h = holds.data!.filter(v => v.agreement_id === row.id);
    if (h.some(v => !["admin_refund", "cancellation_review", "verified_refund", "verified_dispute", "subscription_review", "invoice_recovery"].includes(v.reason))) {
      throw new Error("Invalid collection hold");
    }
    const s = stops.data!.filter(v => v.agreement_id === row.id);
    if (s.length > 1) throw new Error("Ambiguous billing stop");
    const cancellation = h.filter(v => v.reason === "cancellation_review");
    if (cancellation.length > 1) throw new Error("Multiple billing stop requests need review");
    const request = cancellation[0];
    const stop = s[0];
    if (request && (!validId(request.request_id) || !validId(request.requested_by)) ||
      stop && (!request || stop.request_id !== request.request_id || stop.actor_id !== request.requested_by ||
        !["running", "complete"].includes(stop.status))) throw new Error("Invalid billing stop review identity");
    const observations = recoveries.data!.filter(v => v.agreement_id === row.id).map(v => {
      if (v.outcome !== null && !['action_required', 'payment_method_required', 'payment_pending', 'terminal_unpaid', 'paid_accounted', 'review_required'].includes(v.outcome) ||
        v.outcome === null && v.observed_at !== null ||
        v.observed_at !== null && (typeof v.observed_at !== "string" || !Number.isFinite(Date.parse(v.observed_at)))) {
        throw new Error("Invalid recovery review state");
      }
      return { outcome: (v.outcome ?? "review_required") as string, observedAt: v.observed_at as string | null };
    });
    return { id: row.id as string, title: t.title, status: row.status as string, totalCents: t.totalCents,
      paymentCount: t.paymentCount, purchaseId: row.purchase_id as string | null,
      holds: [...new Set(h.map(v => v.reason as string))], recoveries: observations,
      stop: request ? { requestId: request.request_id as string,
        status: (stop?.status ?? "requested") as "requested" | "running" | "complete",
        ownedByCaller: request.requested_by === actorId } : null };
  });
  return { plans, nextCursor: data.length > 25 ? rows.at(-1)!.id : null };
}

/** #3: call after requireAdmin and exact confirmation. Persisted protocol is
 * selected before constructing the legacy provider; v2 errors never fall back. */
export async function stopExactAdminBilling(admin: SupabaseClient, actorId: string,
  input: { agreementId: string; requestId: string }, env: Env) {
  for (const id of [actorId, input.agreementId, input.requestId]) assertAgreementId(id);
  if (!exactAdminEnabled(env)) throw Error("Installment controls unavailable");
  if (env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY === "true") {
    const result = await admin.from("exact_installment_agreements").select("id,terms")
      .eq("id", input.agreementId).maybeSingle();
    if (result.error || !result.data || result.data.id !== input.agreementId) throw Error("Installment source unavailable");
    if (result.data.terms?.version === CONTEXT_RESERVATION_VERSION) {
      if (env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_ADMIN_READY !== "true") throw Error("Context admin unavailable");
      return createExactContextBillingStop(exactContextServerConfig(env)).stopBilling(input.agreementId, actorId, input.requestId);
    }
    if (result.data.terms?.version !== HELD_INSTALLMENT_VERSION) throw Error("Unknown installment protocol");
  }
  if (!exactAdminEnabled({ ...env, CREATOR_EXACT_INSTALLMENTS_CONTEXT_ADMIN_READY: "false" })) throw Error("Legacy controls unavailable");
  return stopExactInstallmentBillingSandbox({ ...input, actorId, store: createExactAgreementStore(admin),
    stopStore: createExactBillingStopStore(admin), stripe: getStripe(), env });
}
