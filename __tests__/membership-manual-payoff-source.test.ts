/** @jest-environment node */
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMembershipRuntime } from "@/lib/membershipRuntime";
import { recordPaymentFeeLedger } from "@/lib/paymentFeeLedger";
import { membershipPayoffFixture, payoffTestEnv } from "../test-support/membership-payoff-fixtures";
import { membershipTestContext as context } from "../test-support/membership-fixtures";
import { SERVER_PAYMENT_PROTOCOL, observeServerPaymentConfirmation,
  serverPaymentCreateRequest } from "@/lib/serverPaymentConfirmation";
import { createServerConfirmationStore } from "@/lib/serverPaymentConfirmationStore";
import { prepareServerPaymentIntent } from "@/lib/serverPaymentIntent";
import { stopServerPaymentIntent } from "@/lib/serverPaymentStop";
jest.mock("@/lib/paymentFeeLedger", () => ({ recordPaymentFeeLedger: jest.fn() }));
jest.mock("@/lib/paymentRefunds", () => ({ reconcileKnownPaymentRefund: jest.fn() }));
jest.mock("@/lib/paymentDisputes", () => ({ reconcileKnownPaymentDispute: jest.fn() }));
jest.mock("@/lib/serverPaymentConfirmationStore", () => ({ createServerConfirmationStore: jest.fn() }));
jest.mock("@/lib/serverPaymentConfirmation", () => ({
  ...jest.requireActual("@/lib/serverPaymentConfirmation"), observeServerPaymentConfirmation: jest.fn() }));
jest.mock("@/lib/serverPaymentStop", () => ({ stopServerPaymentIntent: jest.fn() }));
jest.mock("@/lib/serverPaymentIntent", () => ({ prepareServerPaymentIntent: jest.fn(async (
  args: { assertProviderSource: () => Promise<void>; env: Record<string, string | undefined> }) => {
  if (args.env.CREATOR_SERVER_PAYMENT_INTENT_READY === "true") await args.assertProviderSource();
  return { status: "bound_unpublished", paymentIntentId: "pi_originalpayoff",
    firstDispatchAt: Math.floor(Date.now() / 1000) - 5,
    providerStatus: "requires_payment_method" };
}) }));
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(recordPaymentFeeLedger).mockResolvedValue("40000000-0000-4000-8000-000000000013");
});

