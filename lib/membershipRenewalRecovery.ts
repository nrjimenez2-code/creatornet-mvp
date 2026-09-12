import "server-only";
import { membershipCheck as check, membershipStripeId as sid } from "./membershipCheckout";
import { assertMembershipActivated, assertMembershipInvoice, membershipRenewalPeriod, readMembershipFirstProof } from "./membershipRenewal";
import type { MembershipBillingDependencies } from "./membershipBillingRuntime";
import { monthlyInvoiceCard, consumedMonthlyRetry } from "./membershipCards";
export type MembershipRenewalRecoveryOutcome = "payment_method_required" | "action_required" | "payment_pending" | "terminal_unpaid" | "paid_accounted" | "review_required";
export type MembershipRenewalRecoveryResult = { membershipId: string; invoiceId: string; month: number; amountCents: number;
  periodStart: number; periodEnd: number; outcome: MembershipRenewalRecoveryOutcome };
type Callbacks = { reconcileInvoice(id: string, buyerId: string, invoiceId: string): Promise<{ status: string; month: number }> };
export function membershipRenewalRecoveryReady(env: Record<string, string | undefined>) {
  return ["CREATOR_MONTHLY_MENTORSHIPS_COLLECTION_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_RENEWAL_RECOVERY_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_RENEWAL_RECOVERY_READY"]
    .every(key => env[key] === "true");
}
/** Provider reads and existing captured-payment reconciliation only. No card
 * setup, client secret, new debit, default change, debt waiver or new access.
 * Saving a card and retrying payment require separate durable buyer authority. */
