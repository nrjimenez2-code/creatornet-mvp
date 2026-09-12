import "server-only";

import type Stripe from "stripe";
import { calculateInstallmentPlan } from "../installmentPlan";
import { creatorFeeMetadata, type ProcessingFeeSchedule } from "../money";

/** New agreements only. This is deliberately not the legacy exact-percent-v1. */
export const HELD_INSTALLMENT_VERSION = "exact-cents-held-v1";

/**
 * Must come from a durable, server-owned agreement/period claim, never a request
 * body or unverified event metadata. The caller must claim one invoice per
 * agreed period and check cancellation/refund state before authorizing payment.
 * No runtime caller is enabled until that persistence/collection layer is ready.
 */
export type HeldInvoiceAuthorization = Readonly<{
  planId: string;
  bookingPaymentId: string;
  invoiceId: string;
  subscriptionId: string;
  subscriptionItemId: string;
  customerId: string;
  destinationId: string;
  currency: "usd";
  totalCents: number;
  paymentCount: number;
  paymentNumber: number;
  periodStart: number;
  periodEnd: number;
  cancelAt: number;
  feeSchedule: ProcessingFeeSchedule;
}>;

type InvoiceStripe = {
  invoices: {
    retrieve(id: string): Promise<Stripe.Invoice>;
    addLines(id: string, params: Stripe.InvoiceAddLinesParams, options?: Stripe.RequestOptions): Promise<Stripe.Invoice>;
    update(id: string, params: Stripe.InvoiceUpdateParams, options?: Stripe.RequestOptions): Promise<Stripe.Invoice>;
    finalizeInvoice(id: string, params: Stripe.InvoiceFinalizeInvoiceParams, options?: Stripe.RequestOptions): Promise<Stripe.Invoice>;
  };
  subscriptions: { retrieve(id: string): Promise<Stripe.Subscription> };
  invoicePayments: { list(params: Stripe.InvoicePaymentListParams): Promise<Stripe.ApiList<Stripe.InvoicePayment>> };
  paymentIntents: { retrieve(id: string): Promise<Stripe.PaymentIntent> };
};

function requireThat(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`Held installment invoice stopped: ${reason}`);
}

function id(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id ?? null;
}

function validateAuthorization(a: HeldInvoiceAuthorization) {
  for (const value of [a.planId, a.bookingPaymentId, a.invoiceId,
    a.subscriptionId, a.subscriptionItemId, a.customerId, a.destinationId]) {
    requireThat(typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value), "invalid identifier");
  }
  requireThat(a.currency === "usd", "currency has not been accepted for this collector");
  requireThat(Number.isInteger(a.paymentNumber) && a.paymentNumber >= 2 &&
    a.paymentNumber <= a.paymentCount, "not an authorized renewal number");
  requireThat([a.periodStart, a.periodEnd, a.cancelAt].every(
    (value) => Number.isSafeInteger(value) && value > 0,
  ) && a.periodStart < a.periodEnd && a.periodEnd <= a.cancelAt, "invalid payment period");
  const plan = calculateInstallmentPlan(a.totalCents, a.paymentCount, a.feeSchedule);
  requireThat(plan.payments.every((payment) => payment.amountCents <= 99999999),
    "payment exceeds Stripe's USD amount limit");
  return { plan, payment: plan.payments[a.paymentNumber - 1] };
}

