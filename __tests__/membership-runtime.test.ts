import type Stripe from "stripe";
jest.mock("@/lib/paymentDisputes", () => ({ reconcileKnownPaymentDispute: jest.fn() }));
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMembershipRuntime, inspectMembershipFirstCapture } from "@/lib/membershipRuntime";
import { recordPaymentFeeLedger } from "@/lib/paymentFeeLedger";
import { applyPaymentRefundState, reconcileKnownPaymentRefund, recordPaymentRefundState } from "@/lib/paymentRefunds";
import { runMembershipOperation } from "@/lib/membershipOperation";
import { createMembershipInitialAbandonment } from "@/lib/membershipInitialAbandonment";
import { prepareServerPaymentIntent } from "@/lib/serverPaymentIntent";
import { observeServerPaymentConfirmation, serverPaymentCreateRequest } from "@/lib/serverPaymentConfirmation";
import { createServerConfirmationStore, getServerPaymentAuthentication,
  runServerPaymentConfirmation } from "@/lib/serverPaymentConfirmationStore";
import { stopServerPaymentIntent } from "@/lib/serverPaymentStop";
import { membershipFixture, membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
import { bootstrapRequests } from "../test-support/membership-checkout-recovery-fixtures";
jest.mock("@/lib/creatorStripeConnect", () => ({ isCreatorSellReady: jest.fn() }));
jest.mock("@/lib/paymentFeeLedger", () => ({ recordPaymentFeeLedger: jest.fn() }));
jest.mock("@/lib/paymentRefunds", () => ({ applyPaymentRefundState: jest.fn(), reconcileKnownPaymentRefund: jest.fn(), recordPaymentRefundState: jest.fn() }));
// The real operation wrapper and SQL are covered by their own suites. This
// boundary double exercises concrete runtime wiring, not hosted dispatch.
jest.mock("@/lib/membershipOperation", () => ({ runMembershipOperation: jest.fn() }));
jest.mock("@/lib/membershipInitialAbandonment", () => ({ createMembershipInitialAbandonment: jest.fn() }));
jest.mock("@/lib/serverPaymentIntent", () => ({ prepareServerPaymentIntent: jest.fn() }));
jest.mock("@/lib/serverPaymentConfirmationStore", () => ({ createServerConfirmationStore: jest.fn(),
  getServerPaymentAuthentication: jest.fn(), runServerPaymentConfirmation: jest.fn() }));
jest.mock("@/lib/serverPaymentStop", () => ({ stopServerPaymentIntent: jest.fn() }));
jest.mock("@/lib/serverPaymentConfirmation", () => ({
  ...jest.requireActual("@/lib/serverPaymentConfirmation"), observeServerPaymentConfirmation: jest.fn() }));
const feeLedger = jest.mocked(recordPaymentFeeLedger), refunded = jest.mocked(recordPaymentRefundState);
const applied = jest.mocked(applyPaymentRefundState), reconciled = jest.mocked(reconcileKnownPaymentRefund);
const runOperation = jest.mocked(runMembershipOperation);
const makeInitialAbandonment = jest.mocked(createMembershipInitialAbandonment);
const prepareIntent = jest.mocked(prepareServerPaymentIntent);
const makeConfirmationStore = jest.mocked(createServerConfirmationStore);
const runConfirmation = jest.mocked(runServerPaymentConfirmation);
const authenticate = jest.mocked(getServerPaymentAuthentication);
const stopIntent = jest.mocked(stopServerPaymentIntent);
const observeConfirmation = jest.mocked(observeServerPaymentConfirmation);
const ledgerId = "16000000-0000-4000-8000-000000000007";
beforeEach(() => {
  jest.resetAllMocks(); feeLedger.mockResolvedValue(ledgerId);
  makeInitialAbandonment.mockImplementation(() => ({ abandonFirstCheckout: jest.fn(),
    reconcileAbandonedCheckoutEvent: jest.fn() }) as unknown as ReturnType<typeof createMembershipInitialAbandonment>);
  prepareIntent.mockImplementation(async args => { await args.assertProviderSource(); return { status: "not_enabled" }; });
  runOperation.mockImplementation(async input => { const value = await input.create(input.request, {
    idempotencyKey: `synthetic-${input.kind}`, maxNetworkRetries: 0 }); input.validate(value); return value; });
});
function harness(paid = true) {
  const f = membershipFixture(paid), env = { ...membershipTestEnv }, order: string[] = [];
  let visible = true, entitlement = false, failReceipt = false, dispute: string | null = null;
  let manualSelection: Record<string, unknown> | null = null;
  let manualRegistered = false;
  let manualOperations: Array<Record<string, unknown>> = [];
  let manualIntent: Record<string, unknown> | null = null;
  const response = <T,>(value: T) => ({ ...value, lastResponse: { apiVersion: context.apiVersion, requestId: "req_fixture", headers: {}, statusCode: 200 } });
  const rpc = jest.fn(async (name, params) => {
    order.push(name);
    if (name === "read_monthly_mentorship_entitlement_v1") return { data: { allowed: entitlement, maxAgeSeconds: entitlement ? 3600 : 0 }, error: null };
    if (name === "record_monthly_mentorship_receipt_v1") {
      if (failReceipt) return { data: null, error: { message: "Synthetic unavailable database" } };
      f.a.covered_months = 1; f.a.anchor_at = params.p_start; entitlement = f.charge.amount_refunded < f.charge.amount;
      return { data: true, error: null };
    }
    if (name === "record_monthly_manual_first_receipt_v1") {
      if (failReceipt) return { data: null, error: { message: "Synthetic unavailable database" } };
      f.a.stripe_customer_id = params.p_proof.customerId;
      f.a.stripe_subscription_id = params.p_proof.subscriptionId;
      f.a.covered_months = 1; f.a.anchor_at = params.p_proof.paidAt; entitlement = true;
      return { data: true, error: null };
    }
    if (name === "bind_monthly_mentorship_provider_v1") {
      f.a.stripe_customer_id = params.p_customer_id; f.a.stripe_subscription_id = params.p_subscription_id;
      f.a.stripe_checkout_session_id = params.p_session_id; return { data: true, error: null };
    }
    if (name === "reserve_monthly_mentorship_v1") return { data: f.a.id, error: null };
    if (name === "select_monthly_manual_payment_v1") return manualSelection ?
      { data: manualSelection, error: null } : { data: null, error: { message: "No owned source" } };
    if (name === "register_monthly_manual_source_v1") { manualRegistered = true; return manualSelection ? { data: {
      attempt_id: manualSelection.id, buyer_id: manualSelection.buyer_id,
      product_id: f.a.product_id, kind: "monthly_first", protocol: manualSelection.protocol,
      reservation_id: null, context: params.p_context, source: manualSelection }, error: null } :
      { data: null, error: { message: "No owned source" } }; }
    if (name === "read_server_payment_source_v1") return manualSelection ? { data: {
      attempt_id: manualSelection.id, buyer_id: manualSelection.buyer_id,
      product_id: f.a.product_id, kind: "monthly_first", protocol: manualSelection.protocol,
      reservation_id: null, context: params.p_context, source: manualSelection }, error: null } :
      { data: null, error: { message: "No owned source" } };
    if (name === "read_server_payment_intent_v1") return { data: manualIntent, error: null };
    if (name === "request_server_payment_stop_v1") return { data: { attemptId: manualSelection?.id,
      releaseAllowed: false }, error: null };
    if (name === "request_monthly_initial_abandonment_v1") return { data: { membershipId: f.a.id,
      requested: true, abandoned: false }, error: null };
    throw Error("Unexpected runtime RPC " + name);
  });
  const from = jest.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const q: { select: jest.Mock; eq: jest.Mock; in: jest.Mock; maybeSingle: jest.Mock } = {
      select: jest.fn(() => q), eq: jest.fn((key: string, value: unknown) => { filters[key] = value; return q; }),
      in: jest.fn(async () => ({ error: null, data: manualOperations })),
      maybeSingle: jest.fn(async () => ({ error: null, data: table === "monthly_mentorship_agreements_v1" ?
        visible && filters.id === f.a.id && filters.buyer_id === f.a.buyer_id ? { ...f.a } : null :
        table === "monthly_mentorship_operations_v1" ? { provider_id: f.product.id } :
        table === "monthly_manual_payment_selections_v1" ?
          manualSelection && (filters.id === manualSelection.id || filters.id === undefined && filters.kind === "first") &&
          (filters.agreement_id === f.a.id || filters.agreement_id === undefined && filters.kind === "first") &&
          filters.buyer_id === f.a.buyer_id ? manualSelection : null :
        table === "server_payment_protocols_v1" ? manualRegistered ? { attempt_id: manualSelection?.id } : null :
        table === "server_payment_intent_operations_v1" ? manualIntent ? { attempt_id: manualSelection?.id } : null :
        table === "payment_fee_ledger" ? { dispute_status: dispute } : null })) };
    return q;
  });
  const stripe = {
    accounts: { retrieve: jest.fn(async (id?: string) => response(id ? { object: "account", id,
      charges_enabled: true, payouts_enabled: true, capabilities: { transfers: "active" } } :
      { object: "account", id: context.stripeAccountId })) },
    balance: { retrieve: jest.fn(async () => response({ object: "balance", livemode: false })) },
    customers: { create: jest.fn(async () => response(f.customer)), retrieve: jest.fn(async () => response(f.customer)) },
    products: { create: jest.fn(async () => response(f.product)), retrieve: jest.fn(async () => response(f.product)) },
    subscriptions: { create: jest.fn(async () => response({ ...f.subscription, pause_collection: null })),
      update: jest.fn(async () => response(f.subscription)), retrieve: jest.fn(async () => response(f.subscription)) },
    checkout: { sessions: { create: jest.fn(async () => response(f.session)), retrieve: jest.fn(async () => response(f.session)) } },
    paymentIntents: { retrieve: jest.fn(async () => response(f.paymentIntent)) },
    charges: { retrieve: jest.fn(async () => response(f.charge)) },
    balanceTransactions: { retrieve: jest.fn(async () => response(f.balance)) },
    paymentMethods: { retrieve: jest.fn(async () => response({ id: "pm_fixture", object: "payment_method",
      livemode: false, customer: f.customer.id, type: "card", card: { country: "US" },
      billing_details: { address: { country: "US" } } })) },
  };
  const exactContext = { version: "exact-payment-context-v1", mode: context.mode,
    platformAccountId: context.stripeAccountId, supabaseProjectRef: context.supabaseProjectRef,
    siteOrigin: context.siteOrigin };
  const manualContextEvidence = jest.fn(async () => ({ approvedContext: exactContext, vercelEnvironment: "preview",
    stripeSecretKeyMode: "test", stripePublishableKeyMode: "test", observedPlatformAccountId: exactContext.platformAccountId,
    observedSupabaseProjectRef: exactContext.supabaseProjectRef,
    configuredSupabaseUrl: `https://${exactContext.supabaseProjectRef}.supabase.co`, configuredSiteOrigin: exactContext.siteOrigin }));
  const runtime = createMembershipRuntime(env, { context, admin: { from, rpc } as unknown as SupabaseClient,
    stripe: stripe as unknown as Stripe, manualContextEvidence });
  return { f, env, rpc, from, stripe, runtime, order, manualContextEvidence, setVisible: (value: boolean) => { visible = value; },
    setEntitlement: (value: boolean) => { entitlement = value; }, setFailReceipt: (value: boolean) => { failReceipt = value; },
    setDispute: (value: string | null) => { dispute = value; },
    setManualSelection: (value: Record<string, unknown> | null) => { manualSelection = value; },
    setManualRegistered: (value: boolean) => { manualRegistered = value; },
    getManualSelection: () => manualSelection,
    setManualOperations: (value: Array<Record<string, unknown>>) => { manualOperations = value; },
    setManualIntent: (value: Record<string, unknown> | null) => { manualIntent = value; } };
}
function selectManualFirst(h: ReturnType<typeof harness>) {
  const selectionId = "16000000-0000-4000-8000-000000000099";
  h.env.CREATOR_MONTHLY_MANUAL_PREPARATION_READY = "true";
  h.env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY = "true";
  h.f.a.stripe_customer_id = h.f.a.stripe_subscription_id = h.f.a.stripe_checkout_session_id = null;
  const accepted = Math.floor(Date.parse(h.f.a.accepted_at) / 1000);
  h.setManualSelection({ id: selectionId, agreement_id: h.f.a.id, buyer_id: h.f.a.buyer_id,
    kind: "first", payoff_id: null, protocol: "creatornet-us-manual-confirmation-v1",
    context, selected_at: new Date((accepted + 1) * 1000).toISOString(),
    source: { agreementId: h.f.a.id, purchaseId: h.f.a.purchase_id, buyerId: h.f.a.buyer_id,
      creatorId: h.f.a.creator_id, productId: h.f.a.product_id, postId: h.f.a.post_id,
      agreementFingerprint: h.f.a.fingerprint, sourceFingerprint: h.f.a.fingerprint,
      terms: h.f.a.terms, amountCents: h.f.a.monthly_price_cents, acceptedAt: accepted,
      expiresAt: accepted + 23 * 3600, revision: h.f.a.revision } });
  return selectionId;
}
function completedManualFirstOperations(h: ReturnType<typeof harness>) {
  const ids = { customer: h.f.customer.id, product: h.f.product.id, subscription: h.f.subscription.id };
  const requests = bootstrapRequests(h.f.a, ids);
  const rows = (["customer", "product", "subscription", "hold"] as const).map(kind => ({
    kind, scope_key: "initial", status: "complete", provider_id: ids[kind === "hold" ? "subscription" : kind],
    request: requests[kind], agreement_revision: h.f.a.revision }));
  h.setManualOperations(rows);
  return rows;
}
async function boundManualFirst(h: ReturnType<typeof harness>, selectionId: string) {
  completedManualFirstOperations(h);
  h.setManualRegistered(true);
  h.env.CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY = "true";
  const contract = (await h.runtime.readManualFirstSource(h.f.a.id, h.f.a.buyer_id, selectionId)).contract;
  const now = Math.floor(Date.now() / 1000), evidence = await h.manualContextEvidence();
  h.setManualIntent({ attempt_id: selectionId, contract,
    request: serverPaymentCreateRequest(contract, evidence), payment_intent_id: "pi_fixture",
    bound_at: new Date((now - 4) * 1000).toISOString() });
  prepareIntent.mockResolvedValueOnce({ status: "bound_unpublished", paymentIntentId: "pi_fixture",
    firstDispatchAt: now - 5, providerStatus: "requires_payment_method" });
  return contract;
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
test("manual first bootstrap reuses original operations without a hosted checkout or publication", async () => {
  const h = harness(false), selectionId = selectManualFirst(h);
  const result = await h.runtime.selectAndPrepareManualFirst(h.f.a.id, h.f.a.buyer_id);
  expect(result).toMatchObject({ agreement: { id: h.f.a.id }, selection: { id: selectionId },
    firstPreparation: { customerId: h.f.customer.id, productId: h.f.product.id,
      subscriptionId: h.f.subscription.id },
    contract: { attemptId: selectionId, kind: "monthly_first", customerId: h.f.customer.id,
      amountCents: h.f.a.monthly_price_cents } });
  expect(h.manualContextEvidence).toHaveBeenCalledTimes(2);
  expect(runOperation.mock.calls.map(([input]) => input.kind)).toEqual(["customer", "product", "subscription", "hold"]);
  expect(h.rpc.mock.calls[0]).toEqual(["select_monthly_manual_payment_v1", {
    p_id: h.f.a.id, p_buyer_id: h.f.a.buyer_id, p_context: context, p_kind: "first", p_payoff_id: null }]);
  expect(h.rpc.mock.invocationCallOrder[0]).toBeLessThan(runOperation.mock.invocationCallOrder[0]);
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(h.rpc).not.toHaveBeenCalledWith("bind_monthly_mentorship_provider_v1", expect.anything());
});

test("manual source selection freezes an owned agreement before any provider bootstrap", async () => {
  const h = harness(false), selectionId = selectManualFirst(h);
  expect(await h.runtime.selectManualFirst(h.f.a.id, h.f.a.buyer_id)).toEqual({ membershipId: h.f.a.id, selectionId });
  expect(runOperation).not.toHaveBeenCalled();
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(await h.runtime.readOwnedManualFirst(h.f.a.id, h.f.a.buyer_id)).toMatchObject({
    membershipId: h.f.a.id, selectionId, buyerId: h.f.a.buyer_id,
    amountCents: h.f.a.monthly_price_cents, firstPaymentRecorded: false });
  expect(await h.runtime.resolveManualFirstReturn(selectionId, h.f.a.buyer_id)).toEqual({
    membershipId: h.f.a.id, selectionId });
  expect(runOperation).not.toHaveBeenCalled();
});
test("manual context drift stops before the original provider bootstrap", async () => {
  const h = harness(false); selectManualFirst(h);
  const evidence = await h.manualContextEvidence();
  h.manualContextEvidence.mockResolvedValueOnce({ ...evidence, observedPlatformAccountId: "acct_other" });
  await expect(h.runtime.selectAndPrepareManualFirst(h.f.a.id, h.f.a.buyer_id))
    .rejects.toThrow("Exact payment context validation failed");
  expect(runOperation).not.toHaveBeenCalled();
});
test("manual first source readback verifies the original journal and provider objects without dispatch", async () => {
  const h = harness(false), selectionId = selectManualFirst(h);
  completedManualFirstOperations(h);
  const result = await h.runtime.readManualFirstSource(h.f.a.id, h.f.a.buyer_id, selectionId);
  expect(result).toMatchObject({ selectionId, customerId: h.f.customer.id,
    productId: h.f.product.id, subscriptionId: h.f.subscription.id,
    contract: { attemptId: selectionId, kind: "monthly_first", amountCents: h.f.a.monthly_price_cents } });
  expect(h.stripe.accounts.retrieve).toHaveBeenCalledWith(h.f.a.terms.destinationId);
  expect(runOperation).not.toHaveBeenCalled();
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(h.manualContextEvidence).toHaveBeenCalledTimes(2);
});
test("manual first source readback refuses changed original request before provider reads", async () => {
  const h = harness(false), selectionId = selectManualFirst(h);
  const rows = completedManualFirstOperations(h);
  h.setManualOperations(rows.map(row => row.kind === "hold" ? { ...row,
    request: { method: "POST", path: "/v1/subscriptions/sub_other", params: {} } } : row));
  await expect(h.runtime.readManualFirstSource(h.f.a.id, h.f.a.buyer_id, selectionId))
    .rejects.toThrow("operation request differs");
  expect(h.stripe.customers.retrieve).not.toHaveBeenCalled();
  expect(runOperation).not.toHaveBeenCalled();
});
test("manual first intent composition registers the frozen source and rechecks before shared preparation", async () => {
  const h = harness(false), selectionId = selectManualFirst(h);
  h.env.CREATOR_MONTHLY_MANUAL_INTENT_READY = "true";
  h.env.CREATOR_SERVER_PAYMENT_INTENT_READY = "true";
  completedManualFirstOperations(h);
  expect(await h.runtime.prepareManualFirstIntent(h.f.a.id, h.f.a.buyer_id, selectionId))
    .toEqual({ status: "not_enabled" });
  expect(h.order).toContain("register_monthly_manual_source_v1");
  expect(h.rpc.mock.calls.find(([name]) => name === "register_monthly_manual_source_v1")?.[1])
    .toMatchObject({ p_selection_id: selectionId, p_buyer_id: h.f.a.buyer_id });
  expect(h.rpc.mock.invocationCallOrder[h.rpc.mock.calls.findIndex(([name]) => name === "register_monthly_manual_source_v1")])
    .toBeGreaterThan(runOperation.mock.invocationCallOrder[3]);
  expect(prepareIntent).toHaveBeenCalledTimes(1);
  expect(prepareIntent.mock.calls[0][0].contract).toMatchObject({ attemptId: selectionId, kind: "monthly_first" });
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("manual first intent composition rejects source drift before the shared dispatcher", async () => {
  const h = harness(false), selectionId = selectManualFirst(h);
  h.env.CREATOR_MONTHLY_MANUAL_INTENT_READY = "true";
  h.env.CREATOR_SERVER_PAYMENT_INTENT_READY = "true";
  const rows = completedManualFirstOperations(h);
  prepareIntent.mockImplementationOnce(async args => {
    h.setManualOperations(rows.map(row => row.kind === "hold" ? { ...row, status: "review_required" } : row));
    await args.assertProviderSource();
    return { status: "not_enabled" };
  });
  await expect(h.runtime.prepareManualFirstIntent(h.f.a.id, h.f.a.buyer_id, selectionId))
    .rejects.toThrow("Original monthly preparation differs");
  expect(prepareIntent).toHaveBeenCalledTimes(1);
});
test.each(["current", "legacy"] as const)("%s bound monthly first intent remains recoverable after expiry, stop and revision change", async requestShape => {
  const h = harness(false), selectionId = selectManualFirst(h);
  completedManualFirstOperations(h);
  const fresh = (await h.runtime.readManualFirstSource(h.f.a.id, h.f.a.buyer_id, selectionId)).contract;
  const evidence = await h.manualContextEvidence();
  const accepted = Math.floor(Date.now() / 1000) - 24 * 3600;
  h.f.a.accepted_at = new Date(accepted * 1000).toISOString();
  const selected = h.getManualSelection()!;
  h.setManualSelection({ ...selected, selected_at: new Date((accepted + 1) * 1000).toISOString(),
    source: { ...(selected.source as Record<string, unknown>), acceptedAt: accepted, expiresAt: accepted + 23 * 3600 } });
  completedManualFirstOperations(h);
  h.f.a.revision += 1;
  h.f.a.debit_revoked_at = new Date().toISOString();
  const contract = { ...fresh, acceptedAt: accepted, expiresAt: accepted + 23 * 3600 };
  const request = serverPaymentCreateRequest(contract, evidence);
  if (requestShape === "legacy") {
    delete request.params.payment_method_types;
    request.params.automatic_payment_methods = { enabled: false };
  }
  h.setManualIntent({ attempt_id: selectionId, contract, request,
    payment_intent_id: "pi_fixture", bound_at: new Date((accepted + 5) * 1000).toISOString() });
  prepareIntent.mockImplementationOnce(async args => {
    expect(args.env?.CREATOR_SERVER_PAYMENT_INTENT_READY).toBe("false");
    expect(args.contract).toEqual(contract);
    return { status: "bound_unpublished", paymentIntentId: "pi_fixture",
      firstDispatchAt: accepted + 3, providerStatus: "requires_payment_method" };
  });
  expect(await h.runtime.recoverManualFirstIntent(h.f.a.id, h.f.a.buyer_id, selectionId))
    .toMatchObject({ status: "bound_unpublished", paymentIntentId: "pi_fixture" });
  expect(runOperation).not.toHaveBeenCalled();
  expect(prepareIntent).toHaveBeenCalledTimes(1);
});
test("an unbound original monthly intent stays unresolved without another provider create", async () => {
  const h = harness(false), selectionId = selectManualFirst(h);
  completedManualFirstOperations(h);
  const contract = (await h.runtime.readManualFirstSource(h.f.a.id, h.f.a.buyer_id, selectionId)).contract;
  h.setManualIntent({ attempt_id: selectionId, contract,
    request: serverPaymentCreateRequest(contract, await h.manualContextEvidence()),
    payment_intent_id: null, bound_at: null });
  expect(await h.runtime.recoverManualFirstIntent(h.f.a.id, h.f.a.buyer_id, selectionId))
    .toEqual({ status: "reconciliation_required" });
  expect(prepareIntent).not.toHaveBeenCalled();
  expect(runOperation).not.toHaveBeenCalled();
});
test("monthly manual confirmation uses only the already bound original intent", async () => {
  const h = harness(false), selectionId = selectManualFirst(h);
  const contract = await boundManualFirst(h, selectionId);
  runConfirmation.mockImplementationOnce(async args => {
    await args.assertProviderSource();
    return { status: "busy" as const, operationId: "16000000-0000-4000-8000-000000000098" };
  });
  expect(await h.runtime.confirmManualFirstIntent(h.f.a.id, h.f.a.buyer_id, selectionId,
    { kind: "card", paymentMethodId: "pm_fixture" })).toMatchObject({ status: "busy" });
  expect(runConfirmation).toHaveBeenCalledWith(expect.objectContaining({ contract,
    binding: { paymentIntentId: "pi_fixture", firstDispatchAt: expect.any(Number) },
    action: { kind: "card", paymentMethodId: "pm_fixture" } }));
  expect(prepareIntent).toHaveBeenCalledTimes(1);
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("monthly manual authentication keeps the same saved operation and source", async () => {
  const h = harness(false), selectionId = selectManualFirst(h),
    operationId = "16000000-0000-4000-8000-000000000098";
  await boundManualFirst(h, selectionId);
  authenticate.mockImplementationOnce(async args => {
    expect(args.operationId).toBe(operationId);
    expect(args.binding.paymentIntentId).toBe("pi_fixture");
    await args.assertProviderSource();
    throw Error("synthetic authentication boundary");
  });
  await expect(h.runtime.authenticateManualFirstIntent(h.f.a.id, h.f.a.buyer_id,
    selectionId, operationId)).rejects.toThrow("synthetic authentication boundary");
  expect(authenticate).toHaveBeenCalledTimes(1);
  expect(prepareIntent).toHaveBeenCalledTimes(1);
});
test("monthly manual confirmation refuses an unbound original without provider dispatch", async () => {
  const h = harness(false), selectionId = selectManualFirst(h);
  completedManualFirstOperations(h);
  h.env.CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY = "true";
  const contract = (await h.runtime.readManualFirstSource(h.f.a.id, h.f.a.buyer_id, selectionId)).contract;
  h.setManualIntent({ attempt_id: selectionId, contract,
    request: serverPaymentCreateRequest(contract, await h.manualContextEvidence()),
    payment_intent_id: null, bound_at: null });
  await expect(h.runtime.confirmManualFirstIntent(h.f.a.id, h.f.a.buyer_id, selectionId,
    { kind: "observe" })).rejects.toThrow("reconciliation");
  expect(runConfirmation).not.toHaveBeenCalled();
  expect(prepareIntent).not.toHaveBeenCalled();
});
test("monthly manual confirmation rechecks the frozen source before dispatch", async () => {
  const h = harness(false), selectionId = selectManualFirst(h);
  await boundManualFirst(h, selectionId);
  runConfirmation.mockImplementationOnce(async args => {
    const selection = h.getManualSelection()!;
    h.setManualSelection({ ...selection, source: { ...(selection.source as Record<string, unknown>),
      amountCents: 1 } });
    await args.assertProviderSource();
    return { status: "busy" as const, operationId: "16000000-0000-4000-8000-000000000098" };
  });
  await expect(h.runtime.confirmManualFirstIntent(h.f.a.id, h.f.a.buyer_id, selectionId,
    { kind: "card", paymentMethodId: "pm_fixture" })).rejects.toThrow("source needs review");
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("monthly manual stop persists before canceling only the bound original intent", async () => {
  const h = harness(false), selectionId = selectManualFirst(h);
  const contract = await boundManualFirst(h, selectionId);
  h.env.CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY = "true";
  h.env.CREATOR_SERVER_PAYMENT_CANCELLATION_READY = "true";
  const proof = { version: "server-payment-intent-terminal-v1" as const,
    paymentIntentId: "pi_fixture", status: "canceled" as const, amountReceived: 0 as const,
    amountCapturable: 0 as const, canceledAt: 1, chargeIds: [], observedAt: 1 };
  stopIntent.mockResolvedValueOnce({ status: "intent_canceled_unreleased", releaseAllowed: false, proof });
  expect(await h.runtime.stopManualFirstIntent(h.f.a.id, h.f.a.buyer_id, selectionId))
    .toEqual({ status: "intent_canceled_unreleased", releaseAllowed: false, proof });
  expect(h.rpc.mock.invocationCallOrder[h.rpc.mock.calls.findIndex(([name]) => name === "request_server_payment_stop_v1")])
    .toBeLessThan(prepareIntent.mock.invocationCallOrder[0]);
  expect(stopIntent).toHaveBeenCalledWith(expect.objectContaining({ contract,
    binding: { paymentIntentId: "pi_fixture", firstDispatchAt: expect.any(Number) } }));
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test("monthly manual stop holds an unbound original for reconciliation", async () => {
  const h = harness(false), selectionId = selectManualFirst(h);
  completedManualFirstOperations(h);
  h.env.CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY = "true";
  h.env.CREATOR_SERVER_PAYMENT_CANCELLATION_READY = "true";
  expect(await h.runtime.stopManualFirstIntent(h.f.a.id, h.f.a.buyer_id, selectionId))
    .toEqual({ status: "reconciliation_required", releaseAllowed: false });
  expect(h.order.indexOf("request_server_payment_stop_v1"))
    .toBeLessThan(h.order.indexOf("read_server_payment_intent_v1"));
  expect(stopIntent).not.toHaveBeenCalled();
  expect(prepareIntent).not.toHaveBeenCalled();
});
test("monthly manual terminal composition closes the original subscription only after the intent is proven canceled", async () => {
  const abandon = jest.fn(async () => ({ status: "abandoned" }));
  makeInitialAbandonment.mockImplementationOnce(() => ({ abandonFirstCheckout: abandon,
    reconcileAbandonedCheckoutEvent: jest.fn() }) as unknown as ReturnType<typeof createMembershipInitialAbandonment>);
  const h = harness(false), selectionId = selectManualFirst(h);
  await boundManualFirst(h, selectionId);
  h.env.CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY = "true";
  h.env.CREATOR_SERVER_PAYMENT_CANCELLATION_READY = "true";
  h.env.CREATOR_MONTHLY_MANUAL_TERMINAL_SCHEMA_READY = "true";
  h.env.CREATOR_MONTHLY_MANUAL_TERMINAL_READY = "true";
  stopIntent.mockResolvedValueOnce({ status: "intent_canceled_unreleased", releaseAllowed: false,
    proof: { version: "server-payment-intent-terminal-v1", paymentIntentId: "pi_fixture",
      status: "canceled", amountReceived: 0, amountCapturable: 0, canceledAt: 1, chargeIds: [], observedAt: 1 } });
  expect(await h.runtime.closeManualFirst(h.f.a.id, h.f.a.buyer_id, selectionId, true))
    .toEqual({ status: "abandoned" });
  expect(abandon).toHaveBeenCalledWith(h.f.a.id, h.f.a.buyer_id, true);
  expect(stopIntent.mock.invocationCallOrder[0]).toBeLessThan(abandon.mock.invocationCallOrder[0]);
});
test("monthly manual terminal composition leaves an uncertain original held", async () => {
  const abandon = jest.fn();
  makeInitialAbandonment.mockImplementationOnce(() => ({ abandonFirstCheckout: abandon,
    reconcileAbandonedCheckoutEvent: jest.fn() }) as unknown as ReturnType<typeof createMembershipInitialAbandonment>);
  const h = harness(false), selectionId = selectManualFirst(h);
  h.setManualRegistered(true);
  completedManualFirstOperations(h);
  h.env.CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY = "true";
  h.env.CREATOR_SERVER_PAYMENT_CANCELLATION_READY = "true";
  h.env.CREATOR_MONTHLY_MANUAL_TERMINAL_SCHEMA_READY = "true";
  h.env.CREATOR_MONTHLY_MANUAL_TERMINAL_READY = "true";
  expect(await h.runtime.closeManualFirst(h.f.a.id, h.f.a.buyer_id, selectionId, true))
    .toEqual({ status: "reconciliation_required", releaseAllowed: false });
  expect(abandon).not.toHaveBeenCalled();
});
test("monthly manual terminal composition closes a pre-journal selection through the original close-out", async () => {
  const abandon = jest.fn(async () => ({ status: "abandoned" }));
  makeInitialAbandonment.mockImplementationOnce(() => ({ abandonFirstCheckout: abandon,
    reconcileAbandonedCheckoutEvent: jest.fn() }) as unknown as ReturnType<typeof createMembershipInitialAbandonment>);
  const h = harness(false), selectionId = selectManualFirst(h);
  h.env.CREATOR_MONTHLY_MANUAL_TERMINAL_SCHEMA_READY = "true";
  h.env.CREATOR_MONTHLY_MANUAL_TERMINAL_READY = "true";
  expect(await h.runtime.closeManualFirst(h.f.a.id,h.f.a.buyer_id,selectionId,true))
    .toEqual({status:"abandoned"});
  expect(abandon).toHaveBeenCalledWith(h.f.a.id,h.f.a.buyer_id,true,true);
  expect(h.order).toContain("request_monthly_initial_abandonment_v1");
  expect(stopIntent).not.toHaveBeenCalled();
});
test("captured monthly first intent reaches the existing ledger and atomic manual receipt once", async () => {
  const h = harness(false), selectionId = selectManualFirst(h);
  completedManualFirstOperations(h);
  h.env.CREATOR_MONTHLY_MANUAL_RECEIPT_SCHEMA_READY = "true";
  h.env.CREATOR_MONTHLY_MANUAL_RECEIPT_READY = "true";
  h.env.CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY = "true";
  const contract = (await h.runtime.readManualFirstSource(h.f.a.id, h.f.a.buyer_id, selectionId)).contract;
  const evidence = await h.manualContextEvidence();
  const now = Math.floor(Date.now() / 1000), firstDispatchAt = now - 5;
  h.setManualIntent({ attempt_id: selectionId, contract,
    request: serverPaymentCreateRequest(contract, evidence), payment_intent_id: "pi_fixture",
    bound_at: new Date((now - 4) * 1000).toISOString() });
  prepareIntent.mockResolvedValueOnce({ status: "bound_unpublished", paymentIntentId: "pi_fixture",
    firstDispatchAt, providerStatus: "succeeded" });
  const admission = { operationId: "16000000-0000-4000-8000-000000000098" };
  const assertReadable = jest.fn(async () => {});
  makeConfirmationStore.mockReturnValueOnce({
    latest: jest.fn(async () => ({ admission })), store: { assertReadable },
  } as unknown as ReturnType<typeof createServerConfirmationStore>);
  observeConfirmation.mockResolvedValueOnce({ paymentIntentId: "pi_fixture", status: "succeeded",
    chargeId: "ch_fixture", paymentMethodId: "pm_fixture", observedAt: now,
    nextActionHash: null });
  Object.assign(h.f.paymentIntent, { ...serverPaymentCreateRequest(contract, evidence).params,
    id: "pi_fixture", object: "payment_intent", livemode: false,
    created: now - 4, status: "succeeded", amount_received: contract.amountCents,
    amount_capturable: 0, customer: h.f.customer.id,
    payment_method: "pm_fixture", latest_charge: "ch_fixture",
    setup_future_usage: "off_session", automatic_payment_methods: { enabled: false },
    on_behalf_of: null, shipping: null, transfer_group: null });
  Object.assign(h.f.charge, { created: now - 2, transfer: "tr_fixture",
    billing_details: { address: { country: "US" } } });
  const result = await h.runtime.recordManualFirstCapture(h.f.a.id, h.f.a.buyer_id, selectionId);
  expect(result).toMatchObject({ recorded: true, paymentIntentId: "pi_fixture",
    summary: { firstPaymentRecorded: true, accessGranted: true } });
  expect(feeLedger).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    purchaseId: h.f.a.purchase_id, paymentIntentId: "pi_fixture",
    breakdown: h.f.a.terms.firstMonthFees,
    stripeFee: { chargeId: "ch_fixture", balanceTransactionId: "txn_fixture",
      actualStripeFeeCents: 320,
      applicationFeeAmountCents: h.f.a.terms.firstMonthFees.totalCreatorDeductionCents } }), true);
  const receiptIndex = h.rpc.mock.calls.findIndex(([name]) => name === "record_monthly_manual_first_receipt_v1");
  expect(h.rpc.mock.invocationCallOrder[receiptIndex]).toBeGreaterThan(feeLedger.mock.invocationCallOrder[0]);
  expect(h.rpc.mock.calls[receiptIndex][1].p_proof).toMatchObject({
    checkoutSessionId: null, invoiceId: null,
    manualPayment: { attemptId: selectionId, confirmationOperationId: admission.operationId } });
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(h.stripe.paymentIntents.retrieve).toHaveBeenCalled();
});
test("manual bootstrap with no owned selection makes no provider call", async () => {
  const h = harness(false);
  h.env.CREATOR_MONTHLY_MANUAL_PREPARATION_READY = "true";
  h.env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY = "true";
  await expect(h.runtime.selectAndPrepareManualFirst(h.f.a.id, h.f.a.buyer_id)).rejects.toThrow("selected");
  expect(runOperation).not.toHaveBeenCalled();
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

test("current monthly consent can be saved without creating a hosted checkout", async () => {
  const h = harness(false); h.runtime.quote = jest.fn().mockResolvedValue(h.f.quote);
  expect(await h.runtime.accept(h.f.a.buyer_id, h.f.a.product_id, h.f.a.post_id,
    { accepted: true, version: h.f.a.terms.version, fingerprint: h.f.a.fingerprint }))
    .toEqual({ membershipId: h.f.a.id });
  expect(h.rpc).toHaveBeenCalledWith("reserve_monthly_mentorship_v1", expect.anything());
  expect(runOperation).not.toHaveBeenCalled();
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
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