function harness() {
  const f = membershipPayoffFixture(false), now = Math.floor(Date.now() / 1000);
  let protocolRegistered = false;
  f.p.status = "accepted"; f.p.checkout_request = null; f.p.checkout_dispatched_at = null;
  f.p.stripe_checkout_session_id = null;
  const accepted = Math.floor(Date.parse(f.p.accepted_at) / 1000);
  const selection = {
    id: "40000000-0000-4000-8000-000000000011", agreement_id: f.a.id, buyer_id: f.a.buyer_id,
    kind: "payoff", payoff_id: f.p.id, protocol: SERVER_PAYMENT_PROTOCOL,
    context, selected_at: new Date((now - 1) * 1000).toISOString(),
    source: { agreementId: f.a.id, purchaseId: f.a.purchase_id, buyerId: f.a.buyer_id,
      creatorId: f.a.creator_id, productId: f.a.product_id, postId: f.a.post_id,
      agreementFingerprint: f.a.fingerprint, sourceFingerprint: f.p.fingerprint,
      terms: f.p.terms, amountCents: f.p.terms.amountCents, acceptedAt: accepted,
      expiresAt: Math.min(accepted + 23 * 3600, f.p.terms.periodEnd), revision: f.a.revision } };
  const exact = { version: "exact-payment-context-v1" as const, mode: context.mode,
    platformAccountId: context.stripeAccountId, supabaseProjectRef: context.supabaseProjectRef,
    siteOrigin: context.siteOrigin };
  const evidence = { approvedContext: exact, vercelEnvironment: "preview",
    stripeSecretKeyMode: "test", stripePublishableKeyMode: "test",
    observedPlatformAccountId: context.stripeAccountId,
    observedSupabaseProjectRef: context.supabaseProjectRef,
    configuredSupabaseUrl: `https://${context.supabaseProjectRef}.supabase.co`,
    configuredSiteOrigin: context.siteOrigin };
  const from = jest.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const q: { select: jest.Mock; eq: jest.Mock; neq: jest.Mock; maybeSingle: jest.Mock } = {
      select: jest.fn(() => q), eq: jest.fn((key: string, value: unknown) => { filters[key] = value; return q; }),
      neq: jest.fn(() => q),
      maybeSingle: jest.fn(async () => {
        const row = table === "monthly_mentorship_agreements_v1" ? f.a :
          table === "monthly_mentorship_payoffs_v1" ? f.p :
          table === "monthly_manual_payment_selections_v1" ? selection :
          table === "server_payment_protocols_v1" ? protocolRegistered ? journal : null :
          table === "monthly_mentorship_operations_v1" ? { agreement_id: f.a.id, kind: "product",
            scope_key: "initial", status: "complete", provider_id: f.product.id } : null;
        const matches = row && Object.entries(filters).every(([key, value]) => (row as Record<string, unknown>)[key] === value);
        return { data: matches ? row : null, error: null };
      }) };
    return q;
  });
  let savedOperation: unknown = null;
  const journal = { attempt_id: selection.id, buyer_id: f.a.buyer_id,
    product_id: f.a.product_id, kind: "monthly_payoff", protocol: SERVER_PAYMENT_PROTOCOL,
    reservation_id: null, context: exact, source: selection };
  const rpc = jest.fn(async (name: string, params: Record<string, unknown>) => {
    if (name === "record_monthly_manual_payoff_receipt_v1") {
      if (f.p.status === "captured") return { error: null, data: false };
      f.a.covered_months = f.a.minimum_months; f.a.revision++;
      f.p.status = "captured"; f.p.ledger_id = String(params.p_ledger_id);
      f.p.provider_proof = params.p_proof as Record<string, unknown>;
      return { error: null, data: true };
    }
    if (name === "release_monthly_manual_payoff_v1") {
      f.p.status = "abandoned"; f.a.revision++;
      return { error: null, data: true };
    }
    return { error: null, data: name === "read_monthly_mentorship_exit_quote_v1" ? f.exitQuote :
      name === "select_monthly_manual_payment_v1" ? selection :
      name === "register_monthly_manual_source_v1" || name === "read_server_payment_source_v1" ? journal :
      name === "request_server_payment_stop_v1" ? { attemptId: selection.id, releaseAllowed: false } :
      name === "read_monthly_mentorship_entitlement_v1" ? { allowed: true } :
      name === "read_server_payment_intent_v1" ? savedOperation : null };
  });
  const response = <T,>(value: T) => Object.assign(value as object, {
    lastResponse: { apiVersion: context.apiVersion, requestId: "req_manualpayofffixture" } }) as Stripe.Response<T>;
  const stripe = {
    accounts: { retrieve: jest.fn(async (id?: string) => response(id ?
      { id, charges_enabled: true, payouts_enabled: true, capabilities: { transfers: "active" } } :
      { id: context.stripeAccountId, object: "account" })) },
    balance: { retrieve: jest.fn(async () => response({ object: "balance", livemode: false })) },
    customers: { retrieve: jest.fn(async () => response(f.customer)) },
    subscriptions: { retrieve: jest.fn(async () => response(f.subscription)) },
    checkout: { sessions: { create: jest.fn() } },
    paymentIntents: { create: jest.fn(), retrieve: jest.fn(async () => response(f.pi)) },
    charges: { retrieve: jest.fn(async () => response(f.charge)) },
    balanceTransactions: { retrieve: jest.fn(async () => response(f.balance)) },
    paymentMethods: { retrieve: jest.fn(async () => response({ id: "pm_payofffixture",
      object: "payment_method", livemode: false, customer: f.customer.id,
      type: "card", card: { country: "US" }, billing_details: { address: { country: "US" } } })) },
  };
  const env: Record<string, string | undefined> = { ...payoffTestEnv, CREATOR_MONTHLY_MANUAL_PAYOFF_READY: "true",
    CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY: "true", CREATOR_SERVER_PAYMENT_INTENT_READY: "true",
    CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY: "true", CREATOR_SERVER_PAYMENT_CANCELLATION_READY: "true",
    CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY: "true",
    CREATOR_MONTHLY_MANUAL_PAYOFF_RECEIPT_SCHEMA_READY: "true",
    CREATOR_MONTHLY_MANUAL_PAYOFF_RECEIPT_READY: "true" };
  const runtime = createMembershipRuntime(env, { admin: { from, rpc } as unknown as SupabaseClient,
    stripe: stripe as unknown as Stripe, context, manualContextEvidence: async () => evidence });
  return { f, selection, runtime, stripe, rpc, evidence,
    saveOperation: (operation: unknown) => { savedOperation = operation; },
    registerProtocol: () => { protocolRegistered = true; },
    enableTerminal: () => {
      env.CREATOR_MONTHLY_MANUAL_PAYOFF_TERMINAL_SCHEMA_READY = "true";
      env.CREATOR_MONTHLY_MANUAL_PAYOFF_TERMINAL_READY = "true";
    } };
}

