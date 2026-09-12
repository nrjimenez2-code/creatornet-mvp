/** @jest-environment node */
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMembershipRenewalRecovery } from "@/lib/membershipRenewalRecovery";
import { membershipInvoiceConfiguration } from "@/lib/membershipRenewal";
import { membershipRenewalFixture } from "../test-support/membership-renewal-fixtures";
import { membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
const operationId = "19000000-0000-4000-8000-000000000001";
function harness() {
  const f = membershipRenewalFixture();
  Object.assign(f.invoice, membershipInvoiceConfiguration(f.a, f.proof, f.period.month), { status: "open", attempt_count: 1 });
  f.invoice.lines.data[0].period = { start: f.period.start, end: f.period.end };
  f.paymentIntent.next_action = null;
  const op = { id: operationId, scope_key: String(f.period.month), status: "dispatched", provider_id: null,
    request: { method: "POST", path: "/v1/invoices/" + f.invoice.id + "/pay",
      params: { payment_method: "pm_fixture", off_session: true, forgive: false, paid_out_of_band: false } } };
  const response = <T,>(value: T): Stripe.Response<T> => ({ ...value,
    lastResponse: { apiVersion: context.apiVersion, requestId: "req_recovery", headers: {}, statusCode: 200 } });
  const rpc = jest.fn(async (_name: string, args: Record<string, unknown>) => ({ error: null, data: {
    agreement_id: f.a.id, invoice_id: f.invoice.id, payment_intent_id: f.paymentIntent.id, outcome: args.p_outcome } }));
  const from = jest.fn((table: string) => {
    const q = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn(async () => ({ error: null,
      data: table === "monthly_mentorship_operations_v1" ? op : { provider_proof: f.proof } })) };
    q.select.mockReturnValue(q); q.eq.mockReturnValue(q); return q;
  });
  const stripe = { invoices: { retrieve: jest.fn(async () => response(f.invoice)), pay: jest.fn(), update: jest.fn(), finalizeInvoice: jest.fn() },
    invoicePayments: { list: jest.fn(async () => response({ object: "list", data: [f.invoicePayment], has_more: false, url: "/v1/invoice_payments" })) },
    paymentIntents: { retrieve: jest.fn(async () => response(f.paymentIntent)), confirm: jest.fn() },
    subscriptions: { retrieve: jest.fn(async () => response(f.subscription)), update: jest.fn() },
    checkout: { sessions: { create: jest.fn() } } };
  const reconcileInvoice = jest.fn(async () => ({ status: "recorded", month: f.period.month }));
  const env: Record<string, string> = { ...membershipTestEnv, CREATOR_MONTHLY_MENTORSHIPS_RENEWAL_RECOVERY_SCHEMA_READY: "true",
    CREATOR_MONTHLY_MENTORSHIPS_RENEWAL_RECOVERY_READY: "true" };
  const observeContext = jest.fn(async () => context);
  const runtime = createMembershipRenewalRecovery({ admin: { from, rpc } as unknown as SupabaseClient, stripe: stripe as unknown as Stripe,
    context, env, checked: async p => p, observeContext, load: async () => ({ ...f.a }), productId: async () => f.product.id }, { reconcileInvoice });
  const run = () => runtime.readRenewalRecovery(f.a.id, f.a.buyer_id, f.invoice.id);
  return { f, op, from, rpc, stripe, env, run, response, reconcileInvoice, observeContext };
}
afterEach(() => { jest.useRealTimers(); });
test.each(["requires_payment_method", "requires_action", "processing", "requires_confirmation", "canceled"] as const)(
  "steps 1/5/8: reports original unpaid renewal state %s without dispatching payment", async status => {
    const h = harness(); h.f.paymentIntent.status = status;
    if (status === "requires_action") h.f.paymentIntent.next_action = { type: "use_stripe_sdk", use_stripe_sdk: {} } as Stripe.PaymentIntent.NextAction;
    const before = JSON.stringify(h.f.a);
    const outcome = { requires_payment_method: "payment_method_required", requires_action: "action_required", processing: "payment_pending",
      requires_confirmation: "payment_pending", canceled: "terminal_unpaid" }[status];
    expect(await h.run()).toMatchObject({ outcome, month: h.f.period.month, amountCents: h.f.a.monthly_price_cents });
    expect(JSON.stringify(h.f.a)).toBe(before);
    expect(h.rpc).toHaveBeenCalledWith("record_monthly_mentorship_renewal_recovery_v1", expect.objectContaining({
      p_operation_id: operationId, p_revision: h.f.a.revision, p_outcome: outcome,
      p_proof: expect.objectContaining({ paymentIntentId: h.f.paymentIntent.id, originalPaymentMethodId: "pm_fixture" }) }));
    expect(h.stripe.invoices.pay).not.toHaveBeenCalled(); expect(h.stripe.invoices.update).not.toHaveBeenCalled();
    expect(h.stripe.invoices.finalizeInvoice).not.toHaveBeenCalled(); expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(h.stripe.paymentIntents.confirm).not.toHaveBeenCalled(); expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(h.reconcileInvoice).not.toHaveBeenCalled();
  });
