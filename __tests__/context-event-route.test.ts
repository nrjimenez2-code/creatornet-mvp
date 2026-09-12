import type Stripe from "stripe";
import { handoffExactInstallmentWebhook } from "../lib/installments/routeHandoff";
import { handoffContextInstallmentEvent } from "../lib/installments/contextEventRoute";
import { dispatchExactInstallmentEventSandbox } from "../lib/installments/eventBridge";
import { exactContextServerConfig } from "../lib/installments/contextServer";
const res = "11111111-1111-4111-8111-111111111111", actor = "22222222-2222-4222-8222-222222222222";
const buyer = "33333333-3333-4333-8333-333333333333";
const ctx = { version: "exact-payment-context-v1", mode: "test", platformAccountId: "acct_LocalCheckout",
  supabaseProjectRef: "aaaaaaaaaaaaaaaaaaaa", siteOrigin: "https://synthetic-checkout.vercel.app" };
const cfg = { approvedContext: ctx, expectedApiVersion: "2025-10-29.clover" };
const inspect = jest.fn(), credit = jest.fn(), activate = jest.fn(), bootstrap = jest.fn(), collect = jest.fn(), reconcile = jest.fn(), financial = jest.fn(), subscription = jest.fn(), recovery = jest.fn();
const bankObserve = jest.fn(), bankCheck = jest.fn();
const unpaid = jest.fn();

test.each(["2025-09-30.clover", "2025-10-29.clover"])("compatible %s first completion retains original capture and credit ordering", async version => {
  const a = args("checkout.session.completed"); a.event.api_version = version;
  const snapshot = JSON.stringify(a.event);
  expect(await handoffExactInstallmentWebhook(a)).toBe(true);
  expect(inspect).toHaveBeenCalledWith(res, actor);
  expect(credit).toHaveBeenCalledTimes(1); expect(activate).toHaveBeenCalledTimes(1);
  expect(inspect.mock.invocationCallOrder[0]).toBeLessThan(credit.mock.invocationCallOrder[0]);
  expect(credit.mock.invocationCallOrder[0]).toBeLessThan(activate.mock.invocationCallOrder[0]);
  expect(collect).not.toHaveBeenCalled(); expect(dispatchExactInstallmentEventSandbox).not.toHaveBeenCalled();
  expect(JSON.stringify(a.event)).toBe(snapshot);
});

test.each(["version", "account", "context", "mode", "owner", "receipt"])("September compatibility still rejects %s before credit or legacy fallback", async fault => {
  const a = args("checkout.session.completed"); a.event.api_version = "2025-09-30.clover";
  if (fault === "version") a.event.api_version = "2025-11-17.clover";
  if (fault === "account") a.event.account = "acct_Foreign";
  if (fault === "context") Object.assign(a.event, { context: "acct_Foreign" });
  if (fault === "mode") a.event.livemode = true;
  if (fault === "owner") binding!.customerId = "cus_Foreign";
  if (fault === "receipt") inspect.mockResolvedValue({ receipt: { session_id: "cs_test_Foreign", payment_intent_id: "pi_Foreign" } });
  await expect(handoffExactInstallmentWebhook(a)).rejects.toThrow();
  expect(credit).not.toHaveBeenCalled(); expect(collect).not.toHaveBeenCalled();
  expect(dispatchExactInstallmentEventSandbox).not.toHaveBeenCalled();
});

test.each(["invoice.updated", "payment_intent.requires_action", "payment_intent.canceled"])("unselected %s is not silently acknowledged by version compatibility", async type => {
  const a = args(type); a.event.api_version = "2025-09-30.clover"; binding!.firstCredited = true;
  if (type.startsWith("payment_intent.")) a.event.data.object = { object: "payment_intent", id: "pi_Local", customer: "cus_Local", metadata: {} } as never;
  await expect(handoffExactInstallmentWebhook(a)).rejects.toThrow("retry or review");
  for (const fn of [credit, collect, bankCheck, bankObserve, recovery, dispatchExactInstallmentEventSandbox]) expect(fn).not.toHaveBeenCalled();
});
jest.mock("../lib/installments/contextRuntime", () => ({
  createExactContextCheckout: () => ({ inspectFirstPayment: inspect, inspectBootstrapInvoice: bootstrap, inspectUnpaidCheckout: unpaid }),
  createExactContextFirstCredit: () => ({ creditFirstPayment: credit }), createExactContextActivation: () => ({ activateHeld: activate }),
  createExactContextInvoiceCollection: () => ({ collectInvoice: collect, reconcileInvoice: reconcile }),
  createExactContextFinancialEvents: () => ({ reconcileEvent: financial }),
  createExactContextSubscriptionObservation: () => ({ observeSubscription: subscription }),
  createExactContextPaymentRecovery: () => ({ recoverInvoice: recovery }),
  createExactContextBankVerification: () => ({ observeInvoice: bankObserve, checkPayment: bankCheck }),
}));
jest.mock("../lib/installments/contextServer", () => ({ exactContextServerConfig: jest.fn(() => cfg) }));
jest.mock("../lib/installments/eventBridge", () => ({ createExactEventBindingStore: jest.fn(), dispatchExactInstallmentEventSandbox: jest.fn() }));
let binding: Record<string, unknown> | null;
const rpc = jest.fn(async () => ({ data: binding, error: null }));
const env = { CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY: "true", CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY: "true",
  CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_READY: "true" };
