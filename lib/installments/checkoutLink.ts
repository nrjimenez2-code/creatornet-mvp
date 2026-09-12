import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAgreementId, createExactAgreementStore, operationHash, type ExactAgreementStore } from "./agreementStore";
import { assertExactInstallmentEnvironment, assertExactInstallmentSandbox, installmentMonthBoundary } from "./checkoutPreparation";
import { buildExactInstallmentCheckoutContract } from "./checkoutContract";
import { createExactPurchaseLifecycleStore, prepareExactPurchaseSandbox, type ExactPurchaseLifecycleStore } from "./purchaseLifecycle";
import { calculateInstallmentPlan } from "../installmentPlan";
import { getProcessingFeeSchedule, getSubscriptionProcessingFeeSchedule, type ProcessingFeeSchedule } from "../money";
import { HELD_INSTALLMENT_VERSION } from "./heldInvoice";
import { handoffContextCheckoutLink } from "./contextCheckoutApp";

type Env = Record<string, string | undefined>;
export const EXACT_CHECKOUT_LINK_GATES = Object.freeze([
  "CREATOR_EXACT_INSTALLMENTS_CHECKOUT_SCHEMA_READY", "CREATOR_EXACT_INSTALLMENTS_CHECKOUT_PUBLISH_READY",
  "CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY", "CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE",
  "CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY", "CREATOR_EXACT_INSTALLMENTS_REFUND_EVENTS_READY",
  "CREATOR_EXACT_INSTALLMENTS_BILLING_STOPS_READY", "CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY",
  "CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY", "CREATOR_EXACT_INSTALLMENTS_ADMIN_READY",
] as const);
function check(value: unknown): asserts value { if (!value) throw new Error("Exact checkout requires reconciliation"); }
const id = (value: string | { id: string } | null | undefined) => typeof value === "string" ? value : value?.id;

export interface ExactCheckoutLinkStore {
  lookup(bookingId: string): Promise<string | null>;
  reserve(bookingId: string, actorId: string, count: number, origin: string,
    first: ProcessingFeeSchedule, renewal: ProcessingFeeSchedule): Promise<string>;
  requestHash(agreementId: string, sessionId: string): Promise<string>;
  publish(input: { agreementId: string; actorId: string; sessionId: string; subscriptionId: string;
    purchaseId: string; url: string; expiresAt: number; requestHash: string }): Promise<unknown>;
}
export function createExactCheckoutLinkStore(admin: SupabaseClient): ExactCheckoutLinkStore {
  return {
    async lookup(bookingId) {
      assertAgreementId(bookingId);
      const { data, error } = await admin.from("exact_installment_agreements").select("id")
        .eq("terms->>bookingId", bookingId).maybeSingle();
      check(!error); if (!data) return null; assertAgreementId(data.id); return data.id;
    },
    async reserve(bookingId, actorId, count, origin, first, renewal) {
      const { data, error } = await admin.rpc("reserve_exact_installment_checkout", { p_booking_id: bookingId,
        p_actor_id: actorId, p_count: count, p_origin: origin, p_first_fee: first, p_renewal_fee: renewal });
      check(!error && typeof data === "string"); assertAgreementId(data); return data;
    },
    async requestHash(agreementId, sessionId) {
      const { data, error } = await admin.from("exact_installment_operations").select("request_hash")
        .eq("agreement_id", agreementId).eq("step", "checkout").eq("status", "complete").eq("result_id", sessionId).single();
      check(!error && typeof data?.request_hash === "string" && /^[0-9a-f]{64}$/.test(data.request_hash));
      return data.request_hash;
    },
    async publish(p) {
      const { data, error } = await admin.rpc("publish_exact_installment_checkout", { p_agreement_id: p.agreementId,
        p_actor_id: p.actorId, p_session_id: p.sessionId, p_subscription_id: p.subscriptionId, p_purchase_id: p.purchaseId,
        p_url: p.url, p_expires_at: p.expiresAt, p_request_hash: p.requestHash });
      check(!error); return data;
    },
  };
}

