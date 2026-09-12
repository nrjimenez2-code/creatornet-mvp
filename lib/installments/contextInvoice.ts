import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Stripe from "stripe";
import { assertAgreementId } from "./agreementStore";
import { calculateInstallmentPlan } from "../installmentPlan";
import { installmentMonthBoundary } from "./checkoutPreparation";
import type { ExactContextReservation } from "./contextReservation";
import type { ExactContextCustomerIntent } from "./contextBootstrap";
import { readContextActivation, inspectContextActivationSubscription, type ContextFirstReceipt,
  type ContextActivationDependencies } from "./contextActivation";
import { contextStripeId } from "./contextCheckout";
import { parseRenewalAuthorization, type RenewalAuthorization } from "./invoiceStore";
import type { HeldInvoicePreparationContract } from "./heldInvoice";

function check(value: unknown): asserts value { if (!value) throw new Error("Context invoice requires review"); }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).length === keys.length);
  for (const key of keys) check(descriptors[key] && "value" in descriptors[key] && descriptors[key].enumerable);
  return value as Record<string, unknown>;
}
type Period = Readonly<{ paymentNumber: number; start: number; end: number; amount: number; fee: number }>;
export type ContextInvoiceState = Readonly<{
  bookingPaymentId: string; receipt: ContextFirstReceipt; itemId: string; cancelAt: number;
  periods: ReadonlyArray<Period>;
  claim: Readonly<{ token: string; number: number; status: string; firstStartedAt: number;
    leaseUntil: number; paymentIntentId: string | null; dispatchStartedAt: number | null }> | null;
}>;

export function readContextFirstReceipt(value: unknown, r: ExactContextReservation): ContextFirstReceipt {
  const hasConsent = value != null && typeof value === "object" && Object.hasOwn(value, "purchase_consent_version");
  const paid = fields(value, ["session_id", "payment_intent_id", "charge_id", "balance_transaction_id", "payment_method_id",
    "amount_cents", "application_fee_cents", "actual_stripe_fee_cents", "paid_at", ...(hasConsent ? ["purchase_consent_version"] : [])]);
  check(r.terms.purchaseConsentVersion
    ? paid.purchase_consent_version === r.terms.purchaseConsentVersion
    : !hasConsent || paid.purchase_consent_version === null);
  for (const [key, prefix] of [["session_id", "cs"], ["payment_intent_id", "pi"], ["charge_id", "ch"],
    ["balance_transaction_id", "txn"], ["payment_method_id", "pm"]]) contextStripeId(paid[key], prefix);
  const plan = calculateInstallmentPlan(r.terms.totalCents, r.terms.paymentCount, r.terms.renewalFeeSchedule, r.terms.firstPaymentFeeSchedule);
  check(paid.amount_cents === plan.payments[0].amountCents && paid.application_fee_cents === plan.payments[0].fees.totalCreatorDeductionCents &&
    Number.isSafeInteger(paid.actual_stripe_fee_cents) && Number(paid.actual_stripe_fee_cents) >= 0 && Number(paid.actual_stripe_fee_cents) <= 99999999 &&
    Number.isSafeInteger(paid.paid_at) && Number(paid.paid_at) >= r.createdAt && Number(paid.paid_at) * 1000 <= Date.now());
  // SQL readers installed after consent rollout include NULL for older rows.
  // Normalize that absence without inventing acceptance on a legacy receipt.
  const normalized = { ...paid };
  if (!r.terms.purchaseConsentVersion) delete normalized.purchase_consent_version;
  return Object.freeze(normalized) as ContextFirstReceipt;
}

