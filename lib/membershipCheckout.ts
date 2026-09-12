import "server-only";
import type Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import { calculateCreatorFees, creatorFeeMetadata, type CreatorFeeBreakdown } from "./money";
import { assertMembershipId, membershipAgreementFingerprint, membershipMonthBoundary, type MembershipAgreement } from "./membershipAgreement";

export const MEMBERSHIP_STRIPE_VERSION = "monthly-mentorship-stripe-v1";
export type MembershipRecord = {
  id: string; purchase_id: string; buyer_id: string; creator_id: string; product_id: string; post_id: string;
  terms: MembershipAgreement; fingerprint: string; accepted_at: string; monthly_price_cents: number;
  minimum_months: number; auto_renew: boolean; revision: number; covered_months: number; anchor_at: number | null;
  stripe_customer_id: string | null; stripe_subscription_id: string | null; stripe_checkout_session_id: string | null;
  financial_hold_at: string | null; renewal_stopped_at: string | null; debit_revoked_at: string | null;
  billing_review_at?: string | null; billing_review_reason?: string | null;
  initial_abandon_requested_at?: string | null; initial_abandoned_at?: string | null; initial_abandon_proof?: unknown;
};
export function membershipCheck(value: unknown, message = "Monthly provider evidence requires review"): asserts value {
  if (!value) throw Error(message);
}
export function membershipStripeId(value: unknown, prefix: string): string {
  const id = typeof value === "string" ? value : value && typeof value === "object" && "id" in value ? value.id : null;
  if (typeof id !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(id)) throw Error("Invalid monthly provider identity");
  return id;
}
function validateFees(fees: CreatorFeeBreakdown, price: number) {
  membershipCheck(fees && isDeepStrictEqual(fees, calculateCreatorFees(price, { enabled: fees.processingFeeEnabled,
    basisPoints: fees.processingFeeBasisPoints, fixedCents: fees.processingFeeFixedCents, version: fees.feeScheduleVersion })));
}
export function readMembershipRecord(value: unknown): MembershipRecord {
  if (!value || typeof value !== "object") throw Error("Monthly agreement missing");
  const a = value as MembershipRecord, t = a.terms;
  [a.id, a.purchase_id, a.buyer_id, a.creator_id, a.product_id, a.post_id].forEach(assertMembershipId);
  membershipCheck(t && t.version === "monthly-mentorship-purchase-v1" && t.kind === "monthly_mentorship" &&
    t.buyerId === a.buyer_id && t.creatorId === a.creator_id && t.productId === a.product_id && t.postId === a.post_id &&
    t.monthlyPriceCents === a.monthly_price_cents && t.minimumMonths === a.minimum_months && t.autoRenew === a.auto_renew &&
    t.currency === "usd" && Number.isSafeInteger(t.monthlyPriceCents) && t.monthlyPriceCents >= 50 &&
    Number.isInteger(t.minimumMonths) && t.minimumMonths >= 1 && t.minimumMonths <= 24 &&
    t.minimumTotalCents === t.monthlyPriceCents * t.minimumMonths && t.minimumTotalCents <= 99999999 &&
    typeof t.autoRenew === "boolean" && typeof t.title === "string" && typeof t.description === "string" &&
    Number.isSafeInteger(a.revision) && a.revision >= 0 && Number.isInteger(a.covered_months) && a.covered_months >= 0 &&
    Number.isFinite(Date.parse(a.accepted_at)) && a.fingerprint === membershipAgreementFingerprint(t));
  membershipStripeId(t.destinationId, "acct"); validateFees(t.firstMonthFees, t.monthlyPriceCents); validateFees(t.recurringMonthFees, t.monthlyPriceCents);
  return a;
}
export function membershipMetadata(a: MembershipRecord, operation: string) {
  return { creatornet_membership_version: MEMBERSHIP_STRIPE_VERSION, creatornet_membership_id: a.id,
    creatornet_membership_fingerprint: a.fingerprint, buyer_id: a.buyer_id, creator_id: a.creator_id,
    product_id: a.product_id, post_id: a.post_id, creator_stripe_account_id: a.terms.destinationId,
    kind: "monthly_mentorship", operation_kind: operation };
}
export function membershipBootstrapTimes(a: MembershipRecord) {
  const start = Math.floor(Date.parse(a.accepted_at) / 1000), trialEnd = start + 48 * 3600;
  return { start, trialEnd, cancelAt: membershipMonthBoundary(trialEnd, 1), expiresAt: start + 23 * 3600 };
}
export function buildMembershipSubscription(a: MembershipRecord, customer: string, product: string): Stripe.SubscriptionCreateParams {
  membershipStripeId(customer, "cus"); membershipStripeId(product, "prod"); const times = membershipBootstrapTimes(a);
  return { customer, items: [{ quantity: 1, price_data: { currency: "usd", product,
    unit_amount: a.monthly_price_cents, recurring: { interval: "month" } } }],
    trial_end: times.trialEnd, cancel_at: times.cancelAt, proration_behavior: "none", billing_mode: { type: "classic" },
    collection_method: "charge_automatically", transfer_data: { destination: a.terms.destinationId },
    payment_settings: { payment_method_types: ["card"], save_default_payment_method: "off" },
    trial_settings: { end_behavior: { missing_payment_method: "create_invoice" } }, metadata: membershipMetadata(a, "subscription") };
}
export function buildMembershipCheckout(a: MembershipRecord, customer: string, subscription: string): Stripe.Checkout.SessionCreateParams {
  const t = a.terms, metadata = { ...membershipMetadata(a, "checkout"), membership_subscription_id: subscription,
    ...creatorFeeMetadata(t.firstMonthFees) };
  const amount = `$${(t.monthlyPriceCents / 100).toFixed(2)}`;
  const disclosure = `${amount} today for the first month. Minimum ${t.minimumMonths} month(s), $${(t.minimumTotalCents / 100).toFixed(2)} total minimum. ` +
    (t.autoRenew ? `Then renews monthly at ${amount} until canceled. ` : "No renewal after the minimum term. ") +
    "Early exit requires the unpaid minimum, shown for separate confirmation. Paid access and support continue through the paid term.";
  return { mode: "payment", customer, payment_method_types: ["card"], adaptive_pricing: { enabled: false },
    automatic_tax: { enabled: false }, allow_promotion_codes: false, invoice_creation: { enabled: false },
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: t.monthlyPriceCents,
      product_data: { name: t.title.trim().slice(0, 200), description: disclosure } } }],
    payment_intent_data: { application_fee_amount: t.firstMonthFees.totalCreatorDeductionCents,
      transfer_data: { destination: t.destinationId }, setup_future_usage: "off_session", metadata },
    consent_collection: { payment_method_reuse_agreement: { position: "auto" } },
    custom_text: { submit: { message: disclosure + " By paying you authorize the scheduled monthly card payments in your accepted membership agreement." } },
    expires_at: membershipBootstrapTimes(a).expiresAt, metadata,
    success_url: `${t.paymentContext.siteOrigin}/memberships/complete?membership_id=${a.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${t.paymentContext.siteOrigin}/memberships/review?product_id=${a.product_id}&post_id=${a.post_id}` };
}
export function assertMembershipCustomer(c: Stripe.Customer | Stripe.DeletedCustomer, a: MembershipRecord, unpaid: boolean) {
  membershipCheck(c.object === "customer" && !c.deleted); const customer = c as Stripe.Customer;
  membershipStripeId(customer.id, "cus");
  membershipCheck(customer.livemode === (a.terms.paymentContext.mode === "live") && customer.balance === 0 && customer.test_clock === null &&
    customer.default_source === null && customer.invoice_settings.default_payment_method === null &&
    (!unpaid || customer.email === null) && isDeepStrictEqual(customer.metadata, membershipMetadata(a, "customer")));
}
export function assertMembershipHeld(s: Stripe.Subscription, a: MembershipRecord, customer: string, product: string, held: boolean | null,
  allowMatured = false) {
  const times = membershipBootstrapTimes(a), item = s.items?.data?.[0], price = item?.price, live = a.terms.paymentContext.mode === "live";
  membershipStripeId(s.id, "sub");
  const now = Math.floor(Date.now() / 1000);
  const validState = s.status === "trialing" || allowMatured && held === true && s.status === "active" &&
    now >= times.trialEnd && now < times.cancelAt && s.billing_cycle_anchor === times.trialEnd;
  membershipCheck(s.object === "subscription" && s.livemode === live && validState && s.customer === customer &&
    s.billing_mode?.type === "classic" && s.trial_end === times.trialEnd && s.cancel_at === times.cancelAt && s.cancel_at_period_end === false &&
    s.default_payment_method === null && s.default_source === null && s.application_fee_percent === null &&
    s.transfer_data?.destination === a.terms.destinationId && s.transfer_data.amount_percent == null &&
    s.collection_method === "charge_automatically" && s.automatic_tax.enabled === false && s.discounts.length === 0 &&
    s.default_tax_rates?.length === 0 && s.pending_update === null && s.schedule === null && s.test_clock === null &&
    isDeepStrictEqual(s.metadata, membershipMetadata(a, "subscription")) && s.items.has_more === false && s.items.data.length === 1 &&
    // Stripe inline price_data prices are archived by default. active controls reuse,
    // not this subscription's agreed amount or ability to collect.
    item.quantity === 1 && item.tax_rates?.length === 0 && item.discounts?.length === 0 && typeof price.active === "boolean" && price.livemode === live &&
    price.currency === "usd" && price.product === product && price.unit_amount === a.monthly_price_cents && price.billing_scheme === "per_unit" &&
    price.recurring?.interval === "month" && price.recurring.interval_count === 1 && price.recurring.usage_type === "licensed" &&
    s.payment_settings?.save_default_payment_method === "off" && isDeepStrictEqual(s.payment_settings.payment_method_types, ["card"]) &&
    s.trial_settings?.end_behavior?.missing_payment_method === "create_invoice");
  const isHeld = s.pause_collection?.behavior === "keep_as_draft" && s.pause_collection.resumes_at == null;
  membershipCheck(held === null ? s.pause_collection === null || isHeld : held ? isHeld : s.pause_collection === null);
}
export function assertMembershipSession(s: Stripe.Checkout.Session, a: MembershipRecord, paid: boolean | null) {
  const params = buildMembershipCheckout(a, a.stripe_customer_id!, a.stripe_subscription_id!);
  membershipStripeId(s.id, "cs");
  membershipCheck(s.object === "checkout.session" && s.livemode === (a.terms.paymentContext.mode === "live") && s.mode === "payment" &&
    s.customer === a.stripe_customer_id && s.currency === "usd" && s.amount_total === a.monthly_price_cents && s.amount_subtotal === a.monthly_price_cents &&
    s.automatic_tax.enabled === false && s.total_details?.amount_discount === 0 && s.total_details.amount_tax === 0 && s.total_details.amount_shipping === 0 &&
    s.invoice_creation?.enabled === false && s.subscription === null && s.setup_intent === null &&
    s.success_url === params.success_url && s.cancel_url === params.cancel_url && s.expires_at === params.expires_at &&
    isDeepStrictEqual(s.metadata, params.metadata) && isDeepStrictEqual(s.payment_method_types, ["card"]) &&
    (paid === null || (paid ? s.status === "complete" && s.payment_status === "paid" : s.status === "open" && s.payment_status === "unpaid")));
  if (a.stripe_checkout_session_id) membershipCheck(s.id === a.stripe_checkout_session_id);
  if (paid) membershipStripeId(s.payment_intent, "pi");
}
