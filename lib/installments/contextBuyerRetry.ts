import "server-only";
import { isDeepStrictEqual } from "node:util";
import type Stripe from "stripe";
import { assertAgreementId } from "./agreementStore";
import { readExactContextReservation } from "./contextReservation";
import { readExactContextCustomerIntent } from "./contextBootstrap";
import { contextStripeId } from "./contextCheckout";
import { readContextInvoiceCollection } from "./contextInvoice";
import { inspectContextActivationSubscription } from "./contextActivation";
import { parseExactCardSetup, exactCardSetupParams } from "./cardRecovery";
import { parseExactRetryAuthorization, parseExactFutureCardQuote } from "./paymentRetryStore";
import { inspectPaidRenewal, verifyRenewalProviderHistory } from "./renewal";
import { calculateInstallmentPlan } from "../installmentPlan";
import { PAY_NOW_CONSENT_VERSION, FUTURE_CARD_CONSENT_VERSION, type BuyerPaymentQuote } from "./buyerRecoveryView";
import type { ExactPaymentContext, ExactPaymentContextEvidence } from "./paymentContext";

function check(v: unknown): asserts v { if (!v) throw Error("Context buyer payment requires review"); }
function fields(v: unknown, keys: string[]): Record<string, unknown> {
  check(v && typeof v === "object" && !Array.isArray(v)); const ds = Object.getOwnPropertyDescriptors(v);
  check(Reflect.ownKeys(ds).length === keys.length && keys.every(k => ds[k] && "value" in ds[k] && ds[k].enumerable));
  return v as Record<string, unknown>;
}

/** Existing explicit pay-now semantics, with context-owned SQL and one-shot
 * transport. Review/replay/reconciliation can never manufacture charge consent. */
