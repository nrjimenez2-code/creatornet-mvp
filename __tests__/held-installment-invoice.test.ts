import type Stripe from "stripe";
import {
  HELD_INSTALLMENT_VERSION,
  prepareHeldInstallmentInvoice,
  type HeldInvoiceAuthorization,
} from "../lib/installments/heldInvoice";

const authorization: HeldInvoiceAuthorization = {
  planId: "plan_test", bookingPaymentId: "booking_payment_test",
  invoiceId: "in_test", subscriptionId: "sub_test", subscriptionItemId: "si_test",
  customerId: "cus_test", destinationId: "acct_test", currency: "usd",
  totalCents: 199900, paymentCount: 3, paymentNumber: 2,
  periodStart: 1791334800, periodEnd: 1794013200, cancelAt: 1796605200,
  feeSchedule: { enabled: true, basisPoints: 360, fixedCents: 30, version: "synthetic-billing" },
};

function fixture(a = authorization) {
  const line = {
    id: "il_test", amount: 66633, currency: "usd", quantity: 1, livemode: false, invoice: a.invoiceId,
    period: { start: a.periodStart, end: a.periodEnd },
    parent: { type: "subscription_item_details", subscription_item_details: {
      proration: false, subscription: a.subscriptionId, subscription_item: a.subscriptionItemId,
    } }, discounts: [], discount_amounts: [], taxes: [], pretax_credit_amounts: [],
  };
  const subscription = {
    id: a.subscriptionId, customer: a.customerId, livemode: false, status: "active",
    metadata: { installment_collection_version: HELD_INSTALLMENT_VERSION,
      installment_plan_id: a.planId, booking_payment_id: a.bookingPaymentId },
    collection_method: "charge_automatically", application_fee_percent: null,
    pause_collection: { behavior: "keep_as_draft", resumes_at: null }, cancel_at: a.cancelAt,
    transfer_data: { destination: a.destinationId, amount_percent: null },
    items: { data: [{ id: a.subscriptionItemId, quantity: 1 }], has_more: false },
  };
  const invoice = {
    id: a.invoiceId, livemode: false, customer: a.customerId, currency: "usd",
    parent: { subscription_details: { subscription: a.subscriptionId } },
    status: "draft", auto_advance: false, next_payment_attempt: null,
    automatically_finalizes_at: null, attempted: false, attempt_count: 0,
    collection_method: "charge_automatically", billing_reason: "subscription_cycle",
    amount_due: 66633, amount_remaining: 66633, total: 66633, subtotal: 66633,
    amount_paid: 0, amount_overpaid: 0, starting_balance: 0,
    pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0,
    automatic_tax: { enabled: false }, discounts: [], total_discount_amounts: [],
    total_taxes: [], total_pretax_credit_amounts: [], lines: { data: [line] as unknown[], has_more: false },
  };
  const intent = {
    id: "pi_test", customer: a.customerId, currency: "usd", livemode: false,
    amount: 66633, amount_received: 0, latest_charge: null as string | null,
    status: "requires_payment_method", application_fee_amount: 10425,
    payment_method_types: ["card"],
    transfer_data: { destination: a.destinationId, amount: null }, client_secret: "NOT_FOR_OUTPUT",
  };
  const linked = {
    invoice: a.invoiceId, livemode: false, is_default: true, currency: "usd",
    amount_requested: 66633, amount_paid: null, status: "open",
    payment: { type: "payment_intent", payment_intent: "pi_test" },
  };
  const calls: string[] = [];
  const api = {
    subscriptions: { retrieve: jest.fn(async () => { calls.push("subscription.retrieve"); return subscription; }) },
    invoices: {
      retrieve: jest.fn(async () => { calls.push("invoice.retrieve"); return invoice; }),
      addLines: jest.fn(async (_invoice: string, params: Stripe.InvoiceAddLinesParams) => {
        calls.push("line.add");
        const extra = params.lines[0];
        invoice.total = invoice.subtotal = invoice.amount_due = invoice.amount_remaining = line.amount + extra.amount!;
        linked.amount_requested = intent.amount = invoice.total;
        invoice.lines.data.push({ ...line, ...extra, id: "il_adjustment",
          parent: { type: "invoice_item_details", invoice_item_details: { proration: false, subscription: null } },
        });
        return invoice;
      }),
      update: jest.fn(async () => { calls.push("invoice.update"); return invoice; }),
      finalizeInvoice: jest.fn(async () => { calls.push("invoice.finalize"); invoice.status = "open"; return invoice; }),
      pay: jest.fn(),
    },
    invoicePayments: { list: jest.fn(async () => ({ data: [linked], has_more: false })) },
    paymentIntents: { retrieve: jest.fn(async () => intent), confirm: jest.fn(), update: jest.fn() },
  };
  return { api, stripe: api as unknown as Stripe, subscription, invoice, line, intent, linked, calls };
}

