/** Real signature verifier, canonical HTTP handler, handoff, event bridge and
 * collector. Database/Stripe ports are synthetic; no hosted services or money.
 * Existing SQL tests independently cover durable admission and hold fencing. */
import Stripe from "stripe";
import { exactRenewalFixture } from "../test-support/exact-renewal-fixture";
import { EXACT_WEBHOOK_COLLECTION_GATES } from "../lib/installments/webhookCollection";
import { claimStripeEvent, completeStripeEvent, releaseStripeEvent } from "../lib/stripeEvents";

let f: ReturnType<typeof exactRenewalFixture>;
let binding: { agreementId: string; purchaseId: string; sessionId: string; subscriptionId: string;
  customerId: string; status: string; previewOrigin: string } | null;
const verifier = new Stripe("sk_test_synthetic_no_network");
const recovery = { has: jest.fn(async () => false), begin: jest.fn(), finish: jest.fn() };
const db = { from: jest.fn(() => { throw new Error("Unexpected legacy database path"); }) };
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/stripeClient", () => ({ getStripe: () => ({ ...f.api, webhooks: verifier.webhooks }) }));
jest.mock("@/lib/stripeEvents", () => ({ claimStripeEvent: jest.fn(), completeStripeEvent: jest.fn(), releaseStripeEvent: jest.fn() }));
jest.mock("@/lib/installments/agreementStore", () => ({ ...jest.requireActual("../lib/installments/agreementStore"), createExactAgreementStore: () => f.f.store }));
jest.mock("@/lib/installments/invoiceStore", () => ({ ...jest.requireActual("../lib/installments/invoiceStore"), createExactInvoiceStore: () => f.invoiceStore }));
jest.mock("@/lib/installments/receiptCredit", () => ({ ...jest.requireActual("../lib/installments/receiptCredit"), createExactReceiptCreditStore: () => f.creditStore }));
jest.mock("@/lib/installments/paymentRecovery", () => ({ ...jest.requireActual("../lib/installments/paymentRecovery"), createExactPaymentRecoveryStore: () => recovery }));
jest.mock("@/lib/installments/eventBridge", () => ({ ...jest.requireActual("../lib/installments/eventBridge"),
  createExactEventBindingStore: () => ({ bySubscription: async () => binding, bySession: async () => binding, byIntent: async () => binding }) }));
jest.mock("@/lib/posthogServer", () => ({ trackServerEvent: jest.fn() }));
jest.mock("@/lib/updateInterestScore", () => ({ updateInterestScore: jest.fn() }));
jest.mock("@/lib/updatePostMetrics", () => ({ updatePostMetrics: jest.fn() }));