test("accepted payoff freezes and reads one manual source without payment dispatch", async () => {
  const h = harness();
  const selected = await h.runtime.selectManualPayoff(h.f.a.id, h.f.a.buyer_id, h.f.p.id);
  expect(selected).toMatchObject({ payoffId: h.f.p.id, selectionId: h.selection.id });
  const read = await h.runtime.readManualPayoffSource(h.f.a.id, h.f.a.buyer_id, h.selection.id);
  expect(read.contract).toMatchObject({ kind: "monthly_payoff", attemptId: h.selection.id,
    amountCents: h.f.p.terms.amountCents, termsFingerprint: h.f.p.fingerprint });
  expect(h.rpc).toHaveBeenCalledWith("select_monthly_manual_payment_v1", expect.objectContaining({
    p_kind: "payoff", p_payoff_id: h.f.p.id }));
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
});

test("owned payoff readback and bank return bind the saved payoff selection", async () => {
  const h = harness();
  const owned = await h.runtime.readOwnedManualPayoff(h.f.a.id, h.f.a.buyer_id);
  expect(owned).toMatchObject({ membershipId: h.f.a.id, selectionId: h.selection.id,
    payoffId: h.f.p.id, amountCents: h.f.p.terms.amountCents,
    status: "accepted", manualAvailable: true });
  expect(await h.runtime.resolveManualPaymentReturn(h.selection.id, h.f.a.buyer_id))
    .toEqual({ membershipId: h.f.a.id, selectionId: h.selection.id, kind: "payoff" });
  expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
  expect(h.rpc).not.toHaveBeenCalledWith("record_monthly_manual_payoff_receipt_v1", expect.anything());
});

test("hosted payoff dispatch cannot be adopted into a new manual selection", async () => {
  const h = harness(); h.f.p.checkout_dispatched_at = new Date().toISOString();
  await expect(h.runtime.selectManualPayoff(h.f.a.id, h.f.a.buyer_id, h.f.p.id)).rejects.toThrow("requires recovery");
  expect(h.rpc).not.toHaveBeenCalledWith("select_monthly_manual_payment_v1", expect.anything());
});

test("payoff intent preparation registers only the frozen manual source", async () => {
  const h = harness();
  const result = await h.runtime.prepareManualPayoffIntent(h.f.a.id, h.f.a.buyer_id, h.selection.id);
  expect(result.status).toBe("bound_unpublished");
  expect(h.rpc).toHaveBeenCalledWith("register_monthly_manual_source_v1", expect.objectContaining({
    p_selection_id: h.selection.id, p_buyer_id: h.f.a.buyer_id }));
  expect(prepareServerPaymentIntent).toHaveBeenCalledWith(expect.objectContaining({
    contract: expect.objectContaining({ attemptId: h.selection.id, kind: "monthly_payoff" }) }));
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
});

test("changed frozen payoff amount fails before a manual contract can be read", async () => {
  const h = harness(); h.selection.source.amountCents++;
  await expect(h.runtime.readManualPayoffSource(h.f.a.id, h.f.a.buyer_id, h.selection.id)).rejects.toThrow("needs review");
  expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
});

test("absent original payoff intent remains unresolved without a new provider call", async () => {
  const h = harness();
  expect(await h.runtime.recoverManualPayoffIntent(h.f.a.id, h.f.a.buyer_id, h.selection.id))
    .toEqual({ status: "reconciliation_required" });
  expect(prepareServerPaymentIntent).not.toHaveBeenCalled();
  expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
});