export function readContextInvoiceState(value: unknown, r: ExactContextReservation, invoiceId: string): ContextInvoiceState {
  contextStripeId(invoiceId, "in");
  const v = fields(value, ["agreement_id", "booking_payment_id", "activation", "first_receipt", "periods", "claim"]);
  check(v.agreement_id === r.id && typeof v.booking_payment_id === "string"); assertAgreementId(v.booking_payment_id);
  const receipt = readContextFirstReceipt(v.first_receipt, r);
  const plan = calculateInstallmentPlan(r.terms.totalCents, r.terms.paymentCount, r.terms.renewalFeeSchedule, r.terms.firstPaymentFeeSchedule);
  const outer = fields(v.activation, ["agreement_id", "payment_method_id", "activation"]);
  check(outer.activation && typeof outer.activation === "object" && "activation_snapshot" in outer.activation);
  const snapshot = outer.activation.activation_snapshot as Record<string, unknown>;
  const itemId = contextStripeId(snapshot.subscriptionItemId, "si");
  const activation = readContextActivation(v.activation, r, receipt, itemId); check(activation?.status === "complete");
  check(Array.isArray(v.periods) && v.periods.length === r.terms.paymentCount - 1);
  const periods = v.periods.map((row, i) => {
    const p = fields(row, ["agreement_id", "payment_number", "due_at", "period_end", "amount_cents", "application_fee_cents"]);
    const start = installmentMonthBoundary(activation.authorization.firstRenewalAt, i);
    const end = installmentMonthBoundary(activation.authorization.firstRenewalAt, i + 1);
    check(p.agreement_id === r.id && p.payment_number === i + 2 && p.due_at === start && p.period_end === end &&
      p.amount_cents === plan.payments[i + 1].amountCents && p.application_fee_cents === plan.payments[i + 1].fees.totalCreatorDeductionCents);
    return Object.freeze({ paymentNumber: i + 2, start, end, amount: plan.payments[i + 1].amountCents, fee: plan.payments[i + 1].fees.totalCreatorDeductionCents });
  });
  let claim: ContextInvoiceState["claim"] = null;
  if (v.claim !== null) {
    const c = fields(v.claim, ["agreement_id", "payment_number", "stripe_invoice_id", "stripe_payment_intent_id", "status", "claim_token",
      "lease_until", "first_started_at", "dispatch_started_at"]);
    check(c.agreement_id === r.id && c.stripe_invoice_id === invoiceId && periods.some(p => p.paymentNumber === c.payment_number) &&
      typeof c.status === "string" && ["preparing", "prepared", "dispatching", "paid", "review_required"].includes(c.status) &&
      typeof c.claim_token === "string" && typeof c.lease_until === "string" && typeof c.first_started_at === "string");
    assertAgreementId(c.claim_token);
    const started = Date.parse(c.first_started_at), lease = Date.parse(c.lease_until);
    check(Number.isFinite(started) && started >= Number(receipt.paid_at) * 1000 && started <= Date.now() && Number.isFinite(lease) && lease > started);
    const paymentIntentId = c.stripe_payment_intent_id === null ? null : contextStripeId(c.stripe_payment_intent_id, "pi");
    check(!["prepared", "dispatching", "paid"].includes(c.status) || paymentIntentId);
    const dispatchStartedAt = c.dispatch_started_at === null ? null : typeof c.dispatch_started_at === "string" ? Date.parse(c.dispatch_started_at) : NaN;
    check(dispatchStartedAt === null || Number.isFinite(dispatchStartedAt) && dispatchStartedAt >= started && dispatchStartedAt <= Date.now());
    check(!["dispatching", "paid"].includes(c.status) || dispatchStartedAt !== null);
    claim = Object.freeze({ token: c.claim_token, number: Number(c.payment_number), status: c.status, firstStartedAt: started, leaseUntil: lease, paymentIntentId, dispatchStartedAt });
  }
  return Object.freeze({ bookingPaymentId: v.booking_payment_id, receipt, itemId, cancelAt: activation.authorization.cancelAt,
    periods: Object.freeze(periods), claim });
}