function event(type: string): Stripe.Event {
  const metadata = { installment_collection_version: "exact-cents-context-v2", installment_plan_id: res };
  const object = type.startsWith("invoice.") ? { object: "invoice", id: "in_Local", customer: "cus_Local",
    parent: { subscription_details: { subscription: "sub_Local", metadata } } } : type.startsWith("customer.subscription.") ?
    { object: "subscription", id: "sub_Local", customer: "cus_Local", metadata } : type.startsWith("refund.") ?
    { object: "refund", id: "re_Local", payment_intent: "pi_Local", charge: "ch_Local", metadata } :
    { object: "checkout.session", id: "cs_test_Local", customer: "cus_Local", metadata };
  return { object: "event", id: "evt_Local", livemode: false, api_version: cfg.expectedApiVersion, type, data: { object } } as unknown as Stripe.Event;
}
function args(type: string) { return { event: event(type), admin: { rpc } as never, stripe: {} as Stripe, env }; }
beforeEach(() => {
  jest.clearAllMocks(); binding = { reservationId: res, creatorId: actor, buyerId: buyer, context: ctx, sessionId: "cs_test_Local",
    subscriptionId: "sub_Local", customerId: "cus_Local", firstIntentId: null, firstCredited: false, invoiceId: null, paymentNumber: null };
  rpc.mockImplementation(async () => ({ data: binding, error: null }));
  jest.mocked(exactContextServerConfig).mockImplementation(() => cfg as never);
  bootstrap.mockResolvedValue({ status: "not_bootstrap" }); inspect.mockResolvedValue({ receipt: { session_id: "cs_test_Local", payment_intent_id: "pi_Local" } });
  credit.mockResolvedValue({ status: "first_payment_fulfilled" }); activate.mockResolvedValue({ status: "activated_held" });
  collect.mockResolvedValue({ status: "credited" }); reconcile.mockResolvedValue({ status: "already_credited" });
  financial.mockResolvedValue({ status: "refund_reconciled" }); subscription.mockResolvedValue({ status: "lifecycle_observed" }); recovery.mockResolvedValue({ status: "payment_recovery_recorded" });
  bankObserve.mockResolvedValue({ status: "already_credited" }); bankCheck.mockResolvedValue({ status: "credited" });
  unpaid.mockResolvedValue({ status: "checkout_unpaid_observed", sessionId: "cs_test_Local", sessionStatus: "expired", paymentIntentId: null });
});

test.each(["invoice.created", "invoice.paid", "invoice.payment_failed", "refund.created", "customer.subscription.updated"])(
  "#2 %s before first credit is retryable and cannot enter legacy accounting", async type => {
    await expect(handoffExactInstallmentWebhook(args(type))).rejects.toThrow("retry or review");
    for (const fn of [credit, collect, reconcile, financial, subscription, recovery, dispatchExactInstallmentEventSandbox]) expect(fn).not.toHaveBeenCalled();
    binding!.firstCredited = true;
    expect(await handoffExactInstallmentWebhook(args(type))).toBe(true);
    expect(dispatchExactInstallmentEventSandbox).not.toHaveBeenCalled();
  });