/** Scope new issuance before selecting any customer or calling Stripe. This is
 * a server-only list of staging BOOKING UUIDs, not the monthly agreement list. */
export function selectedExactCheckoutBooking(env: Env, bookingId: string): boolean {
  const raw = env.CREATOR_EXACT_INSTALLMENTS_CHECKOUT_BOOKING_IDS;
  if (!raw?.trim()) return false;
  const ids = raw.split(",").map(value => value.trim());
  check(raw.length <= 500 && ids.length <= 10 && new Set(ids).size === ids.length);
  ids.forEach(assertAgreementId);
  return ids.includes(bookingId);
}

type Input = {
  bookingId: string; actorId: string; count: number;
  store: ExactAgreementStore; links: ExactCheckoutLinkStore; lifecycleStore: ExactPurchaseLifecycleStore;
  stripe: Pick<Stripe, "customers" | "products" | "subscriptions" | "checkout" | "paymentIntents">;
  env: Env; now?: () => number;
};

/** Payable URL publication is distinct from preparation and is never payment
 * or fulfillment. Repeated requests reuse only the immutable reservation and
 * retrieve its original session; old links/plans cannot be converted. */
export async function issueExactCheckoutLinkSandbox(args: Input) {
  const { env, links, stripe } = args;
  assertExactInstallmentSandbox(env, env.NEXT_PUBLIC_SITE_URL || "");
  check(EXACT_CHECKOUT_LINK_GATES.every(key => env[key] === "true") && selectedExactCheckoutBooking(env, args.bookingId));
  assertAgreementId(args.bookingId); assertAgreementId(args.actorId);
  check(Number.isInteger(args.count) && args.count >= 2 && args.count <= 24);
  check(env.CREATOR_PROCESSING_FEE_ENABLED === "true");
  const agreementId = await links.reserve(args.bookingId, args.actorId, args.count, env.NEXT_PUBLIC_SITE_URL!,
    getProcessingFeeSchedule(env), getSubscriptionProcessingFeeSchedule(env));
  const a = await args.store.load(agreementId), t = a.terms;
  check(a.id === agreementId && t.bookingId === args.bookingId && t.creatorId === args.actorId && t.paymentCount === args.count);
  assertExactInstallmentSandbox(env, t.previewOrigin);
  const prepared = await prepareExactPurchaseSandbox({ ...args, agreementId });
  const current = await args.store.load(agreementId);
  check(current.status === "awaiting_first" && operationHash(current.terms) === operationHash(t) &&
    current.sessionId === prepared.sessionId && current.subscriptionId === prepared.subscriptionId && current.customerId);
  const now = (args.now ?? (() => Math.floor(Date.now() / 1000)))();
  const expiresAt = a.createdAt + 86400, trialEnd = a.createdAt + 2 * 86400;
  check(now >= a.createdAt && now < expiresAt - 60);
  const sub = await stripe.subscriptions.retrieve(prepared.subscriptionId);
  const plan = calculateInstallmentPlan(t.totalCents, t.paymentCount, t.renewalFeeSchedule, t.firstPaymentFeeSchedule);
  check(sub.trial_end === trialEnd && sub.cancel_at === installmentMonthBoundary(trialEnd, t.paymentCount - 1) &&
    sub.billing_mode?.type === "classic" && !sub.default_payment_method && !sub.default_source && !sub.pending_update && !sub.schedule &&
    sub.automatic_tax.enabled === false && sub.discounts.length === 0 && sub.collection_method === "charge_automatically" &&
    sub.payment_settings?.save_default_payment_method === "off" && sub.payment_settings.payment_method_types?.length === 1 &&
    sub.payment_settings.payment_method_types[0] === "card" && sub.items.has_more === false && sub.items.data.length === 1 &&
    sub.items.data[0].quantity === 1 && sub.items.data[0].price.unit_amount === plan.regularAmountCents &&
    sub.items.data[0].price.currency === "usd" && sub.items.data[0].price.recurring?.interval === "month" &&
    sub.items.data[0].price.recurring?.interval_count === 1);
  const customer = await stripe.customers.retrieve(current.customerId!);
  check(!customer.deleted && customer.id === current.customerId && customer.livemode === false && customer.balance === 0 &&
    !customer.default_source && !customer.invoice_settings.default_payment_method && customer.metadata.installment_plan_id === agreementId);
  const contract = { ...buildExactInstallmentCheckoutContract({ ...t, planId: agreementId, customerId: current.customerId!,
    subscriptionId: prepared.subscriptionId }, sub), expires_at: expiresAt };
  const hash = operationHash(contract);
  check(hash === await links.requestHash(agreementId, prepared.sessionId));
  const session = await stripe.checkout.sessions.retrieve(prepared.sessionId);
  check(session.id === prepared.sessionId && session.livemode === false && session.mode === "payment" &&
    session.status === "open" && session.payment_status === "unpaid" && id(session.customer) === current.customerId &&
    session.currency === "usd" && session.amount_total === plan.payments[0].amountCents && session.amount_subtotal === session.amount_total &&
    session.expires_at === expiresAt && session.payment_method_types.length === 1 && session.payment_method_types[0] === "card" &&
    !session.automatic_tax.enabled && !session.adaptive_pricing?.enabled && !session.allow_promotion_codes && !session.invoice_creation?.enabled &&
    !session.subscription && !session.after_expiration && !session.recovered_from &&
    session.total_details?.amount_tax === 0 && session.total_details.amount_discount === 0 && session.total_details.amount_shipping === 0 &&
    session.success_url === contract.success_url && session.cancel_url === contract.cancel_url &&
    session.consent_collection?.payment_method_reuse_agreement?.position === "auto" &&
    contract.custom_text?.submit != null && typeof contract.custom_text.submit === "object" &&
    session.custom_text.submit?.message === contract.custom_text.submit.message);
  for (const [key, value] of Object.entries(contract.metadata!)) check(session.metadata?.[key] === value);
  // Stripe documents payment_intent as nullable on an open Session. The durable
  // completed request hash proves the configured first fee before it exists.
  // If already allocated, independently verify the actual unpaid intent too.
  const piId = id(session.payment_intent);
  if (piId) {
    const pi = await stripe.paymentIntents.retrieve(piId);
    check(pi.id === piId && pi.livemode === false && pi.status === "requires_payment_method" && pi.amount_received === 0 &&
      pi.amount_capturable === 0 && !pi.latest_charge && pi.currency === "usd" && pi.amount === plan.payments[0].amountCents &&
      id(pi.customer) === current.customerId && pi.application_fee_amount === plan.payments[0].fees.totalCreatorDeductionCents &&
      id(pi.transfer_data?.destination) === t.destinationId && pi.transfer_data?.amount == null && pi.setup_future_usage === "off_session");
  }
  check(typeof session.url === "string" && session.url.length <= 8192);
  const url = new URL(session.url!);
  check(url.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.port && !url.username && !url.password &&
    url.pathname === `/c/pay/${session.id}` && !/\s/.test(session.url!));
  const raw = await links.publish({ agreementId, actorId: args.actorId, sessionId: session.id, subscriptionId: prepared.subscriptionId,
    purchaseId: prepared.purchaseId, url: session.url!, expiresAt, requestHash: hash });
  check(raw && typeof raw === "object" && !Array.isArray(raw));
  const result = raw as { url: string; reused: boolean; payment: Record<string, unknown> }, p = result.payment;
  check(result.url === session.url && typeof result.reused === "boolean" && p && p.id === t.bookingPaymentId &&
    p.booking_id === t.bookingId && p.status === "link_sent" && p.link_url === session.url && p.plan_type === "installment" &&
    p.installment_collection_version === HELD_INSTALLMENT_VERSION && p.stripe_checkout_session_id === session.id &&
    p.stripe_subscription_id === prepared.subscriptionId && p.amount_total_cents === t.totalCents &&
    p.installment_months === t.paymentCount && p.installment_amount_cents === plan.regularAmountCents &&
    p.platform_fee_cents === plan.payments[0].fees.platformFeeCents && p.processing_fee_cents === plan.payments[0].fees.processingFeeCents &&
    p.total_creator_deduction_cents === plan.payments[0].fees.totalCreatorDeductionCents &&
    p.creator_net_cents === plan.payments[0].fees.creatorNetCents && p.fee_schedule_version === t.firstPaymentFeeSchedule.version && p.currency === "usd");
  const fields = ["id", "booking_id", "plan_type", "installment_months", "status", "link_url", "stripe_checkout_session_id",
    "stripe_subscription_id", "stripe_payment_intent_id", "amount_total_cents", "installment_amount_cents", "platform_fee_cents",
    "processing_fee_cents", "total_creator_deduction_cents", "creator_net_cents", "fee_schedule_version", "currency",
    "created_at", "completed_at", "link_sent_at", "closer_user_id", "installment_collection_version"];
  return { url: result.url, payment: Object.fromEntries(fields.map(key => [key, p[key] ?? null])), reused: result.reused };
}