function assertSubscription(sub: Stripe.Subscription, a: HeldInvoiceAuthorization) {
  // Hard Sandbox restriction for this unfinished collector, independent of env flags.
  requireThat(sub.livemode === false, "live mode is not enabled");
  requireThat(sub.id === a.subscriptionId && id(sub.customer) === a.customerId, "subscription/customer mismatch");
  requireThat(sub.metadata.installment_collection_version === HELD_INSTALLMENT_VERSION &&
    sub.metadata.installment_plan_id === a.planId &&
    sub.metadata.booking_payment_id === a.bookingPaymentId, "agreement/version mismatch");
  requireThat(sub.pause_collection?.behavior === "keep_as_draft" &&
    sub.pause_collection.resumes_at == null, "collection is not held indefinitely");
  requireThat(sub.status === "active" && sub.collection_method === "charge_automatically",
    "subscription is not in the expected active state");
  requireThat(sub.cancel_at === a.cancelAt, "fixed plan end mismatch");
  requireThat(id(sub.transfer_data?.destination) === a.destinationId &&
    sub.transfer_data?.amount_percent == null && sub.application_fee_percent == null,
  "unexpected destination or percentage split");
  requireThat(sub.items.has_more === false && sub.items.data.length === 1 &&
    sub.items.data[0].id === a.subscriptionItemId && sub.items.data[0].quantity === 1,
  "subscription items changed");
}

function assertInvoice(
  invoice: Stripe.Invoice,
  a: HeldInvoiceAuthorization,
  amounts: ReadonlyArray<number>,
  paid = false,
  recovery = false,
  expectedLiveMode = false,
) {
  requireThat(invoice.livemode === expectedLiveMode, "invoice mode differs");
  requireThat(invoice.id === a.invoiceId && id(invoice.customer) === a.customerId &&
    id(invoice.parent?.subscription_details?.subscription) === a.subscriptionId,
  "invoice ownership mismatch");
  requireThat(paid ? invoice.status === "paid" : recovery ? ["open","uncollectible","void"].includes(invoice.status || "") :
    invoice.status === "draft" || invoice.status === "open", "unexpected invoice state");
  requireThat(invoice.auto_advance === false && invoice.next_payment_attempt == null &&
    invoice.automatically_finalizes_at == null,
    "invoice can advance automatically");
  requireThat(paid || recovery || (invoice.attempted === false && invoice.attempt_count === 0),
    "invoice collection has already been attempted");
  requireThat(invoice.collection_method === "charge_automatically" &&
    invoice.billing_reason === "subscription_cycle", "not a regular renewal invoice");
  requireThat(invoice.currency === a.currency && invoice.amount_paid === (paid ? invoice.amount_due : 0) &&
    invoice.amount_overpaid === 0 && invoice.starting_balance === 0 &&
    invoice.pre_payment_credit_notes_amount === 0 && invoice.post_payment_credit_notes_amount === 0,
  "unexpected currency, payment, credit or balance");
  requireThat(invoice.automatic_tax?.enabled === false && !invoice.discounts?.length &&
    !invoice.total_discount_amounts?.length && !invoice.total_taxes?.length &&
    !invoice.total_pretax_credit_amounts?.length, "unapproved tax, discount or credit");
  requireThat(amounts.includes(invoice.amount_due) && invoice.total === invoice.amount_due &&
    invoice.subtotal === invoice.amount_due && invoice.amount_remaining === (paid || recovery && invoice.status === "void" ? 0 : invoice.amount_due),
  "invoice total does not match the agreement");
  requireThat(invoice.lines.has_more === false && invoice.lines.data.length >= 1 &&
    invoice.lines.data.length <= 2, "unexpected invoice lines");
  const baseLines = invoice.lines.data.filter((candidate) => candidate.parent?.type === "subscription_item_details");
  requireThat(baseLines.length === 1, "unexpected number of subscription lines");
  const line = baseLines[0];
  const parent = line.parent?.subscription_item_details;
  requireThat(line.parent?.type === "subscription_item_details" && parent?.proration === false &&
    parent.subscription === a.subscriptionId && parent.subscription_item === a.subscriptionItemId,
  "unexpected invoice line source or proration");
  const plan = calculateInstallmentPlan(a.totalCents, a.paymentCount, a.feeSchedule);
  requireThat(line.amount === plan.regularAmountCents, "subscription base amount changed");
  for (const candidate of invoice.lines.data) {
    requireThat(candidate.livemode === expectedLiveMode && candidate.invoice === a.invoiceId &&
      candidate.currency === a.currency && candidate.quantity === 1 &&
      candidate.period.start === a.periodStart && candidate.period.end === a.periodEnd,
    "invoice period or line identity mismatch");
    requireThat(!candidate.discounts?.length && !candidate.discount_amounts?.length &&
      !candidate.pretax_credit_amounts?.length && !candidate.taxes?.length, "line has unapproved adjustments");
  }
  const adjustments = invoice.lines.data.filter((candidate) => candidate !== line);
  const residual = plan.finalAmountCents - plan.regularAmountCents;
  if (adjustments.length) {
    const adjustment = adjustments[0];
    const source = adjustment.parent?.invoice_item_details;
    requireThat(a.paymentNumber === a.paymentCount && residual > 0 && adjustment.amount === residual &&
      adjustment.parent?.type === "invoice_item_details" && source?.proration === false &&
      (source.subscription == null || source.subscription === a.subscriptionId) &&
      adjustment.metadata.installment_adjustment === "final-cent-v1" &&
      adjustment.metadata.installment_plan_id === a.planId &&
      adjustment.metadata.booking_payment_id === a.bookingPaymentId &&
      adjustment.discountable === false, "unrecognized final balance adjustment");
  }
  requireThat(line.amount + (adjustments[0]?.amount ?? 0) === invoice.amount_due,
    "line amounts do not equal the invoice total");
}

