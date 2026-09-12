/** @jest-environment node */
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMembershipBankVerification } from "@/lib/membershipBankVerification";
import { membershipInvoiceConfiguration } from "@/lib/membershipRenewal";
import { membershipRenewalFixture } from "../test-support/membership-renewal-fixtures";
import { membershipTestEnv } from "../test-support/membership-fixtures";
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
function harness(replacement = false) {
  const f = membershipRenewalFixture(), context = f.a.terms.paymentContext;
  Object.assign(f.invoice, membershipInvoiceConfiguration(f.a, f.proof, 2), { status: "open", attempt_count: 1 });
  f.invoice.lines.data[0].period = { start: f.period.start, end: f.period.end };
  Object.assign(f.paymentIntent, { status: "requires_action", confirmation_method: "automatic", capture_method: "automatic",
    on_behalf_of: null, canceled_at: null, next_action: { type: "use_stripe_sdk", use_stripe_sdk: {} },
    payment_method: replacement ? "pm_replacement" : "pm_fixture", client_secret: f.paymentIntent.id + "_secret_fixture" });
  const card = { ...f.paymentMethod, id: String(f.paymentIntent.payment_method) };
  const b = { version: "monthly-bank-context-v1", membershipId: f.a.id, buyerId: f.a.buyer_id,
    operationId: "40000000-0000-4000-8000-000000000001", invoiceId: f.invoice.id, paymentIntentId: f.paymentIntent.id,
    paymentMethodId: card.id, originalPaymentMethodId: f.proof.paymentMethodId, customerId: f.customer.id, subscriptionId: f.subscription.id,
    paymentContext: context, fingerprint: f.a.fingerprint, revision: f.a.revision, month: 2, amountCents: f.a.monthly_price_cents,
    periodStart: f.period.start, periodEnd: f.period.end, admittedAt: Math.floor(Date.now() / 1000) - 1,
    retryQuoteId: replacement ? "40000000-0000-4000-8000-000000000002" : null };
  const operation = { id: b.operationId, scope_key: "2", request: { method: "POST", path: "/v1/invoices/" + f.invoice.id + "/pay",
    params: { payment_method: f.proof.paymentMethodId, off_session: true, forgive: false, paid_out_of_band: false } } };
  const rpc = jest.fn(async () => {
    if (f.a.debit_revoked_at || f.a.financial_hold_at || f.a.renewal_stopped_at) throw Error("Synthetic durable bank stop");
    return { error: null, data: copy({ ...b, revision: f.a.revision }) };
  });
  const from = jest.fn((table: string) => {
    const q = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn(async () => ({ error: null,
      data: table === "monthly_mentorship_receipts_v1" ? { provider_proof: copy(f.proof) } : copy(operation) })) };
    q.select.mockReturnValue(q); q.eq.mockReturnValue(q); return q;
  });
  const response = <T,>(v: T): Stripe.Response<T> => ({ ...v, lastResponse: { apiVersion: context.apiVersion, requestId: "req_bank", headers: {}, statusCode: 200 } });
  const stripe = { paymentMethods: { retrieve: jest.fn(async () => response(card)) },
    subscriptions: { retrieve: jest.fn(async () => response(f.subscription)), update: jest.fn() },
    invoices: { retrieve: jest.fn(async () => response(f.invoice)), pay: jest.fn(), update: jest.fn() },
    invoicePayments: { list: jest.fn(async () => response({ object: "list", data: [f.invoicePayment], has_more: false, url: "/v1/invoice_payments" })) },
    paymentIntents: { retrieve: jest.fn(async () => response(f.paymentIntent)), confirm: jest.fn(), create: jest.fn() },
    charges: { retrieve: jest.fn(async () => response(f.charge)) } };
  const env = { ...membershipTestEnv, CREATOR_MONTHLY_MENTORSHIPS_RENEWAL_RECOVERY_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_RENEWAL_RECOVERY_READY: "true",
    CREATOR_MONTHLY_MENTORSHIPS_RETRY_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_BANK_SCHEMA_READY: "true",
    CREATOR_MONTHLY_MENTORSHIPS_BANK_VERIFICATION_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_BANK_STOP_COORDINATION_READY: "true",
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_fixture" };
  const readRenewalRecovery = jest.fn(async () => ({ membershipId: f.a.id, invoiceId: f.invoice.id, month: 2,
    amountCents: f.a.monthly_price_cents, periodStart: f.period.start, periodEnd: f.period.end, outcome: "action_required" as const }));
  const api = createMembershipBankVerification({ admin: { rpc, from } as unknown as SupabaseClient, stripe: stripe as unknown as Stripe, context, env,
    checked: async p => p, observeContext: async () => context, load: async (id, buyer) => {
      if (id !== f.a.id || buyer !== f.a.buyer_id) throw Error("Foreign bank owner"); return copy(f.a);
    }, productId: async () => f.product.id }, { readRenewalRecovery });
  return { f, card, b, operation, rpc, from, stripe, env, api, readRenewalRecovery, response,
    challenge: () => api.readRenewalBankChallenge(f.a.id, f.a.buyer_id, f.invoice.id) };
}
test.each([false, true])("steps 1/5/8: original bank capability for replacement=%s never creates a payment or changes defaults", async replacement => {
  const h = harness(replacement), before = copy(h.f.a), result = await h.challenge();
  expect(result).toEqual({ status: "bank_verification_ready", membershipId: h.f.a.id, invoiceId: h.f.invoice.id, month: 2,
    amountCents: h.f.a.monthly_price_cents, periodStart: h.f.period.start, periodEnd: h.f.period.end,
    publishableKey: "pk_test_fixture", clientSecret: h.f.paymentIntent.client_secret });
  expect(h.rpc).toHaveBeenCalledTimes(2); expect(JSON.stringify(h.rpc.mock.calls)).not.toContain("_secret_");
  expect(h.f.a).toEqual(before); expect(h.stripe.invoices.pay).not.toHaveBeenCalled(); expect(h.stripe.invoices.update).not.toHaveBeenCalled();
  expect(h.stripe.paymentIntents.confirm).not.toHaveBeenCalled(); expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
  expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
});
test.each(["key_mode", "key_missing", "card_owner", "card_id", "card_mode", "invoice_id", "invoice_default", "invoice_amount",
  "link_payment", "link_paid", "link_extra", "payment_id", "payment_owner", "payment_amount", "payment_received", "payment_capturable",
  "payment_card", "payment_mode", "payment_fee", "payment_destination", "manual_confirmation", "manual_capture", "redirect_action", "wrong_secret", "succeeded"] as const)(
  "steps 5/8: contradictory native evidence %s prevents secret release", async fault => {
    const h = harness(true);
    if (fault === "key_mode") h.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_live_fixture";
    if (fault === "key_missing") h.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "";
    if (fault === "card_owner") h.card.customer = "cus_other";
    if (fault === "card_id") h.card.id = "pm_other";
    if (fault === "card_mode") h.card.livemode = true;
    if (fault === "invoice_id") h.f.invoice.id = "in_other";
    if (fault === "invoice_default") h.f.invoice.default_payment_method = h.card.id;
    if (fault === "invoice_amount") h.f.invoice.amount_due++;
    if (fault === "link_payment") h.f.invoicePayment.payment.payment_intent = "pi_other";
    if (fault === "link_paid") h.f.invoicePayment.amount_paid = 1;
    if (fault === "link_extra") h.stripe.invoicePayments.list.mockImplementationOnce(async () => h.response({
      object: "list", data: [h.f.invoicePayment, h.f.invoicePayment], has_more: false, url: "/v1/invoice_payments" }));
    if (fault === "payment_id") h.f.paymentIntent.id = "pi_other";
    if (fault === "payment_owner") h.f.paymentIntent.customer = "cus_other";
    if (fault === "payment_amount") h.f.paymentIntent.amount++;
    if (fault === "payment_received") h.f.paymentIntent.amount_received = 1;
    if (fault === "payment_capturable") h.f.paymentIntent.amount_capturable = 1;
    if (fault === "payment_card") h.f.paymentIntent.payment_method = "pm_other";
    if (fault === "payment_mode") h.f.paymentIntent.livemode = true;
    if (fault === "payment_fee") h.f.paymentIntent.application_fee_amount!++;
    if (fault === "payment_destination") h.f.paymentIntent.transfer_data!.destination = "acct_other";
    if (fault === "manual_confirmation") h.f.paymentIntent.confirmation_method = "manual";
    if (fault === "manual_capture") h.f.paymentIntent.capture_method = "manual";
    if (fault === "redirect_action") h.f.paymentIntent.next_action = { type: "redirect_to_url", redirect_to_url: { url: "https://other.example.invalid", return_url: "https://other.example.invalid" } };
    if (fault === "wrong_secret") h.f.paymentIntent.client_secret = "pi_other_secret_fixture";
    if (fault === "succeeded") h.f.paymentIntent.status = "succeeded";
    await expect(h.api.readRenewalBankChallenge(h.f.a.id, h.f.a.buyer_id, h.b.invoiceId)).rejects.toThrow();
    expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
  });