test("#2 bootstrap-zero ACK is not first credit, collection or activation", async () => {
  bootstrap.mockResolvedValue({ status: "bootstrap_zero" });
  expect(await handoffExactInstallmentWebhook(args("invoice.paid"))).toBe(true);
  for (const fn of [credit, activate, collect, reconcile]) expect(fn).not.toHaveBeenCalled();
});
test("#2/#3 first completion uses inspected payment, once-only credit then held activation", async () => {
  expect(await handoffExactInstallmentWebhook(args("checkout.session.completed"))).toBe(true);
  expect(credit).toHaveBeenCalledWith(res, actor); expect(activate).toHaveBeenCalledWith(res, actor);
  expect(inspect.mock.invocationCallOrder[0]).toBeLessThan(credit.mock.invocationCallOrder[0]);
  expect(credit.mock.invocationCallOrder[0]).toBeLessThan(activate.mock.invocationCallOrder[0]);
  expect(collect).not.toHaveBeenCalled(); expect(dispatchExactInstallmentEventSandbox).not.toHaveBeenCalled();
});
test.each(["proof", "mode", "context", "missing", "disabled"])("#2/#3 %s mismatch never falls back or credits", async fault => {
  const a = args("checkout.session.completed");
  if (fault === "proof") inspect.mockResolvedValue({ receipt: { session_id: "cs_test_Foreign", payment_intent_id: "pi_Foreign" } });
  if (fault === "mode") a.event.livemode = true;
  if (fault === "context") binding!.context = { ...ctx, platformAccountId: "acct_Foreign" };
  if (fault === "missing") binding = null;
  if (fault === "disabled") jest.mocked(exactContextServerConfig).mockImplementation(() => { throw Error("Disabled context"); });
  await expect(handoffExactInstallmentWebhook(a)).rejects.toThrow();
  expect(credit).not.toHaveBeenCalled(); expect(collect).not.toHaveBeenCalled(); expect(dispatchExactInstallmentEventSandbox).not.toHaveBeenCalled();
});
test.each(["invoice.paid", "invoice.payment_succeeded"])("#3 %s cannot acquire collection authority", async type => {
  binding!.firstCredited = true;
  expect(await handoffContextInstallmentEvent(args(type))).toBe(true);
  expect(bankObserve).toHaveBeenCalledWith(res, buyer, "in_Local", "evt_Local");
  expect(reconcile).not.toHaveBeenCalled(); expect(collect).not.toHaveBeenCalled();
});

test.each(["reconciliation_required", "paid_accounted", "declined"])("#3 paid event recovery outcome %s never starts collection", async outcome => {
  binding!.firstCredited = true;
  bankObserve.mockResolvedValue(outcome === "reconciliation_required" ? { status: outcome } : { status: "payment_recovery_recorded", outcome });
  if (outcome === "paid_accounted") expect(await handoffContextInstallmentEvent(args("invoice.paid"))).toBe(true);
  else await expect(handoffContextInstallmentEvent(args("invoice.paid"))).rejects.toThrow();
  expect(collect).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
});

test("#3 delayed renewal charge signal uses admitted receipt checking only", async () => {
  binding!.firstCredited = true; binding!.paymentNumber = 2; binding!.invoiceId = "in_Local";
  const a = args("payment_intent.succeeded");
  a.event.data.object = { object: "payment_intent", id: "pi_Renewal", customer: "cus_Local", metadata: {} } as never;
  expect(await handoffContextInstallmentEvent(a)).toBe(true);
  expect(bankCheck).toHaveBeenCalledWith(res, buyer, "in_Local");
  expect(credit).not.toHaveBeenCalled(); expect(collect).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
});
test("#3 disabled invoice collection remains retryable, not successful ACK", async () => {
  binding!.firstCredited = true; const a = args("invoice.created"); a.env = { ...a.env, CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_READY: "false" };
  await expect(handoffExactInstallmentWebhook(a)).rejects.toThrow(); expect(collect).not.toHaveBeenCalled(); expect(dispatchExactInstallmentEventSandbox).not.toHaveBeenCalled();
});

test("#2/#3 bound expired Checkout is observed without financial or access effects", async () => {
  expect(await handoffContextInstallmentEvent(args("checkout.session.expired"))).toBe(true);
  expect(unpaid).toHaveBeenCalledWith(res, actor);
  for (const fn of [credit, activate, collect, financial, subscription, recovery, bankCheck, bankObserve]) expect(fn).not.toHaveBeenCalled();
});
test.each(["open", "foreign", "uncredited-paid"])("#2/#3 expired %s state is not falsely acknowledged", async fault => {
  unpaid.mockResolvedValue(fault === "uncredited-paid" ? { receipt: { session_id: "cs_test_Local" } } :
    { status: "checkout_unpaid_observed", sessionId: fault === "foreign" ? "cs_test_Other" : "cs_test_Local", sessionStatus: "open" });
  await expect(handoffContextInstallmentEvent(args("checkout.session.expired"))).rejects.toThrow(); expect(credit).not.toHaveBeenCalled();
});
test("#2/#3 delayed first failure can acknowledge actual credited success, but cannot credit it", async () => {
  binding!.firstCredited = true; binding!.paymentNumber = 1;
  unpaid.mockResolvedValue({ receipt: { session_id: "cs_test_Local", payment_intent_id: "pi_Local" } });
  const a = args("payment_intent.payment_failed");
  a.event.data.object = { object: "payment_intent", id: "pi_Local", customer: "cus_Local", metadata: {} } as never;
  expect(await handoffContextInstallmentEvent(a)).toBe(true); expect(credit).not.toHaveBeenCalled(); expect(collect).not.toHaveBeenCalled();
});
