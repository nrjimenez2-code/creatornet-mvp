import type Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { createExactReceiptCreditStore, creditVerifiedFirstInstallmentSandbox,
  type ExactReceiptCreditStore } from "../lib/installments/receiptCredit";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";

const purchaseId = "99999999-9999-4999-8999-999999999999";
function fixture() {
  const f = exactInstallmentFixture(); f.paid();
  const steps: string[] = [];
  const balance = { id: "txn_fixture", source: "ch_fixture", type: "charge", amount: 66633,
    currency: "usd", fee: 1962, net: 64671 } as Stripe.BalanceTransaction;
  const retrieve = jest.fn(async () => balance);
  let alreadyCredited = false;
  const creditStore = {
    bindPurchase: jest.fn(async () => { steps.push("bind"); }),
    recordRefundEvidence: jest.fn(async () => { steps.push("refund"); }),
    credit: jest.fn(async () => { steps.push("credit"); const fresh = !alreadyCredited; alreadyCredited = true; return fresh; }),
    reconcileDispute: jest.fn(async () => { steps.push("dispute"); }),
  } satisfies ExactReceiptCreditStore;
  const stripe = { ...f.stripe, balanceTransactions: { retrieve } } as unknown as
    Pick<Stripe, "checkout" | "paymentIntents" | "charges" | "balanceTransactions">;
  return { ...f, balance, retrieve, steps, creditStore,
    creditArgs: { ...f.args, stripe, sessionId: f.session.id, purchaseId, creditStore } };
}

test("verified Stripe evidence precedes the dedicated atomic credit, then preserves dispute audit", async () => {
  const f = fixture();
  expect(await creditVerifiedFirstInstallmentSandbox(f.creditArgs)).toEqual({ credited: true, paymentNumber: 1 });
  expect(f.retrieve).toHaveBeenCalledWith("txn_fixture");
  expect(f.store.recordFirstReceipt).toHaveBeenCalledTimes(1);
  expect(f.steps).toEqual(["bind", "refund", "credit", "dispute"]);
  expect(f.creditStore.bindPurchase).toHaveBeenCalledWith(f.agreement.id, purchaseId);
  expect(f.creditStore.recordRefundEvidence).toHaveBeenCalledWith("pi_fixture", "ch_fixture", 66633, 0);
  expect(f.creditStore.credit).toHaveBeenCalledWith(f.agreement.id, {
    paymentNumber: 1, chargeId: "ch_fixture", balanceTransactionId: "txn_fixture", actualStripeFeeCents: 1962,
  });
  expect(f.creditStore.reconcileDispute).toHaveBeenCalledWith("pi_fixture");
  expect(f.mocks.subscriptions.update).not.toHaveBeenCalled();
  expect(f.mocks.subscriptions.create).not.toHaveBeenCalled();
  expect(f.mocks.checkout.sessions.create).not.toHaveBeenCalled();
  expect(await creditVerifiedFirstInstallmentSandbox(f.creditArgs)).toEqual({ credited: false, paymentNumber: 1 });
  expect(f.receipts).toHaveLength(1);
});

test.each(["id", "source", "type", "currency", "amount", "fee", "fractional fee", "excessive fee", "net"])
  ("mismatched balance-transaction %s cannot record or credit anything", async (field) => {
    const f = fixture();
    if (field === "id") f.balance.id = "txn_other";
    if (field === "source") f.balance.source = "ch_other";
    if (field === "type") f.balance.type = "refund";
    if (field === "currency") f.balance.currency = "eur";
    if (field === "amount") f.balance.amount++;
    if (field === "fee") f.balance.fee = -1;
    if (field === "fractional fee") f.balance.fee = 1.1;
    if (field === "excessive fee") f.balance.fee = 100000000;
    if (field === "net") f.balance.net++;
    await expect(creditVerifiedFirstInstallmentSandbox(f.creditArgs)).rejects.toThrow("balance transaction mismatch");
    expect(f.store.recordFirstReceipt).not.toHaveBeenCalled();
    expect(f.steps).toEqual([]);
  });
