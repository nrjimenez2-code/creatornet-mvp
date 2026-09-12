import { NextRequest } from "next/server";
import { GET, POST } from "../app/api/installments/recovery/route";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
import { CARD_SETUP_CONSENT_VERSION, PAY_NOW_CONSENT_VERSION, FUTURE_CARD_CONSENT_VERSION } from "../lib/installments/buyerRecoveryView";

const buyer = "11111111-1111-4111-8111-111111111111", creator = "22222222-2222-4222-8222-222222222222";
const reservation = "33333333-3333-4333-8333-333333333333", requestId = "44444444-4444-4444-8444-444444444444", quoteId = "55555555-5555-4555-8555-555555555555";
const origin = "https://synthetic-checkout.vercel.app", context = { mode: "test", siteOrigin: origin };
const fee = { enabled: true, basisPoints: 290, fixedCents: 30, version: "synthetic-v1" };
const terms = { buyerId: buyer, creatorId: creator, title: "Synthetic mentorship", totalCents: 199900, paymentCount: 3,
  firstPaymentFeeSchedule: fee, renewalFeeSchedule: fee };
const quote = { id: quoteId, amountCents: 66633, paymentNumber: 2, paymentCount: 3, expiresAt: 9999999999, confirmed: false, consentVersion: PAY_NOW_CONSENT_VERSION };
let db: ReturnType<typeof createMockClient>, actor: string | null, view: Record<string, unknown>;
const save = jest.fn(), publish = jest.fn(), verify = jest.fn(), review = jest.fn(), reviewFuture = jest.fn(), pay = jest.fn(), reconcile = jest.fn();
const bankChallenge = jest.fn(), bankCheck = jest.fn(), observe = jest.fn();
const savedEnv = { ...process.env };
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("../lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: async () => actor ? { id: actor } : null }));
jest.mock("../lib/stripeClient", () => ({ getStripe: () => { throw Error("No legacy payment client allowed"); } }));
jest.mock("../lib/installments/contextServer", () => ({ exactContextServerConfig: () => ({ approvedContext: context }) }));
jest.mock("../lib/installments/contextReservation", () => ({ ...jest.requireActual("../lib/installments/contextReservation"),
  readExactContextReservation: () => ({ id: reservation, terms }) }));
jest.mock("../lib/installments/contextRuntime", () => ({ createExactContextRuntime: () => ({ observeContext: observe }),
  createExactContextCardSetup: () => ({ saveCard: save, verifyCard: verify }), createExactContextCardSetupPublication: () => ({ readRedirect: publish }),
  createExactContextBuyerRetry: () => ({ reviewPayment: review, reviewWithFutureCardChoice: reviewFuture, payNow: pay, reconcile }),
  createExactContextBankVerification: () => ({ readChallenge: bankChallenge, checkPayment: bankCheck }),
}));
beforeEach(() => {
  jest.clearAllMocks(); actor = buyer;
  process.env = { ...savedEnv, NEXT_PUBLIC_SITE_URL: origin, CREATOR_EXACT_INSTALLMENTS_CONTEXT_SCHEMA_READY: "true",
    CREATOR_EXACT_INSTALLMENTS_CONTEXT_BUYER_RECOVERY_READY: "true", CREATOR_EXACT_INSTALLMENTS_CONTEXT_READY: "true",
    CREATOR_EXACT_INSTALLMENTS_CONTEXT_BUYER_RETRY_READY: "true", CREATOR_EXACT_INSTALLMENTS_CARD_SETUP_PUBLISH_READY: "true",
    CREATOR_EXACT_INSTALLMENTS_BANK_VERIFICATION_READY: "true" };
  view = { agreementId: reservation, title: terms.title, totalCents: terms.totalCents, paymentCount: 3, paymentNumber: 2, amountCents: 66633,
    outcome: "payment_method_required", observedAt: "2026-09-09", setupState: "not_started", setupRequestId: null, setupEligible: true, confirmedQuoteId: null };
  db = createMockClient(op => {
    if (op.table === "exact_installment_context_reservations_v2") return { data: { id: reservation }, error: null };
    if (op.table === "read_exact_context_buyer_view_v2") return { data: { view, agreementStatus: "active", invoiceId: "in_Synthetic" }, error: null };
    throw Error("Unexpected source: " + op.table);
  });
  observe.mockResolvedValue({ contextEvidence: "synthetic" }); save.mockResolvedValue({ status: "prepared_unpublished" });
  publish.mockResolvedValue({ status: "card_setup_ready", url: "https://checkout.stripe.com/c/pay/cs_test_Synthetic" });
  verify.mockResolvedValue({ status: "card_saved_payment_not_attempted" });
  review.mockResolvedValue({ status: "payment_review_ready", quote }); reviewFuture.mockResolvedValue({ status: "payment_review_ready", quote: { ...quote, remainingPayments: [] } });
  pay.mockResolvedValue({ status: "credited", quote: { ...quote, confirmed: true } });
  reconcile.mockResolvedValue({ status: "already_credited", quote: { ...quote, confirmed: true } });
  bankCheck.mockResolvedValue({ status: "credited" }); bankChallenge.mockResolvedValue({ status: "bank_verification_ready", clientSecret: "SYNTHETIC" });
});
afterEach(() => { process.env = { ...savedEnv }; });
function request(action?: Record<string, unknown>, site = origin) {
  return new NextRequest(origin + "/api/installments/recovery?agreementId=" + reservation, action ? { method: "POST",
    headers: { origin: site, "content-type": "application/json" }, body: JSON.stringify({ agreementId: reservation, ...action }) } : {});
}
const verified = () => { view.setupState = "verified"; view.setupRequestId = requestId; };
const payInput = () => ({ action: "pay_now", quoteId, accepted: true, consentVersion: PAY_NOW_CONSENT_VERSION });
test("#3 existing recovery GET returns the shared buyer contract without invoice/provider identities or payment", async () => {
  const r = await GET(request()); expect(r.status).toBe(200);
  const body = await r.json(); expect(body.view).toMatchObject({ amountCents: 66633, canSaveCard: true, canAttemptPayment: false });
  expect(JSON.stringify(body)).not.toContain("in_Synthetic"); expect(pay).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});
test.each([null, creator])("#3 recovery rejects unauthenticated/foreign buyer %s", async id => {
  actor = id; const r = await GET(request()); expect(r.status).toBe(id ? 404 : 401);
  expect(save).not.toHaveBeenCalled(); expect(pay).not.toHaveBeenCalled();
});
test("#3 explicit save-card consent precedes URL handoff but never authorizes a payment", async () => {
  const r = await POST(request({ action: "save_card", requestId, accepted: true, consentVersion: CARD_SETUP_CONSENT_VERSION }));
  expect(r.status).toBe(200); expect((await r.json()).status).toBe("card_setup_ready");
  expect(save).toHaveBeenCalledWith(reservation, buyer, "in_Synthetic", requestId, { accepted: true, consentVersion: CARD_SETUP_CONSENT_VERSION });
  expect(publish.mock.invocationCallOrder[0]).toBeGreaterThan(save.mock.invocationCallOrder[0]); expect(pay).not.toHaveBeenCalled();
});
test("#3 card verification remains separate from payment review", async () => {
  view.setupState = "started"; view.setupRequestId = requestId;
  expect((await POST(request({ action: "verify_card" }))).status).toBe(200);
  expect(verify).toHaveBeenCalledWith(reservation, buyer, "in_Synthetic", requestId); expect(pay).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
});
test.each([false, true])("#3 explicit payment review with future-card option %s does not collect", async future => {
  verified(); if (future) process.env.CREATOR_EXACT_INSTALLMENTS_FUTURE_CARD_READY = "true";
  const r = await POST(request({ action: "review_pay_now", quoteId })); expect(r.status).toBe(200);
  expect((future ? reviewFuture : review)).toHaveBeenCalledWith(reservation, buyer, "in_Synthetic", quoteId); expect(pay).not.toHaveBeenCalled();
});
test("#3 explicit pay-now reaches the existing once-admitted collector; confirmed replay only reconciles", async () => {
  verified(); expect((await POST(request(payInput()))).status).toBe(200);
  expect(pay).toHaveBeenCalledWith(reservation, buyer, "in_Synthetic", quoteId, { accepted: true, consentVersion: PAY_NOW_CONSENT_VERSION });
  view.confirmedQuoteId = quoteId; view.setupEligible = false;
  expect((await POST(request(payInput()))).status).toBe(200);
  expect(pay).toHaveBeenCalledTimes(1); expect(reconcile).toHaveBeenCalledWith(reservation, buyer, "in_Synthetic", quoteId);
});
test("#3 replay cannot change the recorded optional future-card choice", async () => {
  verified(); view.confirmedQuoteId = quoteId; view.futureCardAccepted = false;
  expect((await POST(request({ ...payInput(), futureCardConsentVersion: FUTURE_CARD_CONSENT_VERSION }))).status).toBe(409);
  expect(pay).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
});
test.each(["origin", "no consent", "old consent", "extra invoice", "retry paused"])("#3 %s cannot start a retry", async fault => {
  verified(); const body: Record<string, unknown> = payInput();
  if (fault === "no consent") body.accepted = false;
  if (fault === "old consent") body.consentVersion = "single-invoice-retry-v1";
  if (fault === "extra invoice") body.invoiceId = "in_Foreign";
  if (fault === "retry paused") process.env.CREATOR_EXACT_INSTALLMENTS_CONTEXT_BUYER_RETRY_READY = "false";
  expect((await POST(request(body, fault === "origin" ? "https://foreign.invalid" : origin))).status).toBeGreaterThanOrEqual(400);
  expect(pay).not.toHaveBeenCalled();
});
test("#3 bank challenge and receipt check use existing separate response contracts", async () => {
  view.outcome = "action_required";
  expect((await (await POST(request({ action: "verify_bank" }))).json()).status).toBe("bank_verification_ready");
  expect((await (await POST(request({ action: "check_bank_payment" }))).json())).toEqual({ status: "bank_payment_checked", outcome: "paid_accounted" });
  expect(pay).not.toHaveBeenCalled();
});
