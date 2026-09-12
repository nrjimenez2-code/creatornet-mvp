import type Stripe from "stripe";
jest.mock("@/lib/paymentDisputes", () => ({ reconcileKnownPaymentDispute: jest.fn() }));
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMembershipPayoffRuntime } from "@/lib/membershipPayoffRuntime";
import { membershipPayoffFixture, payoffTestEnv } from "../test-support/membership-payoff-fixtures";
import { membershipTestContext as context } from "../test-support/membership-fixtures";
const mockLedger = jest.fn(), mockRefund = jest.fn(), mockApplyRefund = jest.fn(), mockReconcileRefund = jest.fn();
jest.mock("@/lib/paymentFeeLedger", () => ({ recordPaymentFeeLedger: (...args: unknown[]) => mockLedger(...args) }));
jest.mock("@/lib/paymentRefunds", () => ({ recordPaymentRefundState: (...args: unknown[]) => mockRefund(...args),
  applyPaymentRefundState: (...args: unknown[]) => mockApplyRefund(...args), reconcileKnownPaymentRefund: (...args: unknown[]) => mockReconcileRefund(...args) }));
beforeEach(() => { jest.clearAllMocks(); mockLedger.mockResolvedValue("20000000-0000-4000-8000-000000000009");
  mockRefund.mockResolvedValue({ synthetic: true }); mockApplyRefund.mockResolvedValue(undefined); mockReconcileRefund.mockResolvedValue(undefined); });