test.each([null, "not-a-balance-id"])("missing or malformed balance ID %s stops before an accounting write", async (id) => {
  const f = fixture(); f.charge.balance_transaction = id;
  await expect(creditVerifiedFirstInstallmentSandbox(f.creditArgs)).rejects.toThrow("not available");
  expect(f.retrieve).not.toHaveBeenCalled(); expect(f.steps).toEqual([]);
  expect(f.store.recordFirstReceipt).not.toHaveBeenCalled();
});
test("expanded balance/charge pointers are accepted without returning their raw contents", async () => {
  const f = fixture(); f.charge.balance_transaction = f.balance; f.balance.source = f.charge;
  const result = await creditVerifiedFirstInstallmentSandbox(f.creditArgs);
  expect(result).toEqual({ credited: true, paymentNumber: 1 });
  expect(Object.keys(result)).toEqual(["credited", "paymentNumber"]);
});
test.each([10000, 66633])("captured cumulative refund %i is saved before the receipt credit", async (refunded) => {
  const f = fixture(); f.charge.amount_refunded = refunded; f.charge.refunded = refunded === 66633;
  await creditVerifiedFirstInstallmentSandbox(f.creditArgs);
  expect(f.creditStore.recordRefundEvidence).toHaveBeenCalledWith("pi_fixture", "ch_fixture", 66633, refunded);
  expect(f.steps).toEqual(["bind", "refund", "credit", "dispute"]);
});
test.each([-1, 66634, 1.5])("invalid captured refund %s cannot be credited", async (refunded) => {
  const f = fixture(); f.charge.amount_refunded = refunded;
  await expect(creditVerifiedFirstInstallmentSandbox(f.creditArgs)).rejects.toThrow("refund state");
  expect(f.steps).toEqual([]);
});
test("inconsistent full-refund flag is rejected", async () => {
  const f = fixture(); f.charge.refunded = true;
  await expect(creditVerifiedFirstInstallmentSandbox(f.creditArgs)).rejects.toThrow("refund state");
  expect(f.steps).toEqual([]);
});
test("production and unverified payment state cannot reach the credit store", async () => {
  const f = fixture(); f.env.VERCEL_ENV = "production";
  await expect(creditVerifiedFirstInstallmentSandbox(f.creditArgs)).rejects.toThrow();
  expect(f.retrieve).not.toHaveBeenCalled(); expect(f.steps).toEqual([]);
  f.env.VERCEL_ENV = "preview"; f.session.payment_status = "unpaid";
  await expect(creditVerifiedFirstInstallmentSandbox(f.creditArgs)).rejects.toThrow();
  expect(f.steps).toEqual([]);
});
test("failed purchase binding or refund persistence never attempts a credit", async () => {
  const f = fixture(); f.creditStore.bindPurchase.mockRejectedValueOnce(new Error("binding rejected"));
  await expect(creditVerifiedFirstInstallmentSandbox(f.creditArgs)).rejects.toThrow("binding rejected");
  expect(f.creditStore.credit).not.toHaveBeenCalled();
  f.creditStore.recordRefundEvidence.mockRejectedValueOnce(new Error("refund state unavailable"));
  await expect(creditVerifiedFirstInstallmentSandbox(f.creditArgs)).rejects.toThrow("refund state unavailable");
  expect(f.creditStore.credit).not.toHaveBeenCalled();
  expect((await creditVerifiedFirstInstallmentSandbox(f.creditArgs)).credited).toBe(true);
  expect(f.receipts).toHaveLength(1);
});
test("an accounting error is not treated as a successful credit", async () => {
  const f = fixture(); f.creditStore.credit.mockRejectedValueOnce(new Error("credit rejected"));
  await expect(creditVerifiedFirstInstallmentSandbox(f.creditArgs)).rejects.toThrow("credit rejected");
  expect(f.creditStore.reconcileDispute).not.toHaveBeenCalled();
});
test("a dispute-mirror failure can retry the counted receipt without a second credit", async () => {
  const f = fixture(); f.creditStore.reconcileDispute.mockRejectedValueOnce(new Error("audit unavailable"));
  await expect(creditVerifiedFirstInstallmentSandbox(f.creditArgs)).rejects.toThrow("audit unavailable");
  expect(await creditVerifiedFirstInstallmentSandbox(f.creditArgs)).toEqual({ credited: false, paymentNumber: 1 });
  expect(f.creditStore.reconcileDispute).toHaveBeenCalledTimes(2);
});
test("invalid purchase identity cannot read Stripe", async () => {
  const f = fixture(); f.creditArgs.purchaseId = "wrong";
  await expect(creditVerifiedFirstInstallmentSandbox(f.creditArgs)).rejects.toThrow();
  expect(f.mocks.checkout.sessions.retrieve).not.toHaveBeenCalled();
});

test.each([
  {paymentIntentId:"pi_other",chargeId:"ch_fixture"},
  {paymentIntentId:"pi_fixture",chargeId:"ch_other"},
])("secondary event identities must match fresh receipt before any write: %j",async(expectedPayment)=>{
  const f=fixture();
  await expect(creditVerifiedFirstInstallmentSandbox({...f.creditArgs,expectedPayment})).rejects.toThrow("event identity mismatch");
  expect(f.store.recordFirstReceipt).not.toHaveBeenCalled();expect(f.steps).toEqual([]);
  expect(f.retrieve).not.toHaveBeenCalled();
});