/** Shared read-only shape verification after capture. It deliberately does not
 * require the subscription still to be active: a valid delayed paid event can
 * arrive after its fixed end. Local credit/access safeguards remain separate. */
export function assertPaidHeldInvoice(invoice: Stripe.Invoice, a: HeldInvoiceAuthorization) {
  return assertPaidHeldInvoiceUsingContract(invoice, a, { expectedLiveMode: false, collectionVersion: HELD_INSTALLMENT_VERSION, metadata: {} });
}

/** Internal owned-context inspection. Existing public receipt entry stays Sandbox. */
export function assertPaidHeldInvoiceUsingContract(invoice: Stripe.Invoice, a: HeldInvoiceAuthorization,
  contract: Pick<HeldInvoicePreparationContract, "expectedLiveMode" | "collectionVersion" | "metadata">) {
  const { payment } = validateAuthorization(a);
  assertInvoice(invoice,a,[payment.amountCents],true,false,contract.expectedLiveMode);
  // Current Stripe invoice types do not expose fee/transfer fields on retrieve;
  // the caller verifies those on the invoice's actual default PaymentIntent.
  requireThat(invoice.metadata?.installment_collection_version === contract.collectionVersion &&
    invoice.metadata.installment_plan_id === a.planId && invoice.metadata.installment_number === String(a.paymentNumber) &&
    invoice.metadata.booking_payment_id === a.bookingPaymentId &&
    Object.entries(contract.metadata).every(([k,v]) => invoice.metadata?.[k] === v), "paid invoice fee/identity changed");
  return payment;
}

/** Read-only validation after an admitted attempt, including a decline/SCA.
 * Does not relax the preparer's zero-attempt guard or authorize another pay. */
export function assertRecoveryHeldInvoice(invoice:Stripe.Invoice,a:HeldInvoiceAuthorization) {
  return assertRecoveryHeldInvoiceUsingContract(invoice,a,{expectedLiveMode:false,collectionVersion:HELD_INSTALLMENT_VERSION,metadata:{}});
}

/** Read-only owned-context variant; never grants payment or retry permission. */
export function assertRecoveryHeldInvoiceUsingContract(invoice:Stripe.Invoice,a:HeldInvoiceAuthorization,
  contract:Pick<HeldInvoicePreparationContract,"expectedLiveMode"|"collectionVersion"|"metadata">) {
  const {payment}=validateAuthorization(a);
  assertInvoice(invoice,a,[payment.amountCents],false,true,contract.expectedLiveMode);
  requireThat(Number.isSafeInteger(invoice.attempt_count)&&invoice.attempt_count>=0&&
    invoice.metadata?.installment_collection_version===contract.collectionVersion&&invoice.metadata.installment_plan_id===a.planId&&
    invoice.metadata.installment_number===String(a.paymentNumber)&&invoice.metadata.booking_payment_id===a.bookingPaymentId&&
    Object.entries(contract.metadata).every(([k,v])=>invoice.metadata?.[k]===v),
  "recovery invoice identity changed");
  return payment;
}