export async function runContextBuyerRetry(args: {
  reservationId: string; buyerId: string; invoiceId: string; quoteId: string;
  action: "review" | "review_future" | "pay" | "reconcile"; consent: unknown; context: ExactPaymentContext; stripe: Stripe; apiVersion: string;
  evidence(): Promise<ExactPaymentContextEvidence>; fresh(): void;
  rpc(name: "read_exact_context_buyer_retry_v2" | "run_exact_context_buyer_retry_v2", params: object): Promise<unknown>;
  get<T>(path: string, read: () => Promise<T>): Promise<T>;
  verifyCard(requestId: string): Promise<{ status: string }>;
  pay(params: Stripe.InvoicePayParams, key: string, admittedAt: number): Promise<void>;
}) {
  const { reservationId, buyerId, invoiceId, quoteId, context, stripe, get } = args;
  for (const id of [reservationId, buyerId, quoteId]) assertAgreementId(id); contextStripeId(invoiceId, "in");
  const futureAccepted = isDeepStrictEqual(args.consent, { accepted: true, consentVersion: PAY_NOW_CONSENT_VERSION,
    futureCardConsentVersion: FUTURE_CARD_CONSENT_VERSION });
  if (args.action === "pay") check(futureAccepted || isDeepStrictEqual(args.consent, { accepted: true, consentVersion: PAY_NOW_CONSENT_VERSION }));
  else check(args.consent === null);
  const base = { p_reservation_id: reservationId, p_actor_id: buyerId, p_context: context, p_invoice_id: invoiceId, p_quote_id: quoteId };
  async function parse(raw: unknown) {
    const evidence = await args.evidence(); args.fresh();
    const v = fields(raw, ["reservation", "operation", "collection", "dependencies", "setup", "quote", "admission"]);
    const r = readExactContextReservation(v.reservation, evidence); check(r.id === reservationId && r.terms.buyerId === buyerId);
    const intent = readExactContextCustomerIntent({ intentRow: v.operation, reservationRow: v.reservation, contextEvidence: evidence, actorId: r.terms.creatorId });
    check(intent.request.apiVersion === args.apiVersion);
    const d = fields(v.dependencies, ["customerId", "subscriptionId", "productId", "anchor"]);
    const deps = { customerId: contextStripeId(d.customerId, "cus"), subscriptionId: contextStripeId(d.subscriptionId, "sub"),
      productId: contextStripeId(d.productId, "prod"), anchor: Number(d.anchor) }; check(Number.isSafeInteger(d.anchor) && deps.anchor > 0);
    const collection = readContextInvoiceCollection(v.collection, r, deps, invoiceId), auth = collection.authorization, claim = collection.state.claim;
    check(auth && claim && ["dispatching", "paid"].includes(claim.status) && claim.paymentIntentId && claim.dispatchStartedAt !== null);
    const setup = parseExactCardSetup(v.setup, context.mode === "live"), s = v.setup as Record<string, unknown>;
    check(setup.agreementId === r.id && setup.buyerId === buyerId && setup.invoiceId === invoiceId && setup.originalPaymentIntentId === claim.paymentIntentId &&
      isDeepStrictEqual(setup.authorization, auth) && setup.sessionId && setup.setupIntentId && setup.paymentMethodId && s.context_mode === context.mode);
    check(typeof s.context_dispatch_token === "string"); assertAgreementId(s.context_dispatch_token);
    const metadata = { installment_collection_version: r.terms.version, context_hash: intent.contextHash, terms_hash: intent.termsHash };
    const request = fields(s.context_request, ["params", "idempotencyKey"]);
    check(request.idempotencyKey === `cn-exact-v2-card:${setup.id}:${s.context_dispatch_token}` &&
      isDeepStrictEqual(request.params, exactCardSetupParams(setup, context.siteOrigin, metadata)));
    const plan = calculateInstallmentPlan(r.terms.totalCents, r.terms.paymentCount, r.terms.renewalFeeSchedule, r.terms.firstPaymentFeeSchedule);
    let quote: BuyerPaymentQuote | null = null, retry: ReturnType<typeof parseExactRetryAuthorization> | null = null;
    if (v.quote !== null) {
      check(v.quote && typeof v.quote === "object" && !Array.isArray(v.quote)); const q = v.quote as Record<string, unknown>;
      const created = typeof q.created_at === "string" ? Date.parse(q.created_at) : NaN, expected = plan.payments[auth.paymentNumber - 1];
      check(q.id === quoteId && q.agreement_id === r.id && q.buyer_id === buyerId && q.setup_request_id === setup.id &&
        q.stripe_invoice_id === invoiceId && q.original_payment_intent_id === claim.paymentIntentId && q.replacement_payment_method_id === setup.paymentMethodId &&
        q.setup_intent_id === setup.setupIntentId && isDeepStrictEqual(q.authorization_snapshot, auth) && q.amount_cents === expected.amountCents &&
        q.application_fee_cents === expected.fees.totalCreatorDeductionCents && q.consent_version === PAY_NOW_CONSENT_VERSION &&
        typeof q.future_card_option === "boolean" && (q.future_card_option || q.future_card_periods === null && q.future_card_accepted === null) &&
        Number.isFinite(created) && created >= setup.createdAt * 1000 && created <= Date.now() && Number.isSafeInteger(q.expires_at) &&
        Number(q.expires_at) > created / 1000 && Number(q.expires_at) <= Math.min(Math.floor(created / 1000) + 300, setup.expiresAt, auth.periodEnd));
      if (q.confirmed_at !== null) retry = parseExactRetryAuthorization(q, v.admission);
      else check(v.admission === null);
      quote = Object.freeze({ id: quoteId, amountCents: expected.amountCents, paymentNumber: auth.paymentNumber, paymentCount: auth.paymentCount,
        expiresAt: Number(q.expires_at), confirmed: q.confirmed_at !== null, consentVersion: PAY_NOW_CONSENT_VERSION,
        ...parseExactFutureCardQuote(q, auth, PAY_NOW_CONSENT_VERSION) });
      if (quote.remainingPayments) check(isDeepStrictEqual(quote.remainingPayments, collection.state.periods.filter(p => p.paymentNumber > auth.paymentNumber)
        .map(p => ({ paymentNumber: p.paymentNumber, amountCents: p.amount, dueAt: p.start, periodEnd: p.end }))));
    } else check(v.admission === null);
    return { r, intent, deps, collection, auth, claim, setup, metadata, plan, quote, retry };
  }
  const read = async () => { await args.evidence(); args.fresh(); return parse(await args.rpc("read_exact_context_buyer_retry_v2", base)); };
  const phase = async (name: "quote" | "quote_future" | "pay" | "credit", proof: unknown = null) => {
    await args.evidence(); args.fresh();
    const result = fields(await args.rpc("run_exact_context_buyer_retry_v2", { ...base, p_phase: name, p_proof: proof }), ["admitted", "credit", "state"]);
    check(typeof result.admitted === "boolean"); return { admitted: result.admitted, credit: result.credit, state: await parse(result.state) };
  };
  let state = await read();
  if (args.action === "pay") {
    check(!futureAccepted || state.quote?.remainingPayments);
    if (state.quote?.confirmed && state.quote.remainingPayments) check(state.quote.futureCardAccepted === futureAccepted);
  }
  const result = (status: "payment_review_ready" | "reconciliation_required" | "credited" | "already_credited") => Object.freeze({
    version: "exact-context-buyer-retry-result-v1" as const, reservationId, invoiceId, quoteId, status,
    quote: state.quote, publicationAllowed: false as const });
  async function verifyCard() {
    const current = await read(); check(current.collection.agreementStatus === "active" && current.claim.status === "dispatching" &&
      current.retry === null && isDeepStrictEqual(current.setup, state.setup));
    check((await args.verifyCard(current.setup.id)).status === "card_saved_payment_not_attempted"); args.fresh();
  }
  async function reconcile() {
    state = await read(); const retry = state.retry;
    if (!retry || retry.admittedAt === null) return result("reconciliation_required");
    const expectedPI = retry.originalPaymentIntentId;
    let chargeId: string | null = null, balanceId: string | null = null;
    const receipt = await inspectPaidRenewal({
      invoices: { retrieve: id => { check(id === invoiceId); return get(`/v1/invoices/${id}`, () => stripe.invoices.retrieve(id)); } },
      invoicePayments: { list: p => { check(isDeepStrictEqual(p, { invoice: invoiceId, limit: 100 }));
        return get(`/v1/invoice_payments?invoice=${invoiceId}&limit=100`, () => stripe.invoicePayments.list(p)); } },
      paymentIntents: { retrieve: async id => { check(id === expectedPI); const pi = await get(`/v1/payment_intents/${id}`, () => stripe.paymentIntents.retrieve(id));
        chargeId = contextStripeId(pi.latest_charge, "ch"); return pi; } },
      charges: { retrieve: async id => { check(id === chargeId); const c = await get(`/v1/charges/${id}`, () => stripe.charges.retrieve(id));
        balanceId = contextStripeId(c.balance_transaction, "txn"); return c; } },
      balanceTransactions: { retrieve: id => { check(id === balanceId); return get(`/v1/balance_transactions/${id}`, () => stripe.balanceTransactions.retrieve(id)); } },
    }, { ...retry.authorization, paymentMethodId: retry.replacementPaymentMethodId }, expectedPI,
    { expectedLiveMode: context.mode === "live", collectionVersion: state.r.terms.version,
      metadata: { context_hash: state.intent.contextHash, terms_hash: state.intent.termsHash },
      now: () => Math.floor(Date.now() / 1000), minimumChargeCreatedAt: retry.admittedAt });
    if (!receipt) return result("reconciliation_required");
    const fresh = await read(); check(isDeepStrictEqual(fresh.retry, retry));
    const saved = await phase("credit", receipt), credit = fields(saved.credit, ["reservation_id", "invoice_id", "payment_number", "credited", "agreement_status"]);
    check(!saved.admitted && credit.reservation_id === reservationId && credit.invoice_id === invoiceId &&
      credit.payment_number === retry.authorization.paymentNumber && typeof credit.credited === "boolean");
    state = saved.state; return result(credit.credited ? "credited" : "already_credited");
  }
  if (args.action === "reconcile" || state.quote?.confirmed) return reconcile();
  if (args.action === "review" || args.action === "review_future") {
    if (args.action === "review_future") check(state.auth.paymentNumber < state.auth.paymentCount);
    await verifyCard(); const quoted = await phase(args.action === "review_future" ? "quote_future" : "quote"); check(!quoted.admitted && quoted.credit === null);
    state = quoted.state; check(state.quote && !state.quote.confirmed); return result("payment_review_ready");
  }
  check(state.quote && !state.quote.confirmed && Math.floor(Date.now() / 1000) < state.quote.expiresAt);
  await verifyCard(); const { auth, collection, r, intent, deps } = state; let priorCharge: string | null = null;
  await verifyRenewalProviderHistory({
    paymentMethods: { retrieve: id => { check(id === auth.paymentMethodId); return get(`/v1/payment_methods/${id}`, () => stripe.paymentMethods.retrieve(id)); } },
    customers: { retrieve: async id => { check(id === auth.customerId); const c = await get(`/v1/customers/${id}`, () => stripe.customers.retrieve(id));
      check(!c.deleted && c.test_clock == null && isDeepStrictEqual(c.metadata, intent.request.params.metadata)); return c; } },
    paymentIntents: { retrieve: async id => { check(collection.prior.some(p => p.paymentIntentId === id));
      const pi = await get(`/v1/payment_intents/${id}`, () => stripe.paymentIntents.retrieve(id)); priorCharge = contextStripeId(pi.latest_charge, "ch"); return pi; } },
    charges: { retrieve: id => { check(id === priorCharge); return get(`/v1/charges/${id}`, () => stripe.charges.retrieve(id)); } },
  }, auth, collection.prior, state.plan.payments, context.mode === "live");
  const sub = await get(`/v1/subscriptions/${auth.subscriptionId}`, () => stripe.subscriptions.retrieve(auth.subscriptionId));
  const observed = inspectContextActivationSubscription(sub, r, intent, deps, collection.state.receipt, true);
  check(observed.activated && observed.itemId === auth.subscriptionItemId && ["active", "past_due"].includes(sub.status));
  await verifyCard(); // Recheck actual unpaid PI/card/hold after historical reads.
  const admissionStart = Date.now(), admitted = await phase("pay", args.consent); state = admitted.state;
  if (admitted.admitted) {
    const retry = state.retry; check(retry && retry.admittedAt !== null && retry.admittedAt >= Math.floor(admissionStart / 1000));
    const params = { payment_method: retry.replacementPaymentMethodId, off_session: false };
    try { await args.pay(params, `cn-exact-v2-retry:${quoteId}:${state.intent.contextHash}:${state.intent.termsHash}:pay-once-v1`, retry.admittedAt * 1000); }
    catch { /* Permanent admission is consumed; inspect, never resend. */ }
  }
  return reconcile();
}
