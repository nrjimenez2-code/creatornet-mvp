import { readExactBankChallengeSandbox, checkExactBankPaymentSandbox, createExactBankVerificationStore, type BankContext } from "../lib/installments/bankVerification";
import { exactRetryFixture } from "../test-support/exact-retry-fixture";
import type { SupabaseClient } from "@supabase/supabase-js";

async function fixture(retry = true) {
  const f = await exactRetryFixture(), now = f.args.now();
  if (retry) f.setRecord({ admittedAt: now });
  const context: BankContext = { authorization: f.f.a, paymentIntentId: f.f.pi.id, buyerId: f.args.buyerId,
    paymentMethodId: retry ? f.pm.id : f.f.a.paymentMethodId, admittedAt: now, retryId: retry ? f.args.quoteId : null };
  const bankStore = { read: jest.fn(async () => context) };
  Object.assign(f.f.pi, { payment_method: context.paymentMethodId, status: "requires_action", next_action: { type: "use_stripe_sdk" },
    confirmation_method: "automatic", capture_method: "automatic", amount_capturable: 0, canceled_at: null, on_behalf_of: null,
    client_secret: `${f.f.pi.id}_secret_SYNTHETICONLY` });
  const args = { ...f.args, bankStore, env: { ...f.env, CREATOR_EXACT_INSTALLMENTS_BANK_VERIFICATION_READY: "true",
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_SYNTHETICONLY" } };
  return { f, context, bankStore, args };
}
function noDebit(t: Awaited<ReturnType<typeof fixture>>) {
  expect(t.f.api.invoices.pay).not.toHaveBeenCalled(); expect(t.f.api.paymentIntents.confirm).not.toHaveBeenCalled();
  expect(t.f.retryStore.admit).not.toHaveBeenCalled(); expect(t.f.f.invoiceStore.admitDispatch).not.toHaveBeenCalled();
  expect(t.f.api.invoices.update).not.toHaveBeenCalled(); expect(t.f.f.creditStore.credit).not.toHaveBeenCalled();
}
test.each([false, true])("bank challenge is bound to the original PI; replacement admission=%s", async retry => {
  const t = await fixture(retry);
  expect(await readExactBankChallengeSandbox(t.args)).toEqual({ status: "bank_verification_ready", amountCents: 66633,
    paymentNumber: 2, publishableKey: "pk_test_SYNTHETICONLY", clientSecret: "pi_renewal_secret_SYNTHETICONLY" });
  expect(t.bankStore.read).toHaveBeenCalledTimes(2);
  expect(t.bankStore.read).toHaveBeenLastCalledWith(t.args.agreementId, t.args.invoiceId, t.args.buyerId, true);
  noDebit(t);
});
test.each(["wrong owner", "missing retry", "wrong admission", "wrong card", "foreign card", "live PI", "live key", "wrong amount", "wrong fee",
  "wrong destination", "partial transfer", "received money", "capturable money", "manual confirmation", "manual capture", "redirect action",
  "not requires action", "ambiguous link", "wrong invoice", "prior refund", "prior dispute", "changed default", "automatic invoice", "gate off",
  "production", "captured old charge", "changed context", "database hold"])("bank challenge rejects %s without a debit or secret", async problem => {
  const t = await fixture(), { f } = t;
  if (problem === "wrong owner") t.args.buyerId = f.card.id;
  if (problem === "missing retry") f.setRecord({ admittedAt: null });
  if (problem === "wrong admission") f.setRecord({ originalPaymentIntentId: "pi_other" });
  if (problem === "wrong card") f.f.pi.payment_method = "pm_other";
  if (problem === "foreign card") f.pm.customer = "cus_other";
  if (problem === "live PI") f.f.pi.livemode = true;
  if (problem === "live key") t.args.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_live_INVALID";
  if (problem === "wrong amount") f.f.pi.amount++;
  if (problem === "wrong fee") f.f.pi.application_fee_amount!++;
  if (problem === "wrong destination") f.f.pi.transfer_data!.destination = "acct_other";
  if (problem === "partial transfer") f.f.pi.transfer_data!.amount = 1;
  if (problem === "received money") f.f.pi.amount_received = 1;
  if (problem === "capturable money") f.f.pi.amount_capturable = 1;
  if (problem === "manual confirmation") f.f.pi.confirmation_method = "manual";
  if (problem === "manual capture") f.f.pi.capture_method = "manual";
  if (problem === "redirect action") f.f.pi.next_action = { type: "redirect_to_url" };
  if (problem === "not requires action") f.f.pi.status = "processing";
  if (problem === "ambiguous link") f.f.link.is_default = false;
  if (problem === "wrong invoice") f.f.invoice.id = "in_other";
  if (problem === "prior refund") f.f.priorCharges[0].amount_refunded = 1;
  if (problem === "prior dispute") f.f.priorCharges[0].disputed = true;
  if (problem === "changed default") f.f.f.subscription.default_payment_method = "pm_other";
  if (problem === "automatic invoice") f.f.invoice.auto_advance = true;
  if (problem === "gate off") t.args.env.CREATOR_EXACT_INSTALLMENTS_BANK_VERIFICATION_READY = "false";
  if (problem === "production") t.args.env.VERCEL_ENV = "production";
  if (problem === "captured old charge") f.f.pi.latest_charge = f.f.charge.id;
  if (problem === "changed context") t.bankStore.read.mockResolvedValueOnce(t.context).mockResolvedValueOnce({ ...t.context, admittedAt: t.context.admittedAt - 1 });
  if (problem === "database hold") t.bankStore.read.mockResolvedValueOnce(t.context).mockRejectedValueOnce(new Error("SECRET_HOLD"));
  await expect(readExactBankChallengeSandbox(t.args)).rejects.toThrow("Bank verification unavailable"); noDebit(t);
});
test.each([false, true])("server receipt check does not trust the bank UI, replacement=%s", async retry => {
  const t = await fixture(retry);
  expect(await checkExactBankPaymentSandbox(t.args)).toEqual({ status: "bank_payment_checked", outcome: "review_required" }); noDebit(t);
  t.f.f.charge.payment_method = t.context.paymentMethodId; t.f.f.markPaid();
  expect(await checkExactBankPaymentSandbox(t.args)).toEqual({ status: "bank_payment_checked", outcome: "paid_accounted" });
  expect(await checkExactBankPaymentSandbox(t.args)).toEqual({ status: "bank_payment_checked", outcome: "paid_accounted" });
  expect(t.f.api.invoices.pay).not.toHaveBeenCalled(); expect(t.f.api.paymentIntents.confirm).not.toHaveBeenCalled();
  expect(t.f.f.creditStore.credit).toHaveBeenCalledTimes(2); // real credit store is once-only; replay returns already_credited.
});
test("paid-looking PI with an incorrect fee cannot become a receipt", async () => {
  const t = await fixture(); t.f.f.charge.payment_method = t.context.paymentMethodId; t.f.f.markPaid(); t.f.f.pi.application_fee_amount!++;
  await expect(checkExactBankPaymentSandbox(t.args)).rejects.toThrow("Payment receipt is not verified"); noDebit(t);
});
test("private bank adapter passes authenticated ownership and action mode, rejects malformed evidence", async () => {
  const t = await fixture(), c = t.context;
  const rpc = jest.fn(async () => ({ data: { ...c, status: "reconcile" }, error: null }));
  const store = createExactBankVerificationStore({ rpc } as unknown as SupabaseClient);
  expect(await store.read(t.args.agreementId, t.args.invoiceId, t.args.buyerId, true)).toEqual(c);
  expect(rpc).toHaveBeenCalledWith("read_exact_installment_bank_context", { p_agreement_id: t.args.agreementId,
    p_invoice_id: t.args.invoiceId, p_buyer_id: t.args.buyerId, p_for_action: true });
  rpc.mockResolvedValueOnce({ data: { ...c, status: "prepare" }, error: null });
  await expect(store.read(t.args.agreementId, t.args.invoiceId, t.args.buyerId, false)).rejects.toThrow();
});
