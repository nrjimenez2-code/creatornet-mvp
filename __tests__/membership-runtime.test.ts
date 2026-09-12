import type Stripe from "stripe";
jest.mock("@/lib/paymentDisputes", () => ({ reconcileKnownPaymentDispute: jest.fn() }));
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMembershipRuntime, inspectMembershipFirstCapture } from "@/lib/membershipRuntime";
import { recordPaymentFeeLedger } from "@/lib/paymentFeeLedger";
import { applyPaymentRefundState, reconcileKnownPaymentRefund, recordPaymentRefundState } from "@/lib/paymentRefunds";
import { runMembershipOperation } from "@/lib/membershipOperation";
import { membershipFixture, membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
jest.mock("@/lib/creatorStripeConnect", () => ({ isCreatorSellReady: jest.fn() }));
jest.mock("@/lib/paymentFeeLedger", () => ({ recordPaymentFeeLedger: jest.fn() }));
jest.mock("@/lib/paymentRefunds", () => ({ applyPaymentRefundState: jest.fn(), reconcileKnownPaymentRefund: jest.fn(), recordPaymentRefundState: jest.fn() }));
// The real operation wrapper and SQL are covered by their own suites. This
// boundary double exercises concrete runtime wiring, not hosted dispatch.
jest.mock("@/lib/membershipOperation", () => ({ runMembershipOperation: jest.fn() }));
const feeLedger = jest.mocked(recordPaymentFeeLedger), refunded = jest.mocked(recordPaymentRefundState);
const applied = jest.mocked(applyPaymentRefundState), reconciled = jest.mocked(reconcileKnownPaymentRefund);
const runOperation = jest.mocked(runMembershipOperation);
const ledgerId = "16000000-0000-4000-8000-000000000007";
beforeEach(() => {
  jest.resetAllMocks(); feeLedger.mockResolvedValue(ledgerId);
  runOperation.mockImplementation(async input => { const value = await input.create(input.request, {
    idempotencyKey: `synthetic-${input.kind}`, maxNetworkRetries: 0 }); input.validate(value); return value; });
});
function harness(paid = true) {
  const f = membershipFixture(paid), env = { ...membershipTestEnv }, order: string[] = [];
  let visible = true, entitlement = false, failReceipt = false, dispute: string | null = null;
  const response = <T,>(value: T) => ({ ...value, lastResponse: { apiVersion: context.apiVersion, requestId: "req_fixture", headers: {}, statusCode: 200 } });
  const rpc = jest.fn(async (name, params) => {
    order.push(name);
    if (name === "read_monthly_mentorship_entitlement_v1") return { data: { allowed: entitlement, maxAgeSeconds: entitlement ? 3600 : 0 }, error: null };
    if (name === "record_monthly_mentorship_receipt_v1") {
      if (failReceipt) return { data: null, error: { message: "Synthetic unavailable database" } };
      f.a.covered_months = 1; f.a.anchor_at = params.p_start; entitlement = f.charge.amount_refunded < f.charge.amount;
      return { data: true, error: null };
    }
    if (name === "bind_monthly_mentorship_provider_v1") {
      f.a.stripe_customer_id = params.p_customer_id; f.a.stripe_subscription_id = params.p_subscription_id;
      f.a.stripe_checkout_session_id = params.p_session_id; return { data: true, error: null };
    }
    if (name === "reserve_monthly_mentorship_v1") return { data: f.a.id, error: null };
    throw Error("Unexpected runtime RPC " + name);
  });
  const from = jest.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const q: { select: jest.Mock; eq: jest.Mock; maybeSingle: jest.Mock } = {
      select: jest.fn(() => q), eq: jest.fn((key: string, value: unknown) => { filters[key] = value; return q; }),
      maybeSingle: jest.fn(async () => ({ error: null, data: table === "monthly_mentorship_agreements_v1" ?
        visible && filters.id === f.a.id && filters.buyer_id === f.a.buyer_id ? { ...f.a } : null :
        table === "monthly_mentorship_operations_v1" ? { provider_id: f.product.id } :
        table === "payment_fee_ledger" ? { dispute_status: dispute } : null })) };
    return q;
  });
  const stripe = {
    accounts: { retrieve: jest.fn(async () => response({ object: "account", id: context.stripeAccountId })) },
    balance: { retrieve: jest.fn(async () => response({ object: "balance", livemode: false })) },
    customers: { create: jest.fn(async () => response(f.customer)), retrieve: jest.fn(async () => response(f.customer)) },
    products: { create: jest.fn(async () => response(f.product)), retrieve: jest.fn(async () => response(f.product)) },
    subscriptions: { create: jest.fn(async () => response({ ...f.subscription, pause_collection: null })),
      update: jest.fn(async () => response(f.subscription)), retrieve: jest.fn(async () => response(f.subscription)) },
    checkout: { sessions: { create: jest.fn(async () => response(f.session)), retrieve: jest.fn(async () => response(f.session)) } },
    paymentIntents: { retrieve: jest.fn(async () => response(f.paymentIntent)) },
    charges: { retrieve: jest.fn(async () => response(f.charge)) },
    balanceTransactions: { retrieve: jest.fn(async () => response(f.balance)) },
  };
  const runtime = createMembershipRuntime(env, { context, admin: { from, rpc } as unknown as SupabaseClient, stripe: stripe as unknown as Stripe });
  return { f, env, rpc, from, stripe, runtime, order, setVisible: (value: boolean) => { visible = value; },
    setEntitlement: (value: boolean) => { entitlement = value; }, setFailReceipt: (value: boolean) => { failReceipt = value; },
    setDispute: (value: string | null) => { dispute = value; } };
}
test("steps 1/7/8: confirmed capture uses the existing ledger before the owned monthly receipt", async () => {
  const h = harness(), result = await h.runtime.confirmFirst(h.f.a.id, h.f.a.buyer_id);
  expect(result).toMatchObject({ membershipId: h.f.a.id, firstPaymentRecorded: true, accessGranted: true });
  expect(feeLedger).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ purchaseId: h.f.a.purchase_id,
    paymentIntentId: h.f.paymentIntent.id, checkoutSessionId: h.f.session.id, breakdown: h.f.a.terms.firstMonthFees }), true);
  const receiptIndex = h.rpc.mock.calls.findIndex(([name]) => name === "record_monthly_mentorship_receipt_v1");
  expect(h.rpc.mock.invocationCallOrder[receiptIndex]).toBeGreaterThan(feeLedger.mock.invocationCallOrder[0]);
  expect(h.rpc.mock.calls[receiptIndex][1]).toMatchObject({ p_ledger_id: ledgerId, p_month: 1,
    p_proof: { paymentMethodId: "pm_fixture", capturedAmountCents: 10000, paymentContext: context } });
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("step 8: billing review does not reopen an already bound unpaid first-month checkout", async () => {
  const h = harness(false); h.f.a.billing_review_at = new Date().toISOString();
  await expect(h.runtime.prepare(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("support review");
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(h.stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
});
test("step 7: failure to reapply saved dispute state prevents the first receipt transition", async () => {
  const h = harness();
  const dispute = jest.requireMock("@/lib/paymentDisputes") as { reconcileKnownPaymentDispute: jest.Mock };
  dispute.reconcileKnownPaymentDispute.mockRejectedValueOnce(Error("synthetic dispute mirror unavailable"));
  await expect(h.runtime.confirmFirst(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("dispute mirror unavailable");
  expect(h.rpc).not.toHaveBeenCalledWith("record_monthly_mentorship_receipt_v1", expect.anything());
});
test("steps 1/8: visiting confirmation while unpaid creates no ledger, receipt or access", async () => {
  const h = harness(false); expect(await h.runtime.confirmFirst(h.f.a.id, h.f.a.buyer_id)).toMatchObject({ firstPaymentRecorded: false, accessGranted: false });
  expect(feeLedger).not.toHaveBeenCalled(); expect(h.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  expect(h.order).toEqual(["read_monthly_mentorship_entitlement_v1"]);
});
test("step 8: duplicate confirmation does not re-credit or recreate payment", async () => {
  const h = harness(); await h.runtime.confirmFirst(h.f.a.id, h.f.a.buyer_id); await h.runtime.confirmFirst(h.f.a.id, h.f.a.buyer_id);
  expect(feeLedger).toHaveBeenCalledTimes(1); expect(h.stripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(1);
});
test("step 8: an unavailable receipt remains a failure and retry reuses the same captured payment", async () => {
  const h = harness(); h.setFailReceipt(true); await expect(h.runtime.confirmFirst(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("receipt");
  h.setFailReceipt(false); await h.runtime.confirmFirst(h.f.a.id, h.f.a.buyer_id);
  expect(h.stripe.paymentIntents.retrieve.mock.calls).toEqual([["pi_fixture"], ["pi_fixture"]]);
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("steps 1/8: another buyer cannot confirm or observe a membership", async () => {
  const h = harness(); await expect(h.runtime.confirmFirst(h.f.a.id, h.f.a.creator_id)).rejects.toThrow("Owned membership");
  expect(h.stripe.accounts.retrieve).not.toHaveBeenCalled(); expect(feeLedger).not.toHaveBeenCalled();
});
test("step 8: a missing owned agreement prevents provider reads or financial writes", async () => {
  const h = harness(); h.setVisible(false); await expect(h.runtime.confirmFirst(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow();
  expect(h.stripe.accounts.retrieve).not.toHaveBeenCalled(); expect(feeLedger).not.toHaveBeenCalled();
});
test("step 10: wrong provider account cannot authorize a receipt", async () => {
  const h = harness(); h.stripe.accounts.retrieve.mockResolvedValueOnce({ object: "account", id: "acct_other",
    lastResponse: { apiVersion: context.apiVersion, requestId: "req_fixture", headers: {}, statusCode: 200 } });
  await expect(h.runtime.confirmFirst(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("account or mode"); expect(feeLedger).not.toHaveBeenCalled();
});
test("step 10: wrong response API version cannot authorize a receipt", async () => {
  const h = harness(); h.stripe.balance.retrieve.mockResolvedValueOnce({ object: "balance", livemode: false,
    lastResponse: { apiVersion: "2025-09-30.clover", requestId: "req_fixture", headers: {}, statusCode: 200 } });
  await expect(h.runtime.confirmFirst(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("response context"); expect(feeLedger).not.toHaveBeenCalled();
});
test("steps 7/8: refund-before-confirmation uses the existing allocator before receipt credit", async () => {
  const h = harness(); h.f.charge.amount_refunded = 10000; h.f.charge.refunded = true;
  expect(await h.runtime.confirmFirst(h.f.a.id, h.f.a.buyer_id)).toMatchObject({ firstPaymentRecorded: true, accessGranted: false });
  expect(refunded).toHaveBeenCalledWith(expect.anything(), { paymentIntentId: "pi_fixture", chargeId: "ch_fixture", chargeAmountCents: 10000, refundedAmountCents: 10000 });
  expect(applied).toHaveBeenCalledTimes(1); expect(reconciled).toHaveBeenCalledTimes(1);
  const receiptIndex = h.rpc.mock.calls.findIndex(([name]) => name === "record_monthly_mentorship_receipt_v1");
  expect(h.rpc.mock.invocationCallOrder[receiptIndex]).toBeGreaterThan(applied.mock.invocationCallOrder[0]);
});
test("steps 7/8: unknown active dispute cannot credit or grant access", async () => {
  const h = harness(); h.f.charge.disputed = true; h.setDispute("needs_response");
  await expect(h.runtime.confirmFirst(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("dispute");
  expect(h.order).not.toContain("record_monthly_mentorship_receipt_v1");
});
test("steps 7/8: a reconciled won dispute permits the verified receipt", async () => {
  const h = harness(); h.f.charge.disputed = true; h.setDispute("won");
  expect(await h.runtime.confirmFirst(h.f.a.id, h.f.a.buyer_id)).toMatchObject({ firstPaymentRecorded: true });
});
test("step 8: pausing new billing still permits capture reconciliation", async () => {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_BILLING_READY = "false";
  expect(await h.runtime.confirmFirst(h.f.a.id, h.f.a.buyer_id)).toMatchObject({ firstPaymentRecorded: true });
  expect(runOperation).not.toHaveBeenCalled();
});
test("step 1: prepared checkout orders customer, product, subscription, hold, checkout and database publication", async () => {
  const h = harness(false); h.f.a.stripe_customer_id = h.f.a.stripe_subscription_id = h.f.a.stripe_checkout_session_id = null;
  const result = await h.runtime.prepare(h.f.a.id, h.f.a.buyer_id);
  expect(runOperation.mock.calls.map(([input]) => input.kind)).toEqual(["customer", "product", "subscription", "hold", "checkout"]);
  expect(h.order).toEqual(["bind_monthly_mentorship_provider_v1"]); expect(result.url).toBe(h.f.session.url);
  expect(h.stripe.customers.retrieve).toHaveBeenCalledWith("cus_fixture");
});
test("step 8: retry with a published open session returns that URL without any new create", async () => {
  const h = harness(false); expect((await h.runtime.prepare(h.f.a.id, h.f.a.buyer_id)).url).toBe(h.f.session.url);
  expect(runOperation).not.toHaveBeenCalled(); expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("step 8: stopped membership cannot open a payment link", async () => {
  const h = harness(false); h.f.a.debit_revoked_at = new Date().toISOString();
  await expect(h.runtime.prepare(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("support review"); expect(runOperation).not.toHaveBeenCalled();
});
test.each(["accepted", "version", "fingerprint"])("step 4: stale or missing %s refuses reservation before payment preparation", async field => {
  const h = harness(false); h.runtime.quote = jest.fn().mockResolvedValue(h.f.quote);
  const consent = { accepted: true, version: h.f.a.terms.version, fingerprint: h.f.a.fingerprint,
    [field]: field === "accepted" ? false : "stale" };
  await expect(h.runtime.acceptAndPrepare(h.f.a.buyer_id, h.f.a.product_id, h.f.a.post_id, consent)).rejects.toThrow("Review and accept");
  expect(h.rpc).not.toHaveBeenCalled(); expect(runOperation).not.toHaveBeenCalled();
});
test("step 4: current explicit consent is reserved durably before reusing the owned checkout", async () => {
  const h = harness(false); h.runtime.quote = jest.fn().mockResolvedValue(h.f.quote);
  await h.runtime.acceptAndPrepare(h.f.a.buyer_id, h.f.a.product_id, h.f.a.post_id,
    { accepted: true, version: h.f.a.terms.version, fingerprint: h.f.a.fingerprint });
  expect(h.rpc.mock.calls[0]).toEqual(["reserve_monthly_mentorship_v1", { p_buyer_id: h.f.a.buyer_id, p_product_id: h.f.a.product_id,
    p_post_id: h.f.a.post_id, p_terms: h.f.a.terms, p_fingerprint: h.f.a.fingerprint, p_accepted: true }]);
  expect(h.rpc.mock.invocationCallOrder[0]).toBeLessThan(h.stripe.checkout.sessions.retrieve.mock.invocationCallOrder[0]);
});
test.each(["amount", "destination", "applicationFee", "capture", "charge", "method", "balance", "paid"])(
  "steps 1/8: first-capture %s mismatch cannot be accepted", change => {
    const f = membershipFixture(true);
    if (change === "amount") f.paymentIntent.amount_received = 50;
    if (change === "destination") f.paymentIntent.transfer_data!.destination = "acct_other";
    if (change === "applicationFee") f.charge.application_fee_amount = 0;
    if (change === "capture") f.charge.captured = false;
    if (change === "charge") f.charge.payment_intent = "pi_other";
    if (change === "method") f.charge.payment_method = "pm_other";
    if (change === "balance") f.balance.source = "ch_other";
    if (change === "paid") f.session.payment_status = "unpaid";
    expect(() => inspectMembershipFirstCapture(f.a, f)).toThrow();
  });
