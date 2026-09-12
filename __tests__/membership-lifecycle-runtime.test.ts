import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMembershipLifecycleRuntime, membershipLifecycleReady } from "@/lib/membershipLifecycle";
import type { MembershipBillingDependencies } from "@/lib/membershipBillingRuntime";
import { membershipBootstrapTimes, membershipMetadata } from "@/lib/membershipCheckout";
import { membershipMonthBoundary } from "@/lib/membershipAgreement";
import { membershipActivationParams } from "@/lib/membershipRenewal";
import { membershipFixture, membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
import { membershipRenewalFixture } from "../test-support/membership-renewal-fixtures";
import { membershipPayoffFixture } from "../test-support/membership-payoff-fixtures";
// Provider and DB boundaries are synthetic. Actual SQL 085 is exercised in the database suite.
function harness() {
  const f = membershipRenewalFixture(), env = { ...membershipTestEnv };
  let admission: unknown = null, payoff: unknown = null, savedOutcome = "", rpcFailure = "";
  let containmentStatus = "dispatched", dispatchedAt = new Date().toISOString();
  const order: string[] = [], observations: Record<string, unknown>[] = [];
  const response = <T,>(r: T) => ({ ...r, lastResponse: { requestId: "req_lifecycle", apiVersion: context.apiVersion, headers: {}, statusCode: 200 } });
  const rpc = jest.fn(async (name: string, p: Record<string, unknown>) => {
    order.push(name);
    if (name === rpcFailure) return { error: Error("synthetic DB unavailable"), data: null };
    if (name === "record_monthly_mentorship_lifecycle_v1") {
      observations.push(p);
      if (!savedOutcome || !["review_required", "provider_stopped"].includes(savedOutcome)) savedOutcome = p.p_outcome as string;
      return { error: null, data: { agreement_id: f.a.id, event_id: p.p_event_id, outcome: savedOutcome } };
    }
    if (name === "claim_monthly_mentorship_containment_v1") return { error: null, data: {
      id: "21000000-0000-4000-8000-000000000001", agreement_id: f.a.id, event_id: p.p_event_id, resource_id: p.p_resource_id,
      request: p.p_request, dispatched_at: dispatchedAt, status: containmentStatus } };
    return { error: null, data: true };
  });
  const from = jest.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const q: { select: jest.Mock; eq: jest.Mock; maybeSingle: jest.Mock } = { select: jest.fn(() => q), eq: jest.fn((key: string, value: unknown) => { filters[key] = value; return q; }), maybeSingle: jest.fn(async () => ({ error: null,
      data: table === "monthly_mentorship_receipts_v1" ? { provider_proof: f.proof } :
        table === "monthly_mentorship_operations_v1" && filters.kind === "activate" ? {
          id: "21000000-0000-4000-8000-000000000007", status: "complete", provider_id: f.subscription.id } :
        table === "monthly_mentorship_payoffs_v1" ? payoff : admission })) };
    return q;
  });
  const stripe = {
    subscriptions: { retrieve: jest.fn(async () => response(f.subscription)), update: jest.fn(async (_id, params) => {
      order.push("provider-subscription-hold"); f.subscription.pause_collection = params.pause_collection; return response(f.subscription); }) },
    invoices: { retrieve: jest.fn(async () => response(f.invoice)), update: jest.fn(async (_id, params) => {
      order.push("provider-invoice-hold"); f.invoice.auto_advance = params.auto_advance; return response(f.invoice); }) },
    checkout: { sessions: { retrieve: jest.fn(async () => response(f.session)) } },
    invoicePayments: { list: jest.fn(async () => response({ object: "list", has_more: false, data: [] as Stripe.InvoicePayment[] })) },
  };
  const callbacks = { confirmFirst: jest.fn(async () => ({ firstPaymentRecorded: true })),
    confirmPayoff: jest.fn(async () => ({ payoffRecorded: true })), reconcileInvoice: jest.fn(async () => ({ status: "recorded", month: 2 })) };
  const observe = jest.fn(async () => context), load = jest.fn(async () => f.a);
  const d: MembershipBillingDependencies = { admin: { rpc, from } as unknown as SupabaseClient, stripe: stripe as unknown as Stripe,
    context, env, checked: async p => p, observeContext: observe, load, productId: async () => f.product.id };
  const runtime = createMembershipLifecycleRuntime(d, callbacks);
  const event = { id: "evt_lifecycle", type: "invoice.created", api_version: context.apiVersion, livemode: false,
    data: { object: f.invoice } } as Stripe.Event;
  const run = (id: string | null = null) => runtime.reconcileLifecycle(f.a.id, f.a.buyer_id, event, id);
  return { f, env, rpc, from, stripe, callbacks, observe, load, event, run, order, observations,
    setAdmission: (value: unknown) => { admission = value; }, setPayoff: (value: unknown) => { payoff = value; },
    failRpc: (name: string) => { rpcFailure = name; },
    oldContainment: () => { containmentStatus = "review_required"; dispatchedAt = new Date(Date.now() - 21 * 3600000).toISOString(); },
    priorReview: () => { savedOutcome = "review_required"; } };
}
function subEvent(h: ReturnType<typeof harness>, type: Stripe.Event.Type = "customer.subscription.updated") {
  h.event.type = type; h.event.data.object = h.f.subscription;
}
function delayedBootstrap(h: ReturnType<typeof harness>, paid = true) {
  const anchor = Math.floor(Date.now() / 1000) - 3 * 86400;
  h.f.a.accepted_at = new Date((anchor - 60) * 1000).toISOString(); h.f.a.anchor_at = paid ? anchor : null; h.f.a.covered_months = paid ? 1 : 0;
  h.f.proof.paidAt = anchor;
  const t = membershipBootstrapTimes(h.f.a);
  Object.assign(h.f.subscription, { status: "active", trial_end: t.trialEnd, billing_cycle_anchor: t.trialEnd, cancel_at: t.cancelAt,
    default_payment_method: null, metadata: membershipMetadata(h.f.a, "subscription") });
  Object.assign(h.f.invoice, { created: t.trialEnd, status: "draft", hosted_invoice_url: null,
    status_transitions: { finalized_at: null, paid_at: null, marked_uncollectible_at: null, voided_at: null } });
  h.f.invoice.lines.data[0].period = { start: t.trialEnd, end: t.cancelAt };
}
test.each([true, false])("step 8: a healthy held bootstrap cycle with first payment recorded=%p does not create a billing review", async paid => {
  const h = harness(); delayedBootstrap(h, paid); await h.run();
  expect(h.observations[0].p_outcome).toBe("observed"); expect(h.stripe.invoices.update).not.toHaveBeenCalled();
  expect(h.callbacks.reconcileInvoice).not.toHaveBeenCalled();
});
test("step 8: a healthy collection-paused subscription after its bootstrap trial is not treated as a failure", async () => {
  const h = harness(); delayedBootstrap(h); subEvent(h); await h.run();
  expect(h.observations[0].p_outcome).toBe("observed"); expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
});

