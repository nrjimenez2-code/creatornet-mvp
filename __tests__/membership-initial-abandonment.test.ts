import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMembershipInitialAbandonment } from "@/lib/membershipInitialAbandonment";
import { checkoutRecoveryFixture } from "../test-support/membership-checkout-recovery-fixtures";
import { membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
function harness() {
  const f = checkoutRecoveryFixture(), env = { ...membershipTestEnv };
  let ops = f.ops, saveFailure = false, requestFailure = false;
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  const response = <T extends object>(v: T) => Object.assign(clone(v), { lastResponse: { requestId: "req_initial", apiVersion: context.apiVersion } });
  const invoice = { id: "in_initial", object: "invoice", livemode: false, customer: f.ids.customer,
    parent: { type: "subscription_details", subscription_details: { subscription: f.ids.subscription } },
    currency: "usd", amount_paid: 0, total: 0, status: "draft", auto_advance: true, hosted_invoice_url: null } as unknown as Stripe.Invoice;
  const state = { invoices: [invoice], intents: [] as Stripe.PaymentIntent[], charges: [] as Stripe.Charge[], pending: [] as Stripe.InvoiceItem[] };
  type Closure = { id: string; agreement_id: string; kind: string; resource_id: string; request: unknown; status: string };
  const closures: Closure[] = [];
  const rpc = jest.fn(async (name: string, p: Record<string, unknown>) => {
    if (name === "request_monthly_initial_abandonment_v1") {
      if (requestFailure) return { error: Error("private detail"), data: null };
      f.a.initial_abandon_requested_at ||= new Date().toISOString(); f.a.renewal_stopped_at ||= f.a.initial_abandon_requested_at;
      return { error: null, data: { membershipId: f.a.id, requested: true, abandoned: false } };
    }
    if (name === "claim_monthly_initial_closure_v1") {
      const proof = p.p_proof as { objectId: string }, kind = p.p_kind as string;
      let op = closures.find(o => o.kind === kind && o.resource_id === proof.objectId);
      if (!op) {
        const request = kind === "expire_checkout" ? { method: "POST", path: "/v1/checkout/sessions/" + proof.objectId + "/expire", params: {} } :
          kind === "cancel_subscription" ? { method: "DELETE", path: "/v1/subscriptions/" + proof.objectId, params: { invoice_now: false, prorate: false } } :
            { method: "POST", path: "/v1/invoices/" + proof.objectId + (kind === "void_invoice" ? "/void" : ""), params: kind === "void_invoice" ? {} : { auto_advance: false } };
        op = { id: "28000000-0000-4000-8000-00000000000" + (closures.length + 1), agreement_id: f.a.id, kind,
          resource_id: proof.objectId, request, status: "pending" }; closures.push(op);
      }
      return { error: null, data: clone(op) };
    }
    if (name === "complete_monthly_initial_closure_v1") {
      closures.find(o => o.id === p.p_operation_id)!.status = "complete"; return { error: null, data: true };
    }
    if (name === "complete_monthly_initial_abandonment_v1") {
      if (saveFailure) return { error: Error("private detail"), data: null };
      f.a.initial_abandoned_at = new Date().toISOString(); f.a.initial_abandon_proof = clone(p.p_proof); return { error: null, data: true };
    }
    throw Error("Unexpected RPC " + name);
  });
  const from = jest.fn((table: string) => {
    const q = { select: () => q, eq: () => q, limit: async () => ({ data: clone(table === "monthly_mentorship_operations_v1" ? ops : closures), error: null }) };
    return q;
  });
  const stripe = {
    checkout: { sessions: {
      retrieve: jest.fn(async () => response(f.session)), list: jest.fn(async () => response({ data: [f.session], has_more: false })),
      expire: jest.fn(async () => { f.session.status = "expired"; f.session.url = null; return response(f.session); }), create: jest.fn(),
    } },
    subscriptions: { retrieve: jest.fn(async () => response(f.subscription)), list: jest.fn(async () => response({ data: [f.subscription], has_more: false })),
      cancel: jest.fn(async () => { f.subscription.status = "canceled"; return response(f.subscription); }), create: jest.fn(), update: jest.fn() },
    invoices: { list: jest.fn(async () => response({ data: state.invoices, has_more: false })), retrieve: jest.fn(async () => response(invoice)),
      update: jest.fn(async () => { invoice.auto_advance = false; return response(invoice); }),
      voidInvoice: jest.fn(async () => { invoice.status = "void"; return response(invoice); }), finalizeInvoice: jest.fn(), del: jest.fn(), pay: jest.fn(), create: jest.fn() },
    paymentIntents: { list: jest.fn(async () => response({ data: state.intents, has_more: false })), cancel: jest.fn(), create: jest.fn() },
    charges: { list: jest.fn(async () => response({ data: state.charges, has_more: false })) },
    invoiceItems: { list: jest.fn(async () => response({ data: state.pending, has_more: false })) },
    refunds: { create: jest.fn() },
  };
  const reconcileFirstCheckout = jest.fn(async () => ({ ...f.projection, status: "paid" as const, canResume: false, firstPaymentRecorded: true, accessGranted: true }));
  const observeContext = jest.fn(async () => context), load = jest.fn(async () => clone(f.a));
  const runtime = createMembershipInitialAbandonment({ admin: { rpc, from } as unknown as SupabaseClient, stripe: stripe as unknown as Stripe,
    env, context, load, observeContext, checked: async <T,>(v: Promise<Stripe.Response<T>>) => v, productId: async () => f.product.id }, { reconcileFirstCheckout });
  return { f, env, invoice, state, closures, rpc, stripe, runtime, reconcileFirstCheckout, load, response, observeContext,
    run: () => runtime.abandonFirstCheckout(f.a.id, f.a.buyer_id, true), setOps: (rows: typeof ops) => { ops = rows; },
    failSave: (value: boolean) => { saveFailure = value; }, failRequest: () => { requestFailure = true; } };
}
function noMoneyCreation(h: ReturnType<typeof harness>) {
  for (const fn of [h.stripe.checkout.sessions.create, h.stripe.subscriptions.create, h.stripe.subscriptions.update,
    h.stripe.invoices.finalizeInvoice, h.stripe.invoices.del, h.stripe.invoices.pay, h.stripe.invoices.create,
    h.stripe.paymentIntents.cancel, h.stripe.paymentIntents.create, h.stripe.refunds.create]) expect(fn).not.toHaveBeenCalled();
}
test("steps 1/4/5/8: closes only unpaid original resources and holds subscription drafts without finalizing or deleting them", async () => {
  const h = harness(), terms = JSON.stringify(h.f.a.terms), accepted = h.f.a.accepted_at;
  expect(await h.run()).toMatchObject({ status: "abandoned", canAbandon: false, canResume: false, firstPaymentRecorded: false, accessGranted: false });
  expect(h.stripe.checkout.sessions.expire).toHaveBeenCalledWith(h.f.ids.checkout, {}, expect.objectContaining({ maxNetworkRetries: 0 }));
  expect(h.stripe.subscriptions.cancel).toHaveBeenCalledWith(h.f.ids.subscription, { invoice_now: false, prorate: false }, expect.anything());
  expect(h.stripe.invoices.update).toHaveBeenCalledWith("in_initial", { auto_advance: false }, expect.anything());
  expect(h.stripe.checkout.sessions.expire.mock.invocationCallOrder[0]).toBeLessThan(h.stripe.subscriptions.cancel.mock.invocationCallOrder[0]);
  expect(h.rpc).toHaveBeenCalledWith("complete_monthly_initial_abandonment_v1", expect.objectContaining({ p_buyer_id: h.f.a.buyer_id,
    p_proof: expect.objectContaining({ customerId: h.f.ids.customer, readRequestIds: Array(6).fill("req_initial"),
      invoices: [expect.objectContaining({ status: "draft", autoAdvance: false, hostedInvoiceUrlNull: true })] }) }));
  expect(JSON.stringify(h.f.a.terms)).toBe(terms); expect(h.f.a.accepted_at).toBe(accepted); noMoneyCreation(h);
});
test("step 8: finalized unpaid invoices are voided, never paid or finalized as part of close-out", async () => {
  const h = harness(); h.invoice.status = "open";
  expect((await h.run()).status).toBe("abandoned"); expect(h.stripe.invoices.voidInvoice).toHaveBeenCalledWith("in_initial", {}, expect.anything());
  expect(h.stripe.invoices.update).not.toHaveBeenCalled(); noMoneyCreation(h);
});
test("step 8: failed final persistence retries only original stop identities and preserves accepted intent", async () => {
  const h = harness(); h.failSave(true); expect((await h.run()).status).toBe("abandon_pending");
  const before = h.closures.map(o => o.id), requested = h.f.a.initial_abandon_requested_at;
  h.failSave(false); expect((await h.run()).status).toBe("abandoned"); expect(h.closures.map(o => o.id)).toEqual(before);
  expect(h.f.a.initial_abandon_requested_at).toBe(requested); expect(h.stripe.checkout.sessions.expire).toHaveBeenCalledTimes(1);
  expect(h.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1); expect(h.stripe.invoices.update).toHaveBeenCalledTimes(1); noMoneyCreation(h);
});
test("step 8: a replay of an already closed attempt creates no new provider work", async () => {
  const h = harness(); await h.run(); const calls = h.rpc.mock.calls.length; await h.run();
  expect(h.rpc).toHaveBeenCalledTimes(calls); expect(h.stripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(1);
});
test("steps 4/5: separate explicit close-out consent is mandatory", async () => {
  const h = harness(); await expect(h.runtime.abandonFirstCheckout(h.f.a.id, h.f.a.buyer_id, false)).rejects.toThrow("Explicit");
  expect(h.load).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
});
test.each(["INITIAL_ABANDONMENT_SCHEMA_READY", "INITIAL_ABANDONMENT_READY"])("step 10: missing %s blocks close-out", async flag => {
  const h = harness(); h.env["CREATOR_MONTHLY_MENTORSHIPS_" + flag] = "false";
  await expect(h.run()).rejects.toThrow("not enabled"); expect(h.load).not.toHaveBeenCalled();
});
test("step 8: database-proven never-payable attempts need no provider mutations", async () => {
  const h = harness(); h.setOps(h.f.ops.slice(0, 2));
  expect((await h.run()).status).toBe("abandoned");
  expect(h.rpc).toHaveBeenCalledWith("complete_monthly_initial_abandonment_v1", expect.objectContaining({ p_proof: expect.objectContaining({ neverPayable: true }) }));
  expect(h.stripe.checkout.sessions.expire).not.toHaveBeenCalled(); expect(h.stripe.subscriptions.cancel).not.toHaveBeenCalled(); noMoneyCreation(h);
});
test.each(["recorded", "captured", "racing_save"])("step 8: %s payment goes through existing receipt recovery instead of abandonment", async state => {
  const h = harness();
  if (state === "recorded") h.f.a.covered_months = 1;
  if (state === "captured") { h.f.session.status = "complete"; h.f.session.payment_status = "paid"; }
  if (state === "racing_save") h.failRequest();
  expect((await h.run()).status).toBe("paid"); expect(h.reconcileFirstCheckout).toHaveBeenCalledWith(h.f.a.id, h.f.a.buyer_id);
  expect(h.stripe.checkout.sessions.expire).not.toHaveBeenCalled(); expect(h.stripe.subscriptions.cancel).not.toHaveBeenCalled(); noMoneyCreation(h);
});
test.each(["processing", "captured_intent", "charge", "pending_invoice_item", "pagination", "payable_invoice", "foreign_invoice", "recovered_checkout"])(
  "step 8: %s cannot release a reservation or invent a refund", async fault => {
    const h = harness();
    if (fault === "processing" || fault === "captured_intent") h.state.intents.push({ id: "pi_initial", livemode: false, customer: h.f.ids.customer,
      status: fault === "processing" ? "processing" : "canceled", amount_received: fault === "captured_intent" ? 10000 : 0, amount_capturable: 0 } as Stripe.PaymentIntent);
    if (fault === "charge") h.state.charges.push({ id: "ch_initial", livemode: false, customer: h.f.ids.customer, paid: true, amount_captured: 10000 } as Stripe.Charge);
    if (fault === "pending_invoice_item") h.state.pending.push({ id: "ii_initial" } as Stripe.InvoiceItem);
    if (fault === "pagination") h.stripe.charges.list.mockImplementation(async () => h.response({ data: [], has_more: true }));
    if (fault === "payable_invoice") h.invoice.hosted_invoice_url = "https://invoice.stripe.com/i/pending";
    if (fault === "foreign_invoice") h.invoice.customer = "cus_other";
    if (fault === "recovered_checkout") h.f.session.recovered_from = "cs_test_other";
    expect((await h.run()).status).toBe("abandon_pending");
    expect(h.rpc.mock.calls.some(([name]) => name === "complete_monthly_initial_abandonment_v1")).toBe(false); noMoneyCreation(h);
  });
test("step 8: ambiguous unknown original subscription cannot authorize cancellation of a guessed resource", async () => {
  const h = harness(); h.f.ops.find(o => o.kind === "subscription")!.provider_id = null;
  h.stripe.subscriptions.list.mockImplementation(async () => h.response({ data: [], has_more: false }));
  expect((await h.run()).status).toBe("abandon_pending"); expect(h.stripe.subscriptions.cancel).not.toHaveBeenCalled();
});

async function closedBootstrap() {
  const h = harness();
  // Native failure shape: subscription creation returned 200 before the operation
  // completed or any provider bindings/Checkout Session were published.
  const ops = h.f.ops.filter(o => ["customer", "product", "subscription"].includes(o.kind));
  const subscription = ops.find(o => o.kind === "subscription")!;
  subscription.status = "dispatched"; subscription.provider_id = null; h.setOps(ops);
  h.stripe.checkout.sessions.list.mockImplementation(async () => h.response({ data: [], has_more: false }));
  h.invoice.status = "paid"; h.invoice.auto_advance = false;
  h.invoice.hosted_invoice_url = "https://invoice.stripe.com/i/synthetic-zero";
  expect((await h.run()).status).toBe("abandoned");
  const event = { id: "evt_closed", type: "customer.subscription.deleted", livemode: false,
    api_version: context.apiVersion, data: { object: h.response(h.f.subscription) } } as unknown as Stripe.Event;
  jest.clearAllMocks();
  return { ...h, event, reconcile: () => h.runtime.reconcileAbandonedCheckoutEvent(h.f.a.id, h.f.a.buyer_id, event) };
}

function noClosedEventWrites(h: Awaited<ReturnType<typeof closedBootstrap>>) {
  noMoneyCreation(h); expect(h.rpc).not.toHaveBeenCalled(); expect(h.reconcileFirstCheckout).not.toHaveBeenCalled();
  for (const fn of [h.stripe.subscriptions.cancel, h.stripe.checkout.sessions.expire, h.stripe.invoices.update, h.stripe.invoices.voidInvoice])
    expect(fn).not.toHaveBeenCalled();
  expect(h.f.a).toMatchObject({ covered_months: 0, anchor_at: null, stripe_customer_id: null, stripe_subscription_id: null, stripe_checkout_session_id: null });
}

test.each(["customer.subscription.created", "customer.subscription.trial_will_end", "customer.subscription.deleted", "invoice.created", "invoice.payment_succeeded", "invoice.paid"])(
  "closed pre-binding bootstrap safely acknowledges %s using fresh proof without payment/access writes", async type => {
    const h = await closedBootstrap(); h.event.type = type as Stripe.Event.Type;
    if (type.startsWith("invoice.")) h.event.data.object = h.response(h.invoice);
    else if (type !== "customer.subscription.deleted") (h.event.data.object as Stripe.Subscription).status = "trialing";
    const before = JSON.stringify(h.f.a);
    expect(await h.reconcile()).toEqual({ status: "abandoned", membershipId: h.f.a.id });
    expect(await h.reconcile()).toEqual({ status: "abandoned", membershipId: h.f.a.id });
    expect(JSON.stringify(h.f.a)).toBe(before); expect(h.stripe.charges.list).toHaveBeenCalledTimes(2); noClosedEventWrites(h);
  });

test.each(["not_closed", "covered_month", "anchor", "proof_missing", "proof_incomplete", "proof_context", "proof_provenance", "customer", "subscription", "fingerprint", "mode", "account", "api_version", "operation", "closure_pending", "active_subscription", "capture", "pagination", "extra_invoice", "payable_invoice", "pending_item", "paid_event", "unknown_invoice", "payment_event", "flag"])(
  "closed bootstrap %s mismatch cannot be acknowledged or invent a binding", async fault => {
    const h = await closedBootstrap(), saved = h.f.a.initial_abandon_proof as Record<string, unknown>;
    if (fault === "not_closed") h.f.a.initial_abandoned_at = null;
    if (fault === "covered_month") h.f.a.covered_months = 1;
    if (fault === "anchor") h.f.a.anchor_at = 1;
    if (fault === "proof_missing") h.f.a.initial_abandon_proof = null;
    if (fault === "proof_incomplete") saved.listsComplete = false;
    if (fault === "proof_context") saved.paymentContext = { ...context, mode: "live" };
    if (fault === "proof_provenance") saved.readRequestIds = [];
    if (fault === "customer") (h.event.data.object as Stripe.Subscription).customer = "cus_other";
    if (fault === "subscription") (h.event.data.object as Stripe.Subscription).id = "sub_other";
    if (fault === "fingerprint") (h.event.data.object as Stripe.Subscription).metadata.creatornet_membership_fingerprint = "different";
    if (fault === "mode") h.event.livemode = true;
    if (fault === "account") h.event.account = "acct_other";
    if (fault === "api_version") h.event.api_version = "2025-11-17.clover";
    if (fault === "operation") h.f.ops.find(o => o.kind === "customer")!.provider_id = "cus_other";
    if (fault === "closure_pending") h.closures.find(o => o.kind === "cancel_subscription")!.status = "pending";
    if (fault === "active_subscription") h.f.subscription.status = "active";
    if (fault === "capture") h.state.charges.push({ id: "ch_late", livemode: false, customer: h.f.ids.customer, paid: true, amount_captured: 10000 } as Stripe.Charge);
    if (fault === "pagination") h.stripe.charges.list.mockImplementation(async () => h.response({ data: [], has_more: true }));
    if (fault === "extra_invoice") h.state.invoices.push({ ...h.invoice, id: "in_added" });
    if (fault === "payable_invoice") { h.invoice.status = "open"; h.invoice.total = 10000; }
    if (fault === "pending_item") h.state.pending.push({ id: "ii_pending" } as Stripe.InvoiceItem);
    if (fault === "paid_event" || fault === "unknown_invoice") {
      h.event.type = "invoice.payment_succeeded";
      h.event.data.object = { ...h.invoice, ...(fault === "paid_event" ? { amount_paid: 10000 } : { id: "in_unknown" }) };
    }
    if (fault === "payment_event") { h.event.type = "payment_intent.succeeded"; h.event.data.object = h.f.paymentIntent; }
    if (fault === "flag") h.env.CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY = "false";
    await expect(h.reconcile()).rejects.toThrow(); expect(h.rpc).not.toHaveBeenCalled(); noMoneyCreation(h);
    expect(h.stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });
