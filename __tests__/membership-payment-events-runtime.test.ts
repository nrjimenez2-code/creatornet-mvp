import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMembershipPaymentEventRuntime, membershipPaymentEventsReady } from "@/lib/membershipPaymentEvents";
import type { MembershipBillingDependencies } from "@/lib/membershipBillingRuntime";
import { membershipInvoiceConfiguration } from "@/lib/membershipRenewal";
import { membershipFixture, membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
import { membershipRenewalFixture } from "../test-support/membership-renewal-fixtures";
import { membershipPayoffFixture } from "../test-support/membership-payoff-fixtures";
const mockRefund = jest.fn(), mockApplyRefund = jest.fn(), mockReconcileRefund = jest.fn();
const mockDispute = jest.fn(), mockApplyDispute = jest.fn(), mockReconcileDispute = jest.fn();
jest.mock("@/lib/paymentRefunds", () => ({ recordPaymentRefundState: (...args: unknown[]) => mockRefund(...args),
  applyPaymentRefundState: (...args: unknown[]) => mockApplyRefund(...args), reconcileKnownPaymentRefund: (...args: unknown[]) => mockReconcileRefund(...args) }));
jest.mock("@/lib/paymentDisputes", () => ({ recordPaymentDisputeState: (...args: unknown[]) => mockDispute(...args),
  applyPaymentDisputeState: (...args: unknown[]) => mockApplyDispute(...args), reconcileKnownPaymentDispute: (...args: unknown[]) => mockReconcileDispute(...args) }));
beforeEach(() => { jest.clearAllMocks(); mockRefund.mockResolvedValue({ synthetic: true }); mockDispute.mockResolvedValue(true); });
type Kind = "first" | "renewal" | "payoff";
/** Synthetic provider/receipt boundaries. SQL 086 independently enforces real stored receipt ownership. */
function harness(kind: Kind = "first", paid = true) {
  const b = membershipFixture(paid), r = membershipRenewalFixture(), p = membershipPayoffFixture(paid);
  if (paid) { r.capture(); Object.assign(r.invoice, membershipInvoiceConfiguration(r.a, r.proof, r.period.month));
    r.invoice.lines.data[0].period = { start: r.period.start, end: r.period.end }; }
  const a = kind === "renewal" ? r.a : kind === "payoff" ? p.a : b.a;
  const pi = kind === "renewal" ? r.paymentIntent : kind === "payoff" ? p.pi : b.paymentIntent;
  const charge = kind === "renewal" ? r.charge : kind === "payoff" ? p.charge : b.charge;
  const session = kind === "payoff" ? p.session : b.session, invoice = r.invoice;
  pi.payment_method_types = ["card"];
  if (!paid) { pi.status = "requires_payment_method"; pi.amount_received = 0; pi.amount_capturable = 0; pi.latest_charge = null; }
  session.payment_intent = pi.id;
  let eventCharge = charge;
  const env = { ...membershipTestEnv }, response = <T,>(x: T) => ({ ...x,
    lastResponse: { requestId: "req_payment", apiVersion: context.apiVersion, headers: {}, statusCode: 200 } });
  const fees = kind === "payoff" ? p.p.terms.fees : kind === "renewal" ? a.terms.recurringMonthFees : a.terms.firstMonthFees;
  const receipt = { ledger_id: "22000000-0000-4000-8000-000000000001", provider_proof: { paymentContext: context,
    customerId: a.stripe_customer_id, subscriptionId: a.stripe_subscription_id, destinationId: a.terms.destinationId,
    paymentIntentId: pi.id, chargeId: charge.id, capturedAmountCents: pi.amount, applicationFeeAmountCents: fees.totalCreatorDeductionCents,
    invoiceId: kind === "renewal" ? invoice.id : null, checkoutSessionId: kind === "renewal" ? a.stripe_checkout_session_id : session.id } };
  let admitted = true, receiptVisible = true, failObservation = false;
  const observations: Record<string, unknown>[] = [];
  const rpc = jest.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "record_monthly_mentorship_payment_event_v1") {
      observations.push(args); return { error: failObservation ? Error("synthetic journal failure") : null,
        data: { event_id: args.p_event_id, agreement_id: a.id } };
    }
    return { error: null, data: true };
  });
  const from = jest.fn((table: string) => {
    let selection = "";
    const q: { select: jest.Mock; eq: jest.Mock; maybeSingle: jest.Mock } = {
      select: jest.fn((s: string) => { selection = s; return q; }), eq: jest.fn(() => q),
      maybeSingle: jest.fn(async () => ({ error: null, data: table === "monthly_mentorship_operations_v1" ?
        admitted ? { scope_key: "2", request: { path: "/v1/invoices/" + invoice.id + "/pay" } } : null :
        table === "monthly_mentorship_payoffs_v1" && selection === "*" ? p.p :
        selection === "provider_proof" ? { provider_proof: r.proof } : receiptVisible ? receipt : null })) };
    return q;
  });
  const dispute = { id: "dp_payment", object: "dispute", charge: charge.id, payment_intent: pi.id, amount: pi.amount,
    currency: "usd", livemode: false, status: "won" } as Stripe.Dispute;
  const stripe = {
    paymentIntents: { retrieve: jest.fn(async () => response(pi)) },
    charges: { retrieve: jest.fn(async (id: string) => response(id === eventCharge.id ? eventCharge : charge)) },
    checkout: { sessions: { list: jest.fn(async () => response({ object: "list", has_more: false,
      data: kind === "renewal" ? [] as Stripe.Checkout.Session[] : [session] })), retrieve: jest.fn(async () => response(session)) } },
    invoicePayments: { list: jest.fn(async () => response({ object: "list", has_more: false, data: kind === "renewal" ? [r.invoicePayment] : [] as Stripe.InvoicePayment[] })) },
    invoices: { retrieve: jest.fn(async () => response(invoice)) },
    disputes: { list: jest.fn(async () => response({ object: "list", has_more: false, data: [dispute] })),
      retrieve: jest.fn(async () => response(dispute)) },
  };
  const callbacks = { confirmFirst: jest.fn(async () => ({ firstPaymentRecorded: true })),
    confirmPayoff: jest.fn(async () => ({ payoffRecorded: true })), reconcileInvoice: jest.fn(async () => ({ status: "recorded", month: 2 })) };
  const d: MembershipBillingDependencies = { admin: { rpc, from } as unknown as SupabaseClient, stripe: stripe as unknown as Stripe, context, env,
    checked: async value => value, load: jest.fn(async () => a), observeContext: jest.fn(async () => context), productId: async () => b.product.id };
  const runtime = createMembershipPaymentEventRuntime(d, callbacks);
  const event = { id: "evt_payment", type: paid ? "payment_intent.succeeded" : "payment_intent.created", created: Math.floor(Date.now() / 1000),
    api_version: context.apiVersion, livemode: false, data: { object: pi } } as Stripe.Event;
  const run = (hint: string | null = null) => runtime.reconcilePaymentEvent(a.id, a.buyer_id, event, hint);
  return { a, pi, charge, session, invoice, dispute, p, r, stripe, callbacks, rpc, from, event, run, env, d, observations, receipt,
    noAdmission: () => { admitted = false; }, noReceipt: () => { receiptVisible = false; }, failObservation: () => { failObservation = true; },
    setEventCharge: (c: Stripe.Charge) => { eventCharge = c; event.data.object = c; } };
}
test.each((["first", "renewal", "payoff"] as Kind[]).flatMap(kind =>
  ["2025-09-30.clover", "2025-10-29.clover"].map(version => ({ kind, version }))))(
  "steps 1/2/8: fresh $kind success from $version requires its matching captured receipt", async ({ kind, version }) => {
  const h = harness(kind); h.event.api_version = version; expect((await h.run()).status).toBe("reconciled");
  expect(h.callbacks.confirmFirst).toHaveBeenCalledTimes(kind === "first" ? 1 : 0);
  expect(h.callbacks.reconcileInvoice).toHaveBeenCalledTimes(kind === "renewal" ? 1 : 0);
  expect(h.callbacks.confirmPayoff).toHaveBeenCalledTimes(kind === "payoff" ? 1 : 0);
  expect(h.observations[0]).toMatchObject({ p_outcome: "reconciled", p_proof: { path: kind, paymentIntentId: h.pi.id, chargeId: h.charge.id } });
});
test("step 8: a charge without copied metadata finds its payoff from real provider links", async () => {
  const h = harness("payoff"); h.event.type = "charge.succeeded"; h.setEventCharge({ ...h.charge, metadata: {} });
  await h.run(); expect(h.callbacks.confirmPayoff).toHaveBeenCalledWith(h.a.id, h.a.buyer_id, h.p.p.id);
});
test("step 8: a stale failed charge event reconciles the PaymentIntent's current successful charge", async () => {
  const h = harness(); h.event.type = "charge.failed";
  h.setEventCharge({ ...h.charge, id: "ch_oldfailed", status: "failed", paid: false, captured: false });
  await h.run(); expect(h.callbacks.confirmFirst).toHaveBeenCalledTimes(1);
  expect(h.observations[0]).toMatchObject({ p_outcome: "reconciled", p_proof: { objectId: "ch_oldfailed", status: "failed", paymentStatus: "succeeded", chargeId: h.charge.id } });
});
test.each(["first", "renewal", "payoff"] as Kind[])("step 8: pending %s payment does not grant access or manufacture receipt proof", async kind => {
  const h = harness(kind, false); await h.run();
  expect(h.callbacks.confirmFirst).not.toHaveBeenCalled(); expect(h.callbacks.confirmPayoff).not.toHaveBeenCalled();
  expect(h.callbacks.reconcileInvoice).not.toHaveBeenCalled(); expect(h.observations[0].p_outcome).toBe("observed");
});
test("step 8: renewal failure records existing-operation review without another payment attempt", async () => {
  const h = harness("renewal", false); h.event.type = "payment_intent.payment_failed"; await h.run();
  expect(h.rpc).toHaveBeenCalledWith("review_monthly_mentorship_collection_v1", { p_id: h.a.id, p_month: 2, p_context: context });
  expect(h.observations[0].p_outcome).toBe("review_required");
});
test("step 2: canceled payoff payment never releases the payoff hold or cancels membership", async () => {
  const h = harness("payoff", false); h.event.type = "payment_intent.canceled"; h.pi.status = "canceled"; await h.run(h.p.p.id);
  expect(h.observations[0].p_outcome).toBe("checkout_attention");
  expect(h.rpc.mock.calls.every(([name]) => name === "record_monthly_mentorship_payment_event_v1")).toBe(true);
});
test.each(["payment_intent.succeeded", "charge.succeeded", "charge.captured"] as Stripe.Event.Type[])(
  "step 8: %s with fresh uncaptured state stays retryable", async type => {
    const h = harness("first", false); h.event.type = type; if (type.startsWith("charge.")) h.setEventCharge(h.charge);
    await expect(h.run()).rejects.toThrow("not yet confirmed"); expect(h.observations[0].p_outcome).toBe("observed");
  });
