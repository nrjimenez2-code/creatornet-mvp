import "server-only";
import { randomUUID } from "node:crypto";
import { assertMembershipId } from "./membershipAgreement";
import { membershipCheck as check, membershipStripeId as sid } from "./membershipCheckout";
import type { MembershipBillingDependencies } from "./membershipBillingRuntime";
import { membershipRenewalRecoveryReady, type MembershipRenewalRecoveryResult } from "./membershipRenewalRecovery";
import { monthlyRetrySchemaReady, readMonthlyRetry, type MonthlyRetryRow } from "./membershipCards";
import { MONTHLY_RETRY_CONSENT_VERSION, MONTHLY_FUTURE_CARD_CONSENT_VERSION } from "./membershipRetryConsent";
type Callbacks = { readRenewalRecovery(id: string, buyer: string, invoice: string): Promise<MembershipRenewalRecoveryResult>;
  verifyRenewalCardSetup(id: string, buyer: string, setup: string): Promise<{ status: string }> };
export function membershipRetryReady(env: Record<string, string | undefined> = process.env) {
  return monthlyRetrySchemaReady(env) && membershipRenewalRecoveryReady(env);
}
/** One durable consumption, then one pay call on the original invoice.
 * Lost responses never authorize another dispatch or reset an idempotency age.
 * SQL consumption is the admission boundary; stop/in-flight ordering still
 * requires hosted acceptance before enabling the independent write flag. */
export function createMembershipRetry(d: MembershipBillingDependencies, callbacks: Callbacks) {
  const { admin, stripe, env, context, observeContext, load, checked } = d;
  const gate = () => check(membershipRetryReady(env), "Monthly retry recovery is not enabled");
  const writeGate = () => check(membershipRetryReady(env) && env.CREATOR_MONTHLY_MENTORSHIPS_RETRY_READY === "true",
    "Monthly buyer payment retry is not enabled");
  async function action(kind: string, id: string, buyer: string, quote: string, setup: string | null = null,
    accepted = false, consent: string | null = null, future = false, futureConsent: string | null = null) {
    const a = await load(id, buyer); await observeContext();
    const result = await admin.rpc("monthly_retry_v1", { p_action: kind, p_id: quote, p_setup: setup, p_buyer: buyer, p_context: context,
      p_accepted: accepted, p_consent: consent, p_future: future, p_future_consent: futureConsent });
    check(!result.error && result.data, "Monthly retry state needs support review");
    const dispatch = kind === "consume" ? result.data.dispatch : false;
    check(typeof dispatch === "boolean");
    const row = readMonthlyRetry(kind === "consume" ? result.data.retry : result.data, a);
    check(kind === "review" || row.id === quote, "Original monthly retry quote identity differs");
    return { row, dispatch };
  }
  function view(r: MonthlyRetryRow) {
    return { membershipId: r.agreement_id, quote: r.quote, confirmed: r.confirmed_at !== null,
      useFutureCard: r.use_future_card, retryRequested: r.dispatch_consumed_at !== null };
  }
  async function checkRenewalRetry(id: string, buyer: string, quote: string) {
    gate(); assertMembershipId(quote);
    const { row } = await action("read", id, buyer, quote);
    const renewal = await callbacks.readRenewalRecovery(id, buyer, row.invoice_id);
    check(renewal.month === row.month_number && renewal.invoiceId === row.invoice_id);
    return { ...view(row), renewal };
  }
  async function reviewRenewalRetry(id: string, buyer: string, setup: string) {
    gate(); assertMembershipId(setup); const a = await load(id, buyer); await observeContext();
    const existing = await admin.from("monthly_mentorship_retry_quotes_v1").select("*").eq("setup_id", setup)
      .eq("agreement_id", id).eq("buyer_id", buyer).not("confirmed_at", "is", null).maybeSingle();
    check(!existing.error);
    if (existing.data) return checkRenewalRetry(id, buyer, readMonthlyRetry(existing.data, a).id);
    writeGate();
    const saved = await callbacks.verifyRenewalCardSetup(id, buyer, setup);
    check(saved.status === "card_saved_payment_not_attempted", "Monthly retry requires its verified saved card");
    const { row } = await action("review", id, buyer, randomUUID(), setup);
    return view(row);
  }
  async function fresh(r: MonthlyRetryRow) {
    const a = await load(r.agreement_id, r.buyer_id);
    check(a.revision === r.snapshot.revision && a.covered_months + 1 === r.month_number &&
      !a.financial_hold_at && !a.debit_revoked_at && !a.renewal_stopped_at && r.expires_at > Math.floor(Date.now() / 1000),
    "Monthly retry was stopped, changed or expired");
    await observeContext();
    const card = await checked(stripe.paymentMethods.retrieve(r.snapshot.replacementPaymentMethodId));
    check(card.object === "payment_method" && card.id === r.snapshot.replacementPaymentMethodId && card.type === "card" &&
      card.livemode === (context.mode === "live") && sid(card.customer, "cus") === r.snapshot.customerId, "Monthly retry card ownership differs");
    const renewal = await callbacks.readRenewalRecovery(a.id, a.buyer_id, r.invoice_id);
    check(renewal.outcome === "payment_method_required" && renewal.month === r.month_number &&
      renewal.amountCents === r.quote.amountCents && renewal.periodStart === r.quote.periodStart && renewal.periodEnd === r.quote.periodEnd,
    "Original monthly payment is no longer an eligible decline");
  }
  async function payRenewalRetry(id: string, buyer: string, quote: string, consent: string, accepted: boolean,
    future: boolean, futureConsent: string | null) {
    gate(); assertMembershipId(quote);
    check(accepted === true && consent === MONTHLY_RETRY_CONSENT_VERSION && typeof future === "boolean" &&
      (future ? futureConsent === MONTHLY_FUTURE_CARD_CONSENT_VERSION : futureConsent === null),
    "Explicit separate monthly retry and future-card choices are required");
    let { row } = await action("read", id, buyer, quote);
    if (row.confirmed_at) check(row.use_future_card === future && row.consent_version === consent && row.future_consent_version === futureConsent,
      "Accepted monthly retry choices cannot change");
    if (row.dispatch_consumed_at) return checkRenewalRetry(id, buyer, quote);
    writeGate(); await fresh(row);
    ({ row } = await action("confirm", id, buyer, quote, null, true, consent, future, futureConsent));
    await fresh(row); writeGate();
    const consumed = await action("consume", id, buyer, quote);
    if (consumed.dispatch) {
      check(consumed.row.dispatch_consumed_at && consumed.row.confirmed_at, "Monthly retry lacks durable dispatch");
      try {
        await checked(stripe.invoices.pay(consumed.row.invoice_id, consumed.row.request,
          { idempotencyKey: "creatornet-monthly-retry:" + consumed.row.id, maxNetworkRetries: 0 }));
      } catch {
        // Decline, action-required and transport uncertainty all reconcile the
        // same admitted invoice/PI. Never infer success or send another debit.
      }
    }
    return checkRenewalRetry(id, buyer, quote);
  }
  return { reviewRenewalRetry, payRenewalRetry, checkRenewalRetry };
}
