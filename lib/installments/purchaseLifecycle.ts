import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { assertAgreementId, type ExactAgreementStore } from "./agreementStore";
import { assertExactInstallmentEnvironment, assertExactInstallmentSandbox, prepareExactCheckoutSandbox } from "./checkoutPreparation";
import { HELD_INSTALLMENT_VERSION } from "./heldInvoice";
import { classifyExactInstallmentProtocol } from "./protocolBoundary";
import { confirmContextInstallment } from "./contextSuccess";

export interface ExactPurchaseLifecycleStore {
  seed(agreementId: string): Promise<string>;
  fulfillFirst(agreementId: string): Promise<void>;
}
export function createExactPurchaseLifecycleStore(admin: SupabaseClient): ExactPurchaseLifecycleStore {
  return {
    async seed(agreementId) {
      assertAgreementId(agreementId);
      const { data, error } = await admin.rpc("seed_exact_installment_purchase", { p_agreement_id: agreementId });
      if (error || typeof data !== "string") throw new Error("Exact pending purchase could not be prepared");
      assertAgreementId(data);
      return data;
    },
    async fulfillFirst(agreementId) {
      assertAgreementId(agreementId);
      const { error } = await admin.rpc("fulfill_exact_installment_first_payment", { p_agreement_id: agreementId });
      if (error) throw new Error("Exact first-payment delivery needs a retry or review");
    },
  };
}

/** Prepare and atomically seed a NEW purchase before a creator can receive a
 * Checkout URL. A lost seed response resumes the persisted binding; it never
 * creates another subscription. URL publication remains a separate gate. */
export async function prepareExactPurchaseSandbox(args: {
  agreementId: string; store: ExactAgreementStore; lifecycleStore: ExactPurchaseLifecycleStore;
  stripe: Parameters<typeof prepareExactCheckoutSandbox>[0]["stripe"];
  env: Record<string, string | undefined>; now?: () => number;
}): Promise<Readonly<{ sessionId: string; subscriptionId: string; purchaseId: string; status: "prepared_unpublished" }>> {
  assertExactInstallmentSandbox(args.env, args.env.NEXT_PUBLIC_SITE_URL || "");
  let a = await args.store.load(args.agreementId);
  assertExactInstallmentSandbox(args.env, a.terms.previewOrigin);
  if (a.status === "preparing") {
    await prepareExactCheckoutSandbox(args);
    a = await args.store.load(args.agreementId);
  }
  if (a.status !== "awaiting_first" || !a.sessionId || !a.subscriptionId) {
    throw new Error("Exact purchase must be prepared before first payment");
  }
  const purchaseId = await args.lifecycleStore.seed(a.id);
  return Object.freeze({ sessionId: a.sessionId, subscriptionId: a.subscriptionId, purchaseId, status: "prepared_unpublished" });
}

export type Confirmation = Readonly<{ httpStatus: 200 | 202 | 409; body: {
  ok?: boolean; error?: string; status?: "pending" | "paid"; session_id?: string;
  purchase_id?: string; post_id?: string; product_id?: string; creator_id?: string;
} }>;

/** Read-only success-page handoff. The first Checkout is mode=payment, but it
 * MUST NOT reach the legacy full-payment upsert or one-time earnings credit.
 * Schema-ready remains on when preparation/collection is paused. */
export async function confirmExactInstallmentSandbox(args: {
  admin: SupabaseClient; session: Stripe.Checkout.Session; buyerId: string;
  env: Record<string, string | undefined>;
}): Promise<Confirmation | null> {
  const { session, admin, env } = args;
  const context = await confirmContextInstallment(args);
  if (context) return context;
  const tagged = classifyExactInstallmentProtocol(session) === "exact-v1";
  if (env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY !== "true") {
    if (tagged) throw new Error("Exact Checkout confirmation cannot use legacy accounting");
    return null;
  }
  assertExactInstallmentEnvironment(env, env.NEXT_PUBLIC_SITE_URL || "");
  if (session.livemode !== false) throw new Error("Live exact confirmation is not enabled");
  const { data: a, error } = await admin.from("exact_installment_agreements")
    .select("id,terms,status,purchase_id,purchase_seeded_at,first_fulfilled_at,stripe_customer_id,stripe_subscription_id,stripe_checkout_session_id")
    .eq("stripe_checkout_session_id", session.id).maybeSingle();
  if (error) throw new Error("Exact Checkout binding lookup failed");
  if (!a) {
    if (tagged) throw new Error("Exact Checkout binding is not ready");
    return null;
  }
  assertAgreementId(a.id);
  assertExactInstallmentEnvironment(env, a.terms?.previewOrigin);
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (a.terms?.version !== HELD_INSTALLMENT_VERSION || session.mode !== "payment" ||
      a.stripe_checkout_session_id !== session.id || a.stripe_customer_id !== customerId ||
      a.terms.buyerId !== args.buyerId || !a.stripe_subscription_id ||
      (tagged && session.metadata?.installment_plan_id !== a.id)) {
    throw new Error("Exact Checkout owner or identity mismatch");
  }
  const pending: Confirmation = { httpStatus: 202, body: { ok: true, session_id: session.id, status: "pending" } };
  const stopped: Confirmation = { httpStatus: 409, body: { error: "This installment purchase needs review. Please contact support." } };
  if (["canceled", "review_required"].includes(a.status)) return stopped;
  if (!["awaiting_first", "active", "complete"].includes(a.status)) throw new Error("Invalid exact confirmation state");
  if (!a.purchase_id || !a.purchase_seeded_at) return pending;
  assertAgreementId(a.purchase_id);
  const { data: p, error: purchaseError } = await admin.from("purchases")
    .select("id,buyer_id,creator_id,post_id,product_id,booking_id,session_id,subscription_id,status,access_granted,paid_count,target_months,is_refund,is_suspect")
    .eq("id", a.purchase_id).maybeSingle();
  if (purchaseError || !p) throw new Error("Exact purchase lookup failed");
  if (p.buyer_id !== args.buyerId || p.creator_id !== a.terms.creatorId || p.post_id !== a.terms.postId ||
      p.product_id !== a.terms.productId || p.booking_id !== a.terms.bookingId ||
      p.session_id !== session.id || p.subscription_id !== a.stripe_subscription_id || p.target_months !== a.terms.paymentCount) {
    throw new Error("Exact purchase identity mismatch");
  }
  if (p.is_refund || p.is_suspect || !["pending", "processing", "active", "complete"].includes(p.status)) return stopped;
  if (session.status !== "complete" || session.payment_status !== "paid" || !a.first_fulfilled_at ||
      p.access_granted !== true || !["active", "complete"].includes(p.status)) return pending;
  if (!Number.isInteger(p.paid_count) || p.paid_count < 1 || p.paid_count > p.target_months ||
      (p.status === "complete") !== (p.paid_count === p.target_months)) throw new Error("Invalid exact purchase progress");
  // "paid" is the existing success-page response contract, not a DB status
  // change: an unfinished plan remains active with its actual paid_count.
  return { httpStatus: 200, body: { ok: true, session_id: session.id, status: "paid",
    purchase_id: p.id, post_id: p.post_id, product_id: p.product_id, creator_id: p.creator_id } };
}
