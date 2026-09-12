import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handoffMonthlyMentorshipWebhook } from "@/lib/membershipWebhook";
import { membershipFixture, membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
const mockConfirm = jest.fn(), mockPayoffConfirm = jest.fn(), mockReconcile = jest.fn(), mockClosed = jest.fn(), mockContext = jest.fn(() => context);
jest.mock("@/lib/membershipServer", () => ({ membershipServerContext: () => mockContext() }));
jest.mock("@/lib/membershipRuntime", () => ({ createMembershipRuntime: () => ({ confirmFirst: mockConfirm, confirmPayoff: mockPayoffConfirm, reconcileInvoice: mockReconcile, reconcileAbandonedCheckoutEvent: mockClosed }) }));
function harness() {
  const f = membershipFixture(true), env = { ...membershipTestEnv };
  // Retain coverage of the pre-085 fail-closed financial handoff. The enabled
  // lifecycle path has its own handoff/runtime/database suites.
  env.CREATOR_MONTHLY_MENTORSHIPS_LIFECYCLE_READY = "false";
  const result = { data: [{ id: f.a.id, buyer_id: f.a.buyer_id, stripe_customer_id: f.a.stripe_customer_id,
    stripe_subscription_id: f.a.stripe_subscription_id, stripe_checkout_session_id: f.a.stripe_checkout_session_id }], error: null as unknown };
  const receipt = { data: { provider_proof: { paymentIntentId: f.paymentIntent.id } }, error: null };
  const query: { select: jest.Mock; or: jest.Mock; limit: jest.Mock; eq: jest.Mock; maybeSingle: jest.Mock } = {
    select: jest.fn(() => query), or: jest.fn(() => query), limit: jest.fn(async () => result), eq: jest.fn(() => query),
    maybeSingle: jest.fn(async () => receipt) };
  const from = jest.fn(() => query), rpc = jest.fn(async () => ({ data: true, error: null })), admin = { from, rpc } as unknown as SupabaseClient;
  const event = { id: "evt_fixture", type: "checkout.session.completed", data: { object: f.session }, livemode: false,
    api_version: context.apiVersion, account: undefined } as unknown as Stripe.Event;
  const run = () => handoffMonthlyMentorshipWebhook({ event, admin, env });
  return { f, env, event, from, query, result, receipt, rpc, run };
}
beforeEach(() => { jest.clearAllMocks(); mockConfirm.mockResolvedValue({ firstPaymentRecorded: true }); mockPayoffConfirm.mockResolvedValue({ payoffRecorded: true }); mockReconcile.mockResolvedValue({ status: "recorded", month: 2 }); });

test.each(["2025-09-30.clover", "2025-10-29.clover"])("monthly %s delivery reconciles the same first capture without rewriting the event", async version => {
  const h = harness(); h.event.api_version = version; const snapshot = JSON.stringify(h.event);
  expect(await h.run()).toBe(true);
  expect(mockConfirm).toHaveBeenCalledWith(h.f.a.id, h.f.a.buyer_id);
  expect(mockConfirm).toHaveBeenCalledTimes(1); expect(mockReconcile).not.toHaveBeenCalled();
  expect(JSON.stringify(h.event)).toBe(snapshot);
});

test.each(["mode", "account", "customer", "capture"])("monthly September delivery retains the %s rejection", async fault => {
  const h = harness(); h.event.api_version = "2025-09-30.clover";
  if (fault === "mode") h.event.livemode = true;
  if (fault === "account") h.event.account = "acct_other";
  if (fault === "customer") h.result.data[0].stripe_customer_id = "cus_other";
  if (fault === "capture") mockConfirm.mockResolvedValueOnce({ firstPaymentRecorded: false });
  await expect(h.run()).rejects.toThrow(); expect(mockReconcile).not.toHaveBeenCalled();
  if (fault !== "capture") expect(mockConfirm).not.toHaveBeenCalled();
});
test("steps 1/8: owned completed checkout uses first-capture reconciliation and bypasses legacy handling", async () => {
  const h = harness(); expect(await h.run()).toBe(true); expect(mockConfirm).toHaveBeenCalledWith(h.f.a.id, h.f.a.buyer_id);
  expect(h.query.or).toHaveBeenCalledWith(expect.stringContaining(`stripe_checkout_session_id.eq.${h.f.session.id}`));
});
function payoffEventHarness(pi = false) {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_SCHEMA_READY = "true";
  const id = "20000000-0000-4000-8000-000000000001", fingerprint = "a".repeat(64);
  const data = { id, agreement_id: h.f.a.id, buyer_id: h.f.a.buyer_id, stripe_checkout_session_id: "cs_payoffevent", fingerprint };
  const metadata = { ...h.f.session.metadata!, operation_kind: "payoff", creatornet_membership_payoff_id: id, creatornet_membership_payoff_fingerprint: fingerprint };
  if (pi) { h.event.type = "payment_intent.succeeded"; h.f.paymentIntent.metadata = metadata; h.event.data.object = h.f.paymentIntent; }
  else { h.f.session.id = "cs_payoffevent"; h.f.session.metadata = metadata; }
  h.query.maybeSingle.mockResolvedValueOnce({ data, error: null });
  return { ...h, payoffId: id, data };
}
test("steps 2/8: separately bound payoff checkout uses its own captured-payment adapter", async () => {
  const h = payoffEventHarness(); expect(await h.run()).toBe(true);
  expect(mockPayoffConfirm).toHaveBeenCalledWith(h.f.a.id, h.f.a.buyer_id, h.payoffId); expect(mockConfirm).not.toHaveBeenCalled();
});
test("step 8: payoff success is acknowledged only after its actual PaymentIntent is recorded", async () => {
  const h = payoffEventHarness(true); expect(await h.run()).toBe(true);
  expect(mockPayoffConfirm).toHaveBeenCalledTimes(1); expect(mockConfirm).not.toHaveBeenCalled();
});
test("step 8: an unpublished payoff cannot enter first-month or legacy accounting", async () => {
  const h = payoffEventHarness(); h.data.stripe_checkout_session_id = "";
  await expect(h.run()).rejects.toThrow("no published owner"); expect(mockPayoffConfirm).not.toHaveBeenCalled(); expect(mockConfirm).not.toHaveBeenCalled();
});
test("step 8: an owned payoff with unconfirmed capture remains retryable", async () => {
  const h = payoffEventHarness(); mockPayoffConfirm.mockResolvedValueOnce({ payoffRecorded: false });
  await expect(h.run()).rejects.toThrow("not yet recorded"); expect(mockConfirm).not.toHaveBeenCalled();
});
test("step 8: payoff metadata cannot change the accepted identity or provider session", async () => {
  const h = payoffEventHarness(); h.data.fingerprint = "b".repeat(64);
  await expect(h.run()).rejects.toThrow("metadata differs"); expect(mockPayoffConfirm).not.toHaveBeenCalled();
});
test("step 8: disabling payoff schema cannot fall through to a first-month receipt", async () => {
  const h = payoffEventHarness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_SCHEMA_READY = "false";
  await expect(h.run()).rejects.toThrow("schema is unavailable"); expect(mockConfirm).not.toHaveBeenCalled();
});
test("step 8: schema-off known monthly metadata cannot fall through to legacy payment credit", async () => {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = "false";
  await expect(h.run()).rejects.toThrow("never use legacy"); expect(h.from).not.toHaveBeenCalled();
});
test("step 8: default-off does not disturb an unrelated legacy checkout", async () => {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = "false"; h.f.session.metadata = {};
  expect(await h.run()).toBe(false); expect(h.from).not.toHaveBeenCalled();
});
function inheritedInvoiceHarness() {
  const h = harness(); h.event.type = "invoice.paid";
  const inherited = { ...h.f.session.metadata! };
  const invoice = { id: "in_inherited", object: "invoice", metadata: {} as Record<string, string>, customer: h.f.a.stripe_customer_id,
    parent: { subscription_details: { subscription: h.f.a.stripe_subscription_id, metadata: inherited } } };
  h.event.data.object = invoice as unknown as Stripe.Invoice;
  return { ...h, invoice, inherited };
}
test("step 8: inherited monthly invoice metadata cannot fall through while schema is disabled", async () => {
  const h = inheritedInvoiceHarness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY = "false";
  await expect(h.run()).rejects.toThrow("never use legacy"); expect(h.from).not.toHaveBeenCalled();
});
test("step 8: inherited metadata with no saved owner remains retryable before provider publication", async () => {
  const h = inheritedInvoiceHarness(); h.result.data = [];
  await expect(h.run()).rejects.toThrow("no bound owner"); expect(mockReconcile).not.toHaveBeenCalled();
});
test("step 8: inherited metadata cannot bypass unpublished provider bindings", async () => {
  const h = inheritedInvoiceHarness(); h.result.data[0].stripe_customer_id = null;
  await expect(h.run()).rejects.toThrow("customer differs"); expect(mockReconcile).not.toHaveBeenCalled();
});
test("step 8: direct and inherited membership owners must agree before lookup", async () => {
  const h = inheritedInvoiceHarness(); h.invoice.metadata = { ...h.inherited, creatornet_membership_id: h.f.a.purchase_id };
  await expect(h.run()).rejects.toThrow("metadata owners differ"); expect(h.from).not.toHaveBeenCalled();
});
test("step 8: an inherited marker with an unsupported version cannot be hidden by valid direct metadata", async () => {
  const h = inheritedInvoiceHarness(); h.invoice.metadata = { ...h.inherited }; h.inherited.creatornet_membership_version = "unsupported";
  await expect(h.run()).rejects.toThrow("metadata version differs"); expect(h.from).not.toHaveBeenCalled();
});
test("step 8: owned inherited-only metadata reconciles the actual invoice without legacy fallback", async () => {
  const h = inheritedInvoiceHarness(); expect(await h.run()).toBe(true);
  expect(h.query.or).toHaveBeenCalledWith(expect.stringContaining(`id.eq.${h.f.a.id}`));
  expect(mockReconcile).toHaveBeenCalledWith(h.f.a.id, h.f.a.buyer_id, "in_inherited");
});
test("step 8: missing ownership for marked monthly metadata is a retry, not legacy fallback", async () => {
  const h = harness(); h.result.data = []; await expect(h.run()).rejects.toThrow("no bound owner"); expect(mockConfirm).not.toHaveBeenCalled();
});
test("step 8: conflicting customer/session/agreement ownership is rejected", async () => {
  const h = harness(); h.result.data.push({ ...h.result.data[0], id: h.f.a.purchase_id });
  await expect(h.run()).rejects.toThrow("conflicting owners"); expect(mockConfirm).not.toHaveBeenCalled();
});
test("step 8: even unmarked known customer events cannot enter legacy handling", async () => {
  const h = harness(); h.f.session.metadata = {}; expect(await h.run()).toBe(true); expect(mockConfirm).toHaveBeenCalledTimes(1);
});
test.each(["metadata", "customer", "checkout"])("step 8: an OR lookup match cannot hide a conflicting %s identity", async field => {
  const h = harness();
  if (field === "metadata") h.f.session.metadata!.creatornet_membership_id = h.f.a.purchase_id;
  if (field === "customer") h.f.session.customer = "cus_other";
  if (field === "checkout") h.f.session.id = "cs_other";
  await expect(h.run()).rejects.toThrow("differs"); expect(mockConfirm).not.toHaveBeenCalled();
});
test("step 8: paused monthly reconciliation fails closed for an owned event", async () => {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY = "false";
  await expect(h.run()).rejects.toThrow("paused"); expect(mockConfirm).not.toHaveBeenCalled();
});
test.each(["mode", "version", "account"])("step 10: event %s must match the approved server context", async field => {
  const h = harness();
  if (field === "mode") h.event.livemode = true;
  if (field === "version") h.event.api_version = "2025-11-17.clover";
  if (field === "account") h.event.account = "acct_other";
  await expect(h.run()).rejects.toThrow("context differs"); expect(mockConfirm).not.toHaveBeenCalled();
});
test("steps 1/8: completed-but-unconfirmed checkout remains retryable", async () => {
  const h = harness(); mockConfirm.mockResolvedValueOnce({ firstPaymentRecorded: false });
  await expect(h.run()).rejects.toThrow("not yet recorded");
});
test("step 8: first PaymentIntent success is acknowledged only when the first receipt matches it", async () => {
  const h = harness(); h.event.type = "payment_intent.succeeded"; h.event.data.object = h.f.paymentIntent;
  expect(await h.run()).toBe(true); h.receipt.data.provider_proof.paymentIntentId = "pi_other";
  await expect(h.run()).rejects.toThrow("own receipt reconciliation");
});
test.each(["invoice.created", "customer.subscription.deleted", "payment_intent.payment_failed", "checkout.session.expired"] as const)(
  "step 8: unfinished lifecycle adapter %s is explicitly held, not a false success", async type => {
    const h = harness(); h.event.type = type; await expect(h.run()).rejects.toThrow("dedicated adapter"); expect(mockConfirm).not.toHaveBeenCalled();
  });
test("steps 1/8: invoice paid event reconciles its owned invoice without sending a new debit", async () => {
  const h = harness(); h.event.type = "invoice.paid";
  h.event.data.object = { id: "in_fixture", object: "invoice", customer: "cus_fixture", parent: { subscription_details: { subscription: "sub_fixture" } } } as Stripe.Invoice;
  expect(await h.run()).toBe(true); expect(mockReconcile).toHaveBeenCalledWith(h.f.a.id, h.f.a.buyer_id, "in_fixture");
  expect(mockConfirm).not.toHaveBeenCalled();
});
test("step 8: invoice failure uses fresh pending observation to record review, not paid status", async () => {
  const h = harness(); h.event.type = "invoice.payment_failed";
  h.event.data.object = { id: "in_fixture", object: "invoice", customer: "cus_fixture", parent: { subscription_details: { subscription: "sub_fixture" } } } as Stripe.Invoice;
  mockReconcile.mockResolvedValueOnce({ status: "payment_pending", month: 2 }); expect(await h.run()).toBe(true);
  expect(h.rpc).toHaveBeenCalledWith("review_monthly_mentorship_collection_v1", { p_id: h.f.a.id, p_month: 2, p_context: context });
});
test("step 8: stale invoice failure cannot replace a freshly reconciled paid result with review", async () => {
  const h = harness(); h.event.type = "invoice.payment_failed";
  h.event.data.object = { id: "in_fixture", object: "invoice", customer: "cus_fixture", parent: { subscription_details: { subscription: "sub_fixture" } } } as Stripe.Invoice;
  expect(await h.run()).toBe(true); expect(h.rpc).not.toHaveBeenCalled();
});
test.each(["charge.refunded", "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"] as const)(
  "step 7: %s continues through the existing common refund/dispute engine", async type => {
    const h = harness(); h.event.type = type; expect(await h.run()).toBe(false); expect(h.from).not.toHaveBeenCalled();
  });

test("a closed unbound subscription delegates to fresh unpaid-proof reconciliation, not first payment or legacy accounting", async () => {
  const h = harness(); h.event.type = "customer.subscription.deleted"; h.event.data.object = h.f.subscription;
  Object.assign(h.result.data[0], { stripe_customer_id: null, stripe_subscription_id: null, stripe_checkout_session_id: null,
    initial_abandoned_at: new Date().toISOString() });
  mockClosed.mockResolvedValueOnce({ status: "abandoned", membershipId: h.f.a.id });
  expect(await h.run()).toBe(true); expect(mockClosed).toHaveBeenCalledWith(h.f.a.id, h.f.a.buyer_id, h.event);
  expect(mockConfirm).not.toHaveBeenCalled(); expect(mockReconcile).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
});

test("a closed marker alone cannot turn a failed fresh-proof check into acknowledgement", async () => {
  const h = harness(); h.event.type = "customer.subscription.deleted"; h.event.data.object = h.f.subscription;
  Object.assign(h.result.data[0], { initial_abandoned_at: new Date().toISOString() });
  mockClosed.mockRejectedValueOnce(Error("Initial sealed provider evidence changed"));
  await expect(h.run()).rejects.toThrow("evidence changed"); expect(mockConfirm).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
});
