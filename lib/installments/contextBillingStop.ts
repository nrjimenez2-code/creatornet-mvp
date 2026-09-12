import "server-only";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Stripe from "stripe";
import { assertAgreementId } from "./agreementStore";
import { readExactContextReservation } from "./contextReservation";
import { contextStripeId } from "./contextCheckout";
import { stopExactBillingUsingContract, type BillingStopIdentity, type ExactBillingStopStore, type BillingStopProvider } from "./billingStop";
import type { ExactPaymentContext, ExactPaymentContextEvidence } from "./paymentContext";

function check(v: unknown): asserts v { if (!v) throw Error("Context billing stop requires review"); }
function record(v: unknown): Record<string, unknown> {
  check(v && typeof v === "object" && !Array.isArray(v));
  check(Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  for (const d of Object.values(Object.getOwnPropertyDescriptors(v))) check("value" in d && d.enumerable);
  return v as Record<string, unknown>;
}
function fields(v: unknown, keys: string[]) {
  const o = record(v); check(Reflect.ownKeys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k))); return o;
}
export function readCreditedAdminContext(v: unknown, reservationId: string, evidence: ExactPaymentContextEvidence) {
  const s = fields(v, ["reservation", "customerId", "subscriptionId", "sessionId", "metadata", "receipts"]);
  const reservation = readExactContextReservation(s.reservation, evidence); check(reservation.id === reservationId);
  const customerId = contextStripeId(s.customerId, "cus"), subscriptionId = contextStripeId(s.subscriptionId, "sub"), sessionId = contextStripeId(s.sessionId, "cs");
  const metadata = fields(s.metadata, ["customer", "subscription", "checkout"]);
  for (const kind of ["customer", "subscription", "checkout"]) {
    const m = record(metadata[kind]); check(Object.values(m).every(v => typeof v === "string") &&
      m.installment_plan_id === reservation.id && m.installment_collection_version === reservation.terms.version &&
      m.booking_id === reservation.bookingId && m.creator_id === reservation.terms.creatorId && m.buyer_id === reservation.terms.buyerId &&
      m.operation_kind === `${kind}.create`);
  }
  check(Array.isArray(s.receipts) && s.receipts.length >= 1 && s.receipts.length <= reservation.terms.paymentCount);
  const receipts = s.receipts.map(value => {
    const r = fields(value, ["paymentIntentId", "invoiceId", "amountCents"]);
    check(typeof r.amountCents === "number" && Number.isSafeInteger(r.amountCents) && r.amountCents > 0);
    return { paymentIntentId: contextStripeId(r.paymentIntentId, "pi"),
      invoiceId: r.invoiceId === null ? null : contextStripeId(r.invoiceId, "in"), amountCents: r.amountCents };
  });
  check(receipts[0].invoiceId === null && new Set(receipts.map(r => r.paymentIntentId)).size === receipts.length);
  return { reservation, customerId, subscriptionId, sessionId, metadata, receipts };
}

/** INTERNAL post-first-credit composition, not an HTTP or policy surface.
 * Uses the existing 047/050 administrator request, permanent hold and terminal
 * proof. The caller is the private runtime; none of these dependencies or
 * provider identifiers are accepted from a browser/request. Unpaid ordering is
 * deliberately separate. No expiry, refund, pay, proration, waiver or unhold. */