const claim = jest.mocked(claimStripeEvent), complete = jest.mocked(completeStripeEvent), release = jest.mocked(releaseStripeEvent);
const oldEnv = { ...process.env };
beforeAll(() => Object.assign(process.env, exactRenewalFixture().env, {
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-only", STRIPE_WEBHOOK_SECRET: "whsec_synthetic_only" }));
afterAll(() => { process.env = oldEnv; });
beforeEach(() => {
  jest.clearAllMocks(); f = exactRenewalFixture();
  jest.spyOn(Date, "now").mockReturnValue(f.args.now() * 1000);
  binding = { agreementId: f.a.planId, purchaseId: f.f.terms.buyerId, sessionId: "cs_test_fixture",
    subscriptionId: f.a.subscriptionId, customerId: f.a.customerId, status: "active", previewOrigin: f.f.terms.previewOrigin };
  Object.assign(process.env, f.env, Object.fromEntries(EXACT_WEBHOOK_COLLECTION_GATES.map(key => [key, "true"])), {
    CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_AGREEMENT_IDS: f.a.planId });
  claim.mockResolvedValue({ status: "new", claimToken: f.f.terms.buyerId });
  complete.mockResolvedValue(undefined); release.mockResolvedValue(undefined); recovery.has.mockResolvedValue(false);
});
afterEach(() => jest.restoreAllMocks());

async function deliver(type = "invoice.created", options: { eventId?: string; invalidSignature?: boolean; live?: boolean } = {}) {
  const payload = JSON.stringify({ id: options.eventId ?? "evt_monthly", type, livemode: options.live ?? false,
    created: f.args.now(), data: { object: f.invoice } });
  const signature = verifier.webhooks.generateTestHeaderString({ payload, secret: options.invalidSignature ? "wrong" : "whsec_synthetic_only" });
  const request = new Request(`${f.f.terms.previewOrigin}/api/stripe/webhook`, {
    method: "POST", body: payload, headers: { "stripe-signature": signature } });
  const { POST } = await import("../app/api/stripe/webhook/route");
  return POST(request as never);
}
function noDebit() {
  expect(f.api.invoices.pay).not.toHaveBeenCalled(); expect(f.invoiceStore.admitDispatch).not.toHaveBeenCalled();
  expect(f.api.paymentIntents.confirm).not.toHaveBeenCalled();
}

test("signed invoice.created collects exact cents once and credits before acknowledging", async () => {
  expect((await deliver()).status).toBe(200);
  expect(f.pi.amount_received).toBe(66633); expect(f.pi.application_fee_amount).toBe(10425);
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1); expect(f.creditStore.credit).toHaveBeenCalledTimes(1);
  expect(claim.mock.invocationCallOrder[0]).toBeLessThan(f.invoiceStore.claim.mock.invocationCallOrder[0]);
  expect(f.invoiceStore.admitDispatch.mock.invocationCallOrder[0]).toBeLessThan(f.api.invoices.pay.mock.invocationCallOrder[0]);
  expect(f.creditStore.credit.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0]);
  expect(db.from).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
});

test("different event IDs and receipt deliveries reconcile the same admission, not a new debit", async () => {
  expect((await deliver()).status).toBe(200);
  expect((await deliver("invoice.created", { eventId: "evt_redelivery" })).status).toBe(200);
  expect((await deliver("invoice.paid")).status).toBe(200);
  expect((await deliver("invoice.payment_succeeded")).status).toBe(200);
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1); expect(f.invoiceStore.admitDispatch).toHaveBeenCalledTimes(1);
  expect(await Promise.all(f.creditStore.credit.mock.results.map(r => r.value))).toEqual([true, false, false, false]);
  expect(db.from).not.toHaveBeenCalled();
});

test.each(["invoice.paid", "invoice.payment_succeeded"])("stale %s cannot prepare/finalize/admit/pay an unpaid invoice", async type => {
  expect((await deliver(type)).status).toBe(500); noDebit();
  expect(f.api.invoices.update).not.toHaveBeenCalled(); expect(f.api.invoices.finalizeInvoice).not.toHaveBeenCalled();
  expect(f.invoiceStore.prepareDispatch).not.toHaveBeenCalled(); expect(f.creditStore.credit).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
});

test.each(EXACT_WEBHOOK_COLLECTION_GATES)("removing %s prevents a monthly debit", async key => {
  delete process.env[key];
  const response = await deliver();
  expect(response.status).toBe(500); noDebit(); expect(complete).not.toHaveBeenCalled();
});

test.each(["", "88888888-8888-4888-8888-888888888888", "*"])("allowlist %p does not authorize this plan", async value => {
  process.env.CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_AGREEMENT_IDS = value;
  expect((await deliver()).status).toBe(500); noDebit();
});

test("payload metadata cannot make an unselected persisted plan eligible", async () => {
  process.env.CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_AGREEMENT_IDS = "88888888-8888-4888-8888-888888888888";
  f.invoice.metadata = { installment_plan_id: process.env.CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_AGREEMENT_IDS };
  expect((await deliver()).status).toBe(500); noDebit();
});

test("invalid signature cannot reach event or invoice admission", async () => {
  expect((await deliver("invoice.created", { invalidSignature: true })).status).toBe(400);
  expect(claim).not.toHaveBeenCalled(); expect(f.invoiceStore.claim).not.toHaveBeenCalled(); noDebit();
});

test.each(["duplicate", "busy", "unrecorded"] as const)("%s event claim does not reach the collector", async status => {
  claim.mockResolvedValue({ status });
  expect((await deliver()).status).toBe(status === "duplicate" ? 200 : 500);
  expect(f.invoiceStore.claim).not.toHaveBeenCalled(); noDebit();
});

