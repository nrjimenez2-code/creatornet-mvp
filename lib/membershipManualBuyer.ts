import "server-only";
import { membershipCheckoutReady } from "./membershipServer";
import { membershipInitialAbandonmentReady } from "./membershipInitialAbandonment";
import { membershipCheckoutRecoveryReady } from "./membershipCheckoutRecovery";

/** Keep owner readback available when new manual payment admission is paused. */
export function membershipManualBuyerRecoveryReady(env: Record<string, string | undefined> = process.env) {
  return membershipCheckoutRecoveryReady(env) &&
    ["CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY", "CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY",
      "CREATOR_MONTHLY_MANUAL_RECEIPT_SCHEMA_READY", "CREATOR_MONTHLY_MANUAL_TERMINAL_SCHEMA_READY"].every(
      key => env[key] === "true");
}

export function membershipManualPayoffRecoveryReady(env: Record<string, string | undefined> = process.env) {
  return membershipManualBuyerRecoveryReady(env) &&
    ["CREATOR_MONTHLY_MANUAL_PAYOFF_RECEIPT_SCHEMA_READY",
      "CREATOR_MONTHLY_MANUAL_PAYOFF_TERMINAL_SCHEMA_READY"].every(key => env[key] === "true");
}

/** The buyer path stays closed until its complete original-payment lifecycle is enabled. */
export function membershipManualBuyerReady(env: Record<string, string | undefined> = process.env) {
  return membershipCheckoutReady(env) && membershipInitialAbandonmentReady(env) &&
    membershipManualBuyerRecoveryReady(env) &&
    ["CREATOR_MONTHLY_MANUAL_BUYER_READY", "CREATOR_MONTHLY_MANUAL_PAYOFF_READY",
      "CREATOR_MONTHLY_MANUAL_PAYOFF_RECEIPT_SCHEMA_READY",
      "CREATOR_MONTHLY_MANUAL_PAYOFF_RECEIPT_READY",
      "CREATOR_MONTHLY_MANUAL_PAYOFF_TERMINAL_SCHEMA_READY",
      "CREATOR_MONTHLY_MANUAL_PAYOFF_TERMINAL_READY",
      "CREATOR_MONTHLY_MANUAL_RENEWAL_READY", "CREATOR_MONTHLY_MANUAL_PREPARATION_READY",
      "CREATOR_MONTHLY_MANUAL_INTENT_READY", "CREATOR_MONTHLY_MANUAL_RECEIPT_SCHEMA_READY",
      "CREATOR_MONTHLY_MANUAL_RECEIPT_READY", "CREATOR_MONTHLY_MANUAL_TERMINAL_SCHEMA_READY",
      "CREATOR_MONTHLY_MANUAL_TERMINAL_READY", "CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY",
      "CREATOR_SERVER_PAYMENT_INTENT_READY", "CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY",
      "CREATOR_SERVER_PAYMENT_CONFIRMATION_READY", "CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY",
      "CREATOR_SERVER_PAYMENT_CANCELLATION_READY", "CREATOR_SERVER_PAYMENT_CARD_METHOD_SCHEMA_READY",
      "CREATOR_SERVER_PAYMENT_CARD_METHOD_READY", "CREATOR_SERVER_PAYMENT_REPLACEMENT_SCHEMA_READY",
      "CREATOR_SERVER_PAYMENT_REPLACEMENT_READY", "CREATOR_SERVER_PAYMENT_AUTHENTICATION_SCHEMA_READY",
      "CREATOR_SERVER_PAYMENT_AUTHENTICATION_READY"].every(key => env[key] === "true");
}
