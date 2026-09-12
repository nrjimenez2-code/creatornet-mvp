import "server-only";
import { isSupportedStripeSnapshotVersion } from "./stripeSnapshotVersion";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertMembershipId } from "./membershipAgreement";
import { membershipCheck as check, membershipStripeId as sid, MEMBERSHIP_STRIPE_VERSION } from "./membershipCheckout";
import { membershipServerContext } from "./membershipServer";
import { createMembershipRuntime } from "./membershipRuntime";
import { membershipLifecycleReady } from "./membershipLifecycle";
import { membershipPaymentEventsReady } from "./membershipPaymentEvents";

/** Only called after signature verification and the canonical durable event
 * claim. Known monthly payments must never enter legacy one-time accounting.
 * Refunds/disputes deliberately continue through the existing shared engine.
 * Unimplemented monthly lifecycle/renewal events fail closed, not successful
 * acknowledgements. Their adapter is a release prerequisite, not implied here.
 */
export async function handoffMonthlyMentorshipWebhook(args: {
  event: Stripe.Event; admin: SupabaseClient; env: Record<string, string | undefined>;
}): Promise<boolean> {
  const { event, admin, env } = args;
  if (event.type === "charge.refunded" || event.type.startsWith("charge.dispute.") || event.type.startsWith("refund.")) return false;
  if (!/^(checkout\.session\.|payment_intent\.|invoice\.|customer\.subscription\.|charge\.)/.test(event.type)) return false;
  const object = event.data.object as unknown as Record<string, unknown>;
  const direct = object.metadata && typeof object.metadata === "object" ? object.metadata as Record<string, unknown> : {};
  const inherited = object.object === "invoice" ? (event.data.object as Stripe.Invoice).parent?.subscription_details?.metadata ?? {} : {};
  const sources = [direct, inherited].filter(value => value.creatornet_membership_version != null ||
    value.creatornet_membership_id != null || value.kind === "monthly_mentorship");
  const marked = sources.length > 0, metadata = sources[0] ?? {};
  if (env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY !== "true") {
    check(!marked, "Monthly event schema is unavailable; never use legacy payment handling"); return false;
  }
  const filters: string[] = [];
  if (marked) {
    for (const source of sources) {
      check(source.creatornet_membership_version === MEMBERSHIP_STRIPE_VERSION, "Monthly event metadata version differs");
      assertMembershipId(source.creatornet_membership_id);
      check(source.creatornet_membership_id === metadata.creatornet_membership_id, "Monthly invoice metadata owners differ");
    }
    filters.push(`id.eq.${metadata.creatornet_membership_id}`);
  }
  if (object.object === "checkout.session") filters.push(`stripe_checkout_session_id.eq.${sid(object.id, "cs")}`);
  if (object.object === "subscription") filters.push(`stripe_subscription_id.eq.${sid(object.id, "sub")}`);
  if (object.customer != null) filters.push(`stripe_customer_id.eq.${sid(object.customer, "cus")}`);
  if (object.object === "invoice") {
    const invoice = event.data.object as Stripe.Invoice;
    const subscription = invoice.parent?.subscription_details?.subscription;
    if (subscription) filters.push(`stripe_subscription_id.eq.${sid(subscription, "sub")}`);
  }
  if (!filters.length) return false;
  const found = await admin.from("monthly_mentorship_agreements_v1")
    .select("id,buyer_id,stripe_customer_id,stripe_subscription_id,stripe_checkout_session_id,initial_abandoned_at").or(filters.join(",")).limit(2);
  check(!found.error && Array.isArray(found.data), "Monthly event ownership is unavailable");
  if (found.data.length === 0) { check(!marked, "Marked monthly payment has no bound owner"); return false; }
  check(found.data.length === 1, "Monthly event has conflicting owners");
  const agreement = found.data[0]; assertMembershipId(agreement.id); assertMembershipId(agreement.buyer_id);
  check(!marked || metadata.creatornet_membership_id === agreement.id, "Monthly event metadata owner differs");
  if (agreement.initial_abandoned_at && (object.object === "subscription" || object.object === "invoice")) {
    // No provider binding is invented for a bootstrap that closed before publication.
    // Unclosed attempts retain the existing retryable ownership check below.
    await createMembershipRuntime(env).reconcileAbandonedCheckoutEvent(agreement.id, agreement.buyer_id, event);
    return true;
  }
  if (object.customer != null) check(sid(object.customer, "cus") === agreement.stripe_customer_id, "Monthly event customer differs");
  let payoffId: string | null = null;
  const payoffHint = metadata.creatornet_membership_payoff_id;
  if (payoffHint != null || metadata.operation_kind === "payoff" ||
      object.object === "checkout.session" && object.id !== agreement.stripe_checkout_session_id && metadata.operation_kind == null &&
      env.CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_SCHEMA_READY === "true") {
    check(env.CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_SCHEMA_READY === "true", "Payoff event schema is unavailable");
    let query = admin.from("monthly_mentorship_payoffs_v1").select("id,agreement_id,buyer_id,stripe_checkout_session_id,fingerprint")
      .eq("agreement_id", agreement.id).eq("buyer_id", agreement.buyer_id);
    if (payoffHint != null) { assertMembershipId(payoffHint); query = query.eq("id", payoffHint); }
    else { check(object.object === "checkout.session"); query = query.eq("stripe_checkout_session_id", sid(object.id, "cs")); }
    const payoff = await query.maybeSingle();
    check(!payoff.error && payoff.data?.agreement_id === agreement.id && payoff.data.buyer_id === agreement.buyer_id &&
      payoff.data.stripe_checkout_session_id, "Payoff event has no published owner");
    assertMembershipId(payoff.data.id); payoffId = payoff.data.id;
    check(payoffHint == null || payoffId === payoffHint && metadata.creatornet_membership_payoff_fingerprint === payoff.data.fingerprint,
      "Payoff event metadata differs");
    if (object.object === "checkout.session") check(object.id === payoff.data.stripe_checkout_session_id, "Payoff event checkout differs");
  } else if (object.object === "checkout.session") check(object.id === agreement.stripe_checkout_session_id, "Monthly event checkout differs");
  if (object.object === "subscription") check(object.id === agreement.stripe_subscription_id, "Monthly event subscription differs");
  if (object.object === "invoice") {
    const subscription = (event.data.object as Stripe.Invoice).parent?.subscription_details?.subscription;
    if (subscription) check(sid(subscription, "sub") === agreement.stripe_subscription_id, "Monthly invoice subscription differs");
  }
  check(env.CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY === "true", "Monthly event reconciliation is paused");
  const context = membershipServerContext(env);
  check(event.livemode === (context.mode === "live") && isSupportedStripeSnapshotVersion(event.api_version, context.apiVersion) &&
    (event.account == null || event.account === context.stripeAccountId), "Monthly webhook provider context differs");
  if (membershipPaymentEventsReady(env) && (object.object === "payment_intent" || object.object === "charge")) {
    await createMembershipRuntime(env).reconcilePaymentEvent(agreement.id, agreement.buyer_id, event, payoffId);
    return true;
  }
  if (membershipLifecycleReady(env) && (object.object === "invoice" || object.object === "subscription" ||
      ["checkout.session.expired", "checkout.session.async_payment_failed"].includes(event.type))) {
    await createMembershipRuntime(env).reconcileLifecycle(agreement.id, agreement.buyer_id, event, payoffId);
    return true;
  }
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    if (payoffId) {
      const result = await createMembershipRuntime(env).confirmPayoff(agreement.id, agreement.buyer_id, payoffId);
      check(result.payoffRecorded, "Payoff captured payment is not yet recorded"); return true;
    }
    const result = await createMembershipRuntime(env).confirmFirst(agreement.id, agreement.buyer_id);
    check(result.firstPaymentRecorded, "Monthly captured payment is not yet recorded"); return true;
  }
  if (event.type === "payment_intent.succeeded") {
    if (payoffId) {
      const result = await createMembershipRuntime(env).confirmPayoff(agreement.id, agreement.buyer_id, payoffId);
      check(result.payoffRecorded, "Payoff captured payment is not yet recorded");
      const receipt = await admin.from("monthly_mentorship_payoffs_v1").select("provider_proof").eq("id", payoffId)
        .eq("agreement_id", agreement.id).eq("status", "captured").maybeSingle();
      check(!receipt.error && receipt.data?.provider_proof?.paymentIntentId === object.id, "Payoff PaymentIntent receipt differs"); return true;
    }
    await createMembershipRuntime(env).confirmFirst(agreement.id, agreement.buyer_id);
    const receipt = await admin.from("monthly_mentorship_receipts_v1").select("provider_proof").eq("agreement_id", agreement.id)
      .eq("month_number", 1).maybeSingle();
    check(!receipt.error);
    if (receipt.data?.provider_proof?.paymentIntentId === object.id) return true;
    const renewal = await admin.from("monthly_mentorship_receipts_v1").select("provider_proof").eq("agreement_id", agreement.id)
      .eq("provider_proof->>paymentIntentId", sid(object.id, "pi")).maybeSingle();
    check(!renewal.error && renewal.data?.provider_proof?.paymentIntentId === object.id,
      "Monthly renewal payment requires its own receipt reconciliation"); return true;
  }
  if (["invoice.paid", "invoice.payment_succeeded", "invoice.payment_failed", "invoice.payment_action_required"].includes(event.type) &&
      env.CREATOR_MONTHLY_MENTORSHIPS_COLLECTION_SCHEMA_READY === "true") {
    check(object.object === "invoice");
    const result = await createMembershipRuntime(env).reconcileInvoice(agreement.id, agreement.buyer_id, sid(object.id, "in"));
    if (result.status === "payment_pending") {
      check(event.type !== "invoice.paid" && event.type !== "invoice.payment_succeeded", "Monthly invoice capture is not yet recorded");
      const reviewed = await admin.rpc("review_monthly_mentorship_collection_v1", { p_id: agreement.id, p_month: result.month, p_context: context });
      check(!reviewed.error && typeof reviewed.data === "boolean", "Monthly payment failure needs durable review");
    }
    return true;
  }
  // A subscription snapshot, invoice, failure or expiry must be processed by
  // its own lifecycle/renewal adapter. Do not mark it paid, canceled, waived or
  // successfully processed merely because an agreement can be located.
  throw Error("Monthly lifecycle reconciliation requires its dedicated adapter");
}
