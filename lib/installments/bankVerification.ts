import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { assertAgreementId, operationHash } from "./agreementStore";
import { assertExactInstallmentEnvironment } from "./checkoutPreparation";
import { assertRecoveryHeldInvoiceUsingContract, HELD_INSTALLMENT_VERSION, type HeldInvoicePreparationContract } from "./heldInvoice";
import { parseRenewalAuthorization, type RenewalAuthorization } from "./invoiceStore";
import { reconcileExactRenewalReceiptSandbox, verifyExactRetryHistorySandbox } from "./renewal";
import { reconcileExactRetryReceiptSandbox } from "./paymentRetry";
import type { ExactPaymentRetryStore } from "./paymentRetryStore";

export type BankContext = Readonly<{ authorization: RenewalAuthorization; paymentIntentId: string;
  buyerId: string; paymentMethodId: string; admittedAt: number; retryId: string | null }>;
export interface ExactBankVerificationStore {
  read(agreementId: string, invoiceId: string, buyerId: string, forAction: boolean): Promise<BankContext>;
}
function check(v: unknown): asserts v { if (!v) throw new Error("Bank verification needs review"); }
const id = (v: string | { id: string } | null | undefined) => typeof v === "string" ? v : v?.id;
export function createExactBankVerificationStore(admin: SupabaseClient): ExactBankVerificationStore {
  return { async read(agreementId, invoiceId, buyerId, forAction) {
    assertAgreementId(agreementId); assertAgreementId(buyerId); check(/^in_[a-zA-Z0-9]+$/.test(invoiceId));
    const { data: r, error } = await admin.rpc("read_exact_installment_bank_context", {
      p_agreement_id: agreementId, p_invoice_id: invoiceId, p_buyer_id: buyerId, p_for_action: forAction,
    });
    check(!error && r && typeof r === "object" && !Array.isArray(r) && r.status === "reconcile");
    const a = parseRenewalAuthorization(r.authorization);
    check(a.planId === agreementId && a.invoiceId === invoiceId && r.buyerId === buyerId &&
      typeof r.paymentIntentId === "string" && /^pi_[a-zA-Z0-9]+$/.test(r.paymentIntentId) &&
      typeof r.paymentMethodId === "string" && /^pm_[a-zA-Z0-9]+$/.test(r.paymentMethodId) &&
      Number.isSafeInteger(r.admittedAt) && r.admittedAt >= a.periodStart && r.admittedAt < a.periodEnd);
    if (r.retryId !== null) { check(typeof r.retryId === "string"); assertAgreementId(r.retryId); }
    else check(r.paymentMethodId === a.paymentMethodId);
    return Object.freeze({ authorization: a, paymentIntentId: r.paymentIntentId, buyerId, paymentMethodId: r.paymentMethodId,
      admittedAt: r.admittedAt, retryId: r.retryId });
  } };
}
type Input = Parameters<typeof reconcileExactRenewalReceiptSandbox>[0] & {
  buyerId: string; bankStore: ExactBankVerificationStore; retryStore: ExactPaymentRetryStore;
};
async function bound(args: Input, forAction: boolean) {
  assertExactInstallmentEnvironment(args.env, args.env.NEXT_PUBLIC_SITE_URL || "");
  check([args.env.CREATOR_EXACT_INSTALLMENTS_BANK_VERIFICATION_READY, args.env.CREATOR_EXACT_INSTALLMENTS_RETRY_READY,
    args.env.CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY, args.env.CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY].every(v => v === "true"));
  assertAgreementId(args.agreementId); assertAgreementId(args.buyerId);
  const agreement = await args.store.load(args.agreementId);
  check(agreement.terms.buyerId === args.buyerId); assertExactInstallmentEnvironment(args.env, agreement.terms.previewOrigin);
  const c = await args.bankStore.read(args.agreementId, args.invoiceId, args.buyerId, forAction), a = c.authorization;
  check(c.buyerId === args.buyerId && a.planId === agreement.id && a.invoiceId === args.invoiceId &&
    a.customerId === agreement.customerId && a.subscriptionId === agreement.subscriptionId &&
    a.bookingPaymentId === agreement.terms.bookingPaymentId && a.destinationId === agreement.terms.destinationId &&
    a.totalCents === agreement.terms.totalCents && a.paymentCount === agreement.terms.paymentCount &&
    operationHash(a.feeSchedule) === operationHash(agreement.terms.renewalFeeSchedule) &&
    c.admittedAt <= (args.now ?? (() => Math.floor(Date.now() / 1000)))());
  const retry = await args.retryStore.find(agreement.id, a.invoiceId);
  if (c.retryId === null) check(!retry && c.paymentMethodId === a.paymentMethodId);
  else check(retry && retry.id === c.retryId && retry.buyerId === c.buyerId && retry.agreementId === agreement.id &&
    retry.originalPaymentIntentId === c.paymentIntentId && retry.admittedAt === c.admittedAt &&
    retry.replacementPaymentMethodId === c.paymentMethodId && operationHash(retry.authorization) === operationHash(a));
  return c;
}

/** Owner-scoped POST only. One ephemeral capability for the ORIGINAL admitted
 * PaymentIntent. No pay, confirm, card/default mutation, URL, logging or storage.
 * A stop after this response is a distributed-race boundary: do not enable this
 * candidate until the hosted bank-challenge/stop acceptance test is reviewed. */