test("bound original payoff intent recovers with creation explicitly disabled", async () => {
  const h = harness();
  const { contract } = await h.runtime.readManualPayoffSource(h.f.a.id, h.f.a.buyer_id, h.selection.id);
  h.saveOperation({ attempt_id: h.selection.id, contract,
    request: serverPaymentCreateRequest(contract, h.evidence),
    payment_intent_id: "pi_originalpayoff", bound_at: new Date().toISOString() });
  const recovered = await h.runtime.recoverManualPayoffIntent(h.f.a.id, h.f.a.buyer_id, h.selection.id);
  expect(recovered).toMatchObject({ status: "bound_unpublished", paymentIntentId: "pi_originalpayoff" });
  expect(prepareServerPaymentIntent).toHaveBeenCalledWith(expect.objectContaining({
    env: expect.objectContaining({ CREATOR_SERVER_PAYMENT_INTENT_READY: "false" }) }));
  expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
});

test("bound original payoff remains recoverable after its acceptance window", async () => {
  const h = harness();
  const { contract } = await h.runtime.readManualPayoffSource(h.f.a.id, h.f.a.buyer_id, h.selection.id);
  const accepted = Math.floor(Date.now() / 1000) - 24 * 3600;
  h.f.p.accepted_at = new Date(accepted * 1000).toISOString();
  h.selection.selected_at = new Date((accepted + 60) * 1000).toISOString();
  h.selection.source.acceptedAt = accepted;
  h.selection.source.expiresAt = accepted + 23 * 3600;
  const historical = { ...contract, acceptedAt: accepted, expiresAt: accepted + 23 * 3600 };
  h.saveOperation({ attempt_id: h.selection.id, contract: historical,
    request: serverPaymentCreateRequest(historical, h.evidence),
    payment_intent_id: "pi_originalpayoff", bound_at: new Date().toISOString() });
  expect(await h.runtime.recoverManualPayoffIntent(h.f.a.id, h.f.a.buyer_id, h.selection.id))
    .toMatchObject({ status: "bound_unpublished", paymentIntentId: "pi_originalpayoff" });
  expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
});

test("payoff stop persists the original hold when no bound intent can be proven", async () => {
  const h = harness();
  expect(await h.runtime.stopManualPayoffIntent(h.f.a.id, h.f.a.buyer_id, h.selection.id))
    .toEqual({ status: "reconciliation_required", releaseAllowed: false });
  expect(h.rpc).toHaveBeenCalledWith("request_server_payment_stop_v1", expect.objectContaining({
    p_attempt_id: h.selection.id }));
  expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
});

test("captured original payoff reaches the ledger and atomic manual receipt with no Checkout", async () => {
  const h = harness();
  const { contract } = await h.runtime.readManualPayoffSource(h.f.a.id, h.f.a.buyer_id, h.selection.id);
  const now = Math.floor(Date.now() / 1000);
  h.saveOperation({ attempt_id: h.selection.id, contract,
    request: serverPaymentCreateRequest(contract, h.evidence),
    payment_intent_id: "pi_originalpayoff", bound_at: new Date((now - 4) * 1000).toISOString() });
  const request = serverPaymentCreateRequest(contract, h.evidence);
  Object.assign(h.f.pi, { ...request.params, id: "pi_originalpayoff",
    object: "payment_intent", livemode: false, created: now - 4,
    status: "succeeded", amount_received: contract.amountCents, amount_capturable: 0,
    customer: h.f.customer.id, setup_future_usage: null,
    automatic_payment_methods: { enabled: false }, payment_method: "pm_payofffixture",
    latest_charge: h.f.charge.id, on_behalf_of: null, shipping: null, transfer_group: null });
  Object.assign(h.f.charge, { payment_intent: h.f.pi.id,
    payment_method: "pm_payofffixture", created: now - 2, transfer: "tr_payofffixture",
    billing_details: { address: { country: "US" } } });
  const admission = { operationId: "40000000-0000-4000-8000-000000000012" };
  const assertReadable = jest.fn(async () => {});
  jest.mocked(createServerConfirmationStore).mockReturnValueOnce({
    latest: jest.fn(async () => ({ admission })), store: { assertReadable },
  } as unknown as ReturnType<typeof createServerConfirmationStore>);
  jest.mocked(observeServerPaymentConfirmation).mockResolvedValueOnce({
    status: "succeeded", paymentIntentId: h.f.pi.id, chargeId: h.f.charge.id,
    paymentMethodId: "pm_payofffixture", observedAt: now, nextActionHash: null,
  });
  const result = await h.runtime.recordManualPayoffCapture(h.f.a.id, h.f.a.buyer_id, h.selection.id);
  expect(result).toMatchObject({ recorded: true, paymentIntentId: h.f.pi.id,
    summary: { firstPaymentRecorded: true, accessGranted: true } });
  expect(recordPaymentFeeLedger).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    purchaseId: h.f.a.purchase_id, paymentIntentId: h.f.pi.id,
    breakdown: h.f.p.terms.fees }), true);
  expect(h.rpc).toHaveBeenCalledWith("record_monthly_manual_payoff_receipt_v1", expect.objectContaining({
    p_selection_id: h.selection.id, p_proof: expect.objectContaining({
      checkoutSessionId: null, manualPayment: { attemptId: h.selection.id,
        confirmationOperationId: admission.operationId } }) }));
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
  const replay = await h.runtime.recordManualPayoffCapture(h.f.a.id, h.f.a.buyer_id, h.selection.id);
  expect(replay).toMatchObject({ recorded: false, paymentIntentId: h.f.pi.id,
    summary: { firstPaymentRecorded: true, accessGranted: true } });
  expect(recordPaymentFeeLedger).toHaveBeenCalledTimes(1);
});