/**
 * Configure and verify an exact-cent renewal WITHOUT paying it or re-enabling
 * automatic collection. The returned IDs are not permission to charge: agreement
 * state must be checked again by the eventual collection/claim transaction.
 *
 * Delays leave drafts held. Retries after finalization verify the actual default
 * invoice PaymentIntent, not a guessed percentage or metadata assertion. Never
 * edit the default invoice PaymentIntent directly (Stripe does not permit it).
 * No ledger, access, purchase, customer, subscription or payment-state writes.
 */
export type HeldInvoicePreparationContract = Readonly<{
  expectedLiveMode: boolean;
  collectionVersion: string;
  idempotencyPrefix: string;
  metadata: Readonly<Record<string, string>>;
  assertSubscription: (subscription: Stripe.Subscription, authorization: HeldInvoiceAuthorization) => void;
}>;

/** Complete existing requests, shared with the context transport's exact-body
 * check. Neither these parameters nor their existence grants permission to send. */
export function heldInvoicePreparationRequests(a: HeldInvoiceAuthorization, c: HeldInvoicePreparationContract) {
  const { plan, payment } = validateAuthorization(a);
  return {
    adjustment: { lines: [{ amount: payment.amountCents - plan.regularAmountCents,
      description: "Final installment balance adjustment", discountable: false,
      period: { start: a.periodStart, end: a.periodEnd }, metadata: {
        installment_adjustment: "final-cent-v1", installment_plan_id: a.planId, booking_payment_id: a.bookingPaymentId,
      } }] } satisfies Stripe.InvoiceAddLinesParams,
    configure: { auto_advance: false, application_fee_amount: payment.fees.totalCreatorDeductionCents,
      transfer_data: { destination: a.destinationId }, payment_settings: { payment_method_types: ["card"] },
      metadata: { ...c.metadata, installment_collection_version: c.collectionVersion, installment_plan_id: a.planId,
        booking_payment_id: a.bookingPaymentId, installment_number: String(a.paymentNumber), ...creatorFeeMetadata(payment.fees) },
    } satisfies Stripe.InvoiceUpdateParams,
    finalize: { auto_advance: false } satisfies Stripe.InvoiceFinalizeInvoiceParams,
  };
}

/** Shared request/amount algorithm, not a collection authority. A context
 * caller must supply its owned contract and private, write-admitted transport.
 * The original public Sandbox entry below keeps its hard restrictions. */