test.each(["2025-09-30.clover", "2025-10-29.clover"])("monthly lifecycle %s snapshot preserves observation-only held state on replay", async version => {
  const h = harness(); delayedBootstrap(h); subEvent(h); h.event.api_version = version;
  const snapshot = JSON.stringify(h.event);
  await h.run(); await h.run();
  expect(h.observations).toHaveLength(2);
  expect(h.observations.every(row => row.p_outcome === "observed")).toBe(true);
  expect(h.stripe.subscriptions.update).not.toHaveBeenCalled(); expect(h.stripe.invoices.update).not.toHaveBeenCalled();
  expect(h.callbacks.reconcileInvoice).not.toHaveBeenCalled(); expect(JSON.stringify(h.event)).toBe(snapshot);
});

test("monthly lifecycle unknown Clover snapshots are rejected before loading an agreement", async () => {
  const h = harness(); h.event.api_version = "2025-11-17.clover";
  await expect(h.run()).rejects.toThrow("context differs");
  expect(h.load).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
});
test("step 8: a zero invoice for the proven first-paid-month activation remains observation-only", async () => {
  const h = harness(); delayedBootstrap(h); const end = membershipMonthBoundary(h.f.proof.paidAt, 1), now = Math.floor(Date.now() / 1000);
  Object.assign(h.f.subscription, { trial_end: end, billing_cycle_anchor: end, cancel_at: null, default_payment_method: "pm_fixture",
    metadata: membershipActivationParams(h.f.a, h.f.proof).metadata });
  Object.assign(h.f.invoice, { billing_reason: "subscription_update", created: now, total: 0, subtotal: 0, amount_due: 0, amount_remaining: 0, status: "paid" });
  h.f.invoice.lines.data[0].amount = 0; h.f.invoice.lines.data[0].period = { start: now, end };
  await h.run(); expect(h.observations[0].p_outcome).toBe("observed"); expect(h.callbacks.reconcileInvoice).not.toHaveBeenCalled();
});
test("step 8: a paid event cannot be acknowledged as an inert unpaid bootstrap draft", async () => {
  const h = harness(); delayedBootstrap(h); h.event.type = "invoice.paid";
  await expect(h.run()).rejects.toThrow("capture is not yet recorded"); expect(h.observations[0].p_outcome).toBe("review_required");
});
test("step 8: healthy held subscription is observation only, never a paid-access transition", async () => {
  const h = harness(); subEvent(h); await h.run();
  expect(h.observations[0].p_outcome).toBe("observed"); expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
  expect(h.callbacks.confirmFirst).not.toHaveBeenCalled(); expect(h.callbacks.reconcileInvoice).not.toHaveBeenCalled();
});
test("steps 2/8: a fresh canceled subscription overrides an old updated event without fabricating consent", async () => {
  const h = harness(); subEvent(h); h.f.subscription.status = "canceled"; await h.run();
  expect(h.observations[0].p_outcome).toBe("provider_stopped");
  expect(h.rpc).toHaveBeenCalledTimes(1); expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
});
test("step 8: stale deleted payload is not treated as proof that the fresh subscription is canceled", async () => {
  const h = harness(); subEvent(h, "customer.subscription.deleted"); h.event.data.object = { ...h.f.subscription, status: "canceled" };
  await h.run(); expect(h.observations[0].p_outcome).toBe("observed");
});
test.each(["owner", "mode", "fingerprint"])("step 8: wrong subscription %s is not acknowledged or mutated", async field => {
  const h = harness(); subEvent(h);
  if (field === "owner") h.f.subscription.customer = "cus_other";
  if (field === "mode") h.f.subscription.livemode = true;
  if (field === "fingerprint") h.f.subscription.metadata.creatornet_membership_fingerprint = "bad";
  await expect(h.run()).rejects.toThrow("owner differs"); expect(h.rpc).not.toHaveBeenCalled(); expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
});
test("steps 1/8: missing collection pause is durably blocked before a hold-only provider mutation", async () => {
  const h = harness(); subEvent(h); h.f.subscription.pause_collection = null; h.env.CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY = "false";
  await h.run(); expect(h.order).toEqual(["record_monthly_mentorship_lifecycle_v1", "claim_monthly_mentorship_containment_v1",
    "provider-subscription-hold", "complete_monthly_mentorship_containment_v1"]);
  expect(h.stripe.subscriptions.update).toHaveBeenCalledWith(h.f.subscription.id,
    { pause_collection: { behavior: "keep_as_draft" }, proration_behavior: "none" },
    { idempotencyKey: "creatornet-membership-containment:21000000-0000-4000-8000-000000000001", maxNetworkRetries: 0 });
});
test("step 8: an unknown old containment cannot invent another provider write", async () => {
  const h = harness(); subEvent(h); h.f.subscription.pause_collection = null; h.oldContainment();
  await expect(h.run()).rejects.toThrow("requires provider review"); expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
});
test("step 8: fresh restored hold can complete old containment without another mutation", async () => {
  const h = harness(); subEvent(h); h.oldContainment(); h.priorReview(); await h.run();
  expect(h.stripe.subscriptions.update).not.toHaveBeenCalled(); expect(h.rpc).toHaveBeenLastCalledWith(
    "complete_monthly_mentorship_containment_v1", expect.objectContaining({ p_proof: expect.objectContaining({ pauseBehavior: "keep_as_draft" }) }));
});
test("step 8: failed durable review prevents provider containment dispatch", async () => {
  const h = harness(); subEvent(h); h.f.subscription.pause_collection = null; h.failRpc("record_monthly_mentorship_lifecycle_v1");
  await expect(h.run()).rejects.toThrow("needs retry"); expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
});
test("step 8: valid native held invoice waits for the scheduled worker, never pays from the webhook", async () => {
  const h = harness(); await h.run(); expect(h.observations[0].p_outcome).toBe("waiting_collection");
  expect(h.callbacks.reconcileInvoice).not.toHaveBeenCalled(); expect(h.stripe.invoices.update).not.toHaveBeenCalled();
});
test("step 8: a stale failed invoice event reconciles fresh paid money through the existing adapter", async () => {
  const h = harness(); h.event.type = "invoice.payment_failed"; h.setAdmission({ scope_key: "2" }); h.f.capture();
  await h.run(); expect(h.callbacks.reconcileInvoice).toHaveBeenCalledWith(h.f.a.id, h.f.a.buyer_id, h.f.invoice.id);
  expect(h.observations[0].p_outcome).toBe("reconciled");
  expect(h.rpc).not.toHaveBeenCalledWith("review_monthly_mentorship_collection_v1", expect.anything());
});
test("step 8: unadmitted captured invoice is held for review, never a false financial acknowledgement", async () => {
  const h = harness(); h.f.capture(); await expect(h.run()).rejects.toThrow("no owned collection admission");
  expect(h.observations[0].p_outcome).toBe("review_required"); expect(h.callbacks.reconcileInvoice).not.toHaveBeenCalled();
});
test("step 8: pending capture result leaves the event retryable", async () => {
  const h = harness(); h.f.capture(); h.setAdmission({ scope_key: "2" }); h.callbacks.reconcileInvoice.mockResolvedValue({ status: "payment_pending", month: 2 });
  await expect(h.run()).rejects.toThrow("not yet recorded"); expect(h.observations).toHaveLength(0);
});
test.each(["invoice.paid", "invoice.payment_succeeded"] as Stripe.Event.Type[])(
  "step 8: nonzero %s cannot be acknowledged while the fresh invoice is unpaid", async type => {
    const h = harness(); h.event.type = type; h.setAdmission({ scope_key: "2" });
    await expect(h.run()).rejects.toThrow("capture is not yet recorded");
    expect(h.observations[0].p_outcome).toBe("review_required");
    expect(h.callbacks.reconcileInvoice).not.toHaveBeenCalled();
  });
