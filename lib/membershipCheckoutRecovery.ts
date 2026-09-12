import "server-only";
import type Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import { assertMembershipId } from "./membershipAgreement";
import { membershipCheckoutReady } from "./membershipServer";
import { assertMembershipCustomer, assertMembershipHeld, assertMembershipSession, buildMembershipCheckout, buildMembershipSubscription,
  membershipBootstrapTimes, membershipMetadata, membershipCheck as check, membershipStripeId as sid, type MembershipRecord } from "./membershipCheckout";
import type { MembershipBillingDependencies } from "./membershipBillingRuntime";
import type { MembershipProviderRequest } from "./membershipOperation";
export const BOOTSTRAP_STAGES = ["customer", "product", "subscription", "hold", "checkout"] as const;
export type BootstrapKind = typeof BOOTSTRAP_STAGES[number];
export type BootstrapOperation = { id: string; agreement_id: string; kind: BootstrapKind; scope_key: string;
  request: MembershipProviderRequest; status: "complete" | "dispatched" | "review_required"; provider_id: string | null; dispatched_at: string };
export type CheckoutRecoveryResult = { membershipId: string; title: string; monthlyPriceCents: number; minimumMonths: number;
  minimumTotalCents: number; autoRenew: boolean; status: "paid" | "payment_pending" | "checkout_open" | "expired_unpaid" | "resumable" | "review_required" | "abandon_pending" | "abandoned";
  canAbandon?: boolean; reviewUrl?: string;
  canResume: boolean; completedStages: number; firstPaymentRecorded: boolean; accessGranted: boolean; paidThrough: string | null };
type ExistingCheckout = { prepare(id: string, buyerId: string): Promise<{ membershipId: string; url: string }>;
  confirmFirst(id: string, buyerId: string): Promise<{ membershipId: string; firstPaymentRecorded: boolean; accessGranted: boolean; paidThrough: string | null }> };
