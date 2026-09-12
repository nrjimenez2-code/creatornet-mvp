import "server-only";
import type Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import { assertMembershipId } from "./membershipAgreement";
import { membershipCheck as check, membershipStripeId as sid, type MembershipRecord } from "./membershipCheckout";
import { membershipInvoicePayParams, membershipRenewalPeriod, type MembershipFirstProof } from "./membershipRenewal";
import type { MembershipBillingDependencies } from "./membershipBillingRuntime";
import type { MonthlyCardSetup } from "./membershipCardSetup";
import { MONTHLY_RETRY_CONSENT_TEXT, MONTHLY_RETRY_CONSENT_VERSION, MONTHLY_FUTURE_CARD_CONSENT_TEXT,
  MONTHLY_FUTURE_CARD_CONSENT_VERSION, type MonthlyRetryQuote } from "./membershipRetryConsent";
export type MonthlyRetryRow = { id: string; setup_id: string; operation_id: string; agreement_id: string; buyer_id: string;
  invoice_id: string; month_number: number; snapshot: MonthlyCardSetup["snapshot"] & {
    setupId: string; setupIntentId: string; replacementPaymentMethodId: string };
  quote: MonthlyRetryQuote; created_at: number; expires_at: number; confirmed_at: string | null; use_future_card: boolean | null;
  consent_version: string | null; future_consent_version: string | null; dispatch_consumed_at: string | null; request: Stripe.InvoicePayParams };
export function monthlyRetrySchemaReady(env: Record<string, string | undefined>) {
  return env.CREATOR_MONTHLY_MENTORSHIPS_RETRY_SCHEMA_READY === "true";
}
export function readMonthlyRetry(value: unknown, a: MembershipRecord): MonthlyRetryRow {
  check(value && typeof value === "object" && !Array.isArray(value)); const r = value as MonthlyRetryRow, b = r.snapshot, q = r.quote;
  [r.id, r.setup_id, r.operation_id, r.agreement_id, r.buyer_id].forEach(assertMembershipId);
  const p = membershipRenewalPeriod(a, r.month_number);
  check(r.agreement_id === a.id && r.buyer_id === a.buyer_id && b?.membershipId === a.id && b.operationId === r.operation_id &&
    b.setupId === r.setup_id && b.invoiceId === r.invoice_id && b.customerId === a.stripe_customer_id &&
    b.subscriptionId === a.stripe_subscription_id && b.fingerprint === a.fingerprint && isDeepStrictEqual(b.paymentContext, a.terms.paymentContext) &&
    b.monthlyPriceCents === a.monthly_price_cents && b.periodStart === p.start && b.periodEnd === p.end &&
    Number.isSafeInteger(b.revision) && b.revision >= 0 && Number.isSafeInteger(r.created_at) && r.created_at > 0 &&
    Number.isSafeInteger(r.expires_at) && r.expires_at > r.created_at && r.expires_at <= r.created_at + 600 && r.expires_at <= p.end &&
    q?.version === "monthly-retry-quote-v1" && q.id === r.id && q.membershipId === a.id && q.setupId === r.setup_id &&
    typeof q.title === "string" && q.amountCents === a.monthly_price_cents && q.currency === "usd" && q.month === p.month &&
    q.periodStart === p.start && q.periodEnd === p.end && q.expiresAt === r.expires_at && q.minimumMonths === a.minimum_months &&
    q.autoRenew === a.auto_renew && q.canUseForFuture === (a.auto_renew || p.month < a.minimum_months) &&
    q.consentVersion === MONTHLY_RETRY_CONSENT_VERSION && q.consentText === MONTHLY_RETRY_CONSENT_TEXT &&
    q.futureConsentVersion === MONTHLY_FUTURE_CARD_CONSENT_VERSION && q.futureConsentText === MONTHLY_FUTURE_CARD_CONSENT_TEXT,
  "Original monthly retry quote differs");
  sid(b.invoiceId, "in"); sid(b.paymentIntentId, "pi"); sid(b.originalPaymentMethodId, "pm");
  sid(b.replacementPaymentMethodId, "pm"); sid(b.setupIntentId, "seti");
  check(isDeepStrictEqual(r.request, { payment_method: b.replacementPaymentMethodId, off_session: false, forgive: false, paid_out_of_band: false }),
    "Monthly retry request differs");
  if (r.confirmed_at == null) check(r.use_future_card == null && r.consent_version == null && r.future_consent_version == null && r.dispatch_consumed_at == null);
  else check(Number.isFinite(Date.parse(r.confirmed_at)) && Date.parse(r.confirmed_at) >= r.created_at * 1000 &&
    Date.parse(r.confirmed_at) < r.expires_at * 1000 && typeof r.use_future_card === "boolean" &&
    r.consent_version === MONTHLY_RETRY_CONSENT_VERSION && (r.use_future_card ?
      q.canUseForFuture && r.future_consent_version === MONTHLY_FUTURE_CARD_CONSENT_VERSION : r.future_consent_version === null));
  if (r.dispatch_consumed_at != null) check(r.confirmed_at && Number.isFinite(Date.parse(r.dispatch_consumed_at)) &&
    Date.parse(r.dispatch_consumed_at) >= Date.parse(r.confirmed_at) && Date.parse(r.dispatch_consumed_at) < r.expires_at * 1000);
  return r;
}
/** Invoice admission and subscription default are separate. Only a captured
 * receipt can carry an explicitly accepted card into the next service month. */
