import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertMembershipId, membershipMonthBoundary } from "./membershipAgreement";
import { membershipBootstrapTimes, membershipCheck as check, membershipStripeId as sid, type MembershipRecord } from "./membershipCheckout";
import { assertMembershipActivated, type MembershipFirstProof } from "./membershipRenewal";
/** Classify inert native invoices, never a payment or permission to collect. */
export function assertMembershipBootstrapInvoice(i: Stripe.Invoice, a: MembershipRecord, product: string): "bootstrap_zero" | "activation_zero" | "bootstrap_draft" {
  const t = membershipBootstrapTimes(a), line = i.lines?.data?.[0], parent = line?.parent?.subscription_item_details;
  // The installed Invoice contract does not expose legacy Connect fields.
  // If returned, reject conflicting values; their absence is never fee or
  // destination proof. Collection validates the subscription and actual PI.
  const connect = i as Stripe.Invoice & { application_fee_amount?: unknown; transfer_data?: unknown };
  const transfer = connect.transfer_data;
  sid(i.id, "in");
  check(i.object === "invoice" && i.livemode === (a.terms.paymentContext.mode === "live") &&
    sid(i.customer, "cus") === a.stripe_customer_id && sid(i.parent?.subscription_details?.subscription, "sub") === a.stripe_subscription_id &&
    i.currency === "usd" && i.collection_method === "charge_automatically" && Number.isSafeInteger(i.created) &&
    i.created >= t.start && i.created <= Math.floor(Date.now() / 1000) &&
    i.amount_paid === 0 && i.amount_overpaid === 0 && i.starting_balance === 0 && (i.ending_balance == null || i.ending_balance === 0) &&
    i.amount_shipping === 0 && i.pre_payment_credit_notes_amount === 0 && i.post_payment_credit_notes_amount === 0 &&
    !i.automatic_tax.enabled && !i.discounts?.length && !i.total_discount_amounts?.length && !i.total_taxes?.length &&
    i.lines.has_more === false && i.lines.data.length === 1 && line.currency === "usd" && line.quantity === 1 &&
    !line.discount_amounts?.length && !line.discounts?.length && !line.taxes?.length &&
    line.parent?.type === "subscription_item_details" && parent?.subscription === a.stripe_subscription_id && parent.proration === false &&
    line.pricing?.type === "price_details" && line.pricing.price_details?.product === product, "Native bootstrap invoice differs");
  if (i.total === 0) {
    check(i.subtotal === 0 && i.amount_due === 0 && i.amount_remaining === 0 && line.amount === 0 &&
      ["draft", "open", "paid"].includes(i.status || ""), "Zero bootstrap invoice has payment or amount evidence");
    if (i.billing_reason === "subscription_create" && i.created < t.trialEnd &&
      line.period.start >= t.start && line.period.start < t.trialEnd && line.period.end === t.trialEnd) return "bootstrap_zero";
    check(a.covered_months >= 1 && a.anchor_at != null && i.billing_reason === "subscription_update" &&
      i.created >= a.anchor_at && i.created < membershipMonthBoundary(a.anchor_at, 1) &&
      line.period.start >= a.anchor_at && line.period.start <= i.created &&
      line.period.end === membershipMonthBoundary(a.anchor_at, 1), "Zero invoice is not the recorded activation period");
    return "activation_zero";
  }
  check(i.billing_reason === "subscription_cycle" && i.created >= t.trialEnd && i.created < t.cancelAt &&
    i.status === "draft" && i.auto_advance === false && i.hosted_invoice_url == null && i.attempt_count === 0 &&
    i.status_transitions != null && i.status_transitions.finalized_at === null && i.status_transitions.paid_at === null &&
    i.status_transitions.marked_uncollectible_at === null && i.status_transitions.voided_at === null &&
    connect.application_fee_amount == null && i.default_payment_method == null &&
    (transfer == null || typeof transfer === "object" && !Array.isArray(transfer) &&
      "destination" in transfer && transfer.destination === a.terms.destinationId && (!("amount" in transfer) || transfer.amount == null)) &&
    i.subtotal === a.monthly_price_cents && i.total === a.monthly_price_cents && i.amount_due === a.monthly_price_cents &&
    i.amount_remaining === a.monthly_price_cents && line.amount === a.monthly_price_cents &&
    line.period.start === t.trialEnd && line.period.end === t.cancelAt, "Original bootstrap invoice is not an inert held draft");
  return "bootstrap_draft";
}
/** Positive observation only. This does not grant new dispatch or alter consent, receipt, stop flags or service dates. */
export async function reconcileMembershipActivation(admin: SupabaseClient, env: Record<string, string | undefined>,
  a: MembershipRecord, product: string, first: MembershipFirstProof, sub: Stripe.Response<Stripe.Subscription>) {
  assertMembershipActivated(sub, a, product, first);
  const result = await admin.from("monthly_mentorship_operations_v1").select("id,status,provider_id")
    .eq("agreement_id", a.id).eq("kind", "activate").eq("scope_key", "initial").maybeSingle();
  check(!result.error && result.data, "Activated subscription lacks its original operation");
  const op = result.data; assertMembershipId(op.id);
  if (op.status === "complete") { check(op.provider_id === sub.id, "Original activation result differs"); return false; }
  check(env.CREATOR_MONTHLY_MENTORSHIPS_ACTIVATION_RECOVERY_SCHEMA_READY === "true", "Activation recovery schema is not enabled");
  check(["dispatched", "review_required"].includes(op.status), "Original activation state differs");
  const saved = await admin.rpc("reconcile_monthly_mentorship_activation_v1", { p_operation_id: op.id, p_buyer_id: a.buyer_id,
    p_context: a.terms.paymentContext, p_proof: { version: "monthly-activation-recovery-proof-v1", paymentContext: a.terms.paymentContext,
      requestId: sub.lastResponse.requestId, objectId: sub.id, objectType: sub.object, status: sub.status,
      customerId: a.stripe_customer_id, subscriptionId: sub.id, metadata: sub.metadata, trialEnd: sub.trial_end,
      billingCycleAnchor: sub.billing_cycle_anchor, cancelAt: sub.cancel_at, paymentMethodId: first.paymentMethodId,
      pauseBehavior: sub.pause_collection?.behavior, resumesAt: sub.pause_collection?.resumes_at ?? null } });
  check(!saved.error && typeof saved.data === "boolean", "Original activation observation needs retry");
  return saved.data;
}