test.each([
  {paymentIntentId:"invalid",chargeId:"ch_fixture"},
  {paymentIntentId:"pi_fixture",chargeId:"invalid"},
])("malformed expected payment identity stops before provider reads: %j",async(expectedPayment)=>{
  const f=fixture();
  await expect(creditVerifiedFirstInstallmentSandbox({...f.creditArgs,expectedPayment})).rejects.toThrow("Invalid expected");
  expect(f.mocks.checkout.sessions.retrieve).not.toHaveBeenCalled();expect(f.steps).toEqual([]);
});

// Real Supabase request builder, local fetch double only. Never contacts a host
// or uses a real credential. SQL behavior is tested separately with PGlite.
function adapterFixture() {
  const calls: { path: string; method: string; body: Record<string, unknown> | null }[] = [];
  let result: unknown = true; let status = 200;
  const localFetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: new URL(String(input)).pathname, method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(result), { status, headers: { "content-type": "application/json" } });
  });
  const admin = createClient("https://fixture.invalid", "synthetic-not-a-key", {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, global: { fetch: localFetch },
  });
  return { calls, localFetch, adapter: createExactReceiptCreditStore(admin),
    response: (value: unknown, code = 200) => { result = value; status = code; } };
}
const agreementId = "77777777-7777-4777-8777-777777777777";
const audit = { paymentNumber: 1, chargeId: "ch_fixture", balanceTransactionId: "txn_fixture", actualStripeFeeCents: 1962 };
test("adapter binds only the explicit IDs; no caller-provided earnings arithmetic", async () => {
  const f = adapterFixture(); f.response(null);
  await f.adapter.bindPurchase(agreementId, purchaseId);
  expect(f.calls[0]).toEqual({ path: "/rest/v1/rpc/bind_exact_installment_purchase", method: "POST",
    body: { p_agreement_id: agreementId, p_purchase_id: purchaseId } });
});
test.each([true, false])("adapter preserves the scalar %s once-only credit result", async (value) => {
  const f = adapterFixture(); f.response(value);
  expect(await f.adapter.credit(agreementId, audit)).toBe(value);
  expect(f.calls[0]).toEqual({ path: "/rest/v1/rpc/credit_exact_installment_receipt", method: "POST",
    body: { p_agreement_id: agreementId, p_payment_number: 1, p_charge_id: "ch_fixture",
      p_balance_transaction_id: "txn_fixture", p_actual_stripe_fee_cents: 1962 } });
});
test.each([null, "true", [], { credited: true }])("adapter rejects ambiguous credit response %#", async (response) => {
  const f = adapterFixture(); f.response(response);
  await expect(f.adapter.credit(agreementId, audit)).rejects.toThrow("Invalid exact receipt credit response");
});
test.each([10000, "10000", 66633])("cumulative refund evidence %s preserves a higher prior refund", async (response) => {
  const f = adapterFixture(); f.response(response);
  await f.adapter.recordRefundEvidence("pi_fixture", "ch_fixture", 66633, 10000);
  expect(f.calls[0]).toMatchObject({ path: "/rest/v1/rpc/record_payment_refund_state", body: {
    p_payment_intent_id: "pi_fixture", p_charge_id: "ch_fixture", p_charge_amount_cents: 66633, p_refunded_amount_cents: 10000,
  } });
});
test.each([null, 9999, 66634, "NaN", "10000.1", {}])("invalid cumulative refund response %# blocks crediting", async (response) => {
  const f = adapterFixture(); f.response(response);
  await expect(f.adapter.recordRefundEvidence("pi_fixture", "ch_fixture", 66633, 10000)).rejects.toThrow("Invalid cumulative refund");
});
test("adapter redacts raw database errors", async () => {
  const f = adapterFixture(); f.response({ message: "synthetic-sensitive-details", code: "42501" }, 403);
  await expect(f.adapter.credit(agreementId, audit)).rejects.toThrow(
    "Exact receipt operation failed: credit_exact_installment_receipt");
  await expect(f.adapter.reconcileDispute("pi_fixture")).rejects.toThrow("Exact receipt dispute reconciliation failed");
});
test("dispute reconciliation uses the serialized exact audit RPC, never a stale direct ledger PATCH", async () => {
  const f = adapterFixture(); f.response(null);
  await f.adapter.reconcileDispute("pi_fixture");
  expect(f.calls).toEqual([{path:"/rest/v1/rpc/reconcile_exact_installment_dispute_audit",method:"POST",
    body:{p_payment_intent_id:"pi_fixture"}}]);
});