test("step 8: an unattempted original payment is pending, not a proven decline", async () => {
  const h = harness(); h.f.invoice.attempt_count = 0;
  expect((await h.run()).outcome).toBe("payment_pending");
});
test.each(["financial_hold_at", "debit_revoked_at", "renewal_stopped_at"] as const)("step 2: %s requires review without clearing the stop", async key => {
  const h = harness(); h.f.a[key] = new Date().toISOString();
  expect((await h.run()).outcome).toBe("review_required"); expect(h.f.a[key]).not.toBeNull();
});
test("step 1: expired unpaid service cannot be presented as a payment-method retry opportunity", async () => {
  const h = harness(); jest.useFakeTimers().setSystemTime(new Date(h.f.period.end * 1000));
  expect((await h.run()).outcome).toBe("review_required");
});
test("step 8: a captured original attempt uses existing ledger reconciliation, including after a stop", async () => {
  const h = harness(); h.f.capture(); h.f.a.debit_revoked_at = new Date().toISOString();
  expect((await h.run()).outcome).toBe("paid_accounted");
  expect(h.reconcileInvoice).toHaveBeenCalledWith(h.f.a.id, h.f.a.buyer_id, h.f.invoice.id);
  expect(h.stripe.subscriptions.retrieve).not.toHaveBeenCalled(); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
test("step 7: failed ledger reconciliation is not reported as an accounted payment", async () => {
  const h = harness(); h.f.capture(); h.reconcileInvoice.mockResolvedValue({ status: "payment_pending", month: h.f.period.month });
  await expect(h.run()).rejects.toThrow("ledger reconciliation"); expect(h.rpc).not.toHaveBeenCalled();
});
test.each(["owner", "destination", "fee", "amount", "card", "link", "pagination", "hold", "period", "capture"])(
  "step 8: contradictory provider evidence %s cannot become a recovery authority", async fault => {
    const h = harness();
    if (fault === "owner") h.f.paymentIntent.customer = "cus_other";
    if (fault === "destination") h.f.paymentIntent.transfer_data!.destination = "acct_other";
    if (fault === "fee") h.f.paymentIntent.application_fee_amount = 1;
    if (fault === "amount") h.f.paymentIntent.amount = 1;
    if (fault === "card") h.f.paymentIntent.payment_method = "pm_other";
    if (fault === "link") h.f.invoicePayment.invoice = "in_other";
    if (fault === "pagination") h.stripe.invoicePayments.list.mockImplementation(async () => h.response({
      object: "list", data: [h.f.invoicePayment], has_more: true, url: "/v1/invoice_payments" }));
    if (fault === "hold") h.f.subscription.pause_collection = null;
    if (fault === "period") h.f.invoice.lines.data[0].period.end++;
    if (fault === "capture") h.f.paymentIntent.amount_received = 1;
    await expect(h.run()).rejects.toThrow(); expect(h.rpc).not.toHaveBeenCalled(); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
  });
test("step 5: a missing original collection admission is not inferred from invoice metadata", async () => {
  const h = harness(); h.op.request.path = "/v1/invoices/in_other/pay";
  await expect(h.run()).rejects.toThrow("original collection"); expect(h.stripe.invoices.retrieve).not.toHaveBeenCalled();
});
test("step 8: a concurrent database revision change asks for a fresh observation", async () => {
  const h = harness(); h.rpc.mockImplementation(async () => { throw Error("Synthetic revision change"); });
  await expect(h.run()).rejects.toThrow("revision change"); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
test("step 10: schema and runtime gates fail closed before provider reads", async () => {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_RENEWAL_RECOVERY_SCHEMA_READY = "false";
  await expect(h.run()).rejects.toThrow("not enabled"); expect(h.from).not.toHaveBeenCalled(); expect(h.stripe.invoices.retrieve).not.toHaveBeenCalled();
});

