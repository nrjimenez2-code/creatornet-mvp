process.env.STRIPE_SECRET_KEY = "sk_test_tip_fixture";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";

const sessionRetrieve = jest.fn();
const intentRetrieve = jest.fn();
const chargeRetrieve = jest.fn();
const feeRetrieve = jest.fn();
const refundReconcile = jest.fn();
const disputeReconcile = jest.fn();
const tipDisputeReconcile = jest.fn();

jest.mock("@/lib/stripeClient", () => ({
  getStripe: () => ({
    checkout: { sessions: { retrieve: sessionRetrieve } },
    paymentIntents: { retrieve: intentRetrieve },
    charges: { retrieve: chargeRetrieve },
  }),
}));
jest.mock("@/lib/paymentFeeLedger", () => ({ retrieveStripeFeeDetails: (...args: unknown[]) => feeRetrieve(...args) }));
jest.mock("@/lib/paymentRefunds", () => ({ reconcileKnownPaymentRefund: (...args: unknown[]) => refundReconcile(...args) }));
jest.mock("@/lib/paymentDisputes", () => ({ reconcileKnownPaymentDispute: (...args: unknown[]) => disputeReconcile(...args) }));
jest.mock("@/lib/tipDisputes", () => ({ reconcileKnownTipDisputeRecovery: (...args: unknown[]) => tipDisputeReconcile(...args) }));

import { finalizeTipPayment, updateTipFromCheckoutEvent } from "@/lib/tipEvents";
import { tipMetadata, type TipRow } from "@/lib/tips";

const tip: TipRow = {
  id: "44444444-4444-4444-8444-444444444444",
  tipper_id: "11111111-1111-4111-8111-111111111111",
  creator_id: "22222222-2222-4222-8222-222222222222",
  post_id: "33333333-3333-4333-8333-333333333333",
  client_request_key: "55555555-5555-4555-8555-555555555555",
  terms_fingerprint: "frozen-fingerprint",
  gross_amount_cents: 1000,
  platform_fee_cents: 120,
  processing_fee_cents: 0,
  total_creator_deduction_cents: 120,
  creator_net_cents: 880,
  processing_fee_enabled: false,
  processing_fee_basis_points: 0,
  processing_fee_fixed_cents: 0,
  fee_schedule_version: "platform-only-v1",
  currency: "usd",
  status: "open",
  stripe_checkout_session_id: "cs_test_tip",
  stripe_payment_intent_id: null,
  stripe_charge_id: null,
  stripe_destination_account_id: "acct_destination",
  refunded_amount_cents: 0,
};

let db: MockClient;
let session: Record<string, unknown>;
let paymentIntent: Record<string, unknown>;
let charge: Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  const metadata = tipMetadata(tip);
  session = {
    id: "cs_test_tip", status: "complete", livemode: false,
    client_reference_id: tip.id, mode: "payment", payment_status: "paid",
    amount_total: 1000, currency: "usd", payment_intent: "pi_tip", metadata,
  };
  paymentIntent = {
    id: "pi_tip", livemode: false, status: "succeeded", amount: 1000,
    currency: "usd", application_fee_amount: 120,
    transfer_data: { destination: "acct_destination" }, latest_charge: "ch_tip", metadata,
  };
  charge = {
    id: "ch_tip", livemode: false, payment_intent: "pi_tip", amount: 1000,
    currency: "usd", application_fee_amount: 120,
  };
  sessionRetrieve.mockImplementation(async () => session);
  intentRetrieve.mockImplementation(async () => paymentIntent);
  chargeRetrieve.mockImplementation(async () => charge);
  feeRetrieve.mockResolvedValue({ chargeId: "ch_tip", balanceTransactionId: "txn_tip", actualStripeFeeCents: 30, applicationFeeAmountCents: 120 });
  db = createMockClient((op: Op) => {
    if (op.table === "tips" && op.kind === "select") return { data: tip, error: null };
    if (op.table === "finalize_video_tip") return { data: true, error: null };
    return { data: null, error: null };
  });
});

const admin = () => db as unknown as SupabaseClient;

test("an unfinished Checkout Session cannot be treated as a completion", async () => {
  session.status = "open";
  session.payment_status = "unpaid";
  await expect(updateTipFromCheckoutEvent(admin(), session as unknown as Stripe.Checkout.Session,
    "checkout.session.completed")).rejects.toThrow(/still open/);
  expect(db.opsFor("tips").filter((op) => op.kind === "update")).toHaveLength(0);
});

test("expiry only cancels attempts that have not begun processing", async () => {
  session.status = "expired";
  session.payment_status = "unpaid";
  await updateTipFromCheckoutEvent(admin(), session as unknown as Stripe.Checkout.Session,
    "checkout.session.expired");
  expect(db.opsFor("tips").find((op) => op.kind === "update")?.inFilters).toEqual([
    { column: "status", values: ["creating", "open"] },
  ]);
});

test("a verified paid tip finalizes with immutable provider identities", async () => {
  await finalizeTipPayment(admin(), tip.id);
  expect(db.opsFor("finalize_video_tip")[0].payload).toMatchObject({
    p_tip_id: tip.id, p_session_id: "cs_test_tip", p_payment_intent_id: "pi_tip",
    p_charge_id: "ch_tip", p_balance_transaction_id: "txn_tip", p_actual_stripe_fee_cents: 30,
  });
  expect(refundReconcile).toHaveBeenCalledTimes(1);
  expect(disputeReconcile).toHaveBeenCalledTimes(1);
  expect(tipDisputeReconcile).toHaveBeenCalledTimes(1);
});

test.each([
  ["amount", () => { paymentIntent.amount = 999; }],
  ["destination", () => { paymentIntent.transfer_data = { destination: "acct_other" }; }],
  ["fee", () => { paymentIntent.application_fee_amount = 119; }],
  ["terms", () => { paymentIntent.metadata = { ...tipMetadata(tip), checkout_terms_fingerprint: "other" }; }],
  ["charge", () => { charge.payment_intent = "pi_other"; }],
])("rejects a %s mismatch before crediting earnings", async (_label, mutate) => {
  mutate();
  await expect(finalizeTipPayment(admin(), tip.id)).rejects.toThrow();
  expect(db.opsFor("finalize_video_tip")).toHaveLength(0);
});
