import "server-only";
import type Stripe from "stripe";
import { isDeepStrictEqual } from "node:util";
import { assertAgreementId } from "./agreementStore";
import { contextStripeId } from "./contextCheckout";
import { readCreditedAdminContext } from "./contextBillingStop";
import type { ExactPaymentContext, ExactPaymentContextEvidence } from "./paymentContext";
import { ledgerFromRow, operationFromRow, type RefundOperation, type RefundOperationStore } from "../admin/refund-store";
import { previewAdminRefund, createAndProcessAdminRefund, processRefundOperation, type RefundRequestInput } from "../admin/refunds";

function check(v: unknown): asserts v { if (!v) throw Error("Context admin refund requires review"); }
function record(v: unknown): Record<string, unknown> {
  check(v && typeof v === "object" && !Array.isArray(v)); return v as Record<string, unknown>;
}
function cents(v: unknown) { check(Number.isSafeInteger(v) && Number(v) >= 0); return Number(v); }
function providerId(v: unknown, prefix: string) {
  return contextStripeId(typeof v === "string" ? v : record(v).id, prefix);
}
export type ContextRefundAction = { kind: "preview" | "create"; input: RefundRequestInput } | { kind: "retry"; operationId: string };

/** #1: only the context boundary is new. Allocation, cumulative reservations,
 * claims, hold coordination, idempotency and reconciliation use the old engine.
 * Private runtime dependencies; never accept a browser's SDK or provider IDs. */