export async function monthlyCardForService(d: MembershipBillingDependencies, a: MembershipRecord, first: MembershipFirstProof, month: number) {
  if (!monthlyRetrySchemaReady(d.env)) return first;
  const prior = await d.admin.from("monthly_mentorship_receipts_v1").select("provider_proof").eq("agreement_id", a.id).eq("month_number", month - 1).maybeSingle();
  check(!prior.error && prior.data, "Prior monthly card receipt is missing");
  const p = prior.data.provider_proof;
  return { ...first, paymentMethodId: sid(p?.nextPaymentMethodId ?? p?.paymentMethodId, "pm") };
}
export function monthlyInvoiceCard(d: MembershipBillingDependencies, first: MembershipFirstProof, request: unknown, invoice: string): MembershipFirstProof {
  check(request && typeof request === "object"); const r = request as { method: string; path: string; params: Stripe.InvoicePayParams };
  const card = sid(r.params?.payment_method, "pm");
  check(r.method === "POST" && r.path === "/v1/invoices/" + invoice + "/pay" &&
    isDeepStrictEqual(r.params, membershipInvoicePayParams({ ...first, paymentMethodId: card })) &&
    (monthlyRetrySchemaReady(d.env) || card === first.paymentMethodId), "Original monthly invoice card admission differs");
  return { ...first, paymentMethodId: card };
}
export async function consumedMonthlyRetry(d: MembershipBillingDependencies, a: MembershipRecord, operation: string) {
  if (!monthlyRetrySchemaReady(d.env)) return null;
  const q = await d.admin.from("monthly_mentorship_retry_quotes_v1").select("*").eq("operation_id", operation)
    .eq("agreement_id", a.id).not("dispatch_consumed_at", "is", null).maybeSingle();
  check(!q.error); return q.data ? readMonthlyRetry(q.data, a) : null;
}
export async function monthlyCaptureAuthority(d: MembershipBillingDependencies, a: MembershipRecord, original: MembershipFirstProof,
  month: number, invoice: string, paymentIntent: string, paymentMethod: string, paidAt: number) {
  if (!monthlyRetrySchemaReady(d.env)) {
    check(paymentMethod === original.paymentMethodId, "Monthly captured card differs");
    return { proof: original, extension: {} as { retryQuoteId?: string; nextPaymentMethodId?: string } };
  }
  const op = await d.admin.from("monthly_mentorship_operations_v1").select("id,request,scope_key").eq("agreement_id", a.id)
    .eq("kind", "collect").eq("request->>path", "/v1/invoices/" + invoice + "/pay").maybeSingle();
  check(!op.error && op.data && op.data.scope_key === String(month), "Original monthly collection differs");
  const proof = monthlyInvoiceCard(d, original, op.data.request, invoice);
  check(proof.paymentMethodId === original.paymentMethodId);
  const recovery = await d.admin.from("monthly_mentorship_renewal_recoveries_v1").select("payment_intent_id")
    .eq("operation_id", op.data.id).maybeSingle();
  check(!recovery.error && (!recovery.data || recovery.data.payment_intent_id === paymentIntent), "Original monthly recovery payment differs");
  const q = await consumedMonthlyRetry(d, a, op.data.id);
  if (q) check(q.invoice_id === invoice && q.month_number === month && q.snapshot.paymentIntentId === paymentIntent &&
    q.snapshot.originalPaymentMethodId === proof.paymentMethodId, "Consumed monthly retry identity differs");
  // An old original-card capture can race the replacement. It is money to
  // reconcile, not evidence that the buyer's optional future-card choice took effect.
  if (paymentMethod === proof.paymentMethodId) return { proof, extension: { nextPaymentMethodId: proof.paymentMethodId } };
  check(q && q.snapshot.replacementPaymentMethodId === paymentMethod && Number.isSafeInteger(paidAt) &&
    paidAt >= Math.floor(Date.parse(q.dispatch_consumed_at!) / 1000), "Replacement capture lacks its consumed buyer retry");
  return { proof: { ...proof, paymentMethodId: paymentMethod }, extension: { retryQuoteId: q.id,
    nextPaymentMethodId: q.use_future_card ? paymentMethod : proof.paymentMethodId } };
}
