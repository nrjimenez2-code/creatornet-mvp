export const MONTHLY_RETRY_CONSENT_VERSION = "monthly-retry-consent-v1";
export const MONTHLY_RETRY_CONSENT_TEXT = "I authorize one payment retry for the exact monthly amount and original service period shown, using my verified saved card. This does not change my price, minimum, service dates, or any remaining balance.";
export const MONTHLY_FUTURE_CARD_CONSENT_VERSION = "monthly-future-card-consent-v1";
export const MONTHLY_FUTURE_CARD_CONSENT_TEXT = "If this retry succeeds using the saved card, use that card for future charges already authorized by this mentorship agreement. The agreed price, minimum and renewal schedule do not change.";
export type MonthlyRetryQuote = { version: "monthly-retry-quote-v1"; id: string; membershipId: string; setupId: string; title: string;
  amountCents: number; currency: "usd"; month: number; periodStart: number; periodEnd: number; expiresAt: number;
  minimumMonths: number; autoRenew: boolean; canUseForFuture: boolean; consentVersion: typeof MONTHLY_RETRY_CONSENT_VERSION;
  consentText: typeof MONTHLY_RETRY_CONSENT_TEXT; futureConsentVersion: typeof MONTHLY_FUTURE_CARD_CONSENT_VERSION;
  futureConsentText: typeof MONTHLY_FUTURE_CARD_CONSENT_TEXT };