test("step 8: automatic_async capture may still authenticate the original card", async () => {
  const h = harness(); h.f.paymentIntent.capture_method = "automatic_async"; expect((await h.challenge()).status).toBe("bank_verification_ready");
});
test("step 8: an earlier failed, uncaptured charge may remain attached", async () => {
  const h = harness(); h.f.paymentIntent.latest_charge = h.f.charge.id;
  Object.assign(h.f.charge, { paid: false, captured: false, status: "failed", amount_captured: 0, amount_refunded: 0, balance_transaction: null });
  expect((await h.challenge()).status).toBe("bank_verification_ready");
  h.f.charge.captured = true; await expect(h.challenge()).rejects.toThrow("charge evidence");
});
test.each(["stop", "revision"])("step 2: %s during provider reads is caught by the final SQL recheck", async kind => {
  const h = harness(), retrieve = h.stripe.paymentIntents.retrieve.getMockImplementation()!;
  h.stripe.paymentIntents.retrieve.mockImplementationOnce(async () => { const pi = await retrieve();
    if (kind === "stop") h.f.a.debit_revoked_at = new Date().toISOString(); else h.f.a.revision++;
    return pi; });
  await expect(h.challenge()).rejects.toThrow(); expect(h.rpc).toHaveBeenCalledTimes(2); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
test.each(["CREATOR_MONTHLY_MENTORSHIPS_BANK_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_BANK_VERIFICATION_READY",
  "CREATOR_MONTHLY_MENTORSHIPS_BANK_STOP_COORDINATION_READY"] as const)("step 10: %s remains an independent fail-closed gate", async key => {
  const h = harness(); h.env[key] = "false"; await expect(h.challenge()).rejects.toThrow("not enabled");
  expect(h.rpc).not.toHaveBeenCalled(); expect(h.readRenewalRecovery).not.toHaveBeenCalled();
});
test("step 5: a foreign buyer cannot obtain the original payment capability", async () => {
  const h = harness(); await expect(h.api.readRenewalBankChallenge(h.f.a.id, h.f.a.creator_id, h.f.invoice.id)).rejects.toThrow("owner");
  expect(h.rpc).not.toHaveBeenCalled();
});