export async function runContextAdminRefund(args: {
  reservationId: string; actorId: string; ledgerId: string; action: ContextRefundAction;
  context: ExactPaymentContext; stripe: Stripe; evidence(): Promise<ExactPaymentContextEvidence>; fresh(): void;
  rpc(params: object): Promise<unknown>;
  get<T>(path: string, read: () => Promise<T>, account?: string): Promise<T>;
  send<T>(path: string, params: object, key: string, write: () => Promise<T>): Promise<T>;
}) {
  const { reservationId, actorId, ledgerId, stripe, action, context } = args;
  for (const id of [reservationId, actorId, ledgerId]) assertAgreementId(id);
  if (action.kind === "retry") assertAgreementId(action.operationId);
  else check(action.input.paymentFeeLedgerId === ledgerId);
  const base = { p_reservation_id: reservationId, p_actor_id: actorId, p_context: context, p_ledger_id: ledgerId };
  const phase = async (p_phase: string, p_payload: object) => {
    args.fresh(); return args.rpc({ ...base, p_phase, p_payload });
  };
  const evidence = await args.evidence(), source = record(await phase("source", {}));
  const state = readCreditedAdminContext(source.state, reservationId, evidence), ledger = ledgerFromRow(source.ledger);
  check(ledger.id === ledgerId && ledger.creatorId === state.reservation.terms.creatorId &&
    state.receipts.some(r => r.paymentIntentId === ledger.stripePaymentIntentId && r.amountCents === ledger.grossAmountCents));
  const destination = state.reservation.terms.destinationId;
  let chargeId = ledger.stripeChargeId, feeId: string | null = null;
  let operation: RefundOperation | null = null, claimToken: string | null = null;
  const get = async <T>(path: string, read: () => Promise<T>, account?: string) => {
    args.fresh(); return args.get(path, read, account);
  };
  const readIntent = async () => {
    const id = ledger.stripePaymentIntentId;
    const pi = await get(`/v1/payment_intents/${id}?expand[0]=latest_charge`, () => stripe.paymentIntents.retrieve(id, { expand: ["latest_charge"] }));
    check(pi.object === "payment_intent" && pi.id === id && pi.livemode === (context.mode === "live") &&
      pi.currency === ledger.currency && pi.amount === ledger.grossAmountCents && pi.status === "succeeded" &&
      providerId(pi.customer, "cus") === state.customerId && providerId(pi.transfer_data?.destination, "acct") === destination);
    const actual = providerId(pi.latest_charge, "ch"); check(chargeId === null || chargeId === actual); chargeId = actual; return pi;
  };
  const feeMatches = (f: Stripe.ApplicationFee) => {
    check(f.object === "application_fee" && f.id === feeId && f.livemode === (context.mode === "live") &&
      providerId(f.charge, "ch") === chargeId && providerId(f.account, "acct") === destination &&
      f.currency === ledger.currency && f.amount === ledger.totalCreatorDeductionCents);
    cents(f.amount_refunded); check(f.amount_refunded <= f.amount); return f;
  };
  const readCharge = async () => {
    if (!chargeId) await readIntent(); check(chargeId);
    const c = await get(`/v1/charges/${chargeId}?expand[0]=application_fee&expand[1]=balance_transaction`,
      () => stripe.charges.retrieve(chargeId!, { expand: ["application_fee", "balance_transaction"] }));
    check(c.object === "charge" && c.id === chargeId && c.livemode === (context.mode === "live") &&
      providerId(c.payment_intent, "pi") === ledger.stripePaymentIntentId && providerId(c.customer, "cus") === state.customerId &&
      providerId(c.transfer_data?.destination, "acct") === destination && c.amount === ledger.grossAmountCents &&
      c.currency === ledger.currency && c.paid && c.captured && c.status === "succeeded");
    cents(c.amount_refunded); check(c.amount_refunded <= c.amount);
    const id = providerId(c.application_fee, "fee"); check(feeId === null || feeId === id); feeId = id;
    if (typeof c.application_fee === "object" && c.application_fee) feeMatches(c.application_fee);
    if (typeof c.balance_transaction === "object" && c.balance_transaction) {
      const b = c.balance_transaction; check(b.object === "balance_transaction" && b.source === c.id && b.currency === c.currency && b.amount === c.amount); cents(b.fee);
    }
    return c;
  };
  // Establish provider ownership before the old engine can reserve an operation
  // or resume one. No refund POST is possible before its durable hold below.
  await readCharge();
  const readOperation = (value: unknown) => {
    const op = operationFromRow(value);
    check(op.paymentFeeLedgerId === ledger.id && op.creatorId === ledger.creatorId && op.stripePaymentIntentId === ledger.stripePaymentIntentId &&
      op.stripeChargeId === chargeId && op.stripeApplicationFeeId === feeId && op.currency === ledger.currency);
    check(operation === null || op.id === operation.id); operation = op; return op;
  };
  const store: RefundOperationStore = {
    getSourceContext: async id => {
      check(id === ledgerId); const current = record(await phase("source", {}));
      const l = ledgerFromRow(current.ledger);
      check(l.id === ledger.id && l.stripePaymentIntentId === ledger.stripePaymentIntentId && l.grossAmountCents === ledger.grossAmountCents);
      return { ledger: l, cumulativeCustomerRefundTargetCents: cents(current.customerTarget), applicationFeeRefundTargetCents: cents(current.feeTarget) };
    },
    createOperation: async input => { check(action.kind === "create" && input.initiatedBy === actorId && input.paymentFeeLedgerId === ledgerId);
      return readOperation(await phase("create", input)); },
    getOperation: async operationId => readOperation(await phase("read", { operationId })),
    claimOperation: async (operationId, token) => {
      const r = await phase("claim", { operationId, token });
      check(r === "claimed" || r === "busy" || r === "completed" || r === "failed" || r === "missing");
      if (r === "claimed") claimToken = token; return r;
    },
    coordinateInstallmentRefund: async (operationId, token) => {
      check(token === claimToken); const r = await phase("coordinate", { operationId, token });
      check(r === "held" || r === "reconciliation_required"); return r;
    },
    updateClaimedOperation: async (operationId, token, patch) => {
      check(token === claimToken); const op = readOperation(await phase("update", { operationId, token, patch }));
      if (patch.processing_token === null) claimToken = null; return op;
    },
    getCreatorStripeAccountId: async id => { check(id === ledger.creatorId); return destination; },
  };
  const authorize = async () => {
    check(operation && claimToken); await args.evidence(); args.fresh();
    check(await phase("coordinate", { operationId: operation.id, token: claimToken }) === "held"); return operation;
  };
  const refundMatches = (r: Stripe.Refund) => {
    check(operation && r.object === "refund" && contextStripeId(r.id, "re") &&
      providerId(r.payment_intent, "pi") === ledger.stripePaymentIntentId && providerId(r.charge, "ch") === chargeId &&
      r.amount === operation.customerRefundAmountCents && r.currency === ledger.currency &&
      r.metadata?.creatornet_refund_operation_id === operation.id); return r;
  };
  // The old workflow only sees the methods it needs. The private runtime owns
  // the real SDK, exact requests and one-shot network authorization.
  const provider = {
    paymentIntents: { retrieve: async (id: string) => { check(id === ledger.stripePaymentIntentId); return readIntent(); } },
    charges: { retrieve: async (id: string) => { check(id === chargeId); return readCharge(); } },
    balanceTransactions: { retrieve: async (id: string) => {
      const c = await readCharge(); check(providerId(c.balance_transaction, "txn") === id);
      const b = await get(`/v1/balance_transactions/${id}`, () => stripe.balanceTransactions.retrieve(id));
      check(b.source === chargeId && b.amount === ledger.grossAmountCents && b.currency === ledger.currency); cents(b.fee); return b;
    } },
    refunds: {
      retrieve: async (id: string) => { check(operation && id === operation.stripeRefundId);
        return refundMatches(await get(`/v1/refunds/${id}`, () => stripe.refunds.retrieve(id))); },
      create: async (params: Stripe.RefundCreateParams, options: Stripe.RequestOptions) => {
        const op = await authorize(); const expected = { payment_intent: op.stripePaymentIntentId, amount: op.customerRefundAmountCents,
          reverse_transfer: true, refund_application_fee: false, ...(op.reasonCode === "duplicate_charge" ? { reason: "duplicate" } : {}),
          metadata: { creatornet_refund_operation_id: op.id, responsibility: op.responsibility, reason_code: op.reasonCode } };
        const key = `creatornet:refund:${op.id}:customer`; check(isDeepStrictEqual(params, expected) && options.idempotencyKey === key);
        return refundMatches(await args.send("/v1/refunds", params, key, () => stripe.refunds.create(params, { idempotencyKey: key, maxNetworkRetries: 0 })));
      },
    },
    applicationFees: {
      retrieve: async (id: string) => { check(id === feeId); return feeMatches(await get(`/v1/application_fees/${id}`, () => stripe.applicationFees.retrieve(id))); },
      createRefund: async (id: string, params: Stripe.ApplicationFeeCreateRefundParams, options: Stripe.RequestOptions) => {
        const op = await authorize(); check(id === feeId);
        const fee = feeMatches(await get(`/v1/application_fees/${id}`, () => stripe.applicationFees.retrieve(id)));
        const expected = { amount: Math.max(0, op.applicationFeeRefundTargetCents - fee.amount_refunded),
          metadata: { creatornet_refund_operation_id: op.id, responsibility: op.responsibility } };
        const key = `creatornet:refund:${op.id}:application-fee:${op.applicationFeeRefundTargetCents}`;
        check(expected.amount > 0 && isDeepStrictEqual(params, expected) && options.idempotencyKey === key);
        const r = await args.send(`/v1/application_fees/${id}/refunds`, params, key,
          () => stripe.applicationFees.createRefund(id, params, { idempotencyKey: key, maxNetworkRetries: 0 }));
        check(r.object === "fee_refund" && providerId(r.fee, "fee") === id && r.amount === expected.amount &&
          r.currency === ledger.currency && r.metadata?.creatornet_refund_operation_id === op.id); return r;
      },
    },
    balance: { retrieve: async (params: object, options: Stripe.RequestOptions) => {
      check(isDeepStrictEqual(params, {}) && options.stripeAccount === destination);
      const b = await get("/v1/balance", () => stripe.balance.retrieve({}, { stripeAccount: destination }), destination);
      check(b.object === "balance" && b.livemode === (context.mode === "live")); return b;
    } },
  } as unknown as Stripe;
  if (action.kind === "preview") return previewAdminRefund(store, provider, action.input);
  if (action.kind === "create") return createAndProcessAdminRefund(store, provider, actorId, action.input);
  check(action.kind === "retry");
  return processRefundOperation(store, provider, action.operationId);
}
