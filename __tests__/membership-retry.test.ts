/** @jest-environment node */
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMembershipRetry } from "@/lib/membershipRetry";
import { createMembershipRenewalRecovery } from "@/lib/membershipRenewalRecovery";
import { monthlyCardForService, monthlyCaptureAuthority, monthlyInvoiceCard, type MonthlyRetryRow } from "@/lib/membershipCards";
import { membershipInvoiceConfiguration } from "@/lib/membershipRenewal";
import { MONTHLY_RETRY_CONSENT_TEXT, MONTHLY_RETRY_CONSENT_VERSION, MONTHLY_FUTURE_CARD_CONSENT_TEXT, MONTHLY_FUTURE_CARD_CONSENT_VERSION } from "@/lib/membershipRetryConsent";
import { monthlyCardSetupFixture } from "../test-support/membership-card-setup-fixtures";
import { membershipTestEnv } from "../test-support/membership-fixtures";
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
function harness() {
  const { f, r, card } = monthlyCardSetupFixture(), context = f.a.terms.paymentContext, now = Math.floor(Date.now() / 1000);
  Object.assign(f.invoice, membershipInvoiceConfiguration(f.a, f.proof, 2), { status: "open", attempt_count: 1 });
  f.invoice.lines.data[0].period = { start: f.period.start, end: f.period.end }; f.paymentIntent.next_action = null;
  const id = "30000000-0000-4000-8000-000000000001";
  const q: MonthlyRetryRow = { id, setup_id: r.id, operation_id: r.operation_id, agreement_id: f.a.id, buyer_id: f.a.buyer_id,
    invoice_id: f.invoice.id, month_number: 2, snapshot: { ...r.snapshot, setupId: r.id, setupIntentId: "seti_saved", replacementPaymentMethodId: card.id },
    quote: { version: "monthly-retry-quote-v1", id, membershipId: f.a.id, setupId: r.id, title: "Owned monthly mentorship", amountCents: f.a.monthly_price_cents,
      currency: "usd", month: 2, periodStart: f.period.start, periodEnd: f.period.end, expiresAt: now + 600,
      minimumMonths: f.a.minimum_months, autoRenew: f.a.auto_renew, canUseForFuture: true,
      consentVersion: MONTHLY_RETRY_CONSENT_VERSION, consentText: MONTHLY_RETRY_CONSENT_TEXT,
      futureConsentVersion: MONTHLY_FUTURE_CARD_CONSENT_VERSION, futureConsentText: MONTHLY_FUTURE_CARD_CONSENT_TEXT },
    created_at: now, expires_at: now + 600, confirmed_at: null, use_future_card: null, consent_version: null,
    future_consent_version: null, dispatch_consumed_at: null,
    request: { payment_method: card.id, off_session: false, forgive: false, paid_out_of_band: false } };
  const operation = { id: r.operation_id, scope_key: "2", status: "review_required", provider_id: null,
    request: { method: "POST", path: "/v1/invoices/" + f.invoice.id + "/pay",
      params: { payment_method: f.proof.paymentMethodId, off_session: true, forgive: false, paid_out_of_band: false } } };
  const receipts: Record<number, Record<string, unknown>> = { 1: f.proof };
  const from = jest.fn((table: string) => {
    const filters: Record<string, unknown> = {}; let notKey = "";
    const builder = { select: jest.fn(), eq: jest.fn(), not: jest.fn(), maybeSingle: jest.fn(async () => {
        const data = table === "monthly_mentorship_operations_v1" ? operation :
          table === "monthly_mentorship_receipts_v1" ? { provider_proof: receipts[Number(filters.month_number)] } :
          table === "monthly_mentorship_renewal_recoveries_v1" ? { payment_intent_id: r.snapshot.paymentIntentId } :
          table === "monthly_mentorship_retry_quotes_v1" && (notKey === "confirmed_at" ? q.confirmed_at : q.dispatch_consumed_at) ? q : null;
        return { error: null, data: copy(data) };
      }) };
    builder.select.mockReturnValue(builder);
    builder.eq.mockImplementation((key: string, value: unknown) => { filters[key] = value; return builder; });
    builder.not.mockImplementation((key: string) => { notKey = key; return builder; });
    return builder;
  });
  const rpc = jest.fn(async (name: string, p: Record<string, unknown>) => {
    if (name === "record_monthly_mentorship_renewal_recovery_v1") return { error: null, data: { agreement_id: f.a.id, invoice_id: f.invoice.id,
      payment_intent_id: r.snapshot.paymentIntentId, outcome: p.p_outcome } };
    if (name !== "monthly_retry_v1") throw Error("Unexpected private RPC");
    if (p.p_action === "review") { q.id = String(p.p_id); q.quote.id = q.id; }
    if (p.p_action === "confirm" && !q.confirmed_at) {
      q.confirmed_at = new Date().toISOString(); q.use_future_card = Boolean(p.p_future);
      q.consent_version = String(p.p_consent); q.future_consent_version = p.p_future_consent as string | null;
    }
    if (p.p_action === "consume") {
      if (f.a.debit_revoked_at) throw Error("Synthetic durable stop");
      const dispatch = !q.dispatch_consumed_at; q.dispatch_consumed_at ||= new Date().toISOString();
      return { error: null, data: { dispatch, retry: copy(q) } };
    }
    return { error: null, data: copy(q) };
  });
  const response = <T,>(v: T): Stripe.Response<T> => ({ ...v, lastResponse: { apiVersion: context.apiVersion, requestId: "req_retry", headers: {}, statusCode: 200 } });
  const stripe = {
    invoices: { retrieve: jest.fn(async () => response(f.invoice)), pay: jest.fn(async () => {
      f.capture(); f.paymentIntent.payment_method = card.id; f.charge.payment_method = card.id; return response(f.invoice);
    }), update: jest.fn() },
    invoicePayments: { list: jest.fn(async () => response({ data: [f.invoicePayment], has_more: false, object: "list", url: "/v1/invoice_payments" })) },
    paymentIntents: { retrieve: jest.fn(async () => response(f.paymentIntent)), confirm: jest.fn(), create: jest.fn() },
    paymentMethods: { retrieve: jest.fn(async () => response(card)) },
    subscriptions: { retrieve: jest.fn(async () => response(f.subscription)), update: jest.fn() },
  };
  const env = { ...membershipTestEnv, CREATOR_MONTHLY_MENTORSHIPS_RENEWAL_RECOVERY_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_RENEWAL_RECOVERY_READY: "true",
    CREATOR_MONTHLY_MENTORSHIPS_CARD_SETUP_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_CARD_SETUP_READY: "true",
    CREATOR_MONTHLY_MENTORSHIPS_RETRY_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_RETRY_READY: "true" };
  const d = { admin: { from, rpc } as unknown as SupabaseClient, stripe: stripe as unknown as Stripe, context, env,
    checked: async <T,>(p: Promise<Stripe.Response<T>>) => p, observeContext: async () => context,
    load: async (id: string, buyer: string) => { if (id !== f.a.id || buyer !== f.a.buyer_id) throw Error("Foreign monthly owner"); return copy(f.a); },
    productId: async () => f.product.id };
  const reconcileInvoice = jest.fn(async () => ({ status: "recorded", month: 2 }));
  const recovery = createMembershipRenewalRecovery(d, { reconcileInvoice });
  const verifyRenewalCardSetup = jest.fn(async () => ({ status: "card_saved_payment_not_attempted" }));
  const api = createMembershipRetry(d, { ...recovery, verifyRenewalCardSetup });
  const pay = (future = false) => api.payRenewalRetry(f.a.id, f.a.buyer_id, q.id, MONTHLY_RETRY_CONSENT_VERSION, true, future,
    future ? MONTHLY_FUTURE_CARD_CONSENT_VERSION : null);
  return { f, r, q, card, operation, receipts, d, env, api, recovery, pay, rpc, from, stripe, reconcileInvoice, verifyRenewalCardSetup, response };
}
test("steps 1/4/5: review is immutable context, not a debit or future-card acceptance", async () => {
  const h = harness(), result = await h.api.reviewRenewalRetry(h.f.a.id, h.f.a.buyer_id, h.r.id);
  expect(result.quote.amountCents).toBe(10000); expect(result.quote.periodStart).toBe(h.f.period.start);
  expect(result.confirmed).toBe(false); expect(result.useFutureCard).toBeNull(); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
test.each([false, true])("steps 1/4/8: one explicitly accepted retry, future-card choice %s, uses the original invoice", async future => {
  const h = harness(), result = await h.pay(future);
  expect(result.renewal.outcome).toBe("paid_accounted"); expect(h.q.use_future_card).toBe(future);
  expect(h.stripe.invoices.pay).toHaveBeenCalledWith(h.f.invoice.id, h.q.request,
    { idempotencyKey: "creatornet-monthly-retry:" + h.q.id, maxNetworkRetries: 0 });
  await h.pay(future); expect(h.stripe.invoices.pay).toHaveBeenCalledTimes(1);
  expect(h.stripe.invoices.update).not.toHaveBeenCalled(); expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
  expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled(); expect(h.stripe.paymentIntents.confirm).not.toHaveBeenCalled();
});
test("step 8: a lost response is recovered from the original payment, never another pay call", async () => {
  const h = harness(), pay = h.stripe.invoices.pay.getMockImplementation()!;
  h.stripe.invoices.pay.mockImplementationOnce(async () => { await pay(); throw Error("Synthetic lost response"); });
  expect((await h.pay()).renewal.outcome).toBe("paid_accounted");
  const age = h.q.dispatch_consumed_at; await h.pay(); expect(h.q.dispatch_consumed_at).toBe(age); expect(h.stripe.invoices.pay).toHaveBeenCalledTimes(1);
});
test("step 8: a retry decline without a changed attempt counter remains review-only", async () => {
  const h = harness(); h.stripe.invoices.pay.mockImplementationOnce(async () => { throw Error("Synthetic decline"); });
  expect((await h.pay()).renewal.outcome).toBe("review_required"); expect(h.f.invoice.attempt_count).toBe(1);
  await h.pay(); expect(h.stripe.invoices.pay).toHaveBeenCalledTimes(1); expect(h.reconcileInvoice).not.toHaveBeenCalled();
});
test("step 8: bank authentication stays tied to the same admitted PI without exposing a secret", async () => {
  const h = harness(); h.stripe.invoices.pay.mockImplementationOnce(async () => {
    h.f.paymentIntent.status = "requires_action"; h.f.paymentIntent.payment_method = h.card.id;
    h.f.paymentIntent.next_action = { type: "use_stripe_sdk", use_stripe_sdk: {} }; throw Error("Synthetic authentication required");
  });
  const result = await h.pay(); expect(result.renewal.outcome).toBe("action_required"); expect(JSON.stringify(result)).not.toContain("client_secret");
  await h.pay(); expect(h.stripe.invoices.pay).toHaveBeenCalledTimes(1);
});
test.each(["owner", "card_owner", "amount", "fee", "destination", "subscription_card", "invoice_card", "payment_id", "pending", "expired", "stop"] as const)(
  "steps 2/5/8: %s blocks new retry dispatch", async fault => {
    const h = harness();
    if (fault === "owner") { await expect(h.api.payRenewalRetry(h.f.a.id, h.f.a.creator_id, h.q.id, MONTHLY_RETRY_CONSENT_VERSION, true, false, null)).rejects.toThrow("owner"); return; }
    if (fault === "card_owner") h.card.customer = "cus_other";
    if (fault === "amount") h.f.paymentIntent.amount++;
    if (fault === "fee") h.f.paymentIntent.application_fee_amount!++;
    if (fault === "destination") h.f.paymentIntent.transfer_data!.destination = "acct_other";
    if (fault === "subscription_card") h.f.subscription.default_payment_method = h.card.id;
    if (fault === "invoice_card") h.f.invoice.default_payment_method = h.card.id;
    if (fault === "payment_id") { h.f.paymentIntent.id = "pi_other"; h.f.invoicePayment.payment.payment_intent = "pi_other"; }
    if (fault === "pending") h.f.paymentIntent.status = "processing";
    if (fault === "expired") { h.q.created_at -= 700; h.q.expires_at -= 700; h.q.quote.expiresAt -= 700; }
    if (fault === "stop") h.f.a.debit_revoked_at = new Date().toISOString();
    await expect(h.pay()).rejects.toThrow(); expect(h.stripe.invoices.pay).not.toHaveBeenCalled(); expect(h.q.dispatch_consumed_at).toBeNull();
  });
test("step 2: the durable admission rejects a stop after external checks", async () => {
  const h = harness(), rpc = h.rpc.getMockImplementation()!;
  h.rpc.mockImplementation(async (name, p) => { if (p.p_action === "consume") h.f.a.debit_revoked_at = new Date().toISOString(); return rpc(name, p); });
  await expect(h.pay()).rejects.toThrow("durable stop"); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
test("step 4: absent or mismatched separate consent never reaches dispatch", async () => {
  const h = harness();
  await expect(h.api.payRenewalRetry(h.f.a.id, h.f.a.buyer_id, h.q.id, MONTHLY_RETRY_CONSENT_VERSION, false, false, null)).rejects.toThrow("choices");
  await expect(h.api.payRenewalRetry(h.f.a.id, h.f.a.buyer_id, h.q.id, MONTHLY_RETRY_CONSENT_VERSION, true, true, null)).rejects.toThrow("choices");
  await expect(h.api.payRenewalRetry(h.f.a.id, h.f.a.buyer_id, h.q.id, "old", true, false, null)).rejects.toThrow("choices");
  expect(h.rpc).not.toHaveBeenCalled(); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
test("step 4: accepted future choice cannot be changed by a repeated request", async () => {
  const h = harness(); await h.pay(true); await expect(h.pay(false)).rejects.toThrow("cannot change"); expect(h.stripe.invoices.pay).toHaveBeenCalledTimes(1);
});
test("step 10: disabling dispatch preserves observation but cannot initiate a payment", async () => {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_RETRY_READY = "false";
  await expect(h.pay()).rejects.toThrow("not enabled"); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
  expect((await h.api.checkRenewalRetry(h.f.a.id, h.f.a.buyer_id, h.q.id)).renewal.outcome).toBe("payment_method_required");
});
test.each([false, true])("steps 4/7/8: captured replacement advances future card only when chosen (%s)", async future => {
  const h = harness(); await h.pay(future);
  const result = await monthlyCaptureAuthority(h.d, h.f.a, h.f.proof, 2, h.f.invoice.id, h.f.paymentIntent.id, h.card.id, h.f.charge.created);
  expect(result.proof.paymentMethodId).toBe(h.card.id); expect(result.extension.retryQuoteId).toBe(h.q.id);
  expect(result.extension.nextPaymentMethodId).toBe(future ? h.card.id : h.f.proof.paymentMethodId);
  h.receipts[2] = { paymentMethodId: h.card.id, ...result.extension };
  expect((await monthlyCardForService(h.d, h.f.a, h.f.proof, 3)).paymentMethodId).toBe(result.extension.nextPaymentMethodId);
  expect(h.f.subscription.default_payment_method).toBe(h.f.proof.paymentMethodId);
});
test("step 8: an old original-card capture does not activate the optional replacement choice", async () => {
  const h = harness(); await h.pay(true);
  const result = await monthlyCaptureAuthority(h.d, h.f.a, h.f.proof, 2, h.f.invoice.id, h.f.paymentIntent.id, h.f.proof.paymentMethodId, h.f.charge.created);
  expect(result.extension).toEqual({ nextPaymentMethodId: h.f.proof.paymentMethodId });
});
test.each(["no_consumption", "foreign_payment", "early_capture", "wrong_card"])("step 8: %s cannot authorize a replacement receipt", async fault => {
  const h = harness(); if (fault !== "no_consumption") await h.pay(true);
  await expect(monthlyCaptureAuthority(h.d, h.f.a, h.f.proof, 2, h.f.invoice.id,
    fault === "foreign_payment" ? "pi_other" : h.f.paymentIntent.id, fault === "wrong_card" ? "pm_other" : h.card.id,
    fault === "early_capture" ? h.q.created_at - 10 : Math.floor(Date.now() / 1000))).rejects.toThrow();
});
test("step 8: historical invoice admission is not rewritten by a later future card", () => {
  const h = harness(); expect(monthlyInvoiceCard(h.d, h.f.proof, h.operation.request, h.f.invoice.id).paymentMethodId).toBe("pm_fixture");
  h.operation.request.params.payment_method = h.card.id;
  expect(monthlyInvoiceCard(h.d, h.f.proof, h.operation.request, h.f.invoice.id).paymentMethodId).toBe(h.card.id);
  h.env.CREATOR_MONTHLY_MENTORSHIPS_RETRY_SCHEMA_READY = "false";
  expect(() => monthlyInvoiceCard(h.d, h.f.proof, h.operation.request, h.f.invoice.id)).toThrow("admission");
});