describe("held exact-cent invoice preparation — no collection", () => {
  test("classic trial-ending invoice uses its line service period, not the prior invoice header period", async () => {
    // Observed on the isolated classic Sandbox fixture on 2026-09-06:
    // header period describes the elapsed trial, line period describes renewal.
    const a = { ...authorization, periodStart: 1788853798, periodEnd: 1791445798, cancelAt: 1794124198 };
    const f = fixture(a);
    Object.assign(f.invoice, { period_start: 1788680998, period_end: 1788853798 });
    const result = await prepareHeldInstallmentInvoice(f.stripe, a);
    expect(result.status).toBe("verified_unpaid");
    expect(result.amountCents).toBe(66633);
    expect(f.api.invoices.pay).not.toHaveBeenCalled();
  });

  test("destination-only transfer data with omitted amount is not an explicit transfer override", async () => {
    // Stripe's actual unpaid PI returned only destination, not amount:null.
    const f = fixture();
    Reflect.deleteProperty(f.intent.transfer_data, "amount");
    const result = await prepareHeldInstallmentInvoice(f.stripe, authorization);
    expect(result.applicationFeeCents).toBe(10425);
    expect(f.api.invoices.pay).not.toHaveBeenCalled();
  });

  test("sets an integer fee for a price no two-decimal percentage can express", async () => {
    const f = fixture();
    const result = await prepareHeldInstallmentInvoice(f.stripe, authorization);
    expect(f.api.invoices.update).toHaveBeenCalledWith("in_test", expect.objectContaining({
      auto_advance: false, application_fee_amount: 10425, transfer_data: { destination: "acct_test" },
    }), { idempotencyKey: "exact-cents-held-v1:plan_test:in_test:configure" });
    expect(f.calls).toEqual(["subscription.retrieve", "invoice.retrieve", "invoice.update",
      "invoice.retrieve", "subscription.retrieve", "invoice.finalize", "subscription.retrieve"]);
    expect(result).toEqual({ invoiceId: "in_test", paymentIntentId: "pi_test", amountCents: 66633,
      applicationFeeCents: 10425, destinationId: "acct_test", status: "verified_unpaid" });
    expect(f.api.invoices.pay).not.toHaveBeenCalled();
    expect(f.api.paymentIntents.confirm).not.toHaveBeenCalled();
    expect(f.api.paymentIntents.update).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("NOT_FOR_OUTPUT");
  });

  test("only the final installment receives the immutable residual cent", async () => {
    const a = { ...authorization, paymentNumber: 3 };
    const f = fixture(a);
    const result = await prepareHeldInstallmentInvoice(f.stripe, a);
    expect(f.api.invoices.addLines).toHaveBeenCalledWith("in_test", { lines: [expect.objectContaining({ amount: 1,
      metadata: { installment_adjustment: "final-cent-v1", installment_plan_id: "plan_test", booking_payment_id: "booking_payment_test" },
    })] },
      { idempotencyKey: "exact-cents-held-v1:plan_test:in_test:final-cent" });
    expect(result.amountCents).toBe(66634);
    expect(result.applicationFeeCents).toBe(10425);
  });

  test("replaying an open invoice only verifies it; it does not write/finalize/pay again", async () => {
    const f = fixture();
    f.invoice.status = "open";
    await prepareHeldInstallmentInvoice(f.stripe, authorization);
    expect(f.api.invoices.update).not.toHaveBeenCalled();
    expect(f.api.invoices.finalizeInvoice).not.toHaveBeenCalled();
    expect(f.api.invoices.pay).not.toHaveBeenCalled();
  });

  test("replaying the final invoice cannot add a second cent", async () => {
    const a = { ...authorization, paymentNumber: 3 };
    const f = fixture(a);
    const first = await prepareHeldInstallmentInvoice(f.stripe, a);
    // Stripe returned the adjustment first, not the subscription line first.
    f.invoice.lines.data.reverse();
    const replay = await prepareHeldInstallmentInvoice(f.stripe, a);
    expect(replay).toEqual(first);
    expect(f.invoice.amount_due).toBe(66634);
    expect(f.api.invoices.addLines).toHaveBeenCalledTimes(1);
    expect(f.api.invoices.finalizeInvoice).toHaveBeenCalledTimes(1);
    expect(f.api.invoices.pay).not.toHaveBeenCalled();
  });

  test("retry after adding the cent but failing fee configuration reuses the existing line", async () => {
    const a = { ...authorization, paymentNumber: 3 };
    const f = fixture(a);
    f.api.invoices.update.mockRejectedValueOnce(new Error("temporary configuration failure"));
    await expect(prepareHeldInstallmentInvoice(f.stripe, a)).rejects.toThrow("temporary configuration failure");
    expect(f.invoice.status).toBe("draft");
    expect(f.invoice.auto_advance).toBe(false);
    expect(f.api.invoices.finalizeInvoice).not.toHaveBeenCalled();
    await prepareHeldInstallmentInvoice(f.stripe, a);
    expect(f.api.invoices.addLines).toHaveBeenCalledTimes(1);
    expect(f.invoice.amount_due).toBe(66634);
  });

  test.each([
    ["unrecognized marker", (line: Stripe.InvoiceLineItem) => { line.metadata.installment_adjustment = "other"; }],
    ["different plan", (line) => { line.metadata.installment_plan_id = "plan_other"; }],
    ["different booking payment", (line) => { line.metadata.booking_payment_id = "bp_other"; }],
    ["discountable adjustment", (line) => { line.discountable = true; }],
    ["wrong residual", (line) => { line.amount = 2; }],
    ["wrong period", (line) => { line.period.end += 1; }],
    ["other subscription", (line) => { line.parent!.invoice_item_details!.subscription = "sub_other"; }],
  ] satisfies Array<[string, (line: Stripe.InvoiceLineItem) => void]>)
  ("does not accept a final adjustment with %s", async (_name, mutate) => {
    const a = { ...authorization, paymentNumber: 3 };
    const f = fixture(a);
    await prepareHeldInstallmentInvoice(f.stripe, a);
    mutate(f.invoice.lines.data[1] as Stripe.InvoiceLineItem);
    await expect(prepareHeldInstallmentInvoice(f.stripe, a)).rejects.toThrow();
    expect(f.api.invoices.addLines).toHaveBeenCalledTimes(1);
    expect(f.api.invoices.finalizeInvoice).toHaveBeenCalledTimes(1);
    expect(f.api.invoices.pay).not.toHaveBeenCalled();
  });

  test("duplicate final adjustment lines stop processing", async () => {
    const a = { ...authorization, paymentNumber: 3 };
    const f = fixture(a);
    await prepareHeldInstallmentInvoice(f.stripe, a);
    f.invoice.lines.data.push(f.invoice.lines.data[1]);
    await expect(prepareHeldInstallmentInvoice(f.stripe, a)).rejects.toThrow("unexpected invoice lines");
    expect(f.api.invoices.addLines).toHaveBeenCalledTimes(1);
    expect(f.api.invoices.pay).not.toHaveBeenCalled();
  });

  test.each([
    ["production subscription", (f: ReturnType<typeof fixture>) => { f.subscription.livemode = true; }],
    ["wrong customer", (f) => { f.subscription.customer = "cus_other"; }],
    ["legacy subscription", (f) => { f.subscription.metadata.installment_collection_version = "exact-percent-v1"; }],
    ["wrong plan", (f) => { f.subscription.metadata.installment_plan_id = "plan_other"; }],
    ["missing collection hold", (f) => { f.subscription.pause_collection.behavior = "void"; }],
    ["scheduled resumption", (f) => { Object.assign(f.subscription.pause_collection, { resumes_at: 1900000000 }); }],
    ["canceled subscription", (f) => { f.subscription.status = "canceled"; }],
    ["changed fixed end", (f) => { f.subscription.cancel_at += 1; }],
    ["percentage configured", (f) => { Object.assign(f.subscription, { application_fee_percent: 15.65 }); }],
    ["wrong destination", (f) => { f.subscription.transfer_data.destination = "acct_other"; }],
    ["different quantity", (f) => { f.subscription.items.data[0].quantity = 2; }],
    ["production invoice", (f) => { f.invoice.livemode = true; }],
    ["invoice from other subscription", (f) => { f.invoice.parent.subscription_details.subscription = "sub_other"; }],
    ["automatic advancement", (f) => { f.invoice.auto_advance = true; }],
    ["scheduled finalization", (f) => { Object.assign(f.invoice, { automatically_finalizes_at: 1900000000 }); }],
    ["prior attempt", (f) => { f.invoice.attempted = true; }],
    ["nonzero attempt counter", (f) => { f.invoice.attempt_count = 1; }],
    ["payment already made", (f) => { f.invoice.amount_paid = 1; }],
    ["bootstrap trial invoice", (f) => { f.invoice.billing_reason = "subscription_create"; }],
    ["credit balance", (f) => { f.invoice.starting_balance = -1; }],
    ["unexpected total", (f) => { f.invoice.amount_due = 66634; }],
    ["automatic taxes", (f) => { f.invoice.automatic_tax.enabled = true; }],
    ["incomplete lines", (f) => { f.invoice.lines.has_more = true; }],
    ["proration", (f) => { f.line.parent.subscription_item_details.proration = true; }],
    ["wrong period", (f) => { f.line.period.start += 1; }],
  ] satisfies Array<[string, (f: ReturnType<typeof fixture>) => void]>)
  ("rejects %s before any financial-object write", async (_name, mutate) => {
    const f = fixture();
    mutate(f);
    await expect(prepareHeldInstallmentInvoice(f.stripe, authorization)).rejects.toThrow();
    expect(f.api.invoices.update).not.toHaveBeenCalled();
    expect(f.api.invoices.addLines).not.toHaveBeenCalled();
    expect(f.api.invoices.finalizeInvoice).not.toHaveBeenCalled();
  });

  test.each([
    ["wrong actual fee", (f: ReturnType<typeof fixture>) => { f.intent.application_fee_amount = 10428; }],
    ["wrong actual destination", (f) => { f.intent.transfer_data.destination = "acct_other"; }],
    ["prior charge attempt", (f) => { f.intent.latest_charge = "ch_previous"; }],
    ["already paid", (f) => { f.intent.amount_received = 66633; }],
    ["live payment", (f) => { f.intent.livemode = true; }],
    ["other customer payment", (f) => { f.intent.customer = "cus_other"; }],
    ["unexpected authentication state", (f) => { f.intent.status = "requires_action"; }],
    ["unapproved payment method", (f) => { f.intent.payment_method_types.push("klarna"); }],
    ["nondefault invoice payment", (f) => { f.linked.is_default = false; }],
  ] satisfies Array<[string, (f: ReturnType<typeof fixture>) => void]>)
  ("does not record a verified result for %s", async (_name, mutate) => {
    const f = fixture();
    mutate(f);
    await expect(prepareHeldInstallmentInvoice(f.stripe, authorization)).rejects.toThrow();
    expect(f.api.invoices.pay).not.toHaveBeenCalled();
  });

  test("configuration failure does not finalize or fall back to automatic payment", async () => {
    const f = fixture();
    f.api.invoices.update.mockRejectedValueOnce(new Error("simulated API failure"));
    await expect(prepareHeldInstallmentInvoice(f.stripe, authorization)).rejects.toThrow("simulated API failure");
    expect(f.api.invoices.finalizeInvoice).not.toHaveBeenCalled();
    expect(f.api.invoices.pay).not.toHaveBeenCalled();
    expect(f.invoice.auto_advance).toBe(false);
  });

  test("hold removed during configuration prevents finalization", async () => {
    const f = fixture();
    f.api.invoices.update.mockImplementationOnce(async () => {
      f.subscription.pause_collection.behavior = "void";
      return f.invoice;
    });
    await expect(prepareHeldInstallmentInvoice(f.stripe, authorization)).rejects.toThrow("held indefinitely");
    expect(f.api.invoices.finalizeInvoice).not.toHaveBeenCalled();
  });

  test("finalized result with automatic collection enabled is rejected", async () => {
    const f = fixture();
    f.api.invoices.finalizeInvoice.mockImplementationOnce(async () => {
      f.invoice.auto_advance = true;
      f.invoice.status = "open";
      return f.invoice;
    });
    await expect(prepareHeldInstallmentInvoice(f.stripe, authorization)).rejects.toThrow("advance automatically");
  });

  test.each([1, 0, 4, 2.5])("does not prepare unauthorized installment %s", async (paymentNumber) => {
    const f = fixture();
    await expect(prepareHeldInstallmentInvoice(f.stripe, { ...authorization, paymentNumber })).rejects.toThrow();
    expect(f.api.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  test("no mutable caller data can change the agreement mid-flight", async () => {
    const a = { ...authorization, feeSchedule: { ...authorization.feeSchedule } };
    const f = fixture(a);
    f.api.subscriptions.retrieve.mockImplementationOnce(async () => {
      a.destinationId = "acct_injected";
      a.feeSchedule.fixedCents = 9000;
      return f.subscription;
    });
    const result = await prepareHeldInstallmentInvoice(f.stripe, a);
    expect(result.destinationId).toBe("acct_test");
    expect(result.applicationFeeCents).toBe(10425);
  });
});
