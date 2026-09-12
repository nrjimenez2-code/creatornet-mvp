import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isDeepStrictEqual } from "node:util";
import type { Confirmation } from "./purchaseLifecycle";
import { createExactContextReservationStore } from "./contextReservation";
import { classifyContextInstallmentProtocol, classifyExactInstallmentProtocol } from "./protocolBoundary";
import { exactContextServerConfig } from "./contextServer";
import { createExactContextRuntime } from "./contextRuntime";
import { assertAgreementId } from "./agreementStore";

function check(v: unknown): asserts v { if (!v) throw Error("Context purchase confirmation needs review"); }
/** #3: success-page read only. A complete Stripe redirect alone never grants
 * access, marks all installments paid or falls through to the legacy upsert. */
export async function confirmContextInstallment(args: { admin: SupabaseClient; session: Stripe.Checkout.Session;
  buyerId: string; env: Record<string, string | undefined> }): Promise<Confirmation | null> {
  const { admin, session, buyerId, env } = args;
  if (env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY !== "true") {
    classifyExactInstallmentProtocol(session);
    return null;
  }
  const tagged = classifyContextInstallmentProtocol(session) === "exact-context-v2";
  const lookup = await admin.rpc("resolve_exact_context_event_v2", { p_kind: "session", p_provider_id: session.id, p_hint: null });
  check(!lookup.error); if (!lookup.data) { check(!tagged); return null; }
  const b = lookup.data, config = exactContextServerConfig(env);
  check(isDeepStrictEqual(b.context, config.approvedContext) && b.sessionId === session.id && session.livemode === (config.approvedContext.mode === "live"));
  const observation = await createExactContextRuntime(config).observeContext();
  const r = await createExactContextReservationStore({ admin, context: config.approvedContext, contextEvidence: observation.contextEvidence }).load(b.reservationId, b.creatorId);
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  check(r.terms.buyerId === buyerId && session.mode === "payment" && customerId === b.customerId && b.subscriptionId &&
    (!tagged || session.metadata?.installment_plan_id === r.id));
  const pending: Confirmation = { httpStatus: 202, body: { ok: true, session_id: session.id, status: "pending" } };
  if (b.firstCredited !== true) return pending;
  const agreement = await admin.from("exact_installment_agreements")
    .select("id,terms,status,purchase_id,purchase_seeded_at,first_fulfilled_at,stripe_checkout_session_id,stripe_subscription_id,stripe_customer_id")
    .eq("id", r.id).single();
  const a = agreement.data;
  check(!agreement.error && a && a.stripe_checkout_session_id === session.id && a.stripe_subscription_id === b.subscriptionId &&
    a.stripe_customer_id === b.customerId && a.terms.buyerId === buyerId && a.purchase_id && a.purchase_seeded_at);
  assertAgreementId(a.purchase_id);
  const purchase = await admin.from("purchases")
    .select("id,buyer_id,creator_id,post_id,product_id,booking_id,session_id,subscription_id,status,access_granted,paid_count,target_months,is_refund,is_suspect")
    .eq("id", a.purchase_id).single();
  const p = purchase.data, t = r.terms;
  check(!purchase.error && p && p.buyer_id === buyerId && p.creator_id === t.creatorId && p.post_id === t.postId &&
    p.product_id === t.productId && p.booking_id === t.bookingId && p.session_id === session.id && p.subscription_id === b.subscriptionId && p.target_months === t.paymentCount);
  if (["canceled", "review_required"].includes(a.status) || p.is_refund || p.is_suspect ||
    !["pending", "processing", "active", "complete"].includes(p.status)) return { httpStatus: 409,
    body: { error: "This installment purchase needs review. Please contact support." } };
  check(["awaiting_first", "active", "complete"].includes(a.status));
  let financialAccess = p.access_granted === true;
  if (t.serviceMonths !== undefined) {
    check(env.CREATOR_FIXED_SERVICE_SCHEMA_READY === "true");
    const service = await admin.rpc("read_fixed_service_entitlement_v1", { p_purchase_id: p.id, p_buyer_id: buyerId });
    check(!service.error && service.data?.applicable === true && service.data.agreementId === r.id &&
      service.data.serviceMonths === t.serviceMonths && typeof service.data.financialAccess === "boolean");
    // A paid purchase remains paid after service expires; this response is not
    // permission to access content. The owned entitlement reader bounds access.
    financialAccess = service.data.financialAccess;
  }
  if (session.status !== "complete" || session.payment_status !== "paid" || !a.first_fulfilled_at ||
    !financialAccess || !["active", "complete"].includes(p.status)) return pending;
  check(Number.isInteger(p.paid_count) && p.paid_count >= 1 && p.paid_count <= p.target_months &&
    (p.status === "complete") === (p.paid_count === p.target_months));
  return { httpStatus: 200, body: { ok: true, session_id: session.id, status: "paid", purchase_id: p.id,
    post_id: p.post_id, product_id: p.product_id, creator_id: p.creator_id } };
}
