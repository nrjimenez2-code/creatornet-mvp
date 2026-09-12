import { recordVerifiedFirstInstallment } from "../lib/installments/firstReceipt";
import { exactInstallmentFixture } from "../test-support/exact-installment-fixture";

function fixture() {
  const f = exactInstallmentFixture();
  f.paid();
  return { ...f, receiptArgs: { ...f.args, sessionId: f.session.id } };
}

test("verifies Stripe Checkout, intent and captured card charge then records one receipt", async () => {
  const f = fixture();
  const result = await recordVerifiedFirstInstallment(f.receiptArgs);
  expect(result).toEqual({ recorded: true, receipt: { sessionId: "cs_test_fixture", paymentIntentId: "pi_fixture",
    amountCents: 66633, applicationFeeCents: 9958, paidAt: f.charge.created } });
  expect(f.mocks.checkout.sessions.retrieve).toHaveBeenCalledWith("cs_test_fixture");
  expect(f.mocks.paymentIntents.retrieve).toHaveBeenCalledWith("pi_fixture");
  expect(f.mocks.charges.retrieve).toHaveBeenCalledWith("ch_fixture");
  expect((await recordVerifiedFirstInstallment(f.receiptArgs)).recorded).toBe(false);
  expect(f.receipts).toHaveLength(1);
  expect((await f.store.load()).status).toBe("awaiting_first");
  expect(f.store.bind).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("synthetic-never-return");
  expect(JSON.stringify(result)).not.toContain("checkout.stripe.com");
});

test.each(["unbound", "canceled", "wrong session", "production"])("rejects %s before reading Stripe", async (change) => {
  const f = fixture();
  if (change === "unbound") f.setAgreement({ status: "preparing", sessionId: null });
  if (change === "canceled") f.setAgreement({ status: "canceled" });
  if (change === "wrong session") f.receiptArgs.sessionId = "cs_test_other";
  if (change === "production") f.env.VERCEL_ENV = "production";
  await expect(recordVerifiedFirstInstallment(f.receiptArgs)).rejects.toThrow();
  expect(f.mocks.checkout.sessions.retrieve).not.toHaveBeenCalled();
  expect(f.store.recordFirstReceipt).not.toHaveBeenCalled();
});

test.each(["unpaid", "wrong amount", "live", "discount", "wrong buyer", "wrong subscription"])
  ("rejects %s Checkout without recording anything", async (change) => {
    const f = fixture();
    if (change === "unpaid") f.session.payment_status = "unpaid";
    if (change === "wrong amount") f.session.amount_total = 199900;
    if (change === "live") f.session.livemode = true;
    if (change === "discount") f.session.total_details!.amount_discount = 1;
    if (change === "wrong buyer") f.session.customer = "cus_other";
    if (change === "wrong subscription") f.session.metadata = { ...f.session.metadata, installment_subscription_id: "sub_other" };
    await expect(recordVerifiedFirstInstallment(f.receiptArgs)).rejects.toThrow();
    expect(f.store.recordFirstReceipt).not.toHaveBeenCalled();
  });

test.each(["fee", "received", "destination", "transfer override", "currency", "live", "status", "reuse", "metadata"])
  ("rejects actual intent %s mismatch", async (change) => {
    const f = fixture();
    if (change === "fee") f.pi.application_fee_amount = 10425;
    if (change === "received") f.pi.amount_received = 0;
    if (change === "destination") f.pi.transfer_data!.destination = "acct_other";
    if (change === "transfer override") f.pi.transfer_data!.amount = 1;
    if (change === "currency") f.pi.currency = "eur";
    if (change === "live") f.pi.livemode = true;
    if (change === "status") f.pi.status = "requires_action";
    if (change === "reuse") f.pi.setup_future_usage = null;
    if (change === "metadata") f.pi.metadata = { ...f.pi.metadata, installment_number: "2" };
    await expect(recordVerifiedFirstInstallment(f.receiptArgs)).rejects.toThrow();
    expect(f.store.recordFirstReceipt).not.toHaveBeenCalled();
  });

test.each(["uncaptured", "unpaid", "wrong intent", "partial capture", "noncard", "predates agreement"])
  ("rejects %s charge", async (change) => {
    const f = fixture();
    if (change === "uncaptured") f.charge.captured = false;
    if (change === "unpaid") f.charge.paid = false;
    if (change === "wrong intent") f.charge.payment_intent = "pi_other";
    if (change === "partial capture") f.charge.amount_captured = 1;
    if (change === "noncard") f.charge.payment_method_details!.type = "us_bank_account";
    if (change === "predates agreement") f.charge.created = f.agreement.createdAt - 1;
    await expect(recordVerifiedFirstInstallment(f.receiptArgs)).rejects.toThrow();
    expect(f.store.recordFirstReceipt).not.toHaveBeenCalled();
  });

test("a later refund does not rewrite historical receipt evidence or grant access", async () => {
  const f = fixture();
  f.charge.refunded = true; f.charge.amount_refunded = 66633;
  expect((await recordVerifiedFirstInstallment(f.receiptArgs)).recorded).toBe(true);
  expect((await f.store.load()).status).toBe("awaiting_first");
  expect(f.store.bind).not.toHaveBeenCalled();
  expect(f.mocks.subscriptions.update).not.toHaveBeenCalled();
});
