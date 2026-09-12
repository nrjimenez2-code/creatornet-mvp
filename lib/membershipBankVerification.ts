import "server-only";
import { isDeepStrictEqual } from "node:util";
import { assertMembershipId, type MembershipPaymentContext } from "./membershipAgreement";
import { membershipCheck as check, membershipStripeId as sid, type MembershipRecord } from "./membershipCheckout";
import { assertMembershipActivated, assertMembershipInvoice, membershipRenewalPeriod, readMembershipFirstProof } from "./membershipRenewal";
import { monthlyInvoiceCard, monthlyRetrySchemaReady } from "./membershipCards";
import { membershipRenewalRecoveryReady, type MembershipRenewalRecoveryResult } from "./membershipRenewalRecovery";
import type { MembershipBillingDependencies } from "./membershipBillingRuntime";
type BankContext = { version: "monthly-bank-context-v1"; membershipId: string; buyerId: string; operationId: string;
  invoiceId: string; paymentIntentId: string; paymentMethodId: string; originalPaymentMethodId: string; customerId: string; subscriptionId: string;
  paymentContext: MembershipPaymentContext; fingerprint: string; revision: number; month: number; amountCents: number;
  periodStart: number; periodEnd: number; admittedAt: number; retryQuoteId: string | null };
type Recovery = { readRenewalRecovery(id: string, buyer: string, invoice: string): Promise<MembershipRenewalRecoveryResult> };
export function membershipBankVerificationReady(env: Record<string, string | undefined> = process.env) {
  return monthlyRetrySchemaReady(env) && membershipRenewalRecoveryReady(env) &&
    ["CREATOR_MONTHLY_MENTORSHIPS_BANK_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_BANK_VERIFICATION_READY",
      "CREATOR_MONTHLY_MENTORSHIPS_BANK_STOP_COORDINATION_READY"].every(key => env[key] === "true");
}
function read(value: unknown, a: MembershipRecord, invoice: string): BankContext {
  check(value && typeof value === "object" && !Array.isArray(value)); const b = value as BankContext, p = membershipRenewalPeriod(a, b.month);
  assertMembershipId(b.operationId); if (b.retryQuoteId !== null) assertMembershipId(b.retryQuoteId);
  check(b.version === "monthly-bank-context-v1" && b.membershipId === a.id && b.buyerId === a.buyer_id && b.invoiceId === invoice &&
    b.customerId === a.stripe_customer_id && b.subscriptionId === a.stripe_subscription_id && b.fingerprint === a.fingerprint &&
    isDeepStrictEqual(b.paymentContext, a.terms.paymentContext) && b.revision === a.revision && b.month === a.covered_months + 1 &&
    b.amountCents === a.monthly_price_cents && b.periodStart === p.start && b.periodEnd === p.end &&
    Number.isSafeInteger(b.admittedAt) && b.admittedAt >= p.start && b.admittedAt <= Math.floor(Date.now() / 1000) &&
    (b.retryQuoteId !== null || b.paymentMethodId === b.originalPaymentMethodId), "Monthly bank context differs");
  sid(b.paymentIntentId, "pi"); sid(b.paymentMethodId, "pm"); sid(b.originalPaymentMethodId, "pm");
  return b;
}
/** Read-only server release of one ephemeral capability for the ORIGINAL PI.
 * No invoice.pay/PI.confirm, card/default changes, stored secret or payment grant.
 * Stop-after-release remains a distributed boundary. Separate hosted acceptance
 * is mandatory before either BANK_* write-capability flag is enabled. */
