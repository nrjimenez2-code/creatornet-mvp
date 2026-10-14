import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isDeepStrictEqual } from "node:util";
import { runMembershipOperation, type MembershipOperationKind, type MembershipProviderRequest } from "./membershipOperation";
import { assertMembershipId, buildMembershipAgreement, MEMBERSHIP_PAYMENT_PROOF_VERSION, membershipMonthBoundary, type MembershipOffer, type MembershipPaymentContext } from "./membershipAgreement";
import { membershipServerClients, membershipCheckoutReady } from "./membershipServer";
import { assertMembershipCustomer, assertMembershipHeld, assertMembershipSession, buildMembershipCheckout,
  buildMembershipSubscription, membershipBootstrapTimes, membershipCheck as check, membershipMetadata,
  membershipStripeId as sid, readMembershipRecord, type MembershipRecord } from "./membershipCheckout";
import { recordPaymentFeeLedger, type StripeFeeDetails } from "./paymentFeeLedger";
import { applyPaymentRefundState, reconcileKnownPaymentRefund, recordPaymentRefundState } from "./paymentRefunds";
import { resolvePostForProduct, INVALID_POST } from "./checkoutGuards";
import { createMembershipBillingRuntime } from "./membershipBillingRuntime";
import { createMembershipExitRuntime } from "./membershipExit";
import { createMembershipPayoffRuntime } from "./membershipPayoffRuntime";
import { membershipPayoffMetadata, readMembershipPayoff } from "./membershipPayoff";
import { createMembershipLifecycleRuntime } from "./membershipLifecycle";
import { createMembershipPaymentEventRuntime } from "./membershipPaymentEvents";
import { createMembershipCheckoutRecovery } from "./membershipCheckoutRecovery";
import { createMembershipInitialAbandonment } from "./membershipInitialAbandonment";
import { createMembershipRenewalRecovery } from "./membershipRenewalRecovery";
import { createMembershipCardSetup } from "./membershipCardSetup";
import { createMembershipRetry } from "./membershipRetry";
import { createMembershipBankVerification } from "./membershipBankVerification";
import { reconcileKnownPaymentDispute } from "./paymentDisputes";
import { validateExactPaymentContext, type ExactPaymentContext } from "./installments/paymentContext";
import { buildMembershipManualContract } from "./membershipManualContract";
import { prepareServerPaymentIntent } from "./serverPaymentIntent";
import { SERVER_PAYMENT_PROTOCOL, observeServerPaymentConfirmation, serverPaymentCreateRequest, type ServerPaymentContract } from "./serverPaymentConfirmation";
import { createServerConfirmationStore, getServerPaymentAuthentication, runServerPaymentConfirmation } from "./serverPaymentConfirmationStore";
import { stopServerPaymentIntent } from "./serverPaymentStop";
import { inspectMembershipManualFirstCapture } from "./membershipManualFirstCapture";
import { inspectMembershipManualPayoffCapture } from "./membershipManualPayoffCapture";
import { creatorFeeMetadata } from "./money";

type FirstCapture = {
  session: Stripe.Checkout.Session; paymentIntent: Stripe.PaymentIntent; charge: Stripe.Charge; balance: Stripe.BalanceTransaction;
};
export function inspectMembershipFirstCapture(a: MembershipRecord, data: FirstCapture) {
  const { session: s, paymentIntent: pi, charge: c, balance: b } = data;
  assertMembershipSession(s, a, true);
  const live = a.terms.paymentContext.mode === "live", fees = a.terms.firstMonthFees;
  const expected = buildMembershipCheckout(a, a.stripe_customer_id!, a.stripe_subscription_id!);
  check(pi.object === "payment_intent" && pi.id === sid(s.payment_intent, "pi") && pi.livemode === live && pi.status === "succeeded" &&
    pi.customer === a.stripe_customer_id && pi.currency === "usd" && pi.amount === a.monthly_price_cents && pi.amount_received === pi.amount &&
    pi.amount_capturable === 0 && ["automatic", "automatic_async"].includes(pi.capture_method) && pi.setup_future_usage === "off_session" &&
    pi.application_fee_amount === fees.totalCreatorDeductionCents && pi.transfer_data?.destination === a.terms.destinationId &&
    pi.transfer_data.amount == null && isDeepStrictEqual(pi.metadata, expected.payment_intent_data!.metadata));
  const method = sid(pi.payment_method, "pm");
  check(c.object === "charge" && c.id === sid(pi.latest_charge, "ch") && c.payment_intent === pi.id && c.livemode === live &&
    c.customer === a.stripe_customer_id && c.status === "succeeded" && c.paid === true && c.captured === true && c.currency === "usd" &&
    c.amount === a.monthly_price_cents && c.amount_captured === c.amount && c.application_fee_amount === fees.totalCreatorDeductionCents &&
    c.payment_method === method && c.payment_method_details?.type === "card" && Number.isSafeInteger(c.created) &&
    c.created >= Math.floor(Date.parse(a.accepted_at) / 1000) && c.created <= Math.floor(Date.now() / 1000) &&
    Number.isSafeInteger(c.amount_refunded) && c.amount_refunded >= 0 && c.amount_refunded <= c.amount && typeof c.disputed === "boolean");
  check(b.object === "balance_transaction" && b.id === sid(c.balance_transaction, "txn") && b.source === c.id && b.type === "charge" &&
    b.currency === "usd" && b.amount === c.amount && Number.isSafeInteger(b.fee) && b.fee >= 0 && b.fee <= c.amount && b.net === b.amount - b.fee);
  const stripeFee: StripeFeeDetails = { chargeId: c.id, balanceTransactionId: b.id,
    actualStripeFeeCents: b.fee, applicationFeeAmountCents: c.application_fee_amount };
  return { stripeFee, anchor: c.created, proof: { version: MEMBERSHIP_PAYMENT_PROOF_VERSION, paymentContext: a.terms.paymentContext,
    customerId: a.stripe_customer_id, subscriptionId: a.stripe_subscription_id, checkoutSessionId: s.id,
    destinationId: a.terms.destinationId, paymentIntentId: pi.id, chargeId: c.id, invoiceId: null,
    capturedAmountCents: c.amount, applicationFeeAmountCents: c.application_fee_amount, paymentStatus: "succeeded",
    paymentMethodId: method, paidAt: c.created } };
}

/** The default path uses the existing ledger/refund/dispute reconciliation,
 * never a new money balance. Test injection is private to the runtime factory. */
async function writeFirstLedger(admin: SupabaseClient, a: MembershipRecord, data: FirstCapture) {
  const inspected = inspectMembershipFirstCapture(a, data), c = data.charge;
  const ledgerId = await recordPaymentFeeLedger(admin, { breakdown: a.terms.firstMonthFees, currency: "usd", creatorId: a.creator_id,
    purchaseId: a.purchase_id, checkoutSessionId: data.session.id, paymentIntentId: data.paymentIntent.id, stripeFee: inspected.stripeFee }, true);
  if (c.amount_refunded > 0) {
    const state = await recordPaymentRefundState(admin, { paymentIntentId: data.paymentIntent.id, chargeId: c.id,
      chargeAmountCents: c.amount, refundedAmountCents: c.amount_refunded });
    await applyPaymentRefundState(admin, state);
  }
  await reconcileKnownPaymentRefund(admin, data.paymentIntent.id);
  await reconcileKnownPaymentDispute(admin, data.paymentIntent.id);
  if (c.disputed) {
    const result = await admin.from("payment_fee_ledger").select("dispute_status").eq("id", ledgerId!).maybeSingle();
    check(!result.error && ["won", "warning_closed"].includes(result.data?.dispute_status), "Monthly dispute requires reconciliation before credit");
  }
  check(ledgerId); return ledgerId;
}

export type MembershipRuntimeDependencies = { admin: SupabaseClient; stripe: Stripe; context: MembershipPaymentContext;
  writeFirstLedger?: typeof writeFirstLedger; manualContextEvidence?: () => Promise<unknown> };
type ManualFirstSelection = { id: string; agreement_id: string; buyer_id: string; kind: string;
  payoff_id: string | null; protocol: string; context: unknown; source: Record<string, unknown>; selected_at: string };
