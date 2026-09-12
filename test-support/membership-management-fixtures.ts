import { membershipPayoffFixture } from "./membership-payoff-fixtures";
import type { MembershipManagementItem, MembershipView } from "@/lib/membershipManagement";
/** Synthetic account projection for UI/API boundaries, not hosted payment evidence. */
export function managementFixture(minimumMonths = 3, view: MembershipView = "buyer"): MembershipManagementItem {
  const f = membershipPayoffFixture(), q = { ...f.exitQuote, minimumMonths, minimumTotalCents: minimumMonths * 10000,
    remainingMonths: Math.max(0, minimumMonths - 1), payoffAmountCents: Math.max(0, minimumMonths - 1) * 10000 };
  return { id: f.a.id, acceptedAt: f.a.accepted_at, title: f.a.terms.title, postId: f.a.post_id, productId: f.a.product_id,
    counterpartyId: view === "buyer" ? f.a.creator_id : f.a.buyer_id, counterpartyName: view === "buyer" ? "Example Mentor" : "Example Buyer",
    counterpartyUsername: view === "buyer" ? "example-mentor" : "example-buyer",
    monthlyPriceCents: 10000, minimumMonths, autoRenew: true, firstPaymentRecorded: true, billingReview: false,
    quote: q, access: { allowed: true, maxAgeSeconds: 3600, paidThrough: q.paidThrough },
    exitStatus: { membershipId: f.a.id, billingBlocked: false, providerStopped: false, requests: [] }, payoff: null };
}