export async function prepareHeldInvoiceUsingContract(
  stripe: InvoiceStripe,
  authorization: HeldInvoiceAuthorization,
  contract: HeldInvoicePreparationContract,
): Promise<Readonly<{
  invoiceId: string;
  paymentIntentId: string;
  amountCents: number;
  applicationFeeCents: number;
  destinationId: string;
  status: "verified_unpaid";
}>> {
  // Snapshot nested input before awaiting; don't let a caller mutate the agreed
  // amount, identity, period or schedule in the middle of the API sequence.
  const a = Object.freeze({ ...authorization, feeSchedule: Object.freeze({ ...authorization.feeSchedule }) });
  const c = Object.freeze({ ...contract, metadata: Object.freeze({ ...contract.metadata }) });
  const { plan, payment } = validateAuthorization(a);
  const subscription = await stripe.subscriptions.retrieve(a.subscriptionId);
  c.assertSubscription(subscription, a);
  let invoice = await stripe.invoices.retrieve(a.invoiceId);
  const permittedAmounts = a.paymentNumber === a.paymentCount
    ? [plan.regularAmountCents, payment.amountCents] : [payment.amountCents];
  assertInvoice(invoice, a, permittedAmounts, false, false, c.expectedLiveMode);
  const key = c.idempotencyPrefix;
  const requests = heldInvoicePreparationRequests(a, c);

  if (invoice.status === "draft") {
    if (invoice.amount_due !== payment.amountCents) {
      // Stripe rejects amount edits on subscription-typed lines. Add ONLY the
      // immutable residual to this invoice, never edit the recurring price or
      // create an unassigned invoice item that could bill in a different period.
      // assertInvoice recognizes an existing adjustment on retries, and this
      // stable idempotency key protects concurrent attempts in Stripe's window.
      await stripe.invoices.addLines(a.invoiceId, requests.adjustment, { idempotencyKey: `${key}:final-cent` });
    }
    await stripe.invoices.update(a.invoiceId, requests.configure, { idempotencyKey: `${key}:configure` });
    invoice = await stripe.invoices.retrieve(a.invoiceId);
    assertInvoice(invoice, a, [payment.amountCents], false, false, c.expectedLiveMode);
    requireThat(invoice.status === "draft", "invoice finalized outside this collector");
    // Recheck the durable hold immediately before finalization. A thrown error
    // is not swallowed and never falls back to automatic collection or a percent.
    c.assertSubscription(await stripe.subscriptions.retrieve(a.subscriptionId), a);
    invoice = await stripe.invoices.finalizeInvoice(a.invoiceId, requests.finalize, {
      idempotencyKey: `${key}:finalize`,
    });
  }

  assertInvoice(invoice, a, [payment.amountCents], false, false, c.expectedLiveMode);
  requireThat(invoice.status === "open", "finalization did not return an unpaid open invoice");
  const payments = await stripe.invoicePayments.list({ invoice: a.invoiceId, limit: 100 });
  requireThat(payments.has_more === false && payments.data.length === 1, "ambiguous invoice payment linkage");
  const linked = payments.data[0];
  const paymentIntentId = id(linked.payment?.payment_intent);
  requireThat(linked.livemode === c.expectedLiveMode && linked.is_default === true &&
    id(linked.invoice) === a.invoiceId && linked.currency === a.currency &&
    linked.amount_requested === payment.amountCents && linked.amount_paid == null &&
    linked.status === "open" && linked.payment.type === "payment_intent" && paymentIntentId,
  "unexpected invoice payment");
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  requireThat(intent.id === paymentIntentId && intent.livemode === c.expectedLiveMode &&
    id(intent.customer) === a.customerId && intent.currency === a.currency &&
    intent.amount === payment.amountCents && intent.amount_received === 0 &&
    intent.latest_charge == null &&
    ["requires_payment_method", "requires_confirmation"].includes(intent.status),
  "unexpected or already attempted PaymentIntent");
  requireThat(intent.application_fee_amount === payment.fees.totalCreatorDeductionCents &&
    id(intent.transfer_data?.destination) === a.destinationId && intent.transfer_data?.amount == null,
  "actual Stripe fee/destination differs from the agreement");
  requireThat(intent.payment_method_types.length === 1 && intent.payment_method_types[0] === "card",
    "unexpected payment method for the agreed card-processing schedule");
  c.assertSubscription(await stripe.subscriptions.retrieve(a.subscriptionId), a);
  // No client secret, hosted invoice URL, card data or raw Stripe object escapes.
  return Object.freeze({
    invoiceId: a.invoiceId, paymentIntentId, amountCents: payment.amountCents,
    applicationFeeCents: payment.fees.totalCreatorDeductionCents,
    destinationId: a.destinationId, status: "verified_unpaid",
  });
}

/** Existing Sandbox-only entry: no caller-selectable live mode or new context. */
export function prepareHeldInstallmentInvoice(stripe: InvoiceStripe, authorization: HeldInvoiceAuthorization) {
  return prepareHeldInvoiceUsingContract(stripe, authorization, {
    expectedLiveMode: false, collectionVersion: HELD_INSTALLMENT_VERSION,
    idempotencyPrefix: `${HELD_INSTALLMENT_VERSION}:${authorization.planId}:${authorization.invoiceId}`,
    metadata: {}, assertSubscription,
  });
}
