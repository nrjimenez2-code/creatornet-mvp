import "server-only";
import { createHash } from "node:crypto";
import { productPurchaseTerms, type ConsentProduct } from "./purchaseConsent";
import { calculateInstallmentPlan } from "./installmentPlan";
import { readMentorshipInstallmentOptions } from "./mentorshipInstallmentOptions";
import type { ProcessingFeeSchedule } from "./money";
import { FIXED_PURCHASE_CONSENT_TEXT, FIXED_PURCHASE_CONSENT_VERSION } from "./installments/purchaseConsent";

export const MENTORSHIP_INSTALLMENT_QUOTE_VERSION = "buyer-mentorship-installments-v1";
/** Inputs come from the owned server product read and server fee configuration.
 * A quote is not a reservation, payment authorization or payment receipt. */
export function mentorshipInstallmentQuote(args: {
  product: ConsentProduct & { installment_options?: unknown; active?: boolean | null };
  buyerId: string; postId: string | null; paymentCount: number;
  firstPaymentFees: ProcessingFeeSchedule; renewalFees: ProcessingFeeSchedule;
}) {
  const { product, buyerId, postId, paymentCount } = args;
  if (product.active === false || buyerId === product.creator_id) throw Error("Offer not available");
  const base = productPurchaseTerms(product, buyerId, postId).terms;
  const approved = readMentorshipInstallmentOptions(product.installment_options, product.type || "", product.membership_terms != null, base.amountCents);
  if (!approved.includes(paymentCount)) throw Error("That payment plan is not approved by the creator");
  const plan = calculateInstallmentPlan(base.amountCents, paymentCount, args.renewalFees, args.firstPaymentFees);
  const terms = {
    ...base, kind: "fixed_total_installments" as const, installmentVersion: MENTORSHIP_INSTALLMENT_QUOTE_VERSION,
    paymentCount,
    fixedPurchaseConsentVersion: FIXED_PURCHASE_CONSENT_VERSION,
    fixedPurchaseConsentText: FIXED_PURCHASE_CONSENT_TEXT,
    billing: "One fixed purchase total. The first payment is due at checkout; remaining payments are monthly. " +
      "The final payment includes any remaining cents. Payments stop after the agreed total is paid. " +
      "The payment schedule does not change the promised service duration or create an ongoing membership.",
    payments: plan.payments.map(payment => ({ number: payment.number, amountCents: payment.amountCents })),
    firstPaymentFeeSchedule: { ...args.firstPaymentFees }, renewalFeeSchedule: { ...args.renewalFees },
  };
  return { terms, fingerprint: createHash("sha256").update(JSON.stringify(terms)).digest("hex") };
}
