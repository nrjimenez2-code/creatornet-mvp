import type Stripe from "stripe";
jest.mock("@/lib/paymentDisputes", () => ({ reconcileKnownPaymentDispute: jest.fn() }));
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMembershipBillingRuntime } from "@/lib/membershipBillingRuntime";
import { recordPaymentFeeLedger } from "@/lib/paymentFeeLedger";
import { membershipInvoiceConfiguration } from "@/lib/membershipRenewal";
import { membershipBootstrapTimes, membershipMetadata } from "@/lib/membershipCheckout";
import { membershipRenewalFixture } from "../test-support/membership-renewal-fixtures";
import { membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
jest.mock("@/lib/paymentFeeLedger", () => ({ recordPaymentFeeLedger: jest.fn() }));
jest.mock("@/lib/paymentRefunds", () => ({ applyPaymentRefundState: jest.fn(), reconcileKnownPaymentRefund: jest.fn(), recordPaymentRefundState: jest.fn() }));
const ledger = jest.mocked(recordPaymentFeeLedger), operationId = "17000000-0000-4000-8000-000000000001";
type Operation = { id: string; agreement_id: string; kind: string; scope_key: string; agreement_revision: number; request: unknown;
  dispatched_at: string; status: string; provider_id?: string };
beforeEach(() => { jest.clearAllMocks(); ledger.mockResolvedValue("17000000-0000-4000-8000-000000000002"); });
afterEach(() => { jest.useRealTimers(); });
function harness(anchor?: number, covered = 1) {
  const f = membershipRenewalFixture(anchor, covered), operations = new Map<string, Operation>(), receipts = new Map<number, unknown>([[1, f.proof]]);
  const env: Record<string, string> = { ...membershipTestEnv, CREATOR_MONTHLY_MENTORSHIPS_COLLECTION_SCHEMA_READY: "true", CREATOR_MONTHLY_MENTORSHIPS_RENEWALS_READY: "true" };
  let stopped = false, stopDuringConfigure = false, emptyInvoices = false, activationReady = true;
  const response = <T,>(value: T): Stripe.Response<T> => ({ ...value, lastResponse: { apiVersion: context.apiVersion, requestId: "req_fixture", headers: {}, statusCode: 200 } });
  const rpc = jest.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "review_monthly_mentorship_late_activation_v1") {
      f.a.billing_review_at = new Date().toISOString(); return { data: true, error: null };
    }
    const key = `${args.p_kind}:${args.p_scope}`;
    if (name === "claim_monthly_mentorship_operation_v1") {
      if (stopped) return { data: null, error: { message: "Synthetic stop/revision change" } };
      if (!operations.has(key)) operations.set(key, { id: operationId, agreement_id: f.a.id, kind: String(args.p_kind), scope_key: String(args.p_scope),
        agreement_revision: f.a.revision, request: JSON.parse(JSON.stringify(args.p_request)), dispatched_at: new Date().toISOString(), status: "dispatched" });
      return { data: operations.get(key), error: null };
    }
    if (name === "complete_monthly_mentorship_operation_v1") {
      // Synthetic completion of the original journal identity.
      const op = [...operations.values()].find(value => value.id === args.p_operation_id)!; op.status = "complete"; op.provider_id = String(args.p_provider_id);
      return { data: true, error: null };
    }
    if (name === "reconcile_monthly_mentorship_activation_v1") {
      const op = operations.get("activate:initial")!; op.status = "complete"; op.provider_id = f.subscription.id;
      return { data: true, error: null };
    }
    if (name === "record_monthly_mentorship_receipt_v1") {
      receipts.set(Number(args.p_month), args.p_proof); f.a.covered_months = Number(args.p_month);
      const op = operations.get(`collect:${args.p_month}`)!; op.status = "complete"; op.provider_id = f.invoice.id;
      return { data: true, error: null };
    }
    if (name === "review_monthly_mentorship_collection_v1") {
      operations.get(`collect:${args.p_month}`)!.status = "review_required"; return { data: true, error: null };
    }
    throw Error("Unexpected billing RPC " + name);
  });
  const from = jest.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const q: { select: jest.Mock; eq: jest.Mock; maybeSingle: jest.Mock } = { select: jest.fn(() => q),
      eq: jest.fn((key: string, value: unknown) => { filters[key] = value; return q; }), maybeSingle: jest.fn(async () => {
        if (table === "monthly_mentorship_receipts_v1") return { data: receipts.has(Number(filters.month_number)) ? { provider_proof: receipts.get(Number(filters.month_number)) } : null, error: null };
        if (table === "monthly_mentorship_operations_v1") {
          if (filters.kind === "activate") return { data: activationReady ? { status: "complete", provider_id: f.subscription.id } : operations.get("activate:initial") || null, error: null };
          const found = filters["request->>path"] ? [...operations.values()].find(op =>
            (op.request as { path: string }).path === filters["request->>path"]) : operations.get(`collect:${filters.scope_key}`);
          return { data: found || null, error: null };
        }
        if (table === "payment_fee_ledger") return { data: { dispute_status: "needs_response" }, error: null };
        throw Error("Unexpected billing table " + table);
      }) };
    return q;
  });
  const stripe = {
    customers: { retrieve: jest.fn(async () => response(f.customer)) }, paymentMethods: { retrieve: jest.fn(async () => response(f.paymentMethod)) },
    subscriptions: { retrieve: jest.fn(async () => response(f.subscription)), update: jest.fn(async (_id, params) => {
      Object.assign(f.subscription, params); f.subscription.cancel_at = params.cancel_at === "" ? null : params.cancel_at;
      f.subscription.billing_cycle_anchor = params.trial_end; return response(f.subscription);
    }) },
    invoices: {
      list: jest.fn(async () => response({ object: "list", has_more: false, data: emptyInvoices ? [] : [f.invoice] })),
      retrieve: jest.fn(async () => response(f.invoice)),
      updateLineItem: jest.fn(async (_id, _line, params) => { f.invoice.lines.data[0].period = params.period; return response(f.invoice.lines.data[0]); }),
      update: jest.fn(async (_id, params) => { Object.assign(f.invoice, params); if (stopDuringConfigure) stopped = true; return response(f.invoice); }),
      finalizeInvoice: jest.fn(async () => { f.invoice.status = "open"; return response(f.invoice); }),
      pay: jest.fn(async () => { f.capture(); return response(f.invoice); }),
    },
    invoicePayments: { list: jest.fn(async () => response({ object: "list", has_more: false, data: [f.invoicePayment] })) },
    paymentIntents: { retrieve: jest.fn(async () => response(f.paymentIntent)) }, charges: { retrieve: jest.fn(async () => response(f.charge)) },
    balanceTransactions: { retrieve: jest.fn(async () => response(f.balance)) },
  };
  const runtime = createMembershipBillingRuntime({ env, context, admin: { from, rpc } as unknown as SupabaseClient, stripe: stripe as unknown as Stripe,
    checked: async promise => promise, observeContext: async () => context, load: async () => ({ ...f.a }), productId: async () => f.product.id });
  return { f, env, runtime, stripe, rpc, operations, receipts, response, stopDuringConfigure: () => { stopDuringConfigure = true; },
    emptyInvoices: () => { emptyInvoices = true; }, unactivated: () => {
      activationReady = false; emptyInvoices = true; f.a.anchor_at = f.proof.paidAt = Math.floor(Date.now() / 1000);
      f.a.accepted_at = new Date((f.a.anchor_at - 60) * 1000).toISOString();
      const times = membershipBootstrapTimes(f.a); f.subscription.status = "trialing"; f.subscription.trial_end = times.trialEnd;
      f.subscription.cancel_at = times.cancelAt; f.subscription.default_payment_method = null; f.subscription.metadata = membershipMetadata(f.a, "subscription");
    } };
}
function delayedActivation(h: ReturnType<typeof harness>) {
  h.unactivated();
  const anchor = Math.floor(Date.now() / 1000) - 3 * 86400; h.f.a.anchor_at = h.f.proof.paidAt = anchor;
  h.f.a.accepted_at = new Date((anchor - 60) * 1000).toISOString();
  const t = membershipBootstrapTimes(h.f.a);
  Object.assign(h.f.subscription, { status: "active", trial_end: t.trialEnd, billing_cycle_anchor: t.trialEnd, cancel_at: t.cancelAt });
  Object.assign(h.f.invoice, { created: t.trialEnd, status: "draft", hosted_invoice_url: null,
    status_transitions: { finalized_at: null, paid_at: null, marked_uncollectible_at: null, voided_at: null } });
  h.f.invoice.lines.data[0].period = { start: t.trialEnd, end: t.cancelAt };
  h.stripe.invoices.list.mockImplementation(async () => h.response({ object: "list", has_more: false, data: [h.f.invoice] }));
  h.stripe.invoicePayments.list.mockImplementation(async () => h.response({ object: "list", has_more: false, data: [] }));
}
test("steps 1/8: delayed activation keeps the original captured service anchor and does not collect the held bootstrap draft", async () => {
  const h = harness(); delayedActivation(h);
  const before = JSON.stringify(h.f.invoice), anchor = h.f.a.anchor_at, accepted = h.f.a.accepted_at;
  expect(await h.runtime.activate(h.f.a.id, h.f.a.buyer_id)).toMatchObject({ status: "activated_held" });
  expect(h.f.a.anchor_at).toBe(anchor); expect(h.f.a.accepted_at).toBe(accepted); expect(JSON.stringify(h.f.invoice)).toBe(before);
  expect(h.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  expect(h.stripe.invoices.pay).not.toHaveBeenCalled(); expect(h.stripe.invoices.finalizeInvoice).not.toHaveBeenCalled();
  expect(h.stripe.invoices.update).not.toHaveBeenCalled(); expect(ledger).not.toHaveBeenCalled();
});
test("steps 1/8: an old lost activation response is completed by positive observation, not redispatch", async () => {
  const h = harness(); delayedActivation(h);
  h.stripe.subscriptions.update.mockImplementationOnce(async (_id, params) => {
    Object.assign(h.f.subscription, params); h.f.subscription.cancel_at = params.cancel_at === "" ? null : params.cancel_at;
    h.f.subscription.billing_cycle_anchor = params.trial_end; throw Error("Synthetic activation response loss");
  });
  await expect(h.runtime.activate(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("response loss");
  const op = h.operations.get("activate:initial")!; op.dispatched_at = new Date(Date.now() - 21 * 3600000).toISOString(); op.status = "review_required";
  const before = op.dispatched_at, anchor = h.f.a.anchor_at;
  expect((await h.runtime.activate(h.f.a.id, h.f.a.buyer_id)).status).toBe("activated_held");
  expect(h.stripe.subscriptions.update).toHaveBeenCalledTimes(1); expect(op.dispatched_at).toBe(before); expect(h.f.a.anchor_at).toBe(anchor);
  expect(h.rpc).toHaveBeenCalledWith("reconcile_monthly_mentorship_activation_v1", expect.objectContaining({ p_operation_id: op.id,
    p_proof: expect.objectContaining({ objectId: h.f.subscription.id, pauseBehavior: "keep_as_draft" }) }));
  expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
test("never-applied late activation enters manual review without resetting dates or sending payment work", async () => {
  const h = harness(); delayedActivation(h);
  const anchor = h.f.a.anchor_at, before = JSON.stringify(h.f.a.terms), covered = h.f.a.covered_months;
  jest.useFakeTimers().setSystemTime(new Date((anchor! + 40 * 86400) * 1000));
  expect(await h.runtime.activate(h.f.a.id, h.f.a.buyer_id)).toMatchObject({ status: "stopped",
    reason: "late_activation_review_required", billingBlocked: true, balanceWaived: false });
  expect(h.f.a.billing_review_at).toBeTruthy();
  expect(h.f.a.anchor_at).toBe(anchor); expect(h.f.a.covered_months).toBe(covered); expect(JSON.stringify(h.f.a.terms)).toBe(before);
  expect(h.stripe.subscriptions.update).not.toHaveBeenCalled(); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
  expect(h.stripe.invoices.finalizeInvoice).not.toHaveBeenCalled(); expect(ledger).not.toHaveBeenCalled();
});

test("late-activation review persistence failure remains retryable", async () => {
  const h = harness(); delayedActivation(h);
  jest.useFakeTimers().setSystemTime(new Date((h.f.a.anchor_at! + 40 * 86400) * 1000));
  h.rpc.mockResolvedValueOnce({ data: null, error: { message: "synthetic persistence failure" } });
  await expect(h.runtime.activate(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("review needs retry");
  expect(h.stripe.subscriptions.update).not.toHaveBeenCalled(); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});

test("step 8: expired service can recover an already-applied activation without extending access or catching up charges", async () => {
  const h = harness(); delayedActivation(h); await h.runtime.activate(h.f.a.id, h.f.a.buyer_id);
  const op = h.operations.get("activate:initial")!; op.status = "review_required"; const anchor = h.f.a.anchor_at;
  jest.useFakeTimers().setSystemTime(new Date((anchor! + 40 * 86400) * 1000));
  expect((await h.runtime.activate(h.f.a.id, h.f.a.buyer_id)).status).toBe("activated_held");
  expect(h.stripe.subscriptions.update).toHaveBeenCalledTimes(1); expect(h.f.a.anchor_at).toBe(anchor); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
test("step 8: activation metadata without an original operation cannot create a replacement operation", async () => {
  const h = harness(); delayedActivation(h); await h.runtime.activate(h.f.a.id, h.f.a.buyer_id); h.operations.clear();
  await expect(h.runtime.activate(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("original operation");
  expect(h.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
});
test("step 2: a stop during activation preparation prevents the provider update", async () => {
  const h = harness(); delayedActivation(h);
  h.stripe.invoicePayments.list.mockImplementation(async () => {
    h.f.a.renewal_stopped_at = new Date().toISOString(); return h.response({ object: "list", has_more: false, data: [] });
  });
  await expect(h.runtime.activate(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("stopped or changed"); expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
});
test.each(["omitted", "null"])("step 8: inert bootstrap drafts do not require undocumented Connect fields (%s)", async shape => {
  const h = harness(); delayedActivation(h);
  if (shape === "omitted") { Reflect.deleteProperty(h.f.invoice, "application_fee_amount"); Reflect.deleteProperty(h.f.invoice, "transfer_data"); }
  else Object.assign(h.f.invoice, { application_fee_amount: null, transfer_data: null });
  expect((await h.runtime.activate(h.f.a.id, h.f.a.buyer_id)).status).toBe("activated_held");
  expect(h.stripe.invoices.pay).not.toHaveBeenCalled(); expect(h.stripe.invoices.finalizeInvoice).not.toHaveBeenCalled();
});
test.each(["open", "auto_advance", "paid", "wrong_amount", "wrong_period", "foreign", "payment_link", "pagination", "missing_transition", "foreign_destination", "unexpected_fee", "transfer_amount"])(
  "step 8: suspicious preactivation invoice %s cannot authorize activation", async fault => {
    const h = harness(); delayedActivation(h);
    if (fault === "open") h.f.invoice.status = "open";
    if (fault === "auto_advance") h.f.invoice.auto_advance = true;
    if (fault === "paid") h.f.invoice.amount_paid = 1;
    if (fault === "wrong_amount") h.f.invoice.amount_due = 1;
    if (fault === "wrong_period") h.f.invoice.lines.data[0].period.start++;
    if (fault === "foreign") h.f.invoice.customer = "cus_other";
    if (fault === "payment_link") h.stripe.invoicePayments.list.mockImplementation(async () => h.response({ object: "list", has_more: false, data: [h.f.invoicePayment] }));
    if (fault === "pagination") h.stripe.invoices.list.mockImplementation(async () => h.response({ object: "list", has_more: true, data: [h.f.invoice] }));
    if (fault === "missing_transition") h.f.invoice.status_transitions = undefined as unknown as Stripe.Invoice.StatusTransitions;
    if (fault === "foreign_destination") Object.assign(h.f.invoice, { transfer_data: { destination: "acct_other" } });
    if (fault === "unexpected_fee") Object.assign(h.f.invoice, { application_fee_amount: 1 });
    if (fault === "transfer_amount") Object.assign(h.f.invoice, { transfer_data: { destination: h.f.a.terms.destinationId, amount: 1 } });
    await expect(h.runtime.activate(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow();
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled(); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
  });
test("step 10: disabled activation recovery schema prevents new activation work", async () => {
  const h = harness(); delayedActivation(h); h.env.CREATOR_MONTHLY_MENTORSHIPS_ACTIVATION_RECOVERY_SCHEMA_READY = "false";
  await expect(h.runtime.activate(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("not enabled"); expect(h.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
});
test("step 1: fresh first capture activates the exact held schedule without collecting a renewal", async () => {
  const h = harness(); h.unactivated(); expect(await h.runtime.activate(h.f.a.id, h.f.a.buyer_id)).toMatchObject({ status: "activated_held" });
  expect(h.stripe.subscriptions.update).toHaveBeenCalledWith("sub_fixture", expect.objectContaining({ default_payment_method: "pm_fixture",
    pause_collection: { behavior: "keep_as_draft" }, cancel_at: "", proration_behavior: "none" }),
    { idempotencyKey: `creatornet-membership:${operationId}`, maxNetworkRetries: 0 });
  expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
test("step 8: completed activation is retrieved rather than sent again", async () => {
  const h = harness(); h.unactivated(); await h.runtime.activate(h.f.a.id, h.f.a.buyer_id); await h.runtime.activate(h.f.a.id, h.f.a.buyer_id);
  expect(h.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
});
test("step 1: a card attached to another customer cannot activate the membership", async () => {
  const h = harness(); h.unactivated(); h.f.paymentMethod.customer = "cus_other";
  await expect(h.runtime.activate(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow(); expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
});
test("steps 1/7/8: actual journal wrapper binds, configures, finalizes and pays once before ledger/receipt admission", async () => {
  const h = harness(); expect(await h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id)).toMatchObject({ status: "recorded", month: 2 });
  expect(h.stripe.invoices.pay).toHaveBeenCalledTimes(1);
  expect(h.stripe.invoices.pay).toHaveBeenCalledWith("in_fixture", { payment_method: "pm_fixture", off_session: true, forgive: false, paid_out_of_band: false },
    { idempotencyKey: `creatornet-membership:${operationId}`, maxNetworkRetries: 0 });
  expect(ledger).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ invoiceId: "in_fixture", purchaseId: h.f.a.purchase_id,
    breakdown: h.f.a.terms.recurringMonthFees, paymentIntentId: "pi_renewal" }), true);
  expect(h.receipts.get(2)).toMatchObject({ invoiceId: "in_fixture", providerPeriodStart: h.f.period.providerStart });
});
test("step 1: early March-28 invoice cannot be charged before the agreed March-31 renewal", async () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-03-30T12:00:00Z")); const h = harness(Date.UTC(2026, 0, 31, 12) / 1000, 2);
  expect(await h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id)).toMatchObject({ status: "nothing_due" });
  expect(h.stripe.invoices.pay).not.toHaveBeenCalled(); expect(h.operations.size).toBe(0);
});
test("step 1: short-month invoice service dates are aligned without changing the amount before collection", async () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-03-31T12:01:00Z")); const h = harness(Date.UTC(2026, 0, 31, 12) / 1000, 2);
  await h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id);
  expect(h.stripe.invoices.updateLineItem).toHaveBeenCalledWith("in_fixture", "il_fixture", { period: { start: h.f.period.start, end: h.f.period.end } },
    { idempotencyKey: `creatornet-membership:${operationId}:period`, maxNetworkRetries: 0 });
  expect(h.f.invoice.total).toBe(10000); expect(h.receipts.get(3)).toMatchObject({ capturedAmountCents: 10000 });
});
test("step 8: stop during preparation prevents the final debit", async () => {
  const h = harness(); h.stopDuringConfigure(); await expect(h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("stopped or changed");
  expect(h.stripe.invoices.pay).not.toHaveBeenCalled(); expect(ledger).not.toHaveBeenCalled();
});
test.each(["fee", "destination"])("steps 1/7: wrong actual PaymentIntent %s prevents the debit despite configured invoice metadata", async field => {
  const h = harness();
  if (field === "fee") h.f.paymentIntent.application_fee_amount = 1;
  if (field === "destination") h.f.paymentIntent.transfer_data!.destination = "acct_other";
  await expect(h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow();
  expect(h.stripe.invoices.pay).not.toHaveBeenCalled(); expect(ledger).not.toHaveBeenCalled();
});
test("step 8: lost response after capture is recovered by observation without another charge", async () => {
  const h = harness(); h.stripe.invoices.pay.mockImplementationOnce(async () => { h.f.capture(); throw Error("Synthetic lost response"); });
  await expect(h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("lost response");
  expect(await h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id)).toMatchObject({ status: "recorded" });
  expect(h.stripe.invoices.pay).toHaveBeenCalledTimes(1); expect(ledger).toHaveBeenCalledTimes(1);
});
test("step 8: delayed captured observation works while new billing is disabled", async () => {
  const h = harness(); h.stripe.invoices.pay.mockImplementationOnce(async () => { h.f.capture(); throw Error("Synthetic response loss"); });
  await expect(h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow(); h.env.CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY = "false";
  expect(await h.runtime.reconcileInvoice(h.f.a.id, h.f.a.buyer_id, "in_fixture")).toMatchObject({ status: "recorded" });
  expect(h.stripe.invoices.pay).toHaveBeenCalledTimes(1);
});
test("step 8: failed or bank-action-required payment becomes review-only instead of automatic retry", async () => {
  const h = harness(); h.f.paymentIntent.status = "requires_action";
  await expect(h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("explicit recovery");
  expect(h.operations.get("collect:2")?.status).toBe("review_required"); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
test("step 8: duplicate invoice receipt observation cannot credit twice", async () => {
  const h = harness(); await h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id);
  expect(await h.runtime.reconcileInvoice(h.f.a.id, h.f.a.buyer_id, "in_fixture")).toMatchObject({ status: "already_recorded" });
  expect(ledger).toHaveBeenCalledTimes(1); expect(h.stripe.invoices.pay).toHaveBeenCalledTimes(1);
});
test("step 8: an unrelated invoice cannot be adopted as a monthly payment", async () => {
  const h = harness(); await expect(h.runtime.reconcileInvoice(h.f.a.id, h.f.a.buyer_id, "in_other")).rejects.toThrow("no owned collection");
  expect(ledger).not.toHaveBeenCalled(); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
test("step 1: an absent real invoice is not replaced by a fabricated invoice or charge", async () => {
  const h = harness(); h.emptyInvoices(); expect(await h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id)).toMatchObject({ status: "awaiting_invoice" });
  expect(h.operations.size).toBe(0); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
test("step 1: expired unpaid service is not charged through an automatic catch-up loop", async () => {
  const h = harness(Date.UTC(2025, 0, 1, 12) / 1000);
  await expect(h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("not automatic catch-up"); expect(h.operations.size).toBe(0);
});
test("steps 1/7: an active dispute leaves the captured ledger uncredited for review", async () => {
  const h = harness(); h.f.charge.disputed = true;
  await expect(h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("dispute");
  expect(h.receipts.has(2)).toBe(false); expect(ledger).toHaveBeenCalledTimes(1);
});
test("step 1: a nonrenewing paid minimum produces no further debit", async () => {
  const h = harness(); h.f.a.auto_renew = false; h.f.a.minimum_months = 1;
  expect(await h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id)).toMatchObject({ status: "nothing_due" }); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
test("step 8: out-of-window unknown unpaid operation cannot send a fresh charge", async () => {
  const h = harness(); Object.assign(h.f.invoice, membershipInvoiceConfiguration(h.f.a, h.f.proof, 2)); h.f.invoice.status = "open";
  h.operations.set("collect:2", { id: operationId, agreement_id: h.f.a.id, kind: "collect", scope_key: "2", agreement_revision: h.f.a.revision,
    request: { method: "POST", path: "/v1/invoices/in_fixture/pay", params: { payment_method: "pm_fixture", off_session: true, forgive: false, paid_out_of_band: false } },
    dispatched_at: new Date(Date.now() - 21 * 3600000).toISOString(), status: "dispatched" });
  await expect(h.runtime.collectNext(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("reconciliation"); expect(h.stripe.invoices.pay).not.toHaveBeenCalled();
});
