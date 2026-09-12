import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAgreementId } from "./agreementStore";
import { createExactContextReservationStore, CONTEXT_RESERVATION_VERSION, type ContextReservationTerms } from "./contextReservation";
import { createExactContextRuntime, createExactContextBootstrapPlanner, createExactContextCustomerBootstrap,
  createExactContextHeldBootstrap, createExactContextCheckout, createExactContextCheckoutPublication } from "./contextRuntime";
import { exactContextServerConfig } from "./contextServer";
import { calculateInstallmentPlan } from "../installmentPlan";
import { getProcessingFeeSchedule, getSubscriptionProcessingFeeSchedule } from "../money";

type Env = Record<string, string | undefined>;
function check(v: unknown): asserts v { if (!v) throw Error("Context Checkout needs review"); }
type LinkRow = { reservationId: string; bookingId: string; terms: ContextReservationTerms; createdAt: string;
  sessionId: string | null; url: string | null; expiresAt: number | null; publishedAt: string | null };

/** Same creator screen shape, explicitly NOT a booking_payments row. Once the
 * real first payment is credited the original accounting row replaces this. */
export function contextCheckoutPayment(r: LinkRow) {
  assertAgreementId(r.reservationId); assertAgreementId(r.bookingId);
  const t = r.terms; check(t.version === CONTEXT_RESERVATION_VERSION && t.bookingId === r.bookingId && t.currency === "usd");
  const first = calculateInstallmentPlan(t.totalCents, t.paymentCount, t.renewalFeeSchedule, t.firstPaymentFeeSchedule).payments[0];
  return { id: r.reservationId, payment_record_kind: "checkout_reservation", booking_id: r.bookingId, plan_type: "installment",
    installment_months: t.paymentCount, status: r.url ? "link_sent" : r.publishedAt ? "expired" : "pending",
    link_url: r.url, stripe_checkout_session_id: r.sessionId, stripe_subscription_id: null, stripe_payment_intent_id: null,
    amount_total_cents: t.totalCents, installment_amount_cents: first.amountCents,
    platform_fee_cents: first.fees.platformFeeCents, processing_fee_cents: first.fees.processingFeeCents,
    total_creator_deduction_cents: first.fees.totalCreatorDeductionCents, creator_net_cents: first.fees.creatorNetCents,
    fee_schedule_version: t.firstPaymentFeeSchedule.version, currency: "usd", created_at: r.createdAt,
    completed_at: null, link_sent_at: r.publishedAt, closer_user_id: t.creatorId, installment_collection_version: CONTEXT_RESERVATION_VERSION };
}
export async function readContextCheckoutPayments(admin: SupabaseClient, actorId: string, bookingIds: string[], env: Env) {
  if (env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY !== "true") return [];
  assertAgreementId(actorId); bookingIds.forEach(assertAgreementId); check(bookingIds.length <= 100);
  const result = await admin.rpc("read_exact_context_checkout_links_v2", { p_actor_id: actorId, p_booking_ids: bookingIds });
  check(!result.error && Array.isArray(result.data));
  return (result.data as LinkRow[]).map(r => { check(bookingIds.includes(r.bookingId) && r.terms.creatorId === actorId); return contextCheckoutPayment(r); });
}

const publishGates = ["CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY", "CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY",
  "CREATOR_EXACT_INSTALLMENTS_CONTEXT_CHECKOUT_PUBLISH_READY", "CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_READY"] as const;