export async function readExactBankChallengeSandbox(args: Input) {
  try {
    const c = await bound(args, true), a = c.authorization;
    const publicKey = args.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    check(typeof publicKey === "string" && /^pk_test_[a-zA-Z0-9]+$/.test(publicKey));
    await verifyExactRetryHistorySandbox(args, a); // Original defaults + ALL prior refund/dispute checks.
    const challenge = await inspectExactBankChallenge(args.stripe, c,
      { expectedLiveMode: false, collectionVersion: HELD_INSTALLMENT_VERSION, metadata: {} }, publicKey);
    check(operationHash(await bound(args, true)) === operationHash(c)); // Recheck after external reads.
    return challenge;
  } catch { throw new Error("Bank verification unavailable. Check payment status before continuing."); }
}

type BankReader = {
  paymentMethods: { retrieve(id: string): Promise<Stripe.PaymentMethod> };
  invoices: { retrieve(id: string): Promise<Stripe.Invoice> };
  invoicePayments: { list(p: Stripe.InvoicePaymentListParams): Promise<Stripe.ApiList<Stripe.InvoicePayment>> };
  paymentIntents: { retrieve(id: string): Promise<Stripe.PaymentIntent> };
  charges: { retrieve(id: string): Promise<Stripe.Charge> };
};
/** Shared read-only inspector. The owner/context/hold/admission and prior history
 * checks are caller obligations, including a fresh SQL recheck before release. */
export async function inspectExactBankChallenge(stripe: BankReader, c: BankContext,
  contract: Pick<HeldInvoicePreparationContract, "expectedLiveMode" | "collectionVersion" | "metadata">, publicKey: string) {
  try {
    const a = c.authorization, live = contract.expectedLiveMode;
    check(new RegExp(`^pk_${live ? "live" : "test"}_[a-zA-Z0-9]+$`).test(publicKey));
    const pm = await stripe.paymentMethods.retrieve(c.paymentMethodId);
    check(pm.id === c.paymentMethodId && pm.livemode === live && pm.type === "card" && id(pm.customer) === a.customerId);
    const invoice = await stripe.invoices.retrieve(a.invoiceId);
    const payment = assertRecoveryHeldInvoiceUsingContract(invoice, a, contract); check(invoice.status === "open");
    const links = await stripe.invoicePayments.list({ invoice: a.invoiceId, limit: 100 });
    check(!links.has_more && links.data.length === 1); const link = links.data[0];
    check(link.livemode === live && link.is_default === true && id(link.invoice) === a.invoiceId && link.currency === "usd" &&
      link.status === "open" && link.amount_requested === payment.amountCents && (link.amount_paid === null || link.amount_paid === 0) &&
      link.payment.type === "payment_intent" && id(link.payment.payment_intent) === c.paymentIntentId);
    const pi = await stripe.paymentIntents.retrieve(c.paymentIntentId);
    check(pi.id === c.paymentIntentId && pi.livemode === live && id(pi.customer) === a.customerId && pi.currency === "usd" &&
      pi.amount === payment.amountCents && pi.amount_received === 0 && pi.amount_capturable === 0 &&
      pi.status === "requires_action" && pi.next_action?.type === "use_stripe_sdk" && pi.confirmation_method === "automatic" &&
      pi.capture_method === "automatic" && pi.on_behalf_of == null && pi.canceled_at == null &&
      pi.application_fee_amount === payment.fees.totalCreatorDeductionCents && id(pi.transfer_data?.destination) === a.destinationId &&
      pi.transfer_data?.amount == null && id(pi.payment_method) === c.paymentMethodId &&
      pi.payment_method_types.length === 1 && pi.payment_method_types[0] === "card" && typeof pi.client_secret === "string" &&
      pi.client_secret.startsWith(`${pi.id}_secret_`) && /^pi_[a-zA-Z0-9]+_secret_[a-zA-Z0-9]+$/.test(pi.client_secret));
    // An earlier failed charge is possible. It must never conceal captured money.
    const chargeId = id(pi.latest_charge);
    if (chargeId) {
      const charge = await stripe.charges.retrieve(chargeId);
      check(charge.id === chargeId && charge.livemode === live && id(charge.payment_intent) === pi.id &&
        id(charge.customer) === a.customerId && charge.currency === "usd" && charge.amount === payment.amountCents &&
        charge.paid === false && charge.captured === false && charge.status === "failed" && charge.amount_captured === 0 &&
        charge.amount_refunded === 0 && charge.balance_transaction == null);
    }
    return { status: "bank_verification_ready" as const, amountCents: payment.amountCents, paymentNumber: a.paymentNumber,
      publishableKey: publicKey, clientSecret: pi.client_secret };
  } catch { throw new Error("Bank verification unavailable. Check payment status before continuing."); }
}

/** No Stripe mutation. SDK success alone cannot grant access or credit money. */
export async function checkExactBankPaymentSandbox(args: Input) {
  try {
    const c = await bound(args, false);
    const result = c.retryId ? await reconcileExactRetryReceiptSandbox(args) :
      await reconcileExactRenewalReceiptSandbox({ ...args, minimumChargeCreatedAt: c.admittedAt }, c.authorization, c.paymentIntentId);
    return { status: "bank_payment_checked" as const,
      outcome: result.status === "credited" || result.status === "already_credited" ? "paid_accounted" as const : "review_required" as const };
  } catch { throw new Error("Payment receipt is not verified. Do not submit another payment."); }
}