test.each(["live event", "production", "refunded earlier payment", "active hold", "changed card"])
("%s cannot dispatch payment even for an allowlisted ID", async reason => {
  if (reason === "production") process.env.VERCEL_ENV = "production";
  if (reason === "refunded earlier payment") f.priorCharges[0].amount_refunded = 1;
  if (reason === "active hold") f.invoiceStore.admitDispatch.mockRejectedValueOnce(new Error("Held by database"));
  if (reason === "changed card") f.pm.customer = "cus_other";
  expect((await deliver("invoice.created", { live: reason === "live event" })).status).toBe(reason === "live event" ? 400 : 500);
  if (reason === "live event") expect(claim).not.toHaveBeenCalled();
  expect(f.api.invoices.pay).not.toHaveBeenCalled(); expect(f.creditStore.credit).not.toHaveBeenCalled();
});

test("paid but lost pay response reconciles exactly once", async () => {
  f.api.invoices.pay.mockImplementationOnce(async () => { f.markPaid(); throw new Error("Lost response"); });
  expect((await deliver()).status).toBe(200); expect((await deliver()).status).toBe(200);
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1); expect(f.invoiceStore.admitDispatch).toHaveBeenCalledTimes(1);
});

test("unresolved pay result remains held through redelivery, never a second attempt", async () => {
  f.api.invoices.pay.mockRejectedValueOnce(new Error("Indeterminate provider result"));
  expect((await deliver()).status).toBe(500); expect((await deliver()).status).toBe(500);
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1); expect(f.creditStore.credit).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(2);
});

test("failed event completion after capture retries accounting without another debit", async () => {
  complete.mockRejectedValueOnce(new Error("Commit response unavailable"));
  expect((await deliver()).status).toBe(500); expect((await deliver()).status).toBe(200);
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
});

test("turning collection off or breaking its allowlist does not block an admitted paid receipt", async () => {
  expect((await deliver()).status).toBe(200);
  delete process.env.CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_READY;
  process.env.CREATOR_EXACT_INSTALLMENTS_HTTP_COLLECTION_AGREEMENT_IDS = "*";
  expect((await deliver("invoice.paid")).status).toBe(200);
  expect(f.api.invoices.pay).toHaveBeenCalledTimes(1);
});

test("the final-cent adjustment is configured before admission and terminates after the last credited payment", async () => {
  f = exactRenewalFixture(3); jest.spyOn(Date, "now").mockReturnValue(f.args.now() * 1000);
  expect((await deliver()).status).toBe(200);
  expect(f.pi.amount_received).toBe(66634); expect(f.pi.application_fee_amount).toBe(10425);
  expect(f.api.invoices.addLines).toHaveBeenCalledTimes(1);
  expect(f.api.invoices.addLines.mock.invocationCallOrder[0]).toBeLessThan(f.invoiceStore.admitDispatch.mock.invocationCallOrder[0]);
  expect(f.invoiceStore.completeAgreement).toHaveBeenCalledTimes(1);
  expect((await deliver()).status).toBe(200);
  expect(f.api.invoices.addLines).toHaveBeenCalledTimes(1); expect(f.api.invoices.pay).toHaveBeenCalledTimes(1);
});

test("busy invoice claim is released for event redelivery without an attempted debit", async () => {
  f.invoiceStore.claim.mockResolvedValueOnce({ status: "busy" });
  expect((await deliver()).status).toBe(500); noDebit();
  expect(complete).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
});

test("tagged invoice with no persisted binding cannot fall through to the legacy handler", async () => {
  binding = null; f.invoice.metadata = { installment_collection_version: "exact-cents-held-v1" };
  expect((await deliver()).status).toBe(500); noDebit(); expect(db.from).not.toHaveBeenCalled();
});

test("an untagged unrelated invoice.created remains a legacy no-op, not an exact installment", async () => {
  binding = null;
  expect((await deliver()).status).toBe(200); noDebit(); expect(f.invoiceStore.claim).not.toHaveBeenCalled();
});

test.each(["customer", "live invoice", "application fee", "period ended", "agreement stopped"])
("changed %s cannot be collected through the real HTTP path", async reason => {
  if (reason === "customer") f.invoice.customer = "cus_other";
  if (reason === "live invoice") f.invoice.livemode = true;
  if (reason === "application fee") f.pi.application_fee_amount = 1;
  if (reason === "period ended") jest.spyOn(Date, "now").mockReturnValue(f.a.periodEnd * 1000);
  if (reason === "agreement stopped") f.f.setAgreement({ status: "review_required" });
  expect((await deliver()).status).toBe(500); noDebit(); expect(f.creditStore.credit).not.toHaveBeenCalled();
});