test("step 8: a paid callback result without the actual receipt remains retryable", async () => {
  const h = harness(); h.noReceipt(); await expect(h.run()).rejects.toThrow("matching captured receipt"); expect(h.observations).toHaveLength(0);
});
test.each(["paymentIntentId", "chargeId", "destinationId"])("step 8: mismatched receipt %s is not accepted", async field => {
  const h = harness(); Object.assign(h.receipt.provider_proof, { [field]: "other" });
  await expect(h.run()).rejects.toThrow("matching captured receipt"); expect(h.observations).toHaveLength(0);
});
test.each(["missing", "both", "page"])("step 8: %s provider payment links require review instead of a guessed purchase", async kind => {
  const h = harness(), sessions = h.stripe.checkout.sessions.list.getMockImplementation()!;
  if (kind === "missing") h.stripe.checkout.sessions.list.mockImplementation(async () => ({ ...await sessions(), data: [] }));
  if (kind === "both") h.stripe.invoicePayments.list.mockResolvedValue({ object: "list", has_more: false, data: [h.r.invoicePayment],
    lastResponse: { requestId: "req_payment", apiVersion: context.apiVersion, headers: {}, statusCode: 200 } });
  if (kind === "page") h.stripe.checkout.sessions.list.mockImplementation(async () => ({ ...await sessions(), has_more: true }));
  await expect(h.run()).rejects.toThrow("unavailable or ambiguous"); expect(h.observations[0].p_outcome).toBe("review_required");
  expect(h.callbacks.confirmFirst).not.toHaveBeenCalled();
});
test("step 8: an invoice-owned PaymentIntent cannot bypass collection admission", async () => {
  const h = harness("renewal"); h.noAdmission(); await expect(h.run()).rejects.toThrow("collection admission");
  expect(h.callbacks.reconcileInvoice).not.toHaveBeenCalled();
});
test.each(["customer", "mode"])("step 8: wrong PaymentIntent %s is rejected before payment lookup", async field => {
  const h = harness(); if (field === "customer") h.pi.customer = "cus_other"; else h.pi.livemode = true;
  await expect(h.run()).rejects.toThrow("owner"); expect(h.stripe.checkout.sessions.list).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
});
test.each(["amount", "fee", "destination", "method", "consent"])("steps 4/8: changed %s fails closed before capture", async field => {
  const h = harness();
  if (field === "amount") h.pi.amount++;
  if (field === "fee") h.pi.application_fee_amount = 0;
  if (field === "destination") h.pi.transfer_data!.destination = "acct_other";
  if (field === "method") h.pi.payment_method_types = ["card", "link"];
  if (field === "consent") h.pi.setup_future_usage = null;
  await expect(h.run()).rejects.toThrow(); expect(h.callbacks.confirmFirst).not.toHaveBeenCalled();
  expect(h.observations[0].p_outcome).toBe("review_required");
});
test("step 8: an incorrect payoff hint cannot classify an ordinary first payment", async () => {
  const h = harness(); await expect(h.run(h.p.p.id)).rejects.toThrow("cannot be a payoff"); expect(h.callbacks.confirmFirst).not.toHaveBeenCalled();
});
test("step 7: observed refund is sent through the existing refund engine after exact receipt matching", async () => {
  const h = harness(); h.charge.amount_refunded = h.charge.amount; await h.run();
  expect(mockRefund).toHaveBeenCalledWith(expect.anything(), { paymentIntentId: h.pi.id, chargeId: h.charge.id,
    chargeAmountCents: h.charge.amount, refundedAmountCents: h.charge.amount });
  expect(mockApplyRefund).toHaveBeenCalledWith(expect.anything(), { synthetic: true });
});
test("step 7: current dispute state is recorded and reapplied before the capture callback", async () => {
  const h = harness(); h.charge.disputed = true; await h.run();
  expect(mockDispute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ disputeId: h.dispute.id,
    paymentIntentId: h.pi.id, chargeId: h.charge.id, eventCreated: h.event.created, status: "won" }));
  expect(mockApplyDispute.mock.invocationCallOrder[0]).toBeLessThan(h.callbacks.confirmFirst.mock.invocationCallOrder[0]);
  expect(mockReconcileDispute).toHaveBeenCalledWith(expect.anything(), h.pi.id);
});
test("step 8: newer canonical dispute state is reapplied rather than overwritten", async () => {
  const h = harness(); h.charge.disputed = true; mockDispute.mockResolvedValueOnce(false); await h.run();
  expect(mockApplyDispute).not.toHaveBeenCalled(); expect(mockReconcileDispute).toHaveBeenCalled();
});
test("step 8: a dispute with different charge ownership cannot reach the ledger", async () => {
  const h = harness(); h.charge.disputed = true; h.dispute.charge = "ch_other";
  await expect(h.run()).rejects.toThrow("dispute owner"); expect(mockDispute).not.toHaveBeenCalled(); expect(h.callbacks.confirmFirst).not.toHaveBeenCalled();
});
test("step 8: journal failure remains retryable after captured receipt confirmation", async () => {
  const h = harness(); h.failObservation(); await expect(h.run()).rejects.toThrow("observation needs retry");
});
test("step 8: pausing new checkout does not disable reconciliation", async () => {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY = "false"; await expect(h.run()).resolves.toMatchObject({ status: "reconciled" });
});
test.each(["CREATOR_MONTHLY_MENTORSHIPS_PAYMENT_EVENTS_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_PAYMENT_EVENTS_READY"])(
  "step 10: missing %s prevents payment-event activity", async key => {
    const h = harness(); h.env[key] = "false"; expect(membershipPaymentEventsReady(h.env)).toBe(false);
    await expect(h.run()).rejects.toThrow("not enabled"); expect(h.d.load).not.toHaveBeenCalled();
  });
test("step 8: a wrong event context cannot reach the provider", async () => {
  const h = harness(); h.event.account = "acct_other"; await expect(h.run()).rejects.toThrow("context differs"); expect(h.d.load).not.toHaveBeenCalled();
});
test.each(["paymentIntent", "charge", "capturedCharge"])("step 8: retrieved %s must match its requested identity", async field => {
  const h = harness();
  if (field === "paymentIntent") {
    h.event.data.object = { ...h.pi, id: "pi_requested" };
  } else if (field === "charge") {
    h.event.type = "charge.succeeded"; h.event.data.object = { ...h.charge, id: "ch_requested" };
  } else {
    h.pi.latest_charge = "ch_requested";
  }
  await expect(h.run()).rejects.toThrow("identity differs"); expect(h.callbacks.confirmFirst).not.toHaveBeenCalled();
});
test("step 8: dedicated refund events remain with their existing engine", async () => {
  const h = harness(); h.event.type = "charge.refunded"; h.setEventCharge(h.charge);
  await expect(h.run()).rejects.toThrow("existing refund/dispute"); expect(h.d.load).not.toHaveBeenCalled();
});
