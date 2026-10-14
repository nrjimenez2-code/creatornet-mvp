import { membershipTestEnv } from "../test-support/membership-fixtures";
import { membershipManualBuyerReady, membershipManualBuyerRecoveryReady } from "@/lib/membershipManualBuyer";

const extra = ["CREATOR_MONTHLY_MANUAL_BUYER_READY", "CREATOR_MONTHLY_MANUAL_PAYOFF_READY",
  "CREATOR_MONTHLY_MANUAL_PAYOFF_RECEIPT_SCHEMA_READY", "CREATOR_MONTHLY_MANUAL_PAYOFF_RECEIPT_READY",
  "CREATOR_MONTHLY_MANUAL_PAYOFF_TERMINAL_SCHEMA_READY", "CREATOR_MONTHLY_MANUAL_PAYOFF_TERMINAL_READY",
  "CREATOR_MONTHLY_MANUAL_RENEWAL_READY", "CREATOR_MONTHLY_MANUAL_PREPARATION_READY",
  "CREATOR_MONTHLY_MANUAL_INTENT_READY", "CREATOR_MONTHLY_MANUAL_RECEIPT_SCHEMA_READY",
  "CREATOR_MONTHLY_MANUAL_RECEIPT_READY", "CREATOR_MONTHLY_MANUAL_TERMINAL_SCHEMA_READY",
  "CREATOR_MONTHLY_MANUAL_TERMINAL_READY", "CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY",
  "CREATOR_SERVER_PAYMENT_INTENT_READY", "CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY",
  "CREATOR_SERVER_PAYMENT_CONFIRMATION_READY", "CREATOR_SERVER_PAYMENT_CANCELLATION_SCHEMA_READY",
  "CREATOR_SERVER_PAYMENT_CANCELLATION_READY", "CREATOR_SERVER_PAYMENT_CARD_METHOD_SCHEMA_READY",
  "CREATOR_SERVER_PAYMENT_CARD_METHOD_READY", "CREATOR_SERVER_PAYMENT_REPLACEMENT_SCHEMA_READY",
  "CREATOR_SERVER_PAYMENT_REPLACEMENT_READY", "CREATOR_SERVER_PAYMENT_AUTHENTICATION_SCHEMA_READY",
  "CREATOR_SERVER_PAYMENT_AUTHENTICATION_READY"];
const enabled = () => Object.fromEntries(extra.map(key => [key, "true"]));

test("new monthly manual admission requires the full original-payment path", () => {
  const env = { ...membershipTestEnv, ...enabled() };
  expect(membershipManualBuyerReady(env)).toBe(true);
  expect(membershipManualBuyerReady({ ...env, CREATOR_MONTHLY_MANUAL_PAYOFF_READY: "false" })).toBe(false);
  expect(membershipManualBuyerReady({ ...env, CREATOR_MONTHLY_MANUAL_PAYOFF_RECEIPT_READY: "false" })).toBe(false);
  expect(membershipManualBuyerReady({ ...env, CREATOR_MONTHLY_MANUAL_PAYOFF_TERMINAL_READY: "false" })).toBe(false);
  expect(membershipManualBuyerReady({ ...env, CREATOR_MONTHLY_MANUAL_RENEWAL_READY: "false" })).toBe(false);
  expect(membershipManualBuyerReady({ ...env, CREATOR_MONTHLY_MANUAL_TERMINAL_READY: "false" })).toBe(false);
  expect(membershipManualBuyerReady({ ...env, CREATOR_SERVER_PAYMENT_CARD_METHOD_READY: "false" })).toBe(false);
});

test("pausing new buyer admission retains readback when installed recovery schemas remain", () => {
  const env = { ...membershipTestEnv, ...enabled(), CREATOR_MONTHLY_MANUAL_BUYER_READY: "false" };
  expect(membershipManualBuyerReady(env)).toBe(false);
  expect(membershipManualBuyerRecoveryReady(env)).toBe(true);
  expect(membershipManualBuyerRecoveryReady({ ...env, CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY: "false" })).toBe(false);
});