export function createMembershipBankVerification(d: MembershipBillingDependencies, recovery: Recovery) {
  const { admin, stripe, context, env, checked, observeContext, load, productId } = d;
  const gate = () => check(membershipBankVerificationReady(env), "Monthly bank authentication is not enabled");
  async function bound(id: string, buyer: string, invoice: string) {
    gate(); const a = await load(id, buyer); await observeContext();
    const result = await admin.rpc("read_monthly_mentorship_bank_context_v1", { p_id: id, p_buyer: buyer, p_invoice: invoice, p_context: context });
    check(!result.error && result.data, "Monthly bank authentication needs support review");
    return { a, b: read(result.data, a, invoice) };
  }
  async function readRenewalBankChallenge(id: string, buyer: string, invoiceId: string) {
    gate(); assertMembershipId(id); assertMembershipId(buyer); sid(invoiceId, "in");
    const observed = await recovery.readRenewalRecovery(id, buyer, invoiceId);
    check(observed.outcome === "action_required", "Original monthly payment does not require bank authentication");
    const { a, b } = await bound(id, buyer, invoiceId), live = context.mode === "live";
    const publicKey = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    check(typeof publicKey === "string" && new RegExp("^pk_" + (live ? "live" : "test") + "_[A-Za-z0-9]+$").test(publicKey),
      "Monthly bank authentication key context differs");
    const first = await admin.from("monthly_mentorship_receipts_v1").select("provider_proof").eq("agreement_id", a.id).eq("month_number", 1).maybeSingle();
    const op = await admin.from("monthly_mentorship_operations_v1").select("id,request,scope_key").eq("id", b.operationId).eq("agreement_id", a.id).maybeSingle();
    check(!first.error && first.data && !op.error && op.data?.id === b.operationId && op.data.scope_key === String(b.month));
    const original = readMembershipFirstProof(a, first.data.provider_proof), proof = monthlyInvoiceCard(d, original, op.data.request, invoiceId);
    check(proof.paymentMethodId === b.originalPaymentMethodId);
    const card = await checked(stripe.paymentMethods.retrieve(b.paymentMethodId));
    check(card.object === "payment_method" && card.id === b.paymentMethodId && card.type === "card" && card.livemode === live &&
      sid(card.customer, "cus") === b.customerId, "Monthly bank card ownership differs");
    const product = await productId(a), sub = await checked(stripe.subscriptions.retrieve(b.subscriptionId));
    assertMembershipActivated(sub, a, product, original);
    const invoice = await checked(stripe.invoices.retrieve(invoiceId));
    check(invoice.id === invoiceId && invoice.status === "open");
    assertMembershipInvoice(invoice, a, proof, b.month, product, "configured");
    const links = await checked(stripe.invoicePayments.list({ invoice: invoiceId, limit: 100 }));
    check(links.has_more === false && links.data.length === 1); const link = links.data[0];
    check(link.object === "invoice_payment" && link.invoice === invoiceId && link.is_default === true && link.livemode === live &&
      link.currency === "usd" && link.amount_requested === b.amountCents && (link.amount_paid == null || link.amount_paid === 0) &&
      link.status === "open" && link.payment.type === "payment_intent" && sid(link.payment.payment_intent, "pi") === b.paymentIntentId);
    const pi = await checked(stripe.paymentIntents.retrieve(b.paymentIntentId));
    check(pi.object === "payment_intent" && pi.id === b.paymentIntentId && pi.livemode === live && sid(pi.customer, "cus") === b.customerId &&
      pi.currency === "usd" && pi.amount === b.amountCents && pi.amount_received === 0 && pi.amount_capturable === 0 &&
      pi.status === "requires_action" && pi.next_action?.type === "use_stripe_sdk" && pi.confirmation_method === "automatic" &&
      ["automatic", "automatic_async"].includes(pi.capture_method) && pi.on_behalf_of == null && pi.canceled_at == null &&
      pi.application_fee_amount === a.terms.recurringMonthFees.totalCreatorDeductionCents && sid(pi.transfer_data?.destination, "acct") === a.terms.destinationId &&
      pi.transfer_data?.amount == null && sid(pi.payment_method, "pm") === b.paymentMethodId &&
      pi.payment_method_types.length === 1 && pi.payment_method_types[0] === "card" &&
      typeof pi.client_secret === "string" && pi.client_secret.startsWith(pi.id + "_secret_") &&
      /^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/.test(pi.client_secret), "Original monthly bank payment differs");
    if (pi.latest_charge != null) {
      const charge = await checked(stripe.charges.retrieve(sid(pi.latest_charge, "ch")));
      check(charge.object === "charge" && charge.id === sid(pi.latest_charge, "ch") && charge.livemode === live &&
        sid(charge.payment_intent, "pi") === pi.id && sid(charge.customer, "cus") === b.customerId && charge.currency === "usd" &&
        charge.amount === b.amountCents && charge.paid === false && charge.captured === false && charge.status === "failed" &&
        charge.amount_captured === 0 && charge.amount_refunded === 0 && charge.balance_transaction == null,
      "Monthly bank challenge has unresolved charge evidence");
    }
    // Fresh owner, stop, money, review and original-admission checks after all
    // provider reads, immediately before returning the ephemeral capability.
    const final = await bound(id, buyer, invoiceId);
    check(isDeepStrictEqual(final.b, b), "Monthly bank authority changed before release");
    return { status: "bank_verification_ready" as const, membershipId: id, invoiceId, month: b.month, amountCents: b.amountCents,
      periodStart: b.periodStart, periodEnd: b.periodEnd, publishableKey: publicKey, clientSecret: pi.client_secret };
  }
  return { readRenewalBankChallenge };
}
