import { membershipFixture } from "./membership-fixtures";
import { buildMembershipCheckout, buildMembershipSubscription, membershipBootstrapTimes, membershipMetadata, type MembershipRecord } from "@/lib/membershipCheckout";
import { BOOTSTRAP_STAGES, type BootstrapKind, type BootstrapOperation, type CheckoutRecoveryResult } from "@/lib/membershipCheckoutRecovery";
import type { MembershipProviderRequest } from "@/lib/membershipOperation";
export function bootstrapRequests(a: MembershipRecord, ids: { customer: string; product: string; subscription: string }): Record<BootstrapKind, MembershipProviderRequest> {
  return {
    customer: { method: "POST", path: "/v1/customers", params: { metadata: membershipMetadata(a, "customer") } },
    product: { method: "POST", path: "/v1/products", params: { name: a.terms.title.slice(0, 200), metadata: membershipMetadata(a, "product") } },
    subscription: { method: "POST", path: "/v1/subscriptions", params: { ...buildMembershipSubscription(a, ids.customer, ids.product) } },
    hold: { method: "POST", path: "/v1/subscriptions/" + ids.subscription, params: { pause_collection: { behavior: "keep_as_draft" } } },
    checkout: { method: "POST", path: "/v1/checkout/sessions", params: buildMembershipCheckout(a, ids.customer, ids.subscription) as Record<string, unknown> },
  };
}
/** Synthetic original-operation evidence; never a hosted recovery assertion. */
export function checkoutRecoveryFixture(paid = false, ageSeconds = 60) {
  const f = membershipFixture(paid); f.a.accepted_at = new Date(Date.now() - ageSeconds * 1000).toISOString();
  const times = membershipBootstrapTimes(f.a), p = buildMembershipCheckout(f.a, f.customer.id, f.subscription.id);
  f.subscription.trial_end = times.trialEnd; f.subscription.cancel_at = times.cancelAt;
  f.session.expires_at = times.expiresAt; f.session.success_url = p.success_url!; f.session.cancel_url = p.cancel_url!;
  const ids = { customer: f.customer.id, product: f.product.id, subscription: f.subscription.id, hold: f.subscription.id, checkout: f.session.id };
  const requests = bootstrapRequests(f.a, ids);
  const ops: BootstrapOperation[] = BOOTSTRAP_STAGES.map((kind, i) => ({ id: "26000000-0000-4000-8000-00000000000" + (i + 1),
    agreement_id: f.a.id, kind, scope_key: "initial", request: requests[kind], status: "complete", provider_id: ids[kind],
    dispatched_at: f.a.accepted_at }));
  f.a.stripe_customer_id = null; f.a.stripe_subscription_id = null; f.a.stripe_checkout_session_id = null;
  const projection: CheckoutRecoveryResult = { membershipId: f.a.id, title: f.a.terms.title, monthlyPriceCents: 10000, minimumMonths: 3,
    minimumTotalCents: 30000, autoRenew: true, status: "resumable", canResume: true, completedStages: 0,
    firstPaymentRecorded: false, accessGranted: false, paidThrough: null };
  return { ...f, ids, requests, ops, projection };
}