type ManualFirstConfirmationAction = Parameters<typeof runServerPaymentConfirmation>[0]["action"];
export function createMembershipRuntime(env: Record<string, string | undefined> = process.env, injected?: MembershipRuntimeDependencies) {
  const { admin, stripe, context } = injected || membershipServerClients(env), started = Date.now();
  let observedAt = 0;
  const fresh = () => check(Date.now() - started < 45000, "Monthly operation needs a bounded retry");
  async function checked<T>(promise: Promise<Stripe.Response<T>>): Promise<Stripe.Response<T>> {
    fresh(); const result = await promise; fresh();
    check(result.lastResponse?.apiVersion === context.apiVersion && /^req_[A-Za-z0-9]+$/.test(result.lastResponse.requestId) &&
      (result.lastResponse.stripeAccount == null || result.lastResponse.stripeAccount === context.stripeAccountId), "Monthly provider response context differs");
    return result;
  }
  async function observeContext() {
    fresh();
    if (Date.now() - observedAt < 1000) return context;
    const account = await checked(stripe.accounts.retrieve());
    const balance = await checked(stripe.balance.retrieve());
    check(account.object === "account" && account.id === context.stripeAccountId && balance.object === "balance" &&
      balance.livemode === (context.mode === "live"), "Monthly provider account or mode differs");
    observedAt = Date.now(); return context;
  }
  async function manualContextEvidence() {
    const exact: ExactPaymentContext = { version: "exact-payment-context-v1", mode: context.mode,
      platformAccountId: context.stripeAccountId, supabaseProjectRef: context.supabaseProjectRef,
      siteOrigin: context.siteOrigin };
    let evidence: unknown;
    if (injected?.manualContextEvidence) evidence = await injected.manualContextEvidence();
    else {
      const [{ exactContextServerConfig }, { createExactContextRuntime }] = await Promise.all([
        import("./installments/contextServer"), import("./installments/contextRuntime")]);
      const config = exactContextServerConfig(env);
      check(isDeepStrictEqual(config.approvedContext, exact), "Monthly manual context pin differs");
      const observation = await createExactContextRuntime(config).observeContext();
      check(isDeepStrictEqual(observation.context, exact), "Monthly manual context observation differs");
      evidence = observation.contextEvidence;
    }
    validateExactPaymentContext(exact, evidence);
    return evidence;
  }
  async function load(id: string, buyerId: string) {
    const result = await admin.from("monthly_mentorship_agreements_v1").select("*").eq("id", id).eq("buyer_id", buyerId).maybeSingle();
    check(!result.error && result.data, "Owned membership not found");
    const a = readMembershipRecord(result.data);
    check(a.id === id && a.buyer_id === buyerId && isDeepStrictEqual(a.terms.paymentContext, context), "Monthly agreement context differs");
    return a;
  }
  async function loadManualFirstSelection(id: string, buyerId: string, selectionId: string, historical = false) {
    assertMembershipId(selectionId);
    const a = await load(id, buyerId); await observeContext();
    const selected = await admin.from("monthly_manual_payment_selections_v1").select("*")
      .eq("id", selectionId).eq("agreement_id", id).eq("buyer_id", buyerId).maybeSingle();
    check(!selected.error && selected.data, "Owned monthly manual selection not found");
    const s = selected.data as ManualFirstSelection;
    const accepted = Math.floor(Date.parse(a.accepted_at) / 1000), expiry = accepted + 23 * 3600;
    check(Object.keys(s).sort().join(",") === "agreement_id,buyer_id,context,id,kind,payoff_id,protocol,selected_at,source" &&
      s.source && typeof s.source === "object" && !Array.isArray(s.source) &&
      Object.keys(s.source).sort().join(",") ===
      "acceptedAt,agreementFingerprint,agreementId,amountCents,buyerId,creatorId,expiresAt,postId,productId,purchaseId,revision,sourceFingerprint,terms" &&
      s.id === selectionId && s.agreement_id === id && s.buyer_id === buyerId && s.kind === "first" &&
      s.protocol === "creatornet-us-manual-confirmation-v1" && s.payoff_id === null &&
      isDeepStrictEqual(s.context, context) && s.source?.agreementId === id &&
      s.source?.purchaseId === a.purchase_id && s.source?.buyerId === buyerId &&
      s.source?.creatorId === a.creator_id && s.source?.productId === a.product_id &&
      s.source?.postId === a.post_id && s.source?.agreementFingerprint === a.fingerprint &&
      s.source?.sourceFingerprint === a.fingerprint && s.source?.amountCents === a.monthly_price_cents &&
      s.source?.acceptedAt === accepted && s.source?.expiresAt === expiry &&
      Number.isSafeInteger(s.source?.revision) && (historical ?
        (s.source.revision as number) >= 0 && (s.source.revision as number) <= a.revision : s.source.revision === a.revision) &&
      isDeepStrictEqual(s.source?.terms, a.terms) &&
      Number.isFinite(Date.parse(s.selected_at)) && Date.parse(s.selected_at) >= accepted * 1000 &&
      Date.parse(s.selected_at) < expiry * 1000 && (historical || Date.now() < expiry * 1000),
      "Monthly manual source needs review");
    return { a, s };
  }
  async function productId(a: MembershipRecord) {
    const result = await admin.from("monthly_mentorship_operations_v1").select("provider_id").eq("agreement_id", a.id)
      .eq("kind", "product").eq("scope_key", "initial").eq("status", "complete").maybeSingle();
    check(!result.error); return sid(result.data?.provider_id, "prod");
  }
  async function operation<T extends { id: string; lastResponse?: { requestId?: string } }>(a: MembershipRecord, kind: MembershipOperationKind,
    path: string, params: object, create: (params: MembershipProviderRequest, options: { idempotencyKey: string; maxNetworkRetries: 0 }) => Promise<T>,
    retrieve: (id: string) => Promise<T>, validate: (object: T) => void) {
    return runMembershipOperation({ admin, agreementId: a.id, actorId: a.buyer_id, revision: a.revision, kind, scope: "initial", context,
      request: { method: "POST", path, params: params as Record<string, unknown> }, env, observeContext, create, retrieve, validate });
  }
  async function summary(a: MembershipRecord) {
    const result = await admin.rpc("read_monthly_mentorship_entitlement_v1", { p_purchase_id: a.purchase_id, p_buyer_id: a.buyer_id });
    check(!result.error && result.data && typeof result.data.allowed === "boolean");
    return { membershipId: a.id, title: a.terms.title, firstPaymentRecorded: a.covered_months > 0, accessGranted: result.data.allowed,
      paidThrough: a.anchor_at && a.covered_months > 0 ? new Date(membershipMonthBoundary(a.anchor_at, a.covered_months) * 1000).toISOString() : null };
  }
  // Keep the original customer/product/subscription/hold operation sequence in
  // one place. A separately selected manual first payment can reuse these
  // exact journal entries without admitting a hosted Checkout Session.
  async function bootstrapOriginal(a: MembershipRecord) {
    check(a.covered_months === 0 && !a.stripe_checkout_session_id && !a.financial_hold_at &&
      !a.billing_review_at && !a.debit_revoked_at && !a.renewal_stopped_at &&
      !a.initial_abandon_requested_at && !a.initial_abandoned_at,
      "Monthly bootstrap needs original payment review");
    check(Math.floor(Date.now() / 1000) < membershipBootstrapTimes(a).expiresAt - 31 * 60,
      "Monthly checkout acceptance needs recovery");
    const customer = await operation(a, "customer", "/v1/customers", { metadata: membershipMetadata(a, "customer") },
      (r, opts) => checked(stripe.customers.create(r.params as Stripe.CustomerCreateParams, opts)),
      id => checked(stripe.customers.retrieve(id)), c => assertMembershipCustomer(c, a, true));
    const product = await operation(a, "product", "/v1/products", { name: a.terms.title.slice(0, 200), metadata: membershipMetadata(a, "product") },
      (r, opts) => { check(typeof r.params.name === "string"); return checked(stripe.products.create({ ...r.params, name: r.params.name }, opts)); }, id => checked(stripe.products.retrieve(id)), p => {
        check(p.object === "product" && p.active && p.livemode === (context.mode === "live") && p.name === a.terms.title.slice(0, 200) &&
          p.default_price === null && isDeepStrictEqual(p.metadata, membershipMetadata(a, "product"))); });
    const subscription = await operation(a, "subscription", "/v1/subscriptions", buildMembershipSubscription(a, customer.id, product.id),
      (r, opts) => { check(typeof r.params.customer === "string"); return checked(stripe.subscriptions.create({ ...r.params, customer: r.params.customer }, opts)); }, id => checked(stripe.subscriptions.retrieve(id)),
      s => assertMembershipHeld(s, a, customer.id, product.id, null));
    await operation(a, "hold", `/v1/subscriptions/${subscription.id}`, { pause_collection: { behavior: "keep_as_draft" } },
      (r, opts) => checked(stripe.subscriptions.update(subscription.id, r.params as Stripe.SubscriptionUpdateParams, opts)), id => checked(stripe.subscriptions.retrieve(id)),
      s => { check(s.id === subscription.id); assertMembershipHeld(s, a, customer.id, product.id, true); });
    const held = await checked(stripe.subscriptions.retrieve(subscription.id));
    assertMembershipHeld(held, a, customer.id, product.id, true);
    assertMembershipCustomer(await checked(stripe.customers.retrieve(customer.id)), a, true);
    return { customer, product, subscription: held };
  }
  async function readManualFirstJournal(a: MembershipRecord, originalRevision: number) {
    const kinds = ["customer", "product", "subscription", "hold"] as const;
    const result = await admin.from("monthly_mentorship_operations_v1")
      .select("kind,scope_key,status,provider_id,request,agreement_revision")
      .eq("agreement_id", a.id).eq("scope_key", "initial").in("kind", [...kinds]);
    check(!result.error && result.data?.length === kinds.length, "Original monthly preparation is incomplete");
    type Row = { kind: string; scope_key: string; status: string; provider_id: string | null;
      request: unknown; agreement_revision: number };
    const rows = new Map<string, Row>();
    for (const row of result.data as Row[]) {
      check(kinds.some(kind => kind === row.kind) && !rows.has(row.kind) && row.scope_key === "initial" &&
        row.status === "complete" && row.agreement_revision === originalRevision,
        "Original monthly preparation differs");
      rows.set(row.kind, row);
    }
    const customerId = sid(rows.get("customer")?.provider_id, "cus");
    const productId = sid(rows.get("product")?.provider_id, "prod");
    const subscriptionId = sid(rows.get("subscription")?.provider_id, "sub");
    check(rows.get("hold")?.provider_id === subscriptionId &&
      (a.stripe_customer_id === null || a.stripe_customer_id === customerId) &&
      (a.stripe_subscription_id === null || a.stripe_subscription_id === subscriptionId),
      "Original monthly provider binding differs");
    const expected = {
      customer: { method: "POST", path: "/v1/customers", params: { metadata: membershipMetadata(a, "customer") } },
      product: { method: "POST", path: "/v1/products", params: { name: a.terms.title.slice(0, 200),
        metadata: membershipMetadata(a, "product") } },
      subscription: { method: "POST", path: "/v1/subscriptions", params: buildMembershipSubscription(a, customerId, productId) },
      hold: { method: "POST", path: `/v1/subscriptions/${subscriptionId}`,
        params: { pause_collection: { behavior: "keep_as_draft" } } },
    };
    for (const kind of kinds) check(isDeepStrictEqual(rows.get(kind)?.request, expected[kind]),
      "Original monthly operation request differs");
    return { customerId, productId, subscriptionId };
  }
  function historicalManualFirstContract(a: MembershipRecord, s: ManualFirstSelection,
    customerId: string, subscriptionId: string, evidence: unknown): ServerPaymentContract {
    check(a.stripe_checkout_session_id === null && s.source.revision !== undefined,
      "Original monthly manual history differs");
    const exact: ExactPaymentContext = { version: "exact-payment-context-v1", mode: context.mode,
      platformAccountId: context.stripeAccountId, supabaseProjectRef: context.supabaseProjectRef,
      siteOrigin: context.siteOrigin };
    const validated = validateExactPaymentContext(exact, evidence), fees = a.terms.firstMonthFees;
    const contract: ServerPaymentContract = Object.freeze({
      protocol: SERVER_PAYMENT_PROTOCOL, attemptId: s.id, buyerId: a.buyer_id,
      creatorId: a.creator_id, productId: a.product_id, termsFingerprint: a.fingerprint,
      context: validated, customerId, destinationId: a.terms.destinationId,
      amountCents: a.monthly_price_cents,
      processingFees: Object.freeze({ enabled: fees.processingFeeEnabled,
        basisPoints: fees.processingFeeBasisPoints, fixedCents: fees.processingFeeFixedCents,
        version: fees.feeScheduleVersion }),
      kind: "monthly_first", sourceMetadata: Object.freeze({ ...membershipMetadata(a, "manual_first"),
        membership_subscription_id: subscriptionId, ...creatorFeeMetadata(fees) }),
      acceptedAt: s.source.acceptedAt as number, expiresAt: s.source.expiresAt as number,
    });
    serverPaymentCreateRequest(contract, evidence);
    return contract;
  }
  const billing = createMembershipBillingRuntime({ admin, stripe, context, env, checked, observeContext, load, productId });
  const exit = createMembershipExitRuntime({ admin, stripe, context, env, checked, observeContext, load, productId });
  const payoff = createMembershipPayoffRuntime({ admin, stripe, context, env, checked, observeContext, load, productId });
  async function loadManualPayoffSelection(id: string, buyerId: string, selectionId: string, historical = false) {
    assertMembershipId(selectionId);
    const a = await load(id, buyerId); await observeContext();
    const selected = await admin.from("monthly_manual_payment_selections_v1").select("*")
      .eq("id", selectionId).eq("agreement_id", id).eq("buyer_id", buyerId).eq("kind", "payoff").maybeSingle();
    check(!selected.error && selected.data, "Owned monthly payoff selection not found");
    const s = selected.data as ManualFirstSelection;
    assertMembershipId(s.payoff_id);
    const saved = await admin.from("monthly_mentorship_payoffs_v1").select("*")
      .eq("id", s.payoff_id).eq("agreement_id", id).eq("buyer_id", buyerId).maybeSingle();
    check(!saved.error && saved.data, "Owned monthly payoff not found");
    const p = readMembershipPayoff(saved.data, a);
    const accepted = Math.floor(Date.parse(p.accepted_at) / 1000);
    const expiry = Math.min(accepted + 23 * 3600, p.terms.periodEnd);
    check(Object.keys(s).sort().join(",") === "agreement_id,buyer_id,context,id,kind,payoff_id,protocol,selected_at,source" &&
      s.source && typeof s.source === "object" && !Array.isArray(s.source) &&
      Object.keys(s.source).sort().join(",") ===
      "acceptedAt,agreementFingerprint,agreementId,amountCents,buyerId,creatorId,expiresAt,postId,productId,purchaseId,revision,sourceFingerprint,terms" &&
      s.id === selectionId && s.agreement_id === id && s.buyer_id === buyerId && s.kind === "payoff" &&
      s.protocol === SERVER_PAYMENT_PROTOCOL && s.payoff_id === p.id &&
      isDeepStrictEqual(s.context, context) && s.source.agreementId === id &&
      s.source.purchaseId === a.purchase_id && s.source.buyerId === buyerId &&
      s.source.creatorId === a.creator_id && s.source.productId === a.product_id &&
      s.source.postId === a.post_id && s.source.agreementFingerprint === a.fingerprint &&
      s.source.sourceFingerprint === p.fingerprint && s.source.amountCents === p.terms.amountCents &&
      s.source.acceptedAt === accepted && s.source.expiresAt === expiry &&
      Number.isSafeInteger(s.source.revision) && (historical ?
        (s.source.revision as number) >= 0 && (s.source.revision as number) <= a.revision :
        s.source.revision === a.revision) && isDeepStrictEqual(s.source.terms, p.terms) &&
      Number.isFinite(Date.parse(s.selected_at)) && Date.parse(s.selected_at) >= accepted * 1000 &&
      Date.parse(s.selected_at) < expiry * 1000 && (historical || Date.now() < expiry * 1000),
      "Monthly payoff source needs review");
    return { a, p, s };
  }
  function historicalManualPayoffContract(a: MembershipRecord, p: ReturnType<typeof readMembershipPayoff>,
    s: ManualFirstSelection, evidence: unknown): ServerPaymentContract {
    check(s.kind === "payoff" && s.payoff_id === p.id && p.checkout_request === null &&
      p.checkout_dispatched_at === null && p.stripe_checkout_session_id === null,
      "Original monthly payoff history differs");
    const exact: ExactPaymentContext = { version: "exact-payment-context-v1", mode: context.mode,
      platformAccountId: context.stripeAccountId, supabaseProjectRef: context.supabaseProjectRef,
      siteOrigin: context.siteOrigin };
    const validated = validateExactPaymentContext(exact, evidence), fees = p.terms.fees;
    const contract: ServerPaymentContract = Object.freeze({
      protocol: SERVER_PAYMENT_PROTOCOL, attemptId: s.id, buyerId: a.buyer_id,
      creatorId: a.creator_id, productId: a.product_id, termsFingerprint: p.fingerprint,
      context: validated, customerId: sid(a.stripe_customer_id, "cus"),
      destinationId: a.terms.destinationId, amountCents: p.terms.amountCents,
      processingFees: Object.freeze({ enabled: fees.processingFeeEnabled,
        basisPoints: fees.processingFeeBasisPoints, fixedCents: fees.processingFeeFixedCents,
        version: fees.feeScheduleVersion }),
      kind: "monthly_payoff", sourceMetadata: Object.freeze(membershipPayoffMetadata(a, p)),
      acceptedAt: s.source.acceptedAt as number, expiresAt: s.source.expiresAt as number,
    });
    serverPaymentCreateRequest(contract, evidence);
    return contract;
  }
  const api = {
    context, activate: billing.activate, collectNext: billing.collectNext, reconcileInvoice: billing.reconcileInvoice,
    quoteExit: exit.quoteExit, requestExit: exit.requestExit, reconcileExitStop: exit.reconcileExitStop,
    quotePayoff: payoff.quotePayoff, acceptPayoff: payoff.acceptPayoff,
    acceptAndPreparePayoff: payoff.acceptAndPreparePayoff,
    confirmPayoff: payoff.confirmPayoff, abandonPayoff: payoff.abandonPayoff,
    /** Freeze a separately accepted payoff before any manual provider operation. */
    async selectManualPayoff(id: string, buyerId: string, payoffId: string) {
      check(env.CREATOR_MONTHLY_MANUAL_PAYOFF_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY === "true", "Monthly manual payoff is not enabled");
      assertMembershipId(payoffId);
      const a = await load(id, buyerId);
      const saved = await admin.from("monthly_mentorship_payoffs_v1").select("*")
        .eq("id", payoffId).eq("agreement_id", id).eq("buyer_id", buyerId).maybeSingle();
      check(!saved.error && saved.data, "Owned monthly payoff not found");
      await payoff.assertManualPayoffEligible(a, readMembershipPayoff(saved.data, a));
      const selected = await admin.rpc("select_monthly_manual_payment_v1", {
        p_id: id, p_buyer_id: buyerId, p_context: context, p_kind: "payoff", p_payoff_id: payoffId });
      check(!selected.error && selected.data?.id, "Monthly payoff source could not be selected safely");
      await loadManualPayoffSelection(id, buyerId, selected.data.id);
      return { membershipId: id, payoffId, selectionId: selected.data.id as string };
    },
    /** Owner readback is safe while new payoff admission is paused. The active
     * payoff ID comes from the server quote, never from a browser return. */
    async readOwnedManualPayoff(id: string, buyerId: string) {
      const quote = await payoff.quotePayoff(id, buyerId);
      const a = await load(id, buyerId);
      if (!quote.payoffId) return { membershipId: id, selectionId: null, buyerId,
        productId: a.product_id, title: a.terms.title, amountCents: quote.terms.amountCents,
        currency: "usd" as const, payoffId: null, status: quote.status,
        terms: quote.terms, fingerprint: quote.fingerprint, acceptanceExpiresAt: null,
        manualAvailable: true };
      const saved = await admin.from("monthly_mentorship_payoffs_v1").select("*")
        .eq("id", quote.payoffId).eq("agreement_id", id).eq("buyer_id", buyerId).maybeSingle();
      check(!saved.error && saved.data, "Owned monthly payoff not found");
      const active = readMembershipPayoff(saved.data, a);
      const manualAvailable = active.status === "accepted" &&
        active.checkout_request === null && active.checkout_dispatched_at === null &&
        active.stripe_checkout_session_id === null && active.ledger_id === null;
      const selected = await admin.from("monthly_manual_payment_selections_v1").select("id")
        .eq("agreement_id", id).eq("buyer_id", buyerId).eq("kind", "payoff")
        .eq("payoff_id", quote.payoffId).maybeSingle();
      check(!selected.error, "Owned monthly payoff selection needs review");
      if (!selected.data) return { membershipId: id, selectionId: null, buyerId,
        productId: a.product_id, title: a.terms.title, amountCents: quote.terms.amountCents,
        currency: "usd" as const, payoffId: quote.payoffId, status: quote.status,
        terms: quote.terms, fingerprint: quote.fingerprint,
        acceptanceExpiresAt: Math.min(Math.floor(Date.parse(active.accepted_at) / 1000) + 23 * 3600,
          active.terms.periodEnd),
        manualAvailable };
      const { p, s } = await loadManualPayoffSelection(id, buyerId, selected.data.id, true);
      return { membershipId: id, selectionId: s.id, buyerId, productId: a.product_id,
        title: a.terms.title, amountCents: p.terms.amountCents, currency: "usd" as const,
        payoffId: p.id, status: p.status, terms: p.terms, fingerprint: p.fingerprint,
        acceptanceExpiresAt: s.source.expiresAt as number, manualAvailable };
    },
    async resolveManualPayoffReturn(attemptId: string, buyerId: string) {
      assertMembershipId(attemptId);
      const selected = await admin.from("monthly_manual_payment_selections_v1")
        .select("id,agreement_id").eq("id", attemptId).eq("buyer_id", buyerId)
        .eq("kind", "payoff").maybeSingle();
      check(!selected.error && selected.data?.id === attemptId && selected.data.agreement_id,
        "Owned monthly payoff return not found");
      await loadManualPayoffSelection(selected.data.agreement_id, buyerId, attemptId, true);
      return { membershipId: selected.data.agreement_id as string,
        selectionId: attemptId, kind: "payoff" as const };
    },
    /** Current source readback cannot create or confirm a PaymentIntent. */
    async readManualPayoffSource(id: string, buyerId: string, selectionId: string) {
      check(env.CREATOR_MONTHLY_MANUAL_PAYOFF_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY === "true", "Monthly manual payoff is not enabled");
      const { a, p, s } = await loadManualPayoffSelection(id, buyerId, selectionId);
      await manualContextEvidence();
      await payoff.assertManualPayoffEligible(a, p);
      const customer = await checked(stripe.customers.retrieve(sid(a.stripe_customer_id, "cus")));
      const destination = await checked(stripe.accounts.retrieve(a.terms.destinationId));
      check(destination.id === a.terms.destinationId && destination.charges_enabled &&
        destination.payouts_enabled && destination.capabilities?.transfers === "active",
        "Monthly payoff destination is not payable");
      const current = await loadManualPayoffSelection(id, buyerId, selectionId);
      check(isDeepStrictEqual(current.s, s) && current.a.revision === a.revision &&
        isDeepStrictEqual(current.p, p), "Monthly payoff source changed during readback");
      const contract = buildMembershipManualContract({ selection: current.s, agreement: current.a,
        payoff: current.p, contextEvidence: await manualContextEvidence(),
        now: Math.floor(Date.now() / 1000), customer });
      return { contract, selection: current.s, selectionId, payoffId: p.id, customerId: customer.id };
    },
    /** Fresh payoff admission uses the shared original-intent journal. This
     * remains internal until bound recovery, confirmation and receipt exist. */
    async prepareManualPayoffIntent(id: string, buyerId: string, selectionId: string) {
      check(env.CREATOR_MONTHLY_MANUAL_PAYOFF_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_INTENT_READY === "true", "Monthly manual payoff intent is not enabled");
      const prepared = await this.readManualPayoffSource(id, buyerId, selectionId);
      const c = prepared.contract;
      const registered = await admin.rpc("register_monthly_manual_source_v1", {
        p_selection_id: selectionId, p_buyer_id: buyerId, p_context: c.context });
      check(!registered.error && registered.data &&
        registered.data.attempt_id === selectionId && registered.data.buyer_id === buyerId &&
        registered.data.product_id === c.productId && registered.data.kind === "monthly_payoff" &&
        registered.data.protocol === c.protocol && registered.data.reservation_id === null &&
        isDeepStrictEqual(registered.data.context, c.context) &&
        isDeepStrictEqual(registered.data.source, prepared.selection),
        "Original monthly payoff journal registration differs");
      return prepareServerPaymentIntent({ contract: c, admin, stripe, env,
        contextEvidence: manualContextEvidence,
        assertProviderSource: async () => {
          const latest = await this.readManualPayoffSource(id, buyerId, selectionId);
          check(isDeepStrictEqual(latest.contract, c), "Monthly payoff source changed before intent dispatch");
        } });
    },
    /** Bound-only payoff recovery, including after expiry or a stop. An absent
     * or unbound original never becomes authority to create a new intent. */
    async recoverManualPayoffIntent(id: string, buyerId: string, selectionId: string) {
      check(env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY === "true", "Monthly payoff intent recovery is not enabled");
      const { a, p, s } = await loadManualPayoffSelection(id, buyerId, selectionId, true);
      const evidence = await manualContextEvidence();
      const contract = historicalManualPayoffContract(a, p, s, evidence);
      const scope = { p_attempt_id: selectionId, p_buyer_id: buyerId, p_context: contract.context };
      const source = await admin.rpc("read_server_payment_source_v1", { ...scope, p_for_dispatch: false });
      check(!source.error && source.data && source.data.attempt_id === selectionId &&
        source.data.buyer_id === buyerId && source.data.product_id === a.product_id &&
        source.data.kind === "monthly_payoff" && source.data.protocol === contract.protocol &&
        source.data.reservation_id === null && isDeepStrictEqual(source.data.context, contract.context) &&
        isDeepStrictEqual(source.data.source, s), "Original monthly payoff source differs");
      const original = await admin.rpc("read_server_payment_intent_v1", scope);
      check(!original.error, "Original monthly payoff intent could not be read");
      if (!original.data) return { status: "reconciliation_required" as const };
      const op = original.data as { attempt_id: string; contract: ServerPaymentContract;
        request: unknown; payment_intent_id: string | null; bound_at: string | null };
      check(op.attempt_id === selectionId && isDeepStrictEqual(op.contract, contract) &&
        isDeepStrictEqual(op.request, serverPaymentCreateRequest(contract, evidence, op.request)),
        "Original monthly payoff intent differs");
      if (!op.payment_intent_id || !op.bound_at) return { status: "reconciliation_required" as const };
      const recovered = await prepareServerPaymentIntent({ contract, admin, stripe,
        env: { ...env, CREATOR_SERVER_PAYMENT_INTENT_READY: "false" },
        contextEvidence: manualContextEvidence,
        assertProviderSource: async () => { throw Error("Bound recovery cannot dispatch a new payoff intent"); } });
      if (recovered.status === "bound_unpublished")
        check(recovered.paymentIntentId === op.payment_intent_id,
          "Original monthly payoff intent binding changed during recovery");
      return recovered.status === "bound_unpublished" ? recovered : { status: "reconciliation_required" as const };
    },
    async manualPayoffConfirmationDependencies(id: string, buyerId: string, selectionId: string) {
      check(env.CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY === "true",
        "Monthly payoff confirmation schema is not enabled");
      const recovered = await this.recoverManualPayoffIntent(id, buyerId, selectionId);
      check(recovered.status === "bound_unpublished", "Original monthly payoff intent needs reconciliation");
      const { a, p, s } = await loadManualPayoffSelection(id, buyerId, selectionId, true);
      const contract = historicalManualPayoffContract(a, p, s, await manualContextEvidence());
      return { contract, binding: { paymentIntentId: recovered.paymentIntentId,
        firstDispatchAt: recovered.firstDispatchAt }, admin, stripe, env,
        contextEvidence: manualContextEvidence,
        assertProviderSource: async () => {
          const current = await this.readManualPayoffSource(id, buyerId, selectionId);
          check(isDeepStrictEqual(current.contract, contract),
            "Monthly payoff source changed before confirmation");
        } };
    },
    async confirmManualPayoffIntent(id: string, buyerId: string, selectionId: string,
      action: ManualFirstConfirmationAction) {
      return runServerPaymentConfirmation({
        ...await this.manualPayoffConfirmationDependencies(id, buyerId, selectionId), action });
    },
    async authenticateManualPayoffIntent(id: string, buyerId: string, selectionId: string,
      operationId: string) {
      return getServerPaymentAuthentication({
        ...await this.manualPayoffConfirmationDependencies(id, buyerId, selectionId), operationId });
    },
    async stopManualPayoffIntent(id: string, buyerId: string, selectionId: string) {
      check(env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_CANCELLATION_READY === "true",
        "Monthly manual payoff stop is not enabled");
      const { a, p, s } = await loadManualPayoffSelection(id, buyerId, selectionId, true);
      const contract = historicalManualPayoffContract(a, p, s, await manualContextEvidence());
      const stopped = await admin.rpc("request_server_payment_stop_v1", {
        p_attempt_id: selectionId, p_buyer_id: buyerId, p_context: contract.context });
      check(!stopped.error && stopped.data?.attemptId === selectionId && stopped.data?.releaseAllowed === false,
        "Original monthly payoff stop needs reconciliation");
      const recovered = await this.recoverManualPayoffIntent(id, buyerId, selectionId);
      if (recovered.status !== "bound_unpublished")
        return { status: "reconciliation_required" as const, releaseAllowed: false as const };
      return stopServerPaymentIntent({ contract,
        binding: { paymentIntentId: recovered.paymentIntentId, firstDispatchAt: recovered.firstDispatchAt },
        admin, stripe, env, contextEvidence: manualContextEvidence });
    },
    /** Account only an independently observed capture of the original bound
     * payoff intent. This remains private until buyer recovery is complete. */
    async recordManualPayoffCapture(id: string, buyerId: string, selectionId: string) {
      check(env.CREATOR_MONTHLY_MANUAL_PAYOFF_RECEIPT_SCHEMA_READY === "true" &&
        env.CREATOR_MONTHLY_MANUAL_PAYOFF_RECEIPT_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY === "true" &&
        env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY === "true" &&
        env.CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY === "true",
        "Monthly manual payoff receipt is not enabled");
      const recovered = await this.recoverManualPayoffIntent(id, buyerId, selectionId);
      check(recovered.status === "bound_unpublished", "Original monthly payoff intent needs reconciliation");
      const { a, p, s } = await loadManualPayoffSelection(id, buyerId, selectionId, true);
      const evidence = await manualContextEvidence();
      const contract = historicalManualPayoffContract(a, p, s, evidence);
      if (p.status === "captured") {
        const proof = p.provider_proof as Record<string, unknown> | null;
        const manual = proof?.manualPayment as Record<string, unknown> | undefined;
        check(p.ledger_id && proof?.version === "monthly-mentorship-payoff-proof-v1" &&
          proof.paymentContext && isDeepStrictEqual(proof.paymentContext, context) &&
          proof.payoffId === p.id && proof.payoffFingerprint === p.fingerprint &&
          proof.checkoutSessionId === null && proof.paymentIntentId === recovered.paymentIntentId &&
          manual?.attemptId === selectionId && typeof manual.confirmationOperationId === "string",
          "Original monthly payoff receipt differs");
        const replay = await admin.rpc("record_monthly_manual_payoff_receipt_v1", {
          p_payoff_id: p.id, p_buyer_id: buyerId, p_context: contract.context,
          p_selection_id: selectionId, p_ledger_id: p.ledger_id, p_proof: proof });
        check(!replay.error && replay.data === false, "Original monthly payoff receipt replay needs review");
        await reconcileKnownPaymentRefund(admin, recovered.paymentIntentId);
        await reconcileKnownPaymentDispute(admin, recovered.paymentIntentId);
        return { recorded: false as const, paymentIntentId: recovered.paymentIntentId,
          providerStopped: false, summary: await summary(await load(id, buyerId)) };
      }
      const binding = { paymentIntentId: recovered.paymentIntentId,
        firstDispatchAt: recovered.firstDispatchAt };
      const dependencies = { contract, binding, admin, contextEvidence: manualContextEvidence,
        assertProviderSource: async () => { throw Error("Captured payoff readback cannot dispatch payment"); }, env };
      const storage = createServerConfirmationStore(dependencies);
      const latest = await storage.latest();
      check(latest, "Original monthly payoff confirmation is absent");
      const observed = await observeServerPaymentConfirmation({ ...dependencies, stripe,
        admission: latest.admission, store: storage.store });
      check(observed.status === "succeeded" && observed.paymentIntentId === binding.paymentIntentId,
        "Original monthly payoff has not succeeded");
      const paymentIntent = await checked(stripe.paymentIntents.retrieve(binding.paymentIntentId));
      const charge = await checked(stripe.charges.retrieve(sid(paymentIntent.latest_charge, "ch")));
      const balance = await checked(stripe.balanceTransactions.retrieve(sid(charge.balance_transaction, "txn")));
      const paymentMethod = await checked(stripe.paymentMethods.retrieve(sid(paymentIntent.payment_method, "pm")));
      const inputs = { agreement: a, payoff: p, contract, binding,
        confirmationOperationId: latest.admission.operationId,
        nowSeconds: Math.floor(Date.now() / 1000) };
      const proof = inspectMembershipManualPayoffCapture({ ...inputs,
        contextEvidence: await manualContextEvidence(), data: { paymentIntent, charge, balance, paymentMethod } });
      check(proof.chargeId === observed.chargeId && proof.paymentMethodId === observed.paymentMethodId,
        "Monthly payoff provider capture differs from confirmation");
      const freshIntent = await checked(stripe.paymentIntents.retrieve(binding.paymentIntentId));
      const freshCharge = await checked(stripe.charges.retrieve(charge.id));
      const freshProof = inspectMembershipManualPayoffCapture({ ...inputs,
        contextEvidence: await manualContextEvidence(), data: { paymentIntent: freshIntent,
          charge: freshCharge, balance, paymentMethod } });
      check(isDeepStrictEqual(proof, freshProof), "Monthly payoff capture changed during readback");
      await storage.store.assertReadable(latest.admission);
      const ledgerId = await recordPaymentFeeLedger(admin, {
        breakdown: p.terms.fees, currency: "usd", creatorId: a.creator_id,
        purchaseId: a.purchase_id, paymentIntentId: proof.paymentIntentId,
        stripeFee: { chargeId: proof.chargeId,
          balanceTransactionId: proof.balanceTransactionId,
          actualStripeFeeCents: proof.actualStripeFeeCents,
          applicationFeeAmountCents: proof.applicationFeeAmountCents } }, true);
      check(ledgerId, "Monthly manual payoff captured payment has no ledger");
      await reconcileKnownPaymentRefund(admin, proof.paymentIntentId);
      await reconcileKnownPaymentDispute(admin, proof.paymentIntentId);
      const recorded = await admin.rpc("record_monthly_manual_payoff_receipt_v1", {
        p_payoff_id: p.id, p_buyer_id: buyerId, p_context: contract.context,
        p_selection_id: selectionId, p_ledger_id: ledgerId, p_proof: proof });
      check(!recorded.error && typeof recorded.data === "boolean",
        "Monthly manual payoff accounting needs review");
      let providerStopped = false;
      try { providerStopped = (await exit.requestExit(a.id, a.buyer_id,
        "stop_renewal", true, null)).providerStopped; }
      catch { /* Durable SQL stop request remains queued for review. */ }
      return { recorded: recorded.data as boolean, paymentIntentId: proof.paymentIntentId,
        providerStopped, summary: await summary(await load(id, buyerId)) };
    },
    /** Explicit buyer stop. A dispatched but unbound original remains held;
     * only no-dispatch SQL proof or the original canceled intent can release. */
    async releaseManualPayoff(id: string, buyerId: string, selectionId: string, confirmed: boolean) {
      check(confirmed === true, "Explicit payoff stop confirmation required");
      check(env.CREATOR_MONTHLY_MANUAL_PAYOFF_TERMINAL_SCHEMA_READY === "true" &&
        env.CREATOR_MONTHLY_MANUAL_PAYOFF_TERMINAL_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY === "true",
        "Monthly manual payoff terminal release is not enabled");
      const { a, p, s } = await loadManualPayoffSelection(id, buyerId, selectionId, true);
      if (p.status === "captured") return { status: "already_paid" as const, payoffId: p.id };
      if (p.status === "abandoned") return { status: "abandoned" as const, payoffId: p.id };
      check(p.status === "accepted", "Original payoff payment requires recovery");
      const scope = { p_attempt_id: selectionId, p_buyer_id: buyerId,
        p_context: validateExactPaymentContext({ version: "exact-payment-context-v1",
          mode: context.mode, platformAccountId: context.stripeAccountId,
          supabaseProjectRef: context.supabaseProjectRef, siteOrigin: context.siteOrigin },
        await manualContextEvidence()) };
      const protocol = await admin.from("server_payment_protocols_v1").select("attempt_id")
        .eq("attempt_id", selectionId).maybeSingle();
      check(!protocol.error, "Original payoff journal could not be read");
      let terminal: { neverDispatched: boolean; paymentIntentId: string | null;
        terminalProof: unknown };
      if (!protocol.data) {
        terminal = { neverDispatched: true, paymentIntentId: null, terminalProof: null };
      } else {
        check(protocol.data.attempt_id === selectionId, "Original payoff journal differs");
        const stopped = await admin.rpc("request_server_payment_stop_v1", scope);
        check(!stopped.error && stopped.data?.attemptId === selectionId &&
          stopped.data?.releaseAllowed === false, "Original payoff stop needs reconciliation");
        const original = await admin.rpc("read_server_payment_intent_v1", scope);
        check(!original.error, "Original payoff intent could not be read");
        if (!original.data) {
          terminal = { neverDispatched: true, paymentIntentId: null, terminalProof: null };
        } else {
          const op = original.data as { payment_intent_id: string | null; bound_at: string | null };
          if (!op.payment_intent_id || !op.bound_at)
            return { status: "reconciliation_required" as const, payoffId: p.id, releaseAllowed: false as const };
          const stoppedIntent = await this.stopManualPayoffIntent(id, buyerId, selectionId);
          if (stoppedIntent.status !== "intent_canceled_unreleased")
            return { status: "reconciliation_required" as const, payoffId: p.id, releaseAllowed: false as const };
          terminal = { neverDispatched: false, paymentIntentId: op.payment_intent_id,
            terminalProof: stoppedIntent.proof };
        }
      }
      const proof = { version: "monthly-manual-payoff-terminal-v1", paymentContext: context,
        payoffId: p.id, selectionId: s.id, ...terminal };
      const released = await admin.rpc("release_monthly_manual_payoff_v1", {
        p_payoff_id: p.id, p_buyer_id: buyerId, p_context: scope.p_context,
        p_selection_id: selectionId, p_proof: proof });
      check(!released.error && typeof released.data === "boolean",
        "Original monthly payoff release needs reconciliation");
      const current = await load(id, buyerId);
      return { status: "abandoned" as const, payoffId: p.id,
        originalMonthlyPaymentsMayResume: !current.debit_revoked_at &&
          !current.renewal_stopped_at && !current.financial_hold_at && !current.billing_review_at };
    },
    /** Freezes the original monthly first-payment source before any provider
     * bootstrap operation. This private method does not create an intent. */
    async selectManualFirst(id: string, buyerId: string) {
      check(env.CREATOR_MONTHLY_MANUAL_PREPARATION_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY === "true", "Monthly manual preparation is not enabled");
      await load(id, buyerId); await observeContext();
      const selected = await admin.rpc("select_monthly_manual_payment_v1", {
        p_id: id, p_buyer_id: buyerId, p_context: context, p_kind: "first", p_payoff_id: null });
      check(!selected.error && selected.data && typeof selected.data.id === "string",
        "Monthly manual source could not be selected safely");
      await loadManualFirstSelection(id, buyerId, selected.data.id);
      return { membershipId: id, selectionId: selected.data.id as string };
    },
    async selectAndPrepareManualFirst(id: string, buyerId: string) {
      const selected = await this.selectManualFirst(id, buyerId);
      return this.prepareManualFirstBootstrap(id, buyerId, selected.selectionId);
    },
    async readOwnedManualFirst(id: string, buyerId: string) {
      const a = await load(id, buyerId);
      const selected = await admin.from("monthly_manual_payment_selections_v1").select("id")
        .eq("agreement_id", id).eq("buyer_id", buyerId).eq("kind", "first").maybeSingle();
      check(!selected.error && selected.data?.id, "Owned monthly manual selection not found");
      const { s } = await loadManualFirstSelection(id, buyerId, selected.data.id, true);
      return { membershipId: id, selectionId: s.id, buyerId, productId: a.product_id,
        title: a.terms.title, amountCents: a.monthly_price_cents, currency: "usd" as const,
        firstPaymentRecorded: a.covered_months > 0, initialAbandoned: a.initial_abandoned_at !== null,
        initialAbandonedAt: a.initial_abandoned_at,
        initialAbandonRequested: a.initial_abandon_requested_at !== null,
        acceptanceExpiresAt: s.source.expiresAt as number };
    },
    async resolveManualFirstReturn(attemptId: string, buyerId: string) {
      assertMembershipId(attemptId);
      const selected = await admin.from("monthly_manual_payment_selections_v1").select("id,agreement_id")
        .eq("id", attemptId).eq("buyer_id", buyerId).eq("kind", "first").maybeSingle();
      check(!selected.error && selected.data?.id === attemptId && selected.data?.agreement_id,
        "Owned monthly payment return not found");
      const owned = await this.readOwnedManualFirst(selected.data.agreement_id, buyerId);
      check(owned.selectionId === attemptId, "Monthly payment return source differs");
      return { membershipId: owned.membershipId, selectionId: attemptId };
    },
    async resolveManualPaymentReturn(attemptId: string, buyerId: string) {
      assertMembershipId(attemptId);
      const selected = await admin.from("monthly_manual_payment_selections_v1")
        .select("id,agreement_id,kind").eq("id", attemptId)
        .eq("buyer_id", buyerId).maybeSingle();
      check(!selected.error && selected.data?.id === attemptId,
        "Owned monthly payment return not found");
      if (selected.data.kind === "payoff")
        return this.resolveManualPayoffReturn(attemptId, buyerId);
      check(selected.data.kind === "first", "Unknown original monthly payment kind");
      const first = await this.resolveManualFirstReturn(attemptId, buyerId);
      return { ...first, kind: "first" as const };
    },
    /** Internal original-operation handoff only. No public route uses it.
     * Selection must already be frozen before any bootstrap provider call. */
    async prepareManualFirstBootstrap(id: string, buyerId: string, selectionId: string) {
      check(env.CREATOR_MONTHLY_MANUAL_PREPARATION_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY === "true", "Monthly manual preparation is not enabled");
      const { a, s } = await loadManualFirstSelection(id, buyerId, selectionId);
      await manualContextEvidence();
      const { customer, product, subscription } = await bootstrapOriginal(a);
      const current = await load(id, buyerId);
      check(current.revision === a.revision && current.covered_months === 0 &&
        !current.stripe_checkout_session_id && !current.financial_hold_at &&
        !current.billing_review_at && !current.debit_revoked_at && !current.renewal_stopped_at &&
        !current.initial_abandon_requested_at && !current.initial_abandoned_at &&
        (current.stripe_customer_id === null || current.stripe_customer_id === customer.id) &&
        (current.stripe_subscription_id === null || current.stripe_subscription_id === subscription.id) &&
        isDeepStrictEqual(current.terms, a.terms), "Monthly manual source changed during bootstrap");
      const firstPreparation = { customerId: customer.id, productId: product.id,
        subscriptionId: subscription.id, subscription };
      const contract = buildMembershipManualContract({ selection: s, agreement: current,
        contextEvidence: await manualContextEvidence(), now: Math.floor(Date.now() / 1000),
        customer, firstPreparation });
      return { agreement: current, selection: s, customer, firstPreparation, contract };
    },
    /** Read-only original-source check for a later manual intent dispatch. No
     * journal claim, hosted session, PaymentIntent, or access write occurs. */
    async readManualFirstSource(id: string, buyerId: string, selectionId: string) {
      check(env.CREATOR_MONTHLY_MANUAL_PREPARATION_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY === "true", "Monthly manual preparation is not enabled");
      const { a, s } = await loadManualFirstSelection(id, buyerId, selectionId);
      await manualContextEvidence();
      const { customerId, productId, subscriptionId } = await readManualFirstJournal(a, a.revision);
      const customer = await checked(stripe.customers.retrieve(customerId));
      const product = await checked(stripe.products.retrieve(productId));
      const subscription = await checked(stripe.subscriptions.retrieve(subscriptionId));
      const destination = await checked(stripe.accounts.retrieve(a.terms.destinationId));
      assertMembershipCustomer(customer, a, true);
      check(product.object === "product" && product.active && product.livemode === (context.mode === "live") &&
        product.name === a.terms.title.slice(0, 200) && product.default_price === null &&
        isDeepStrictEqual(product.metadata, membershipMetadata(a, "product")),
        "Original monthly product differs");
      assertMembershipHeld(subscription, a, customerId, productId, true);
      check(destination.id === a.terms.destinationId && destination.charges_enabled && destination.payouts_enabled &&
        destination.capabilities?.transfers === "active", "Monthly destination is not payable");
      const current = await loadManualFirstSelection(id, buyerId, selectionId);
      check(isDeepStrictEqual(current.s, s) && current.a.revision === a.revision &&
        (current.a.stripe_customer_id === null || current.a.stripe_customer_id === customerId) &&
        (current.a.stripe_subscription_id === null || current.a.stripe_subscription_id === subscriptionId),
        "Monthly manual source changed during readback");
      const contract = buildMembershipManualContract({ selection: current.s, agreement: current.a,
        contextEvidence: await manualContextEvidence(), now: Math.floor(Date.now() / 1000),
        customer, firstPreparation: { customerId, productId, subscriptionId, subscription } });
      return { contract, selectionId, customerId, productId, subscriptionId };
    },
    /** Internal fresh-admission step only. Bound and uncertain intent recovery
     * after the acceptance window must be composed before any public route uses
     * this. No confirmation, client secret, receipt, or access is returned. */
    async prepareManualFirstIntent(id: string, buyerId: string, selectionId: string) {
      check(env.CREATOR_MONTHLY_MANUAL_INTENT_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_INTENT_READY === "true", "Monthly manual intent preparation is not enabled");
      const prepared = await this.prepareManualFirstBootstrap(id, buyerId, selectionId);
      const current = await this.readManualFirstSource(id, buyerId, selectionId);
      check(isDeepStrictEqual(current.contract, prepared.contract), "Monthly manual contract changed before registration");
      const c = current.contract;
      const registered = await admin.rpc("register_monthly_manual_source_v1", {
        p_selection_id: selectionId, p_buyer_id: buyerId, p_context: c.context });
      check(!registered.error && registered.data &&
        registered.data.attempt_id === selectionId && registered.data.buyer_id === buyerId &&
        registered.data.product_id === c.productId && registered.data.kind === "monthly_first" &&
        registered.data.protocol === c.protocol && registered.data.reservation_id === null &&
        isDeepStrictEqual(registered.data.context, c.context) &&
        isDeepStrictEqual(registered.data.source, prepared.selection),
        "Original monthly manual journal registration differs");
      return prepareServerPaymentIntent({ contract: c, admin, stripe, env,
        contextEvidence: manualContextEvidence,
        assertProviderSource: async () => {
          const latest = await this.readManualFirstSource(id, buyerId, selectionId);
          check(isDeepStrictEqual(latest.contract, c), "Monthly manual source changed before intent dispatch");
        } });
    },
    /** Read-only bound-intent recovery, including after a stop or expiry. An
     * unbound original stays unresolved; this method never claims or creates. */
    async recoverManualFirstIntent(id: string, buyerId: string, selectionId: string) {
      check(env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY === "true", "Monthly manual intent recovery is not enabled");
      const { a, s } = await loadManualFirstSelection(id, buyerId, selectionId, true);
      const evidence = await manualContextEvidence();
      const { customerId, subscriptionId } = await readManualFirstJournal(a, s.source.revision as number);
      const contract = historicalManualFirstContract(a, s, customerId, subscriptionId, evidence);
      const scope = { p_attempt_id: selectionId, p_buyer_id: buyerId, p_context: contract.context };
      const source = await admin.rpc("read_server_payment_source_v1", { ...scope, p_for_dispatch: false });
      check(!source.error && source.data && source.data.attempt_id === selectionId &&
        source.data.buyer_id === buyerId && source.data.product_id === a.product_id &&
        source.data.kind === "monthly_first" && source.data.protocol === contract.protocol &&
        source.data.reservation_id === null && isDeepStrictEqual(source.data.context, contract.context) &&
        isDeepStrictEqual(source.data.source, s), "Original monthly manual source differs");
      const original = await admin.rpc("read_server_payment_intent_v1", scope);
      check(!original.error, "Original monthly manual intent could not be read");
      if (!original.data) return { status: "reconciliation_required" as const };
      const op = original.data as { attempt_id: string; contract: ServerPaymentContract;
        request: unknown; payment_intent_id: string | null; bound_at: string | null };
      check(op.attempt_id === selectionId && isDeepStrictEqual(op.contract, contract) &&
        isDeepStrictEqual(op.request, serverPaymentCreateRequest(contract, evidence, op.request)),
        "Original monthly manual intent differs");
      if (!op.payment_intent_id || !op.bound_at) return { status: "reconciliation_required" as const };
      // The shared adapter's bound branch re-reads SQL and Stripe. A disabled
      // write flag guarantees a race cannot turn this recovery into admission.
      const recovered = await prepareServerPaymentIntent({ contract, admin, stripe,
        env: { ...env, CREATOR_SERVER_PAYMENT_INTENT_READY: "false" },
        contextEvidence: manualContextEvidence,
        assertProviderSource: async () => { throw Error("Bound recovery cannot dispatch a new monthly intent"); } });
      return recovered.status === "bound_unpublished" ? recovered : { status: "reconciliation_required" as const };
    },
    /** Internal confirmation of the saved monthly first intent. This readback
     * cannot prepare or replace an unbound intent. Fresh payment dispatch must
     * pass the same current source check used by intent preparation. */
    async manualFirstConfirmationDependencies(id: string, buyerId: string, selectionId: string) {
      check(env.CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY === "true",
        "Monthly manual confirmation schema is not enabled");
      const recovered = await this.recoverManualFirstIntent(id, buyerId, selectionId);
      check(recovered.status === "bound_unpublished", "Original monthly intent needs reconciliation");
      const { a, s } = await loadManualFirstSelection(id, buyerId, selectionId, true);
      const evidence = await manualContextEvidence();
      const { customerId, subscriptionId } = await readManualFirstJournal(a, s.source.revision as number);
      const contract = historicalManualFirstContract(a, s, customerId, subscriptionId, evidence);
      return { contract, binding: { paymentIntentId: recovered.paymentIntentId,
        firstDispatchAt: recovered.firstDispatchAt }, admin, stripe, env,
        contextEvidence: manualContextEvidence,
        assertProviderSource: async () => {
          const current = await this.readManualFirstSource(id, buyerId, selectionId);
          check(isDeepStrictEqual(current.contract, contract) &&
            current.selectionId === selectionId && current.customerId === customerId &&
            current.subscriptionId === subscriptionId,
            "Monthly manual source changed before confirmation");
        } };
    },
    async confirmManualFirstIntent(id: string, buyerId: string, selectionId: string,
      action: ManualFirstConfirmationAction) {
      return runServerPaymentConfirmation({
        ...await this.manualFirstConfirmationDependencies(id, buyerId, selectionId), action });
    },
    async authenticateManualFirstIntent(id: string, buyerId: string, selectionId: string,
      operationId: string) {
      return getServerPaymentAuthentication({
        ...await this.manualFirstConfirmationDependencies(id, buyerId, selectionId), operationId });
    },
    /** Persist the original stop before provider cancellation. An unbound
     * response remains unresolved; canceled intent proof cannot release the
     * held subscription or the manual selection by itself. */
    async stopManualFirstIntent(id: string, buyerId: string, selectionId: string) {
      check(env.CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_CANCELLATION_READY === "true",
        "Monthly manual stop is not enabled");
      const { a, s } = await loadManualFirstSelection(id, buyerId, selectionId, true);
      await manualContextEvidence();
      const stopped = await admin.rpc("request_server_payment_stop_v1", {
        p_attempt_id: selectionId, p_buyer_id: buyerId, p_context: context });
      check(!stopped.error && stopped.data?.attemptId === selectionId && stopped.data?.releaseAllowed === false,
        "Original monthly stop needs reconciliation");
      const evidence = await manualContextEvidence();
      const { customerId, subscriptionId } = await readManualFirstJournal(a, s.source.revision as number);
      const contract = historicalManualFirstContract(a, s, customerId, subscriptionId, evidence);
      const recovered = await this.recoverManualFirstIntent(id, buyerId, selectionId);
      if (recovered.status !== "bound_unpublished")
        return { status: "reconciliation_required" as const, releaseAllowed: false as const };
      return stopServerPaymentIntent({ contract, binding: { paymentIntentId: recovered.paymentIntentId,
        firstDispatchAt: recovered.firstDispatchAt }, admin, stripe, env,
        contextEvidence: manualContextEvidence });
    },
    /** Internal captured-money reconciliation for the frozen manual first
     * selection. It only reads an already bound intent and existing confirmed
     * payment, then uses the existing ledger and one transactional receipt.
     * No public route calls this method. */
    async recordManualFirstCapture(id: string, buyerId: string, selectionId: string) {
      check(env.CREATOR_MONTHLY_MANUAL_RECEIPT_SCHEMA_READY === "true" &&
        env.CREATOR_MONTHLY_MANUAL_RECEIPT_READY === "true" &&
        env.CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY === "true" &&
        env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY === "true" &&
        env.CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY === "true",
        "Monthly manual receipt is not enabled");
      const recovered = await this.recoverManualFirstIntent(id, buyerId, selectionId);
      check(recovered.status === "bound_unpublished", "Original monthly intent needs reconciliation");
      const { a, s } = await loadManualFirstSelection(id, buyerId, selectionId, true);
      const evidence = await manualContextEvidence();
      const { customerId, subscriptionId } = await readManualFirstJournal(a, s.source.revision as number);
      const contract = historicalManualFirstContract(a, s, customerId, subscriptionId, evidence);
      const binding = { paymentIntentId: recovered.paymentIntentId, firstDispatchAt: recovered.firstDispatchAt };
      const dependencies = { contract, binding, admin, contextEvidence: manualContextEvidence,
        assertProviderSource: async () => { throw Error("Captured monthly readback cannot dispatch payment"); }, env };
      const storage = createServerConfirmationStore(dependencies);
      const latest = await storage.latest();
      check(latest, "Original monthly confirmation is absent");
      const observed = await observeServerPaymentConfirmation({ ...dependencies, stripe,
        admission: latest.admission, store: storage.store });
      check(observed.status === "succeeded" && observed.paymentIntentId === binding.paymentIntentId,
        "Original monthly payment has not succeeded");
      const paymentIntent = await checked(stripe.paymentIntents.retrieve(binding.paymentIntentId));
      const charge = await checked(stripe.charges.retrieve(sid(paymentIntent.latest_charge, "ch")));
      const balance = await checked(stripe.balanceTransactions.retrieve(sid(charge.balance_transaction, "txn")));
      const paymentMethod = await checked(stripe.paymentMethods.retrieve(sid(paymentIntent.payment_method, "pm")));
      const inputs = { agreement: a, contract, subscriptionId, binding,
        confirmationOperationId: latest.admission.operationId, nowSeconds: Math.floor(Date.now() / 1000) };
      const proof = inspectMembershipManualFirstCapture({ ...inputs,
        contextEvidence: await manualContextEvidence(), data: { paymentIntent, charge, balance, paymentMethod } });
      check(proof.chargeId === observed.chargeId && proof.paymentMethodId === observed.paymentMethodId,
        "Monthly provider capture differs from confirmation");
      const freshIntent = await checked(stripe.paymentIntents.retrieve(binding.paymentIntentId));
      const freshCharge = await checked(stripe.charges.retrieve(charge.id));
      const freshProof = inspectMembershipManualFirstCapture({ ...inputs,
        contextEvidence: await manualContextEvidence(), data: { paymentIntent: freshIntent,
          charge: freshCharge, balance, paymentMethod } });
      check(isDeepStrictEqual(proof, freshProof), "Monthly provider capture changed during readback");
      await storage.store.assertReadable(latest.admission);
      const ledgerId = await recordPaymentFeeLedger(admin, {
        breakdown: a.terms.firstMonthFees, currency: "usd", creatorId: a.creator_id,
        purchaseId: a.purchase_id, paymentIntentId: proof.paymentIntentId,
        stripeFee: { chargeId: proof.chargeId, balanceTransactionId: proof.balanceTransactionId,
          actualStripeFeeCents: proof.actualStripeFeeCents,
          applicationFeeAmountCents: proof.applicationFeeAmountCents } }, true);
      check(ledgerId, "Monthly manual captured payment has no ledger");
      await reconcileKnownPaymentRefund(admin, proof.paymentIntentId);
      await reconcileKnownPaymentDispute(admin, proof.paymentIntentId);
      const recorded = await admin.rpc("record_monthly_manual_first_receipt_v1", {
        p_id: id, p_buyer_id: buyerId, p_context: contract.context,
        p_selection_id: selectionId, p_ledger_id: ledgerId, p_proof: proof });
      check(!recorded.error && typeof recorded.data === "boolean",
        "Monthly manual captured payment needs accounting review");
      return { recorded: recorded.data as boolean, paymentIntentId: proof.paymentIntentId,
        summary: await summary(await load(id, buyerId)) };
    },
    async quote(buyerId: string, product: string, post: string | null) {
      check(membershipCheckoutReady(env), "Monthly checkout is not enabled");
      await observeContext();
      const found = await admin.from("products").select("id,creator_id,title,description,type,price_cents,amount_cents,currency,membership_terms")
        .eq("id", product).maybeSingle();
      check(!found.error && found.data, "Monthly offer not found"); const offer = found.data as MembershipOffer;
      const postId = await resolvePostForProduct(admin, post, offer.id, offer.creator_id);
      check(postId && postId !== INVALID_POST, "Select the post that sells this monthly offer");
      const creator = await admin.from("profiles").select("stripe_account_id").eq("id", offer.creator_id).maybeSingle();
      const { isCreatorSellReady } = await import("./creatorStripeConnect");
      check(!creator.error && creator.data?.stripe_account_id && await isCreatorSellReady(offer.creator_id), "Creator is not accepting payments");
      return buildMembershipAgreement({ offer, buyerId, postId, destinationId: creator.data.stripe_account_id, context, env });
    },
    async accept(buyerId: string, product: string, post: string, consent: { accepted: boolean; version: string; fingerprint: string }) {
      check(membershipCheckoutReady(env), "Monthly checkout is not enabled");
      const quote = await this.quote(buyerId, product, post);
      check(consent.accepted === true && consent.version === quote.agreement.version && consent.fingerprint === quote.fingerprint,
        "Review and accept the current monthly agreement");
      const saved = await admin.rpc("reserve_monthly_mentorship_v1", { p_buyer_id: buyerId, p_product_id: product, p_post_id: post,
        p_terms: quote.agreement, p_fingerprint: quote.fingerprint, p_accepted: true });
      check(!saved.error && typeof saved.data === "string", "Monthly acceptance could not be recorded");
      return { membershipId: saved.data as string };
    },
    async acceptAndPrepare(buyerId: string, product: string, post: string, consent: { accepted: boolean; version: string; fingerprint: string }) {
      const saved = await this.accept(buyerId, product, post, consent);
      return this.prepare(saved.membershipId, buyerId);
    },
    async prepare(id: string, buyerId: string) {
      check(membershipCheckoutReady(env), "Monthly checkout is not enabled");
      const a = await load(id, buyerId); await observeContext();
      const success = `${context.siteOrigin}/memberships/complete?membership_id=${a.id}`;
      if (a.covered_months > 0) return { membershipId: id, url: success };
      check(!a.billing_review_at && !a.financial_hold_at && !a.debit_revoked_at && !a.renewal_stopped_at, "Membership payment needs support review");
      if (a.stripe_checkout_session_id) {
        const session = await checked(stripe.checkout.sessions.retrieve(a.stripe_checkout_session_id));
        assertMembershipSession(session, a, null);
        if (session.status === "complete") return { membershipId: id, url: success };
        check(session.status === "open" && session.payment_status === "unpaid", "Monthly checkout expired and needs recovery");
        assertMembershipHeld(await checked(stripe.subscriptions.retrieve(a.stripe_subscription_id!)), a, a.stripe_customer_id!, await productId(a), true);
        check(session.url && new URL(session.url).origin === "https://checkout.stripe.com");
        if (process.env.DISCOVER_V4_ENABLED === "true" && a.post_id) {
          const { recordDiscoverEvent } = await import("./discoverServer");
          await recordDiscoverEvent({actor: `user:${a.buyer_id}`, userId: a.buyer_id, postId: a.post_id, kind: "checkout_start", entityKey: session.id});
        }
        return { membershipId: id, url: session.url };
      }
      const { customer, product, subscription } = await bootstrapOriginal(a);
      const bound = { ...a, stripe_customer_id: customer.id, stripe_subscription_id: subscription.id };
      const session = await operation(a, "checkout", "/v1/checkout/sessions", buildMembershipCheckout(bound, customer.id, subscription.id),
        (r, opts) => checked(stripe.checkout.sessions.create(r.params as Stripe.Checkout.SessionCreateParams, opts)),
        id => checked(stripe.checkout.sessions.retrieve(id)), s => assertMembershipSession(s, bound, false));
      const linked = await admin.rpc("bind_monthly_mentorship_provider_v1", { p_id: a.id, p_customer_id: customer.id,
        p_subscription_id: subscription.id, p_session_id: session.id });
      check(!linked.error && typeof linked.data === "boolean", "Monthly payment link could not be published safely");
      check(session.url && new URL(session.url).origin === "https://checkout.stripe.com");
      if (process.env.DISCOVER_V4_ENABLED === "true" && a.post_id) {
        const { recordDiscoverEvent } = await import("./discoverServer");
        await recordDiscoverEvent({actor: `user:${a.buyer_id}`, userId: a.buyer_id, postId: a.post_id, kind: "checkout_start", entityKey: session.id});
      }
      return { membershipId: id, url: session.url };
    },
    async confirmFirst(id: string, buyerId: string) {
      check(env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY === "true" && env.CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY === "true",
        "Monthly payment reconciliation is not enabled");
      const a = await load(id, buyerId); await observeContext();
      if (a.covered_months > 0) return summary(a); // Never rerun an already recorded earnings/access transition.
      check(a.stripe_checkout_session_id && a.stripe_subscription_id && a.stripe_customer_id, "Monthly checkout is not bound");
      const session = await checked(stripe.checkout.sessions.retrieve(a.stripe_checkout_session_id));
      assertMembershipSession(session, a, null);
      if (session.status !== "complete" || session.payment_status !== "paid") return summary(a);
      const paymentIntent = await checked(stripe.paymentIntents.retrieve(sid(session.payment_intent, "pi")));
      const charge = await checked(stripe.charges.retrieve(sid(paymentIntent.latest_charge, "ch")));
      const balance = await checked(stripe.balanceTransactions.retrieve(sid(charge.balance_transaction, "txn")));
      const data = { session, paymentIntent, charge, balance }, inspected = inspectMembershipFirstCapture(a, data);
      await observeContext();
      const ledgerId = await (injected?.writeFirstLedger || writeFirstLedger)(admin, a, data);
      const recorded = await admin.rpc("record_monthly_mentorship_receipt_v1", { p_id: a.id, p_ledger_id: ledgerId, p_month: 1,
        p_start: inspected.anchor, p_end: membershipMonthBoundary(inspected.anchor, 1), p_proof: inspected.proof });
      check(!recorded.error && typeof recorded.data === "boolean", "Monthly receipt requires retry or review");
      return summary(await load(id, buyerId));
    },
  };
  const lifecycle = createMembershipLifecycleRuntime({ admin, stripe, context, env, checked, observeContext, load, productId }, api);
  const paymentEvents = createMembershipPaymentEventRuntime({ admin, stripe, context, env, checked, observeContext, load, productId }, api);
  const recovery = createMembershipCheckoutRecovery({ admin, stripe, context, env, checked, observeContext, load, productId }, api);
  const initialAbandonment = createMembershipInitialAbandonment({ admin, stripe, context, env, checked, observeContext, load, productId }, recovery);
  async function closeManualFirst(id: string, buyerId: string, selectionId: string, confirmed: boolean) {
    check(env.CREATOR_MONTHLY_MANUAL_TERMINAL_SCHEMA_READY === "true" &&
      env.CREATOR_MONTHLY_MANUAL_TERMINAL_READY === "true" && confirmed === true,
      "Monthly manual terminal close-out is not enabled");
    await loadManualFirstSelection(id, buyerId, selectionId, true);
    await manualContextEvidence();
    // The agreement lock in this RPC closes journal registration before the
    // following classification read. A previously admitted original remains
    // recoverable under its saved identity.
    const requested = await admin.rpc("request_monthly_initial_abandonment_v1", {
      p_id: id, p_buyer_id: buyerId, p_context: context, p_confirmed: true });
    check(!requested.error && requested.data?.membershipId === id && requested.data?.requested === true,
      "Original monthly manual close-out needs reconciliation");
    const registered = await admin.from("server_payment_protocols_v1").select("attempt_id")
      .eq("attempt_id", selectionId).maybeSingle();
    check(!registered.error, "Original monthly manual journal could not be read");
    if (!registered.data) {
      const intent = await admin.from("server_payment_intent_operations_v1").select("attempt_id")
        .eq("attempt_id", selectionId).maybeSingle();
      check(!intent.error, "Original monthly manual intent could not be read");
      if (intent.data) return { status: "reconciliation_required" as const, releaseAllowed: false as const };
      return initialAbandonment.abandonFirstCheckout(id, buyerId, true, true);
    }
    const stopped = await api.stopManualFirstIntent(id, buyerId, selectionId);
    if (stopped.status !== "intent_canceled_unreleased") return stopped;
    // The existing initial close-out verifies the original subscription,
    // invoices and complete customer financial lists. The SQL guard binds its
    // atomic retirement to the separately recorded manual terminal proof.
    return initialAbandonment.abandonFirstCheckout(id, buyerId, true);
  }
  const renewalRecovery = createMembershipRenewalRecovery({ admin, stripe, context, env, checked, observeContext, load, productId }, api);
  const cardSetup = createMembershipCardSetup({ admin, stripe, context, env, checked, observeContext, load, productId }, renewalRecovery);
  const retry = createMembershipRetry({ admin, stripe, context, env, checked, observeContext, load, productId }, { ...renewalRecovery, ...cardSetup });
  const bank = createMembershipBankVerification({ admin, stripe, context, env, checked, observeContext, load, productId }, renewalRecovery);
  return { ...api, ...recovery, ...initialAbandonment, closeManualFirst, ...renewalRecovery, ...cardSetup, ...retry, ...bank, reconcileLifecycle: lifecycle.reconcileLifecycle, reconcilePaymentEvent: paymentEvents.reconcilePaymentEvent };
}
