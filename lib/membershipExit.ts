import "server-only";
import type Stripe from "stripe";
import { assertMembershipId } from "./membershipAgreement";
import { membershipCheck as check, membershipStripeId as sid, MEMBERSHIP_STRIPE_VERSION, type MembershipRecord } from "./membershipCheckout";
import type { MembershipBillingDependencies } from "./membershipBillingRuntime";
export type MembershipExitKind = "stop_renewal" | "revoke_debits";
export type MembershipExitQuote = {
  version: "monthly-exit-quote-v1"; membershipId: string; revision: number; agreementFingerprint: string;
  monthlyPriceCents: number; minimumMonths: number; minimumTotalCents: number; coveredMonths: number; remainingMonths: number;
  payoffAmountCents: number | null; paidThrough: number | null; minimumEnd: number | null;
  reviewReasons: string[]; renewalStopped: boolean; debitsRevoked: boolean; policyVersion: string;
};
export function membershipExitReady(env: Record<string, string | undefined> = process.env) {
  // A stopped checkout/new-billing gate must not disable an existing buyer's stop request.
  return ["CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_EXIT_SCHEMA_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_EXIT_READY"].every(key => env[key] === "true");
}
export function createMembershipExitRuntime(d: MembershipBillingDependencies) {
  const { admin, stripe, context, env, checked, observeContext, load } = d;
  const ready = () => check(membershipExitReady(env), "Monthly exit handling is not enabled");
  async function quoteExit(id: string, buyerId: string): Promise<MembershipExitQuote> {
    ready(); const a = await load(id, buyerId);
    const result = await admin.rpc("read_monthly_mentorship_exit_quote_v1", { p_id: a.id, p_buyer_id: a.buyer_id, p_context: context });
    const q = result.data as MembershipExitQuote;
    check(!result.error && q?.version === "monthly-exit-quote-v1" && q.membershipId === a.id &&
      q.agreementFingerprint === a.fingerprint && q.revision === a.revision && Array.isArray(q.reviewReasons),
    "Monthly exit quote needs fresh receipt state");
    return q;
  }
  function ownedSubscription(sub: Stripe.Subscription, a: MembershipRecord) {
    check(sub.object === "subscription" && sub.id === a.stripe_subscription_id && sid(sub.customer, "cus") === a.stripe_customer_id &&
      sub.livemode === (context.mode === "live") && sub.metadata.creatornet_membership_version === MEMBERSHIP_STRIPE_VERSION &&
      sub.metadata.creatornet_membership_id === a.id && sub.metadata.creatornet_membership_fingerprint === a.fingerprint,
    "Monthly stop subscription ownership differs");
  }
  async function requestExit(id: string, buyerId: string, kind: MembershipExitKind, accepted: boolean, quote: unknown = null) {
    ready(); check(accepted === true && ["stop_renewal", "revoke_debits"].includes(kind), "Explicit exit confirmation required");
    const a = await load(id, buyerId);
    const requested = await admin.rpc("request_monthly_mentorship_exit_v1", { p_id: a.id, p_buyer_id: a.buyer_id,
      p_context: context, p_kind: kind, p_quote: quote, p_accepted: accepted });
    const e = requested.data;
    check(!requested.error && e?.agreement_id === a.id && e.buyer_id === a.buyer_id && e.kind === kind, "Monthly exit request needs review");
    assertMembershipId(e.id);
    return processExitStop(a, e.id, kind);
  }
  async function reconcileExitStop(id: string, buyerId: string, requestId: string) {
    ready(); assertMembershipId(requestId); const a = await load(id, buyerId);
    const saved = await admin.from("monthly_mentorship_exit_requests_v1").select("id,agreement_id,buyer_id,kind,status")
      .eq("id", requestId).eq("agreement_id", a.id).eq("buyer_id", a.buyer_id).maybeSingle();
    const e = saved.data;
    check(!saved.error && e?.id === requestId && e.agreement_id === a.id && e.buyer_id === a.buyer_id &&
      ["stop_renewal", "revoke_debits"].includes(e.kind) &&
      ["requested", "dispatching", "review_required", "provider_stopped"].includes(e.status), "Existing monthly exit request required");
    check(e.kind === "stop_renewal" ? a.renewal_stopped_at != null : a.debit_revoked_at != null, "Monthly exit lacks its durable billing block");
    return processExitStop(a, e.id, e.kind as MembershipExitKind);
  }
  async function processExitStop(a: MembershipRecord, requestId: string, kind: MembershipExitKind) {
    // The durable database stop precedes ANY provider work. Failure never
    // restarts billing, cancels an outstanding balance or removes paid access.
    const pending = { status: "provider_review_required" as const, requestId: requestId, kind, billingBlocked: true,
      providerStopped: false, balanceWaived: false };
    if (!a.stripe_subscription_id) return pending;
    try {
      await observeContext();
      let sub = await checked(stripe.subscriptions.retrieve(a.stripe_subscription_id));
      ownedSubscription(sub, a);
      if (sub.status !== "canceled") {
        const admitted = await admin.rpc("claim_monthly_mentorship_exit_stop_v1", { p_exit_id: requestId, p_buyer_id: a.buyer_id, p_context: context });
        check(!admitted.error && admitted.data?.id === requestId && admitted.data.status === "dispatching", "Monthly provider stop requires reconciliation");
        await observeContext();
        sub = await checked(stripe.subscriptions.cancel(a.stripe_subscription_id, { invoice_now: false, prorate: false },
          { idempotencyKey: `creatornet-membership-exit:${requestId}`, maxNetworkRetries: 0 }));
        ownedSubscription(sub, a);
      }
      check(sub.status === "canceled", "Monthly subscription is not stopped");
      await observeContext();
      const saved = await admin.rpc("record_monthly_mentorship_exit_stop_v1", { p_exit_id: requestId, p_buyer_id: a.buyer_id, p_context: context,
        p_proof: { version: "monthly-exit-stop-proof-v1", paymentContext: context, subscriptionId: sub.id,
          customerId: a.stripe_customer_id, status: sub.status, requestId: sub.lastResponse.requestId } });
      check(!saved.error && typeof saved.data === "boolean");
      return { status: "provider_stopped" as const, requestId: requestId, kind, billingBlocked: true, providerStopped: true, balanceWaived: false };
    } catch { return pending; }
  }
  return { quoteExit, requestExit, reconcileExitStop };
}
