/** #6. Prospective, versioned owner-approved business rules. Legal activation
 * is separate from source implementation and never inferred from the date. */
export const PURCHASE_POLICY_VERSION = "creatornet-purchase-2026-09-09-v1";
export const PURCHASE_POLICY = Object.freeze({
  version: PURCHASE_POLICY_VERSION,
  application: "These purchase rules apply only to a purchase that records your acceptance of this version. Earlier purchases retain the terms disclosed for those purchases. This version does not retroactively change them.",
  refunds: "Request refund review within 14 days of the affected service, a missed delivery date, or discovering a billing or service problem. This is a standard request window, not an unconditional money-back guarantee. Applicable legal rights, unauthorized-payment protections and bank dispute rights are not restricted by this window. Support may consider exceptional circumstances.",
  eligibility: "Refund grounds include non-delivery, a material difference from the listing, and duplicate billing. Receiving the service as described and then changing your mind does not automatically qualify. A mentorship is assessed as the promised package, not automatically divided into separately priced calls. Unused sessions alone do not produce an automatic per-call refund; this does not excuse failure to deliver promised services.",
  calls: "For a standalone paid call, cancel at least 24 hours before the appointment for a full refund, or reschedule once without an additional charge with that notice. With less notice, a refund or free reschedule is not automatic; emergencies and technical failures can be reviewed. A buyer who has not joined within 10 minutes, or by the end of a shorter appointment, may be treated as a no-show only if the creator was available and supplied working joining instructions. Arriving late does not extend the appointment. If the creator cancels or misses a standalone paid call, the buyer chooses a full refund or rescheduling at no additional charge.",
  delivery: "Digital delivery and paid-call scheduling access follow confirmed payment, not card setup or a success redirect alone. The creator must provide the services and duration described in the accepted offer. Service duration is distinct from the number of payment installments.",
  installments: "A fixed-total purchase is a commitment to the full purchase price. Installments spread that price over time; they are not a cancel-anytime membership. Ordinary withdrawal from participation does not itself waive the unpaid purchase balance. Refunds for non-delivery and rights required by applicable law remain separate.",
  memberships: "A monthly mentorship is an ongoing service. The offer states its monthly price, minimum commitment and renewal setting. No additional minimum means the first paid month only. When a minimum applies, early exit requires the remaining unpaid minimum commitment to be settled through an exact, buyer-confirmed one-time payoff, not a surprise automatic charge. A completed payoff stops renewal and preserves access and the promised mentor support through the paid minimum term. Once the minimum is satisfied, cancellation stops renewal and access continues through the paid period. If renewal is off, service ends after the agreed paid term.",
  authorization: "Permission to debit a payment method is separate from any valid contractual balance. A request to stop automatic debits stops further automatic collection and is referred for balance review; it does not authorize a surprise payoff or by itself decide whether a balance is owed or waived. Failed or abandoned payoff attempts are not recorded as paid.",
  refundFees: "Approved refunds return to the original payment method. The buyer receives the full approved refund amount without a processing-fee deduction. CreatorNet returns its 12% platform fee attributable to the refunded amount. Creators bear nonreturned processing costs for creator non-delivery, missed sessions, material listing misrepresentation and creator-approved discretionary refunds. CreatorNet bears those costs for duplicate billing and CreatorNet technical or billing errors. No automatic per-session allocation is introduced.",
  jurisdiction: "Subject to applicable mandatory law, the proposed agreement uses Arizona law and appropriate courts in Maricopa County, Arizona. Applicable consumer protections and appropriate small-claims rights are preserved. This agreement does not impose mandatory arbitration or a class-action waiver.",
  support: "Contact support@creatornet.net from your account email with the purchase, creator, date and issue. No refund or cancellation request is rejected solely because it was sent through the support channel rather than a particular screen.",
});

export function purchasePoliciesActive(env: Record<string, string | undefined>): boolean {
  return env.CREATOR_PURCHASE_CONSENT_SCHEMA_READY === "true" &&
    env.CREATOR_PURCHASE_POLICIES_READY === "true" &&
    env.CREATOR_PURCHASE_POLICIES_LEGAL_APPROVED === "true";
}

export type PurchasePolicySection = "terms" | "refunds" | "delivery" | "creators";
export function policyParagraphs(section: PurchasePolicySection): readonly string[] {
  if (section === "refunds") return [PURCHASE_POLICY.refunds, PURCHASE_POLICY.eligibility, PURCHASE_POLICY.calls, PURCHASE_POLICY.refundFees];
  if (section === "delivery") return [PURCHASE_POLICY.delivery, PURCHASE_POLICY.installments, PURCHASE_POLICY.memberships, PURCHASE_POLICY.authorization, PURCHASE_POLICY.calls];
  if (section === "creators") return [PURCHASE_POLICY.delivery, PURCHASE_POLICY.calls, PURCHASE_POLICY.memberships, PURCHASE_POLICY.refundFees];
  return [PURCHASE_POLICY.installments, PURCHASE_POLICY.memberships, PURCHASE_POLICY.authorization, PURCHASE_POLICY.jurisdiction];
}
