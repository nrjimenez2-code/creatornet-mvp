import "server-only";
import { isSupportedStripeSnapshotVersion } from "../stripeSnapshotVersion";
import { isDeepStrictEqual } from "node:util";
import type Stripe from "stripe";
import { assertAgreementId } from "./agreementStore";
import { readExactContextReservation } from "./contextReservation";
import { readExactContextCustomerIntent } from "./contextBootstrap";
import { contextStripeId } from "./contextCheckout";
import { readContextInvoiceCollection, contextInvoiceContract } from "./contextInvoice";
import { inspectContextActivationSubscription } from "./contextActivation";
import { parseExactRetryAuthorization } from "./paymentRetryStore";
import { inspectExactBankChallenge, type BankContext } from "./bankVerification";
import { inspectPaidRenewal, verifyRenewalProviderHistory } from "./renewal";
import { inspectUnpaidExactRecovery, parseExactRecoveryRead, type RecoveryRead, type RecoveryOutcome, type RecoveryEvidence } from "./paymentRecovery";
import { calculateInstallmentPlan } from "../installmentPlan";
import type { ExactPaymentContext, ExactPaymentContextEvidence } from "./paymentContext";

function check(v: unknown): asserts v { if (!v) throw Error("Context bank verification requires review"); }
function fields(v: unknown, keys: string[]): Record<string, unknown> {
  check(v && typeof v === "object" && !Array.isArray(v)); const ds = Object.getOwnPropertyDescriptors(v);
  check(Reflect.ownKeys(ds).length === keys.length && keys.every(k => ds[k] && "value" in ds[k] && ds[k].enumerable));
  return v as Record<string, unknown>;
}
export type ContextBankRpc = "read_exact_context_bank_v2" | "run_exact_context_recovery_v2" | "credit_exact_context_invoice_v2";

/** No provider mutation is available. Bank action is an authenticated buyer's
 * explicit request; event observation and captured-receipt checks are separate.
 * Never persist/log the ephemeral capability or interpret SDK success as paid. */
