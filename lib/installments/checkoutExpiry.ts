import "server-only";
import type Stripe from "stripe";
import { calculateInstallmentPlan } from "../installmentPlan";
import { assertAgreementId, type ExactAgreementStore } from "./agreementStore";
import { assertExactInstallmentEnvironment } from "./checkoutPreparation";
import type { ExactLifecycleStore, LifecycleResult } from "./lifecycleEvents";

/** Expiry is an abandonment observation, not buyer debt forgiveness or a refund.
 * Records a durable subscription review hold so the existing admin stop workflow
 * can clean up the isolated held subscription. Never expires/cancels/charges here.
 * An open/pending/paid session is not treated as an expired unpaid purchase. */
export async function observeExpiredExactCheckoutSandbox(args: {
  agreementId: string; sessionId: string; eventId: string; store: ExactAgreementStore;
  lifecycleEventStore: ExactLifecycleStore; stripe: Pick<Stripe, "checkout" | "paymentIntents">;
  env: Record<string, string | undefined>; now?: () => number;
}): Promise<LifecycleResult> {
  assertExactInstallmentEnvironment(args.env, args.env.NEXT_PUBLIC_SITE_URL || "");
  if (args.env.CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY !== "true" ||
    args.env.CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY !== "true") throw new Error("Checkout expiry review not enabled");
  assertAgreementId(args.agreementId);
  if (!/^cs_test_[a-zA-Z0-9]+$/.test(args.sessionId) || !/^evt_[a-zA-Z0-9]+$/.test(args.eventId)) throw new Error("Invalid expiry identity");
  const a = await args.store.load(args.agreementId);
  assertExactInstallmentEnvironment(args.env, a.terms.previewOrigin);
  if (a.id !== args.agreementId || a.sessionId !== args.sessionId || !a.customerId || !a.subscriptionId) throw new Error("Checkout expiry binding differs");
  const id = (v: string | { id: string } | null) => typeof v === "string" ? v : v?.id;
  const requireThat = (v: unknown) => { if (!v) throw new Error("Checkout expiry evidence differs"); };
  const readStripe = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch { throw new Error("Checkout expiry evidence unavailable"); }
  };
  const read = await args.lifecycleEventStore.read(a.id, a.subscriptionId);
  const session = await readStripe(() => args.stripe.checkout.sessions.retrieve(args.sessionId));
  const first = calculateInstallmentPlan(a.terms.totalCents, a.terms.paymentCount,
    a.terms.renewalFeeSchedule, a.terms.firstPaymentFeeSchedule).payments[0];
  requireThat(session.id === a.sessionId && session.livemode === false && session.mode === "payment" &&
    id(session.customer) === a.customerId && session.currency === "usd" && session.amount_subtotal === first.amountCents &&
    session.amount_total === first.amountCents && !session.total_details?.amount_tax && !session.total_details?.amount_discount &&
    !session.total_details?.amount_shipping && session.metadata?.installment_plan_id === a.id &&
    session.metadata.installment_collection_version === a.terms.version && session.metadata.booking_payment_id === a.terms.bookingPaymentId);
  if (session.status !== "expired" || session.payment_status !== "unpaid") return { status: "reconciliation_required" };
  requireThat(Number.isSafeInteger(session.expires_at) && session.expires_at > a.createdAt &&
    session.expires_at <= (args.now ?? (() => Math.floor(Date.now() / 1000)))());
  // The actual terminal session is verified before recording its review hold.
  // A canceled invoice PI and a Checkout PI have different lifecycle controls.
  // Never cancel a Checkout PI directly or infer a canceled payment from expiry.
  const piId = id(session.payment_intent);
  let settled = piId == null;
  if (piId) {
    requireThat(/^pi_[a-zA-Z0-9]+$/.test(piId));
    const pi = await readStripe(() => args.stripe.paymentIntents.retrieve(piId));
    requireThat(pi.id === piId && pi.livemode === false && id(pi.customer) === a.customerId && pi.currency === "usd" &&
      pi.amount === first.amountCents && pi.application_fee_amount === first.fees.totalCreatorDeductionCents &&
      id(pi.transfer_data?.destination ?? null) === a.terms.destinationId && pi.transfer_data?.amount == null);
    settled = pi.status === "canceled" && pi.amount_received === 0 && pi.amount_capturable === 0;
  }
  await args.lifecycleEventStore.hold(a.id, args.eventId, a.subscriptionId, null);
  const saved = await args.lifecycleEventStore.observe({ agreementId: a.id, eventId: args.eventId, objectId: a.subscriptionId, read },
    "review_required", { reason: settled ? "checkout_expired_unpaid" : "checkout_expired_payment_unsettled", checkoutStatus: "expired" });
  return { status: saved ? "lifecycle_review_recorded" : "reconciliation_required" };
}