function selected(env: Env, bookingId: string) {
  const raw = env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_CHECKOUT_BOOKING_IDS;
  if (!raw?.trim()) return false;
  const ids = raw.split(",").map(v => v.trim());
  check(raw.length <= 500 && ids.length <= 10 && new Set(ids).size === ids.length); ids.forEach(assertAgreementId);
  return ids.includes(bookingId);
}
export async function handoffContextCheckoutLink(args: {
  admin: SupabaseClient; bookingId: string; actorId: string; body: unknown; origin: string | null; env: Env;
}): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const { env, admin, bookingId, actorId } = args;
  if (env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY !== "true") {
    if (env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_CHECKOUT_PUBLISH_READY === "true")
      return { status: 409, body: { error: "Context schema is not ready for Checkout." } };
    return null;
  }
  try {
    assertAgreementId(bookingId); assertAgreementId(actorId);
    const known = await admin.from("exact_installment_context_reservations_v2").select("id").eq("booking_id", bookingId).maybeSingle();
    check(!known.error);
    const body = args.body as Record<string, unknown> | null;
    const chosen = selected(env, bookingId);
    if (!known.data && (!chosen || body?.plan_type !== "installment")) return null;
    if (!known.data) {
      // Keep earlier agreements on their original protocol even if a rollout
      // list mistakenly includes that booking. Never relabel/adopt them.
      const prior = await admin.from("booking_payments").select("id").eq("booking_id", bookingId).limit(1);
      check(!prior.error && Array.isArray(prior.data)); if (prior.data.length) return null;
    }
    if (!chosen || !publishGates.every(g => env[g] === "true")) return { status: 409, body: {
      error: "This installment link is paused. Its existing reservation is preserved.", code: "EXACT_CHECKOUT_HELD" } };
    const config = exactContextServerConfig(env);
    if (args.origin !== config.approvedContext.siteOrigin) return { status: 403, body: { error: "Request origin is not allowed." } };
    if (!body || Array.isArray(body) || Object.keys(body).some(k => !["plan_type", "installment_months"].includes(k)) ||
      body.plan_type !== "installment" || !Number.isInteger(body.installment_months) || Number(body.installment_months) < 2 || Number(body.installment_months) > 24)
      return { status: 400, body: { error: "Use an installment count from 2 to 24 without changing an existing plan." } };
    check(env.CREATOR_PROCESSING_FEE_ENABLED === "true");
    const observed = await createExactContextRuntime(config).observeContext();
    const store = createExactContextReservationStore({ admin, context: config.approvedContext, contextEvidence: observed.contextEvidence });
    const r = known.data ? await store.load(known.data.id, actorId) : await store.reserve({ actorId, bookingId,
      paymentCount: Number(body.installment_months), firstPaymentFeeSchedule: getProcessingFeeSchedule(env), renewalFeeSchedule: getSubscriptionProcessingFeeSchedule(env) });
    check(r.bookingId === bookingId && r.terms.paymentCount === body.installment_months);
    if (r.terms.serviceMonths !== undefined &&
      (env.CREATOR_FIXED_SERVICE_SCHEMA_READY !== "true" || env.CREATOR_FIXED_SERVICE_CONTEXT_READY !== "true")) {
      return { status: 409, body: { error: "This timed-service offer is paused. Its saved terms are preserved.", code: "FIXED_SERVICE_HELD" } };
    }
    await createExactContextBootstrapPlanner(config).planCustomer(r.id, actorId);
    check((await createExactContextCustomerBootstrap(config).createCustomer(r.id, actorId)).status === "customer_bound");
    check((await createExactContextHeldBootstrap(config).prepareHeld(r.id, actorId)).status === "held_unpublished");
    check((await createExactContextCheckout(config).prepareCheckout(r.id, actorId)).status === "checkout_prepared_unpublished");
    const p = await createExactContextCheckoutPublication(config).publishCheckout(r.id, actorId);
    check(p.status === "checkout_published");
    const payments = await readContextCheckoutPayments(admin, actorId, [bookingId], env);
    const payment = payments.find(row => row.id === r.id);
    check(payment && payment.link_url === p.url && payment.stripe_checkout_session_id === p.sessionId);
    return { status: 200, body: { url: p.url, payment, reused: p.reused } };
  } catch {
    // Lost replies retain durable identities. Never fall back, replace a plan
    // or expose a provider URL that has not passed publication admission.
    return { status: 409, body: { error: "This installment link needs review. Its existing reservation is preserved.", code: "EXACT_CHECKOUT_REVIEW_REQUIRED" } };
  }
}
