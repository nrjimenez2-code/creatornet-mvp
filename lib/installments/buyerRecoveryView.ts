/** Client-safe contracts only. Never import service-role or Stripe clients here. */
export const CARD_SETUP_CONSENT_VERSION="replacement-card-setup-v1";
export const CARD_SETUP_CONSENT_TEXT="Save a replacement card for this installment plan. Saving does not make a payment, replace the currently authorized card, or restart automatic collection. You must separately confirm a payment before CreatorNet attempts it.";
export const RETRY_CONSENT_VERSION="single-invoice-retry-v1";
export const PAY_NOW_CONSENT_VERSION="single-invoice-pay-now-v1";
export const FUTURE_CARD_CONSENT_VERSION="same-plan-remaining-card-v1";
export const FUTURE_CARD_CONSENT_TEXT="Optional: Use this replacement card for the remaining scheduled installments on this plan only, after this payment is verified and the account checks pass. The original amounts, dates, and fixed end stay unchanged. This does not collect the remaining balance now or authorize payments for other purchases.";
export type RemainingCardPayment=Readonly<{paymentNumber:number;amountCents:number;dueAt:number;periodEnd:number}>;
export type PaymentConsentVersion=typeof RETRY_CONSENT_VERSION|typeof PAY_NOW_CONSENT_VERSION;
export type BuyerRecoveryView=Readonly<{agreementId:string;title:string;totalCents:number;paymentCount:number;
  paymentNumber:number|null;amountCents:number|null;outcome:string|null;observedAt:string|null;
  setupRequestId:string|null;setupState:"not_started"|"reserved"|"started"|"verified";setupEligible:boolean;
  confirmedQuoteId:string|null;canSaveCard:boolean;canConfirmPayment:boolean;canAttemptPayment?:boolean;
  canVerifyBank?:boolean;canCheckBankPayment?:boolean;futureCardAccepted?:boolean}>;
export type BuyerPaymentQuote=Readonly<{id:string;amountCents:number;paymentNumber:number;paymentCount:number;expiresAt:number;confirmed:boolean;
  consentVersion?:PaymentConsentVersion;remainingPayments?:ReadonlyArray<RemainingCardPayment>;futureCardAccepted?:boolean}>;
export function retryConsentText(amount:string,hasFutureOption=false) {
  return `I authorize one payment attempt of ${amount} for this installment using my saved replacement card. This does not change the plan total or authorize duplicate charges. ${hasFutureOption ? "This checkbox covers this payment only. Future card use is a separate choice below." : "Future collection remains paused until separately reviewed."}`;
}