export async function runContextBankVerification(args: {
  reservationId: string; buyerId: string; invoiceId: string; action: "challenge" | "check" | "observe";
  publicKey: string | null; eventId: string | null; context: ExactPaymentContext; stripe: Stripe; apiVersion: string;
  evidence(): Promise<ExactPaymentContextEvidence>; fresh(): void;
  rpc(name: ContextBankRpc, params: object): Promise<unknown>;
  get<T>(path: string, read: () => Promise<T>): Promise<T>;
  retryReceipt(quoteId: string): Promise<{ status: string }>;
}) {
  const { reservationId, buyerId, invoiceId, context, stripe, get } = args;
  assertAgreementId(reservationId); assertAgreementId(buyerId); contextStripeId(invoiceId, "in");
  check(args.action === "observe" ? args.eventId !== null : args.eventId === null);
  check(args.action === "challenge" ? typeof args.publicKey === "string" : args.publicKey === null);
  async function read(forAction = false) {
    const evidence = await args.evidence(); args.fresh();
    const v = fields(await args.rpc("read_exact_context_bank_v2", { p_reservation_id: reservationId, p_actor_id: buyerId,
      p_context: context, p_invoice_id: invoiceId, p_for_action: forAction }), ["reservation", "operation", "collection", "dependencies", "bank", "retry"]);
    const r = readExactContextReservation(v.reservation, evidence); check(r.id === reservationId && r.terms.buyerId === buyerId);
    const intent = readExactContextCustomerIntent({ intentRow: v.operation, reservationRow: v.reservation, contextEvidence: evidence, actorId: r.terms.creatorId });
    check(intent.request.apiVersion === args.apiVersion);
    const d = fields(v.dependencies, ["customerId", "subscriptionId", "productId", "anchor"]);
    const deps = { customerId: contextStripeId(d.customerId, "cus"), subscriptionId: contextStripeId(d.subscriptionId, "sub"),
      productId: contextStripeId(d.productId, "prod"), anchor: Number(d.anchor) }; check(Number.isSafeInteger(d.anchor) && deps.anchor > 0);
    const collection = readContextInvoiceCollection(v.collection, r, deps, invoiceId), auth = collection.authorization, claim = collection.state.claim;
    check(auth && claim && ["dispatching", "paid"].includes(claim.status) && claim.paymentIntentId && claim.dispatchStartedAt !== null);
    const b = fields(v.bank, ["status", "authorization", "paymentIntentId", "buyerId", "paymentMethodId", "admittedAt", "retryId"]);
    check(b.status === "reconcile" && b.buyerId === buyerId && b.paymentIntentId === claim.paymentIntentId && isDeepStrictEqual(b.authorization, auth) &&
      Number.isSafeInteger(b.admittedAt) && Number(b.admittedAt) >= auth.periodStart && Number(b.admittedAt) < auth.periodEnd && Number(b.admittedAt) <= Math.floor(Date.now() / 1000));
    const pm = contextStripeId(b.paymentMethodId, "pm");
    if (b.retryId === null) check(v.retry === null && pm === auth.paymentMethodId && b.admittedAt === Math.floor(claim.dispatchStartedAt / 1000));
    else {
      check(typeof b.retryId === "string"); assertAgreementId(b.retryId);
      const state = fields(v.retry, ["reservation", "operation", "collection", "dependencies", "setup", "quote", "admission"]);
      check(isDeepStrictEqual(state.reservation, v.reservation) && isDeepStrictEqual(state.collection, v.collection) &&
        isDeepStrictEqual(state.operation, v.operation) && isDeepStrictEqual(state.dependencies, v.dependencies));
      const retry = parseExactRetryAuthorization(state.quote, state.admission);
      check(retry.id === b.retryId && retry.agreementId === reservationId && retry.buyerId === buyerId && retry.authorization.invoiceId === invoiceId &&
        retry.originalPaymentIntentId === claim.paymentIntentId && retry.replacementPaymentMethodId === pm && retry.admittedAt === b.admittedAt &&
        isDeepStrictEqual(retry.authorization, auth));
    }
    const bank: BankContext = { authorization: auth, paymentIntentId: claim.paymentIntentId, buyerId, paymentMethodId: pm,
      admittedAt: Number(b.admittedAt), retryId: b.retryId as string | null };
    return { r, intent, deps, collection, auth, claim, bank, contract: contextInvoiceContract(r, intent, deps, collection.state, auth) };
  }
  let state = await read(args.action === "challenge");
  const result = (status: "credited" | "already_credited" | "reconciliation_required" | "payment_recovery_recorded", outcome?: RecoveryOutcome) => Object.freeze({
    version: "exact-context-bank-result-v1" as const, reservationId, invoiceId, status, ...(outcome ? { outcome } : {}), publicationAllowed: false as const });
  const identity = () => ({ bank: state.bank, token: state.claim.token, dispatch: state.claim.dispatchStartedAt });
  async function unchanged(forAction = false) {
    const original = identity(), fresh = await read(forAction);
    check(isDeepStrictEqual(original, { bank: fresh.bank, token: fresh.claim.token, dispatch: fresh.claim.dispatchStartedAt }));
    state = fresh; args.fresh();
  }
  let latestCharge: string | null = null;
  const currentReaders = {
    invoices: { retrieve: (id: string) => { check(id === invoiceId); return get(`/v1/invoices/${id}`, () => stripe.invoices.retrieve(id)); } },
    invoicePayments: { list: (p: Stripe.InvoicePaymentListParams) => { check(isDeepStrictEqual(p, { invoice: invoiceId, limit: 100 }));
      return get(`/v1/invoice_payments?invoice=${invoiceId}&limit=100`, () => stripe.invoicePayments.list(p)); } },
    paymentIntents: { retrieve: async (id: string) => { check(id === state.bank.paymentIntentId);
      const pi = await get(`/v1/payment_intents/${id}`, () => stripe.paymentIntents.retrieve(id));
      latestCharge = pi.latest_charge == null ? null : contextStripeId(pi.latest_charge, "ch"); return pi; } },
    charges: { retrieve: (id: string) => { check(id === latestCharge); return get(`/v1/charges/${id}`, () => stripe.charges.retrieve(id)); } },
  };
  async function reconcile() {
    await unchanged();
    if (state.bank.retryId) {
      const receipt = await args.retryReceipt(state.bank.retryId); args.fresh();
      return result(receipt.status === "credited" || receipt.status === "already_credited" ? receipt.status : "reconciliation_required");
    }
    let balanceId: string | null = null;
    const receipt = await inspectPaidRenewal({ ...currentReaders,
      charges: { retrieve: async id => { const charge = await currentReaders.charges.retrieve(id);
        balanceId = contextStripeId(charge.balance_transaction, "txn"); return charge; } },
      balanceTransactions: { retrieve: id => { check(id === balanceId); return get(`/v1/balance_transactions/${id}`, () => stripe.balanceTransactions.retrieve(id)); } },
    }, state.auth, state.bank.paymentIntentId, { ...state.contract, now: () => Math.floor(Date.now() / 1000), minimumChargeCreatedAt: state.bank.admittedAt });
    if (!receipt) return result("reconciliation_required");
    await unchanged(); await args.evidence(); args.fresh();
    const credit = fields(await args.rpc("credit_exact_context_invoice_v2", { p_reservation_id: reservationId, p_actor_id: state.r.terms.creatorId,
      p_context: context, p_invoice_id: invoiceId, p_receipt: receipt }), ["reservation_id", "invoice_id", "payment_number", "credited", "agreement_status"]);
    check(credit.reservation_id === reservationId && credit.invoice_id === invoiceId && credit.payment_number === state.auth.paymentNumber && typeof credit.credited === "boolean");
    return result(credit.credited ? "credited" : "already_credited");
  }
  if (args.action === "check") return reconcile();
  if (args.action === "observe") {
    const eventId = contextStripeId(args.eventId, "evt"), event = await get(`/v1/events/${eventId}`, () => stripe.events.retrieve(eventId));
    check(event.object === "event" && event.id === eventId && isSupportedStripeSnapshotVersion(event.api_version, args.apiVersion) && event.livemode === (context.mode === "live") &&
      ["invoice.payment_failed", "invoice.payment_action_required", "invoice.voided", "invoice.marked_uncollectible", "invoice.paid", "invoice.payment_succeeded"].includes(event.type) &&
      Number.isSafeInteger(event.created) && event.created > 0 && event.created <= Math.floor(Date.now() / 1000));
    const ei = event.data.object as Stripe.Invoice;
    check(ei.object === "invoice" && ei.id === invoiceId && ei.livemode === event.livemode &&
      contextStripeId(ei.customer, "cus") === state.auth.customerId && contextStripeId(ei.parent?.subscription_details?.subscription, "sub") === state.auth.subscriptionId);
    const eventLocator = { id: eventId, type: event.type, invoiceId, customerId: state.auth.customerId, subscriptionId: state.auth.subscriptionId,
      created: event.created, livemode: event.livemode };
    async function observe(phase: "begin" | "finish", snapshot: RecoveryRead | null = null, outcome: RecoveryOutcome | null = null, proof: RecoveryEvidence | null = null) {
      await args.evidence(); args.fresh();
      const v = fields(await args.rpc("run_exact_context_recovery_v2", { p_reservation_id: reservationId, p_actor_id: state.r.terms.creatorId,
        p_context: context, p_invoice_id: invoiceId, p_event: eventLocator, p_phase: phase, p_read: snapshot, p_outcome: outcome, p_evidence: proof }), ["read", "retryAdmitted", "saved"]);
      check(v.retryAdmitted === (state.bank.retryId !== null) && typeof v.saved === "boolean");
      const read = v.read === null ? null : parseExactRecoveryRead(v.read);
      if (read) check(read.paymentIntentId === state.bank.paymentIntentId && read.subscriptionId === state.auth.subscriptionId &&
        read.periodStart === state.auth.periodStart && read.periodEnd === state.auth.periodEnd && read.dispatchStartedAt === Math.floor(state.claim.dispatchStartedAt! / 1000));
      return { read, saved: v.saved };
    }
    let started = await observe("begin"); await unchanged();
    const invoice = await currentReaders.invoices.retrieve(invoiceId);
    check(invoice.id === invoiceId && invoice.livemode === (context.mode === "live") && contextStripeId(invoice.customer, "cus") === state.auth.customerId &&
      contextStripeId(invoice.parent?.subscription_details?.subscription, "sub") === state.auth.subscriptionId);
    if (invoice.status === "paid") {
      const receipt = await reconcile(); if (!["credited", "already_credited"].includes(receipt.status) || !started.read) return receipt;
      started = await observe("begin"); check(started.read);
      const saved = await observe("finish", started.read, "paid_accounted", { invoiceStatus: "paid", paymentStatus: "succeeded",
        amountReceived: invoice.amount_paid, amountCapturable: 0, canceledAt: null, voidedAt: null });
      return saved.saved ? result("payment_recovery_recorded", "paid_accounted") : result("reconciliation_required");
    }
    check(started.read);
    const observed = await inspectUnpaidExactRecovery(currentReaders, invoice, state.auth, started.read, state.bank.paymentMethodId, state.contract);
    await unchanged();
    const saved = await observe("finish", started.read, observed.outcome, observed.evidence);
    return saved.saved ? result("payment_recovery_recorded", observed.outcome) : result("reconciliation_required");
  }
  const { auth, r, intent, deps, collection } = state;
  let priorCharge: string | null = null;
  const plan = calculateInstallmentPlan(r.terms.totalCents, r.terms.paymentCount, r.terms.renewalFeeSchedule, r.terms.firstPaymentFeeSchedule);
  await verifyRenewalProviderHistory({
    paymentMethods: { retrieve: id => { check(id === auth.paymentMethodId); return get(`/v1/payment_methods/${id}`, () => stripe.paymentMethods.retrieve(id)); } },
    customers: { retrieve: async id => { check(id === auth.customerId); const c = await get(`/v1/customers/${id}`, () => stripe.customers.retrieve(id));
      check(!c.deleted && c.test_clock == null && isDeepStrictEqual(c.metadata, intent.request.params.metadata)); return c; } },
    paymentIntents: { retrieve: async id => { check(collection.prior.some(p => p.paymentIntentId === id));
      const pi = await get(`/v1/payment_intents/${id}`, () => stripe.paymentIntents.retrieve(id)); priorCharge = contextStripeId(pi.latest_charge, "ch"); return pi; } },
    charges: { retrieve: id => { check(id === priorCharge); return get(`/v1/charges/${id}`, () => stripe.charges.retrieve(id)); } },
  }, auth, collection.prior, plan.payments, context.mode === "live");
  const sub = await get(`/v1/subscriptions/${auth.subscriptionId}`, () => stripe.subscriptions.retrieve(auth.subscriptionId));
  check(inspectContextActivationSubscription(sub, r, intent, deps, collection.state.receipt, true).activated);
  const challenge = await inspectExactBankChallenge({ ...currentReaders,
    paymentMethods: { retrieve: id => { check(id === state.bank.paymentMethodId); return get(`/v1/payment_methods/${id}`, () => stripe.paymentMethods.retrieve(id)); } },
  }, state.bank, state.contract, args.publicKey!);
  await unchanged(true); // Stop/refund/receipt arriving during provider reads blocks release.
  return Object.freeze(challenge);
}