test("an unregistered payoff source releases only through the dedicated terminal RPC", async () => {
  const h = harness(); h.enableTerminal();
  expect(await h.runtime.releaseManualPayoff(h.f.a.id, h.f.a.buyer_id, h.selection.id, true))
    .toMatchObject({ status: "abandoned", originalMonthlyPaymentsMayResume: true });
  expect(h.rpc).toHaveBeenCalledWith("release_monthly_manual_payoff_v1", expect.objectContaining({
    p_selection_id: h.selection.id, p_proof: expect.objectContaining({
      neverDispatched: true, paymentIntentId: null, terminalProof: null }) }));
  expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
});

test("an unbound dispatched payoff stays held after explicit stop", async () => {
  const h = harness(); h.enableTerminal(); h.registerProtocol();
  h.saveOperation({ attempt_id: h.selection.id, payment_intent_id: null, bound_at: null });
  expect(await h.runtime.releaseManualPayoff(h.f.a.id, h.f.a.buyer_id, h.selection.id, true))
    .toEqual({ status: "reconciliation_required", payoffId: h.f.p.id, releaseAllowed: false });
  expect(h.rpc).not.toHaveBeenCalledWith("release_monthly_manual_payoff_v1", expect.anything());
  expect(stopServerPaymentIntent).not.toHaveBeenCalled();
});

test("a bound payoff releases only with the original canceled zero-money proof", async () => {
  const h = harness(); h.enableTerminal(); h.registerProtocol();
  const { contract } = await h.runtime.readManualPayoffSource(h.f.a.id, h.f.a.buyer_id, h.selection.id);
  h.saveOperation({ attempt_id: h.selection.id, contract,
    request: serverPaymentCreateRequest(contract, h.evidence),
    payment_intent_id: "pi_originalpayoff", bound_at: new Date().toISOString() });
  const terminalProof = { version: "server-payment-intent-terminal-v1" as const,
    paymentIntentId: "pi_originalpayoff", status: "canceled" as const,
    amountReceived: 0 as const, amountCapturable: 0 as const, canceledAt: 1,
    chargeIds: [] as string[], observedAt: 1 };
  jest.mocked(stopServerPaymentIntent).mockResolvedValueOnce({
    status: "intent_canceled_unreleased", releaseAllowed: false, proof: terminalProof });
  expect(await h.runtime.releaseManualPayoff(h.f.a.id, h.f.a.buyer_id, h.selection.id, true))
    .toMatchObject({ status: "abandoned" });
  expect(h.rpc).toHaveBeenCalledWith("release_monthly_manual_payoff_v1", expect.objectContaining({
    p_proof: expect.objectContaining({ neverDispatched: false,
      paymentIntentId: "pi_originalpayoff", terminalProof }) }));
});

test("payoff release requires explicit confirmation before any journal read", async () => {
  const h = harness(); h.enableTerminal();
  await expect(h.runtime.releaseManualPayoff(h.f.a.id, h.f.a.buyer_id, h.selection.id, false))
    .rejects.toThrow("Explicit payoff stop");
  expect(h.rpc).not.toHaveBeenCalled();
});