/** Existing authenticated creator route calls this before legacy link creation.
 * Keep SCHEMA_READY enabled for persisted exact plans during a feature pause:
 * known reservations must never fall back to legacy Stripe session creation. */
export async function handoffExactCheckoutLink(args: {
  bookingId: string; actorId: string; body: unknown; origin: string | null;
  admin: SupabaseClient; stripe: () => Stripe; env: Env;
}): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const { env } = args;
  const context = await handoffContextCheckoutLink(args);
  if (context) return context;
  if (env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY !== "true" && env.CREATOR_EXACT_INSTALLMENTS_CHECKOUT_SCHEMA_READY !== "true" &&
    env.CREATOR_EXACT_INSTALLMENTS_CHECKOUT_PUBLISH_READY !== "true") return null;
  try {
    assertExactInstallmentEnvironment(env, env.NEXT_PUBLIC_SITE_URL || "");
    check(env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY === "true");
    const links = createExactCheckoutLinkStore(args.admin);
    const known = await links.lookup(args.bookingId);
    const selected = env.CREATOR_EXACT_INSTALLMENTS_CHECKOUT_PUBLISH_READY === "true" && selectedExactCheckoutBooking(env, args.bookingId);
    const b = args.body as Record<string, unknown> | null;
    if (!known && (!selected || b?.plan_type !== "installment")) return null;
    if (!selected || !EXACT_CHECKOUT_LINK_GATES.every(key => env[key] === "true")) return {
      status: 409, body: { error: "This installment link is paused for review. No replacement link was created.", code: "EXACT_CHECKOUT_HELD" } };
    if (args.origin !== env.NEXT_PUBLIC_SITE_URL) return { status: 403, body: { error: "Request origin is not allowed." } };
    if (!b || Array.isArray(b) || Object.keys(b).some(key => !["plan_type", "installment_months"].includes(key)) ||
      b.plan_type !== "installment" || !Number.isInteger(b.installment_months) || Number(b.installment_months) < 2 || Number(b.installment_months) > 24) {
      return { status: 400, body: { error: "Use an installment count from 2 to 24 without changing an existing plan." } };
    }
    const body = await issueExactCheckoutLinkSandbox({ bookingId: args.bookingId, actorId: args.actorId, count: Number(b.installment_months),
      links, store: createExactAgreementStore(args.admin), lifecycleStore: createExactPurchaseLifecycleStore(args.admin), stripe: args.stripe(), env });
    return { status: 200, body };
  } catch {
    // A lost provider/DB reply can follow a durable reservation. Preserve it;
    // do not claim nothing happened, leak raw errors, or try the legacy path.
    return { status: 409, body: { error: "This installment link could not be verified. Its existing reservation is preserved for review.",
      code: "EXACT_CHECKOUT_REVIEW_REQUIRED" } };
  }
}