export function createMembershipRenewalRecovery(d: MembershipBillingDependencies, callbacks: Callbacks) {
  const { admin, stripe, context, env, checked, observeContext, load, productId } = d;
  async function readRenewalRecovery(id: string, buyerId: string, invoiceId: string): Promise<MembershipRenewalRecoveryResult> {
    check(membershipRenewalRecoveryReady(env), "Monthly renewal recovery is not enabled");
    sid(invoiceId, "in");
    const a = await load(id, buyerId); await observeContext();
    const query = await admin.from("monthly_mentorship_operations_v1").select("id,scope_key,request,status,provider_id")
      .eq("agreement_id", a.id).eq("kind", "collect").eq("request->>path", "/v1/invoices/" + invoiceId + "/pay").maybeSingle();
    const op = query.data;
    check(!query.error && op && /^[1-9][0-9]{0,8}$/.test(op.scope_key) &&
      ["dispatched", "review_required", "complete"].includes(op.status) && op.request?.method === "POST" &&
      op.request.path === "/v1/invoices/" + invoiceId + "/pay", "Monthly recovery lacks its original collection admission");
    const month = Number(op.scope_key), p = membershipRenewalPeriod(a, month), product = await productId(a);
    check(month >= 2 && (op.status !== "complete" || op.provider_id === invoiceId));
    const first = await admin.from("monthly_mentorship_receipts_v1").select("provider_proof").eq("agreement_id", a.id).eq("month_number", 1).maybeSingle();
    check(!first.error && first.data);
    const original = readMembershipFirstProof(a, first.data.provider_proof), proof = monthlyInvoiceCard(d, original, op.request, invoiceId);
    const retry = await consumedMonthlyRetry(d, a, op.id);
    if (retry) check(retry.invoice_id === invoiceId && retry.month_number === month && retry.snapshot.originalPaymentMethodId === proof.paymentMethodId,
      "Original monthly retry admission differs");
    const invoice = await checked(stripe.invoices.retrieve(invoiceId));
    check(invoice.id === invoiceId);
    assertMembershipInvoice(invoice, a, proof, month, product, invoice.status === "paid" ? "paid" : "configured");
    const links = await checked(stripe.invoicePayments.list({ invoice: invoiceId, limit: 100 }));
    check(links.has_more === false && links.data.length === 1, "Monthly recovery payment linkage needs review");
    const link = links.data[0], paid = invoice.status === "paid";
    check(link.object === "invoice_payment" && link.invoice === invoiceId && link.is_default === true &&
      link.livemode === (context.mode === "live") && link.currency === "usd" && link.amount_requested === a.monthly_price_cents &&
      (paid ? link.status === "paid" && link.amount_paid === a.monthly_price_cents :
        link.status === "open" && (link.amount_paid == null || link.amount_paid === 0)) &&
      link.payment.type === "payment_intent", "Monthly recovery original payment differs");
    const pi = await checked(stripe.paymentIntents.retrieve(sid(link.payment.payment_intent, "pi")));
    check(pi.object === "payment_intent" && pi.id === sid(link.payment.payment_intent, "pi") && pi.livemode === (context.mode === "live") &&
      sid(pi.customer, "cus") === a.stripe_customer_id && pi.amount === a.monthly_price_cents && pi.currency === "usd" &&
      pi.application_fee_amount === a.terms.recurringMonthFees.totalCreatorDeductionCents &&
      pi.transfer_data?.destination === a.terms.destinationId && pi.transfer_data.amount == null &&
      pi.payment_method_types.length === 1 && pi.payment_method_types[0] === "card" &&
      ["automatic", "automatic_async"].includes(pi.capture_method) && pi.amount_capturable === 0 &&
      Number.isSafeInteger(invoice.attempt_count) && invoice.attempt_count >= 0, "Monthly recovery payment contract differs");
    if (retry) check(pi.id === retry.snapshot.paymentIntentId, "Original monthly retry payment cannot change");
    const admittedCard = pi.payment_method === proof.paymentMethodId || retry && pi.payment_method === retry.snapshot.replacementPaymentMethodId;
    let outcome: MembershipRenewalRecoveryOutcome;
    if (paid) {
      check(pi.status === "succeeded" && pi.amount_received === a.monthly_price_cents && admittedCard);
      const recovered = await callbacks.reconcileInvoice(a.id, a.buyer_id, invoiceId);
      check(["recorded", "already_recorded"].includes(recovered.status) && recovered.month === month,
        "Monthly captured payment still needs ledger reconciliation");
      outcome = "paid_accounted";
    } else {
      check(invoice.status === "open" && pi.amount_received === 0 &&
        (pi.payment_method == null || admittedCard), "Monthly unpaid evidence differs");
      const sub = await checked(stripe.subscriptions.retrieve(a.stripe_subscription_id!));
      assertMembershipActivated(sub, a, product, original);
      const now = Math.floor(Date.now() / 1000);
      if (a.financial_hold_at || a.debit_revoked_at || a.renewal_stopped_at || now < p.start || now >= p.end) outcome = "review_required";
      else if (pi.status === "requires_payment_method" && invoice.attempt_count > 0 && pi.next_action == null) outcome = retry ? "review_required" : "payment_method_required";
      else if (pi.status === "requires_action" && invoice.attempt_count > 0 && pi.next_action != null) outcome = "action_required";
      else if (pi.status === "canceled") outcome = "terminal_unpaid";
      else if (["processing", "requires_confirmation", "requires_payment_method"].includes(pi.status)) outcome = "payment_pending";
      else outcome = "review_required";
    }
    const providerProof = { version: "monthly-renewal-recovery-proof-v1", paymentContext: context, operationId: op.id,
      customerId: a.stripe_customer_id, subscriptionId: a.stripe_subscription_id, invoiceId, paymentIntentId: pi.id,
      originalPaymentMethodId: proof.paymentMethodId, month, periodStart: p.start, periodEnd: p.end,
      invoiceStatus: invoice.status, paymentStatus: pi.status, amountDueCents: invoice.amount_due, amountPaidCents: invoice.amount_paid,
      amountReceivedCents: pi.amount_received, amountCapturableCents: pi.amount_capturable, attemptCount: invoice.attempt_count,
      observedAt: Math.floor(Date.now() / 1000), invoiceRequestId: invoice.lastResponse.requestId, paymentRequestId: pi.lastResponse.requestId };
    await observeContext();
    const saved = await admin.rpc("record_monthly_mentorship_renewal_recovery_v1", { p_id: a.id, p_buyer_id: a.buyer_id,
      p_operation_id: op.id, p_context: context, p_revision: a.revision, p_outcome: outcome, p_proof: providerProof });
    check(!saved.error && saved.data?.agreement_id === a.id && saved.data.invoice_id === invoiceId &&
      saved.data.payment_intent_id === pi.id && saved.data.outcome === outcome, "Monthly recovery observation needs a fresh retry");
    return { membershipId: a.id, invoiceId, month, amountCents: a.monthly_price_cents, periodStart: p.start, periodEnd: p.end, outcome };
  }
  return { readRenewalRecovery };
}