test("step 8: unknown capture-adapter status is not payment proof", async () => {
  const h = harness(); h.f.capture(); h.setAdmission({ scope_key: "2" });
  h.callbacks.reconcileInvoice.mockResolvedValue({ status: "unrecognized", month: 2 });
  await expect(h.run()).rejects.toThrow("capture is not yet recorded"); expect(h.observations).toHaveLength(0);
});
test("step 8: owned pending failure marks its existing operation and billing review without another charge", async () => {
  const h = harness(); h.event.type = "invoice.payment_failed"; h.setAdmission({ scope_key: "2" }); await h.run();
  expect(h.rpc).toHaveBeenCalledWith("review_monthly_mentorship_collection_v1", { p_id: h.f.a.id, p_month: 2, p_context: context });
  expect(h.observations[0].p_outcome).toBe("review_required"); expect(h.callbacks.reconcileInvoice).not.toHaveBeenCalled();
});
test("step 8: unexpectedly advancing unpaid invoice is held using frozen no-charge parameters", async () => {
  const h = harness(); h.f.invoice.auto_advance = true; await h.run();
  expect(h.stripe.invoices.update).toHaveBeenCalledWith(h.f.invoice.id, { auto_advance: false }, expect.objectContaining({ maxNetworkRetries: 0 }));
  expect(h.observations[0].p_outcome).toBe("review_required"); expect(h.callbacks.reconcileInvoice).not.toHaveBeenCalled();
});
test.each(["price", "line", "period"])("step 8: unexpected draft invoice %s never becomes eligible for worker collection", async field => {
  const h = harness();
  if (field === "price") h.f.invoice.amount_due = 1;
  if (field === "line") h.f.invoice.lines.has_more = true;
  if (field === "period") h.f.invoice.lines.data[0].period.end++;
  await expect(h.run()).rejects.toThrow(); expect(h.observations[0].p_outcome).toBe("review_required");
});
test("step 8: wrong invoice customer is rejected before writing agreement state", async () => {
  const h = harness(); h.f.invoice.customer = "cus_other"; await expect(h.run()).rejects.toThrow("owner differs"); expect(h.rpc).not.toHaveBeenCalled();
});
test("step 8: invoice-created containment also restores a missing subscription hold", async () => {
  const h = harness(); h.f.subscription.pause_collection = null; await h.run();
  expect(h.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  expect(h.observations[0].p_outcome).toBe("review_required"); expect(h.callbacks.reconcileInvoice).not.toHaveBeenCalled();
});
test.each([false, true])("step 8: capture racing containment with admission=%s never becomes an unpaid acknowledgement", async admitted => {
  const h = harness(); h.f.invoice.auto_advance = true; if (admitted) h.setAdmission({ scope_key: "2" });
  const retrieve = h.stripe.invoices.retrieve.getMockImplementation()!;
  h.stripe.invoices.retrieve.mockImplementationOnce(retrieve).mockImplementationOnce(async () => {
    h.f.capture(); h.f.invoice.auto_advance = false; return retrieve();
  });
  if (admitted) {
    await h.run(); expect(h.callbacks.reconcileInvoice).toHaveBeenCalledTimes(1);
    expect(h.observations.at(-1)?.p_outcome).toBe("reconciled");
  } else {
    await expect(h.run()).rejects.toThrow("no owned collection admission"); expect(h.callbacks.reconcileInvoice).not.toHaveBeenCalled();
  }
  expect(h.stripe.invoices.update).not.toHaveBeenCalled();
});
function zero(h: ReturnType<typeof harness>) {
  const b = membershipFixture(false); Object.assign(h.f.a, b.a); Object.assign(h.f.subscription, b.subscription);
  const times = membershipBootstrapTimes(h.f.a), i = h.f.invoice;
  Object.assign(i, { billing_reason: "subscription_create", created: times.start + 1, subtotal: 0, total: 0, amount_due: 0,
    amount_paid: 0, amount_remaining: 0, status: "paid" });
  i.lines.data[0].amount = 0; i.lines.data[0].period = { start: times.start + 1, end: times.trialEnd };
}
test("step 8: a real-shaped zero bootstrap invoice never grants access or credits earnings", async () => {
  const h = harness(); zero(h); await h.run(); expect(h.observations[0].p_outcome).toBe("observed");
  expect(h.callbacks.confirmFirst).not.toHaveBeenCalled(); expect(h.callbacks.reconcileInvoice).not.toHaveBeenCalled();
});
test.each(["balance", "payment", "period", "ownerReason"])("step 8: zero total with unexpected %s is not accepted as bootstrap", async field => {
  const h = harness(); zero(h);
  if (field === "balance") h.f.invoice.starting_balance = -10000;
  if (field === "payment") h.stripe.invoicePayments.list.mockResolvedValue({ object: "list", has_more: false, data: [h.f.invoicePayment],
    lastResponse: { requestId: "req_fixture", apiVersion: context.apiVersion, headers: {}, statusCode: 200 } });
  if (field === "period") h.f.invoice.lines.data[0].period.end++;
  if (field === "ownerReason") h.f.invoice.billing_reason = "subscription_cycle";
  await expect(h.run()).rejects.toThrow(); expect(h.observations[0].p_outcome).toBe("review_required");
});
test("step 8: unpaid first checkout expiry records recovery, not access or cancellation", async () => {
  const h = harness(), b = membershipFixture(false); Object.assign(h.f.a, b.a); Object.assign(h.f.session, b.session);
  h.f.session.status = "expired"; h.event.type = "checkout.session.expired"; h.event.data.object = h.f.session;
  await h.run(); expect(h.observations[0].p_outcome).toBe("checkout_attention"); expect(h.callbacks.confirmFirst).not.toHaveBeenCalled();
});
test("step 8: stale expiry with a fresh paid first checkout reconciles actual money", async () => {
  const h = harness(), b = membershipFixture(true); Object.assign(h.f.a, b.a); Object.assign(h.f.session, b.session);
  h.event.type = "checkout.session.expired"; h.event.data.object = { ...h.f.session, status: "expired" };
  await h.run(); expect(h.callbacks.confirmFirst).toHaveBeenCalledTimes(1); expect(h.observations[0].p_outcome).toBe("reconciled");
});
test.each([false, true])("steps 2/8: payoff failure/expiry reconciles fresh paid=%s without automatic abandonment", async paid => {
  const h = harness(), p = membershipPayoffFixture(paid); Object.assign(h.f.a, p.a); Object.assign(h.f.session, p.session); h.setPayoff(p.p);
  if (!paid) h.f.session.status = "expired"; h.event.type = "checkout.session.async_payment_failed"; h.event.data.object = h.f.session;
  await h.run(p.p.id); expect(h.observations[0].p_outcome).toBe(paid ? "reconciled" : "checkout_attention");
  expect(h.callbacks.confirmPayoff).toHaveBeenCalledTimes(paid ? 1 : 0);
  expect(h.rpc.mock.calls.every(([name]) => !name.includes("abandon") && !name.includes("receipt"))).toBe(true);
});
test.each(["CREATOR_MONTHLY_MENTORSHIPS_LIFECYCLE_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_LIFECYCLE_READY"])(
  "step 10: missing %s blocks lifecycle before provider or DB activity", async key => {
    const h = harness(); h.env[key] = "false"; expect(membershipLifecycleReady(h.env)).toBe(false);
    await expect(h.run()).rejects.toThrow("not enabled"); expect(h.load).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
  });
test("step 8: context mismatch is rejected before owned load or provider retrieval", async () => {
  const h = harness(); h.event.livemode = true; await expect(h.run()).rejects.toThrow("context differs");
  expect(h.load).not.toHaveBeenCalled(); expect(h.stripe.invoices.retrieve).not.toHaveBeenCalled();
});