/** Owned durable evidence is not permission to send another charge. */
export function readContextInvoiceCollection(value: unknown, r: ExactContextReservation,
  deps: ContextActivationDependencies, invoiceId: string) {
  const v = fields(value, ["state", "authorization", "agreement_status", "prior"]);
  const state = readContextInvoiceState(v.state, r, invoiceId);
  check(typeof v.agreement_status === "string" && Array.isArray(v.prior) && v.prior.length <= r.terms.paymentCount);
  const prior = v.prior.map((row, i) => {
    const p = fields(row, ["paymentNumber", "paymentIntentId"]);
    check(p.paymentNumber === i + 1);
    return Object.freeze({ paymentNumber: i + 1, paymentIntentId: contextStripeId(p.paymentIntentId, "pi") });
  });
  const period = state.periods.find(p => p.paymentNumber === state.claim?.number);
  check(state.claim ? period && v.authorization !== null : v.authorization === null);
  const authorization = period ? contextInvoiceAuthorization(v.authorization, r, deps, state, invoiceId, period) : null;
  return Object.freeze({ state, authorization, agreementStatus: v.agreement_status, prior: Object.freeze(prior) });
}

export function contextInvoicePeriod(inv: Stripe.Invoice, r: ExactContextReservation, deps: ContextActivationDependencies,
  state: ContextInvoiceState, invoiceId: string): Period {
  check(inv.object === "invoice" && inv.id === invoiceId && inv.livemode === (r.context.mode === "live") &&
    inv.customer === deps.customerId && inv.parent?.subscription_details?.subscription === deps.subscriptionId &&
    inv.billing_reason === "subscription_cycle" && inv.lines.has_more === false);
  const base = inv.lines.data.filter(l => l.parent?.type === "subscription_item_details");
  check(base.length === 1 && base[0].parent?.subscription_item_details?.proration === false &&
    base[0].parent.subscription_item_details.subscription_item === state.itemId && base[0].parent.subscription_item_details.subscription === deps.subscriptionId);
  const period = state.periods.find(p => p.start === base[0].period.start && p.end === base[0].period.end); check(period);
  return period;
}

export function contextInvoiceAuthorization(value: unknown, r: ExactContextReservation, deps: ContextActivationDependencies,
  state: ContextInvoiceState, invoiceId: string, period: Period): RenewalAuthorization {
  const a = parseRenewalAuthorization(value);
  check(a.planId === r.id && a.bookingPaymentId === state.bookingPaymentId && a.invoiceId === invoiceId &&
    a.customerId === deps.customerId && a.subscriptionId === deps.subscriptionId && a.subscriptionItemId === state.itemId &&
    a.destinationId === r.terms.destinationId && a.totalCents === r.terms.totalCents && a.paymentCount === r.terms.paymentCount &&
    a.paymentNumber === period.paymentNumber && a.periodStart === period.start && a.periodEnd === period.end && a.cancelAt === state.cancelAt &&
    isDeepStrictEqual(a.feeSchedule, r.terms.renewalFeeSchedule) &&
    (a.defaultPaymentMethodId ?? a.paymentMethodId) === state.receipt.payment_method_id);
  return a;
}

export function contextInvoiceContract(r: ExactContextReservation, intent: ExactContextCustomerIntent,
  deps: ContextActivationDependencies, state: ContextInvoiceState, a: RenewalAuthorization): HeldInvoicePreparationContract {
  const hash = createHash("sha256").update(JSON.stringify([r.id, intent.contextHash, intent.termsHash, a.invoiceId])).digest("hex");
  return Object.freeze({ expectedLiveMode: r.context.mode === "live", collectionVersion: r.terms.version,
    idempotencyPrefix: `cn-exact-v2-invoice:${hash}`, metadata: Object.freeze({ context_hash: intent.contextHash, terms_hash: intent.termsHash }),
    assertSubscription(s: Stripe.Subscription) {
      const observed = inspectContextActivationSubscription(s, r, intent, deps, state.receipt);
      check(observed.activated && observed.itemId === a.subscriptionItemId && s.status === "active");
    },
  });
}