export async function stopCreditedContextBilling(args: {
  reservationId: string; actorId: string; requestId: string; context: ExactPaymentContext; stripe: Stripe;
  evidence(): Promise<ExactPaymentContextEvidence>;
  fresh(): void;
  rpc(name: "read_exact_context_stop_v2" | "run_exact_context_stop_v2", params: object): Promise<unknown>;
  get<T>(path: string, read: () => Promise<T>): Promise<T>;
  cancel(id: string, authorizedAt: number): Promise<Stripe.Subscription>;
}) {
  const { reservationId, actorId, requestId, context, stripe, get } = args;
  for (const id of [reservationId, actorId, requestId]) assertAgreementId(id);
  const identity: BillingStopIdentity = { agreementId: reservationId, actorId, requestId, token: randomUUID() };
  const base = { p_reservation_id: reservationId, p_actor_id: actorId, p_context: context };
  const read = async () => {
    const evidence = await args.evidence(); args.fresh();
    return readCreditedAdminContext(await args.rpc("read_exact_context_stop_v2", base), reservationId, evidence);
  };
  const state = await read();
  let authorization: number | null = null;
  const phase = async (name: "claim" | "assert" | "complete", proof: object | null = null) => {
    await args.evidence(); args.fresh();
    const value = fields(await args.rpc("run_exact_context_stop_v2", { ...base, p_request_id: requestId,
      p_token: identity.token, p_phase: name, p_proof: proof }), ["reservationId", "actorId", "requestId", "token", "status"]);
    check(value.reservationId === reservationId && value.actorId === actorId && value.requestId === requestId && value.token === identity.token);
    return value.status;
  };
  const sameIdentity = (i: BillingStopIdentity) => check(isDeepStrictEqual(i, identity));
  const store: ExactBillingStopStore = {
    claim: async i => { sameIdentity(i); const s = await phase("claim");
      check(s === "ready" || s === "busy" || s === "complete" || s === "reconciliation_required"); return s; },
    assertClaim: async i => { sameIdentity(i); check(authorization === null && await phase("assert") === "authorized"); authorization = Date.now(); },
    accounted: async (id, kind, providerId, amount) => {
      check(id === reservationId); const current = await read();
      check(isDeepStrictEqual(current.reservation, state.reservation) && current.customerId === state.customerId &&
        current.subscriptionId === state.subscriptionId && current.sessionId === state.sessionId && isDeepStrictEqual(current.metadata, state.metadata));
      return current.receipts.some(r => (kind === "intent" ? r.paymentIntentId : r.invoiceId) === providerId && r.amountCents === amount);
    },
    complete: async (i, proof) => { sameIdentity(i); check(proof.checkoutStatus === "complete" &&
      proof.firstPaymentIntentId === state.receipts[0].paymentIntentId && await phase("complete", proof) === "collection_stopped"); },
  };
  const query = (params: Record<string, string | number | boolean | undefined>) =>
    new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
  const intentIds = new Set([state.receipts[0].paymentIntentId]);
  const invoiceIds = new Set<string>(); let cursor: string | undefined;
  const provider: BillingStopProvider = {
    customers: { retrieve: async id => { check(id === state.customerId); return get(`/v1/customers/${id}`, () => stripe.customers.retrieve(id)); } },
    subscriptions: {
      retrieve: async id => { check(id === state.subscriptionId); return get(`/v1/subscriptions/${id}`, () => stripe.subscriptions.retrieve(id)); },
      list: async p => { check(isDeepStrictEqual(p, { customer: state.customerId, status: "all", limit: 100 }));
        return get(`/v1/subscriptions?${query(p)}`, () => stripe.subscriptions.list(p)); },
      cancel: async (id, p, options) => {
        check(id === state.subscriptionId && isDeepStrictEqual(p, { invoice_now: false, prorate: false }) &&
          isDeepStrictEqual(options, { maxNetworkRetries: 0 }) && authorization !== null);
        const at = authorization; authorization = null; args.fresh(); return args.cancel(id, at);
      },
    },
    checkout: { sessions: {
      retrieve: async id => { check(id === state.sessionId);
        const s = await get(`/v1/checkout/sessions/${id}`, () => stripe.checkout.sessions.retrieve(id));
        check(s.status === "complete" && s.payment_status === "paid" && contextStripeId(s.payment_intent, "pi") === state.receipts[0].paymentIntentId); return s; },
      expire: async () => { throw Error("Credited context cannot expire Checkout"); },
    } },
    invoiceItems: { list: async p => { check(isDeepStrictEqual(p, { customer: state.customerId, pending: true, limit: 100 }));
      return get(`/v1/invoiceitems?${query(p)}`, () => stripe.invoiceItems.list(p)); } },
    invoices: { list: async p => {
      check(p.customer === state.customerId && p.limit === 100 && Object.keys(p).every(k => ["customer", "limit", "starting_after"].includes(k)) &&
        (p.starting_after === undefined || p.starting_after === cursor));
      if (p.starting_after === undefined) { invoiceIds.clear(); cursor = undefined; }
      const page = await get(`/v1/invoices?${query(p)}`, () => stripe.invoices.list(p));
      for (const inv of page.data) {
        check(contextStripeId(inv.customer, "cus") === state.customerId && contextStripeId(inv.parent?.subscription_details?.subscription, "sub") === state.subscriptionId &&
          inv.livemode === (context.mode === "live")); invoiceIds.add(contextStripeId(inv.id, "in"));
      }
      cursor = page.has_more ? page.data.at(-1)?.id : undefined; return page;
    } },
    invoicePayments: { list: async p => {
      check(invoiceIds.has(p.invoice) && p.limit === 100 && Object.keys(p).length === 2);
      const page = await get(`/v1/invoice_payments?${query(p)}`, () => stripe.invoicePayments.list(p));
      for (const link of page.data) {
        check(contextStripeId(link.invoice, "in") === p.invoice && link.livemode === (context.mode === "live") && link.payment.type === "payment_intent");
        intentIds.add(contextStripeId(link.payment.payment_intent, "pi"));
      }
      return page;
    } },
    paymentIntents: { retrieve: async id => { check(intentIds.has(id)); return get(`/v1/payment_intents/${id}`, () => stripe.paymentIntents.retrieve(id)); } },
  };
  const result = await stopExactBillingUsingContract({ identity, agreement: { id: reservationId, customerId: state.customerId,
    subscriptionId: state.subscriptionId, sessionId: state.sessionId, terms: state.reservation.terms }, stopStore: store, stripe: provider,
    expectedLiveMode: context.mode === "live", matchesMetadata: (kind, metadata) => !!metadata &&
      Object.entries(record(state.metadata[kind])).every(([k, v]) => metadata[k] === v) });
  return Object.freeze({ version: "exact-context-billing-stop-result-v1" as const, reservationId, status: result.status,
    publicationAllowed: false as const });
}