export function membershipCheckoutRecoveryReady(env: Record<string, string | undefined> = process.env) {
  return ["LEDGER_SCHEMA_READY", "OPERATIONS_SCHEMA_READY", "EVENTS_READY", "CHECKOUT_RECOVERY_SCHEMA_READY", "CHECKOUT_RECOVERY_READY"]
    .every(suffix => env["CREATOR_MONTHLY_MENTORSHIPS_" + suffix] === "true");
}
export function createMembershipCheckoutRecovery(d: MembershipBillingDependencies, api: ExistingCheckout) {
  const { admin, stripe, context, env, load, checked, observeContext } = d;
  const eligible = (a: MembershipRecord) => membershipCheckoutReady(env) && !a.financial_hold_at && !a.billing_review_at &&
    !a.debit_revoked_at && !a.renewal_stopped_at && a.covered_months === 0;
  const inWindow = (a: MembershipRecord) => Math.floor(Date.now() / 1000) < membershipBootstrapTimes(a).expiresAt - 31 * 60;
  const identity = (a: MembershipRecord, stage: string) => "metadata['creatornet_membership_id']:'" + a.id +
    "' AND metadata['creatornet_membership_fingerprint']:'" + a.fingerprint + "' AND metadata['operation_kind']:'" + stage + "'";
  function pick<T extends { id: string; metadata: Stripe.Metadata | null }>(list: { data: T[]; has_more: boolean }, a: MembershipRecord, kind: string) {
    check(Array.isArray(list.data) && list.data.length <= 100 && list.has_more === false, "Monthly recovery lookup is incomplete");
    const matches = list.data.filter(value => value.metadata?.creatornet_membership_id === a.id &&
      value.metadata.creatornet_membership_fingerprint === a.fingerprint && value.metadata.operation_kind === kind);
    check(matches.length <= 1, "Monthly recovery lookup is ambiguous");
    return matches[0]?.id; // Absence is not proof that no provider object exists.
  }
  async function reconcileFirstCheckout(id: string, buyerId: string): Promise<CheckoutRecoveryResult> {
    check(membershipCheckoutRecoveryReady(env), "Monthly checkout recovery is not enabled");
    let a = await load(id, buyerId);
    const result = (status: CheckoutRecoveryResult["status"], completedStages: number, canResume = false): CheckoutRecoveryResult => ({
      membershipId: a.id, title: a.terms.title, monthlyPriceCents: a.monthly_price_cents, minimumMonths: a.minimum_months,
      minimumTotalCents: a.terms.minimumTotalCents, autoRenew: a.auto_renew,
      status: a.initial_abandon_requested_at && !a.initial_abandoned_at && !["paid", "payment_pending"].includes(status) ? "abandon_pending" : status,
      canResume: canResume && !a.initial_abandon_requested_at, completedStages,
      canAbandon: a.covered_months === 0 && !a.initial_abandoned_at && !a.financial_hold_at &&
        env.CREATOR_MONTHLY_MENTORSHIPS_INITIAL_ABANDONMENT_SCHEMA_READY === "true" && env.CREATOR_MONTHLY_MENTORSHIPS_INITIAL_ABANDONMENT_READY === "true",
      reviewUrl: "/memberships/review?product_id=" + a.product_id + "&post_id=" + a.post_id,
      firstPaymentRecorded: false, accessGranted: false, paidThrough: null });
    async function confirmed() {
      const confirmation = await api.confirmFirst(a.id, a.buyer_id);
      check(confirmation.membershipId === a.id && typeof confirmation.firstPaymentRecorded === "boolean" && typeof confirmation.accessGranted === "boolean");
      return { ...result(confirmation.firstPaymentRecorded ? "paid" : "payment_pending", 5), ...confirmation, canAbandon: false };
    }
    if (a.covered_months > 0) return confirmed();
    if (a.initial_abandoned_at) return result("abandoned", 0);
    await observeContext();
    const saved = await admin.from("monthly_mentorship_operations_v1").select("id,agreement_id,kind,scope_key,request,status,provider_id,dispatched_at")
      .eq("agreement_id", a.id).eq("scope_key", "initial").in("kind", [...BOOTSTRAP_STAGES]).limit(6);
    check(!saved.error && Array.isArray(saved.data) && saved.data.length <= 5, "Monthly recovery journal unavailable");
    const ops = saved.data as BootstrapOperation[], seen = new Set<string>();
    for (const op of ops) {
      assertMembershipId(op.id);
      check(op.agreement_id === a.id && op.scope_key === "initial" && BOOTSTRAP_STAGES.includes(op.kind) && !seen.has(op.kind) &&
        ["complete", "dispatched", "review_required"].includes(op.status) && Number.isFinite(Date.parse(op.dispatched_at)), "Monthly recovery journal differs");
      seen.add(op.kind);
    }
    const ids: Partial<Record<BootstrapKind, string>> = {};
    let complete = 0;
    for (const kind of BOOTSTRAP_STAGES) {
      const op = ops.find(value => value.kind === kind);
      if (!op) {
        // An original unstarted stage may be resumed, but never treat a missing
        // earlier operation with later journal entries as a fresh purchase.
        const later = BOOTSTRAP_STAGES.slice(complete + 1).some(stage => seen.has(stage));
        return result(!later && eligible(a) && inWindow(a) ? "resumable" : "review_required", complete, !later && eligible(a) && inWindow(a));
      }
      const bound = { ...a, stripe_customer_id: ids.customer ?? a.stripe_customer_id, stripe_subscription_id: ids.subscription ?? a.stripe_subscription_id };
      const request: MembershipProviderRequest = kind === "customer" ? { method: "POST", path: "/v1/customers", params: { metadata: membershipMetadata(a, kind) } } :
        kind === "product" ? { method: "POST", path: "/v1/products", params: { name: a.terms.title.slice(0, 200), metadata: membershipMetadata(a, kind) } } :
        kind === "subscription" ? { method: "POST", path: "/v1/subscriptions", params: { ...buildMembershipSubscription(a, ids.customer!, ids.product!) } } :
        kind === "hold" ? { method: "POST", path: "/v1/subscriptions/" + ids.subscription, params: { pause_collection: { behavior: "keep_as_draft" } } } :
        { method: "POST", path: "/v1/checkout/sessions", params: buildMembershipCheckout(bound, ids.customer!, ids.subscription!) as Record<string, unknown> };
      if (!isDeepStrictEqual(op.request, request)) return result("review_required", complete);
      if (op.status === "complete") {
        ids[kind] = sid(op.provider_id, kind === "customer" ? "cus" : kind === "product" ? "prod" : kind === "checkout" ? "cs" : "sub");
        if (kind === "hold") check(ids.hold === ids.subscription, "Monthly saved hold identity differs");
        complete++; continue;
      }
      let object: Stripe.Response<Stripe.Customer | Stripe.Product | Stripe.Subscription | Stripe.Checkout.Session> | undefined;
      try {
        await observeContext();
        if (kind === "customer") {
          const id = pick(await checked(stripe.customers.search({ query: identity(a, kind), limit: 100 })), a, kind);
          if (id) { const value = await checked(stripe.customers.retrieve(id)); check(value.id === id); assertMembershipCustomer(value, a, false); object = value as Stripe.Response<Stripe.Customer>; }
        } else if (kind === "product") {
          const id = pick(await checked(stripe.products.search({ query: identity(a, kind), limit: 100 })), a, kind);
          if (id) {
            const value = await checked(stripe.products.retrieve(id)); check(value.id === id && value.object === "product" && value.active &&
              value.livemode === (context.mode === "live") && value.name === a.terms.title.slice(0, 200) && value.default_price === null &&
              isDeepStrictEqual(value.metadata, membershipMetadata(a, kind))); object = value;
          }
        } else if (kind === "subscription" || kind === "hold") {
          const id = kind === "hold" ? ids.subscription : pick(await checked(stripe.subscriptions.list({ customer: ids.customer, status: "all", limit: 100 })), a, "subscription");
          if (id) { const value = await checked(stripe.subscriptions.retrieve(id)); check(value.id === id);
            assertMembershipHeld(value, a, ids.customer!, ids.product!, kind === "hold" ? true : null); object = value; }
        } else {
          const id = pick(await checked(stripe.checkout.sessions.list({ customer: ids.customer, limit: 100,
            created: { gte: membershipBootstrapTimes(a).start, lte: membershipBootstrapTimes(a).expiresAt } })), a, "checkout");
          if (id) { const value = await checked(stripe.checkout.sessions.retrieve(id)); check(value.id === id); assertMembershipSession(value, bound, null); object = value; }
        }
      } catch { return result("review_required", complete); }
      if (!object) {
        const age = Date.now() - Date.parse(op.dispatched_at);
        const retry = op.status === "dispatched" && age >= -1000 && age < 20 * 3600 * 1000 && eligible(a) && inWindow(a);
        return result(retry ? "resumable" : "review_required", complete, retry);
      }
      await observeContext();
      const proof = { version: "monthly-bootstrap-recovery-proof-v1", paymentContext: context, operationId: op.id, kind,
        objectType: object.object, objectId: object.id, requestId: object.lastResponse.requestId, metadata: object.metadata,
        customerId: ids.customer ?? null, productId: ids.product ?? null, subscriptionId: kind === "subscription" ? object.id : ids.subscription ?? null,
        held: kind === "hold" };
      const recorded = await admin.rpc("reconcile_monthly_mentorship_bootstrap_v1", { p_operation_id: op.id, p_buyer_id: a.buyer_id,
        p_context: context, p_request: request, p_proof: proof });
      check(!recorded.error && typeof recorded.data === "boolean", "Monthly recovery proof needs retry");
      ids[kind] = object.id; complete++;
    }
    const bound = { ...a, stripe_customer_id: ids.customer!, stripe_subscription_id: ids.subscription!, stripe_checkout_session_id: ids.checkout! };
    const session = await checked(stripe.checkout.sessions.retrieve(ids.checkout!)); assertMembershipSession(session, bound, null);
    await observeContext();
    const published = await admin.rpc("publish_monthly_mentorship_recovery_v1", { p_id: a.id, p_buyer_id: a.buyer_id, p_context: context });
    check(!published.error && typeof published.data === "boolean", "Monthly recovered binding needs retry");
    a = await load(a.id, a.buyer_id);
    check(a.stripe_customer_id === ids.customer && a.stripe_subscription_id === ids.subscription && a.stripe_checkout_session_id === ids.checkout,
      "Monthly recovered binding differs");
    if (session.status === "complete" && session.payment_status === "paid") return confirmed();
    if (session.status === "complete") return result("payment_pending", complete);
    if (session.status === "expired" && session.payment_status === "unpaid") return result("expired_unpaid", complete);
    if (session.status !== "open" || session.payment_status !== "unpaid" || !eligible(a) || !inWindow(a)) return result("review_required", complete);
    try {
      const subscription = await checked(stripe.subscriptions.retrieve(ids.subscription!)); check(subscription.id === ids.subscription);
      assertMembershipHeld(subscription, a, ids.customer!, ids.product!, true);
    } catch { return result("review_required", complete); }
    return result("checkout_open", complete, true);
  }
  async function resumeFirstCheckout(id: string, buyerId: string, confirmed: boolean) {
    check(confirmed === true, "Explicit original-checkout resumption required");
    const recovered = await reconcileFirstCheckout(id, buyerId);
    check(recovered.canResume && !recovered.firstPaymentRecorded && ["resumable", "checkout_open"].includes(recovered.status),
      "Original checkout requires review, not a new payment");
    const prepared = await api.prepare(id, buyerId);
    check(prepared.membershipId === id, "Monthly resumed checkout identity differs");
    const url = new URL(prepared.url);
    check(url.protocol === "https:" && (url.origin === "https://checkout.stripe.com" ||
      url.origin === context.siteOrigin && url.pathname === "/memberships/complete" && url.searchParams.get("membership_id") === id),
    "Monthly resumed destination differs");
    return { ...recovered, url: url.href };
  }
  return { reconcileFirstCheckout, resumeFirstCheckout };
}