function harness(paid = false) {
  const f = membershipPayoffFixture(paid), env: Record<string, string | undefined> = { ...payoffTestEnv }, trace: string[] = [];
  let hasPayoff = true, review = false, publicationFails = false, receiptFails = false, quoteBad = false, refunded = false;
  const response = <T>(v: T) => Object.assign(v as object, { lastResponse: { requestId: "req_payofffixture", apiVersion: context.apiVersion } }) as Stripe.Response<T>;
  const from = jest.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const q: { select: jest.Mock; eq: jest.Mock; neq: jest.Mock; maybeSingle: jest.Mock } = {
      select: jest.fn(() => q), eq: jest.fn((k: string, v: unknown) => { filters[k] = v; return q; }), neq: jest.fn(() => q),
      maybeSingle: jest.fn(async () => ({ data: table === "monthly_mentorship_payoffs_v1" ? hasPayoff ? f.p : null :
        table === "payment_fee_ledger" ? { dispute_status: "won" } : null, error: null })) };
    return q;
  });
  const rpc = jest.fn(async (name: string, params: Record<string, unknown>) => {
    trace.push(name);
    if (name === "read_monthly_mentorship_exit_quote_v1") return { data: f.p.status === "captured" ?
      { ...f.exitQuote, coveredMonths: 3, remainingMonths: 0, payoffAmountCents: 0, paidThrough: refunded ? null : f.p.terms.periodEnd } :
      { ...f.exitQuote, reviewReasons: quoteBad ? ["refund_or_payment_review"] : [] }, error: null };
    if (name === "reserve_monthly_mentorship_payoff_v1") { hasPayoff = true; return { data: f.p, error: null }; }
    if (name === "claim_monthly_mentorship_payoff_checkout_v1") {
      f.p.status = review ? "review_required" : "checkout_dispatched"; f.p.checkout_request = params.p_request as Record<string, unknown>;
      f.p.checkout_dispatched_at = new Date().toISOString(); return { data: f.p, error: null };
    }
    if (name === "bind_monthly_mentorship_payoff_checkout_v1") {
      if (publicationFails) return { data: null, error: Error("Synthetic publication failure") };
      f.p.stripe_checkout_session_id = String(params.p_session_id); f.p.status = "checkout_ready"; return { data: true, error: null };
    }
    if (name === "record_monthly_mentorship_payoff_v1") {
      if (receiptFails) return { data: null, error: Error("Synthetic receipt failure") };
      f.p.status = "captured"; return { data: true, error: null };
    }
    if (name === "request_monthly_mentorship_exit_v1") return { data: { id: "20000000-0000-4000-8000-000000000008",
      agreement_id: f.a.id, buyer_id: f.a.buyer_id, kind: "stop_renewal" }, error: null };
    if (name === "claim_monthly_mentorship_exit_stop_v1") return { data: { id: params.p_exit_id, status: "dispatching" }, error: null };
    if (name === "read_monthly_mentorship_entitlement_v1") return { data: { allowed: !refunded }, error: null };
    if (name === "abandon_monthly_mentorship_payoff_v1") f.p.status = "abandoned";
    return { data: true, error: null };
  });
  const stripe = {
    checkout: { sessions: { retrieve: jest.fn(async () => response(f.session)), create: jest.fn(async () => response(f.session)),
      list: jest.fn(async () => response({ data: [] as Stripe.Checkout.Session[], has_more: false })),
      expire: jest.fn(async () => { f.session.status = "expired"; return response(f.session); }) } },
    paymentIntents: { retrieve: jest.fn(async () => response(f.pi)), cancel: jest.fn(async () => { f.pi.status = "canceled"; return response(f.pi); }) },
    charges: { retrieve: jest.fn(async () => response(f.charge)) }, balanceTransactions: { retrieve: jest.fn(async () => response(f.balance)) },
    subscriptions: { retrieve: jest.fn(async () => response(f.subscription)), cancel: jest.fn(async () => { f.subscription.status = "canceled"; return response(f.subscription); }) },
  };
  const load = jest.fn(async () => f.a), observeContext = jest.fn(async () => context);
  const runtime = createMembershipPayoffRuntime({ admin: { from, rpc } as unknown as SupabaseClient, stripe: stripe as unknown as Stripe,
    context, env, checked: async <T>(p: Promise<Stripe.Response<T>>) => p, load, observeContext, productId: async () => f.product.id });
  const consent = { accepted: true, version: f.p.terms.version, fingerprint: f.p.fingerprint };
  return { f, env, rpc, stripe, load, observeContext, trace, runtime, consent, fresh: () => {
    hasPayoff = false; f.p.status = "accepted"; f.p.checkout_request = null; f.p.checkout_dispatched_at = null; f.p.stripe_checkout_session_id = null;
  }, review: () => { review = true; }, publicationFailure: () => { publicationFails = true; }, receiptFailure: () => { receiptFails = true; },
    unsent: () => { f.p.status = "accepted"; f.p.checkout_request = null; f.p.checkout_dispatched_at = null; f.p.stripe_checkout_session_id = null; },
    lostResult: () => { f.p.status = "review_required"; f.p.stripe_checkout_session_id = null; },
    badQuote: () => { quoteBad = true; }, refunded: () => { refunded = true; f.charge.amount_refunded = f.charge.amount; } };
}
const prepare = (h: ReturnType<typeof harness>) => h.runtime.acceptAndPreparePayoff(h.f.a.id, h.f.a.buyer_id, h.consent);
const confirm = (h: ReturnType<typeof harness>) => h.runtime.confirmPayoff(h.f.a.id, h.f.a.buyer_id, h.f.p.id);
test("steps 2/4: separately accepted payoff creates one admitted checkout and binds it before returning", async () => {
  const h = harness(); h.fresh(); const result = await prepare(h); expect(result.url).toBe(h.f.session.url);
  expect(h.stripe.checkout.sessions.create).toHaveBeenCalledWith(h.f.p.checkout_request,
    { idempotencyKey: `creatornet-membership-payoff:${h.f.p.id}`, maxNetworkRetries: 0 });
  expect(h.rpc).toHaveBeenCalledWith("bind_monthly_mentorship_payoff_checkout_v1", expect.objectContaining({ p_session_id: h.f.session.id }));
});
test("step 8: repeated acceptance reuses the bound open checkout without creating another", async () => {
  const h = harness(); expect((await prepare(h)).url).toBe(h.f.session.url); expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("step 8: a lost creation result is recovered from one actual owned provider checkout without another create", async () => {
  const h = harness(); h.lostResult(); h.stripe.checkout.sessions.list.mockResolvedValueOnce({ data: [h.f.session], has_more: false } as never);
  expect((await prepare(h)).url).toBe(h.f.session.url); expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(h.rpc).toHaveBeenCalledWith("bind_monthly_mentorship_payoff_checkout_v1", expect.objectContaining({ p_session_id: h.f.session.id }));
});
test("step 8: missing provider search result is not treated as proof that an unknown payment can be abandoned", async () => {
  const h = harness(); h.lostResult(); await expect(h.runtime.abandonPayoff(h.f.a.id, h.f.a.buyer_id, h.f.p.id, true)).rejects.toThrow("Unknown payoff checkout");
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(h.rpc.mock.calls.some(([name]) => name === "abandon_monthly_mentorship_payoff_v1")).toBe(false);
});
test("step 8: multiple provider matches cannot be guessed into one payable result", async () => {
  const h = harness(); h.lostResult(); h.stripe.checkout.sessions.list.mockResolvedValueOnce({ data: [h.f.session, { ...h.f.session, id: "cs_duplicate" }], has_more: false } as never);
  await expect(prepare(h)).rejects.toThrow("More than one"); expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("step 4: absent or stale consent cannot reach the reservation or payment provider", async () => {
  const h = harness(); await expect(h.runtime.acceptAndPreparePayoff(h.f.a.id, h.f.a.buyer_id, { ...h.consent, accepted: false })).rejects.toThrow("Separate");
  await expect(h.runtime.acceptAndPreparePayoff(h.f.a.id, h.f.a.buyer_id, { ...h.consent, fingerprint: "bad" })).rejects.toThrow("quote changed");
  expect(h.rpc).not.toHaveBeenCalled(); expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("step 10: a disabled new-payoff gate cannot create a new charge opportunity", async () => {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_READY = "false"; await expect(prepare(h)).rejects.toThrow("not enabled");
  expect(h.load).not.toHaveBeenCalled();
});
test("step 2: pausing new payoff checkout preserves the existing buyer's recovery view", async () => {
  const h = harness(); h.env.CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_READY = "false";
  expect(await h.runtime.quotePayoff(h.f.a.id, h.f.a.buyer_id)).toMatchObject({ payoffId: h.f.p.id, checkoutEnabled: false });
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("step 10: paused checkout cannot offer a new payoff when no accepted one exists", async () => {
  const h = harness(); h.fresh(); h.env.CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_READY = "false";
  await expect(h.runtime.quotePayoff(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("not enabled"); expect(h.rpc).not.toHaveBeenCalled();
});
test("step 8: an uncertain checkout creation outside the allowed window is not retried", async () => {
  const h = harness(); h.fresh(); h.review(); await expect(prepare(h)).rejects.toThrow("reconciliation");
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("step 8: failed provider publication cannot leak an unbound payable URL", async () => {
  const h = harness(); h.fresh(); h.publicationFailure(); await expect(prepare(h)).rejects.toThrow("publication");
});
test("step 8: changed financial state blocks a saved open checkout URL from being reissued", async () => {
  const h = harness(); h.badQuote(); await expect(prepare(h)).rejects.toThrow("balance changed"); expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("step 2: prior debit revocation permits only this separate buyer-confirmed payoff, not resumed monthly authority", async () => {
  const h = harness(); h.f.a.debit_revoked_at = new Date().toISOString(); h.f.subscription.status = "canceled";
  expect((await prepare(h)).url).toBe(h.f.session.url); expect(h.f.a.debit_revoked_at).not.toBeNull();
});
test("steps 2/7: captured payoff uses the existing ledger/refund engine and durable stop request", async () => {
  const h = harness(true), result = await confirm(h);
  expect(result).toMatchObject({ payoffRecorded: true, accessGranted: true, paidThrough: h.f.p.terms.periodEnd, providerStopped: true });
  expect(mockLedger).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ purchaseId: h.f.a.purchase_id,
    paymentIntentId: h.f.pi.id, breakdown: h.f.p.terms.fees }), true);
  expect(mockReconcileRefund).toHaveBeenCalledWith(expect.anything(), h.f.pi.id);
  expect(h.stripe.subscriptions.cancel).toHaveBeenCalledWith(h.f.a.stripe_subscription_id, { invoice_now: false, prorate: false }, expect.anything());
});
test("step 8: confirmation is reconciliation-only even when new-payoff checkout is disabled", async () => {
  const h = harness(true); h.env.CREATOR_MONTHLY_MENTORSHIPS_PAYOFF_READY = "false"; expect((await confirm(h)).payoffRecorded).toBe(true);
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("step 8: pending payment is not a receipt or a new payment attempt", async () => {
  const h = harness(); expect(await confirm(h)).toMatchObject({ payoffRecorded: false, accessGranted: false });
  expect(mockLedger).not.toHaveBeenCalled(); expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
});
test("step 7: already refunded payoff is reconciled before admission and not described as paid-through service", async () => {
  const h = harness(true); h.refunded(); const result = await confirm(h);
  expect(mockRefund).toHaveBeenCalled(); expect(mockApplyRefund).toHaveBeenCalled(); expect(result).toMatchObject({ accessGranted: false, paidThrough: null });
});
test("step 8: failed receipt admission does not claim the minimum is paid", async () => {
  const h = harness(true); h.receiptFailure(); await expect(confirm(h)).rejects.toThrow("receipt needs");
  expect(h.stripe.subscriptions.cancel).not.toHaveBeenCalled();
});
test("step 2: undispatched payoff can be abandoned without provider work", async () => {
  const h = harness(); h.unsent();
  expect(await h.runtime.abandonPayoff(h.f.a.id, h.f.a.buyer_id, h.f.p.id, true)).toMatchObject({ status: "abandoned" });
  expect(h.rpc).toHaveBeenCalledWith("abandon_monthly_mentorship_payoff_v1", expect.objectContaining({
    p_proof: { paymentContext: context, neverDispatched: true } }));
  expect(h.stripe.checkout.sessions.retrieve).not.toHaveBeenCalled(); expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
});
test("step 8: expiration plus a canceled uncaptured PaymentIntent safely releases a known payoff", async () => {
  const h = harness(); h.f.session.payment_intent = h.f.pi.id;
  const result = await h.runtime.abandonPayoff(h.f.a.id, h.f.a.buyer_id, h.f.p.id, true);
  expect(result).toMatchObject({ status: "abandoned", originalMonthlyPaymentsMayResume: true });
  expect(h.stripe.checkout.sessions.expire).toHaveBeenCalledTimes(1); expect(h.stripe.paymentIntents.cancel).toHaveBeenCalledTimes(1);
  expect(h.rpc).toHaveBeenCalledWith("abandon_monthly_mentorship_payoff_v1", expect.objectContaining({ p_proof: expect.objectContaining({
    sessionStatus: "expired", paymentIntentStatus: "canceled", amountReceived: 0 }) }));
});
test("step 8: a processing payment cannot release the payoff hold", async () => {
  const h = harness(); h.f.session.payment_intent = h.f.pi.id; h.f.pi.status = "processing";
  await expect(h.runtime.abandonPayoff(h.f.a.id, h.f.a.buyer_id, h.f.p.id, true)).rejects.toThrow("still in flight");
  expect(h.rpc.mock.calls.some(([name]) => name === "abandon_monthly_mentorship_payoff_v1")).toBe(false);
});
test("step 2: abandonment cannot undo an earlier debit revocation", async () => {
  const h = harness(); h.f.a.debit_revoked_at = new Date().toISOString();
  expect(await h.runtime.abandonPayoff(h.f.a.id, h.f.a.buyer_id, h.f.p.id, true)).toMatchObject({ originalMonthlyPaymentsMayResume: false });
});
test("step 8: paid-while-abandoning is reconciled as real money, not discarded", async () => {
  const h = harness(true); const result = await h.runtime.abandonPayoff(h.f.a.id, h.f.a.buyer_id, h.f.p.id, true);
  expect(result).toMatchObject({ status: "already_paid", payoffRecorded: true }); expect(h.stripe.checkout.sessions.expire).not.toHaveBeenCalled();
});
