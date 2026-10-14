import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createMockClient, type Op } from "./__mocks__/supabaseQueryMock";

jest.mock("@/lib/paymentDisputes", () => ({ getPaymentDisputeState: jest.fn() }));

import { reconcileTipDisputeRecovery } from "@/lib/tipDisputes";

const tipId = "44444444-4444-4444-8444-444444444444";
const createReversal = jest.fn();
const createTransfer = jest.fn();
let providerReversals: Array<Record<string, unknown>>;
let providerRestorations: Array<Record<string, unknown>>;
let failReversalSave: boolean;
let failRestorationSave: boolean;
let recovery: Record<string, unknown> | null;
let dispute: Record<string, unknown>;
let admin: SupabaseClient;
let stripe: Stripe;

beforeEach(() => {
  jest.clearAllMocks();
  recovery = null;
  dispute = { id: "dp_tip", amount: 500, currency: "usd", livemode: false, status: "under_review" };
  providerReversals = [];
  providerRestorations = [];
  failReversalSave = false;
  failRestorationSave = false;
  createReversal.mockImplementation(async (_transferId: string, params: Record<string, unknown>) => {
    providerReversals.push({ id: "trr_tip", amount: params.amount, transfer: "tr_original", metadata: params.metadata });
    return { id: "trr_tip" };
  });
  createTransfer.mockImplementation(async (params: Record<string, unknown>) => {
    providerRestorations.push({
      id: "tr_restore", amount: params.amount, currency: params.currency,
      destination: params.destination, livemode: false,
      transfer_group: params.transfer_group, metadata: params.metadata,
    });
    return { id: "tr_restore" };
  });
  const db = createMockClient((op: Op) => {
    if (op.table === "payment_fee_ledger" && op.kind === "select") return { data: { tip_id: tipId }, error: null };
    if (op.table === "tips" && op.kind === "select") return { data: {
      id: tipId, creator_id: "creator", stripe_destination_account_id: "acct_creator", currency: "usd",
    }, error: null };
    if (op.table === "tip_dispute_recoveries" && op.kind === "select") return { data: recovery, error: null };
    if (op.table === "record_tip_dispute_recovery") {
      const args = op.payload as Record<string, unknown>;
      if (recovery && Number(recovery.stripe_event_created) > Number(args.p_event_created)) return { data: false, error: null };
      recovery = {
        tip_id: tipId,
        stripe_payment_intent_id: "pi_tip",
        stripe_charge_id: "ch_tip",
        stripe_transfer_id: "tr_original",
        stripe_event_created: args.p_event_created,
        reversal_amount_cents: recovery?.reversal_amount_cents ?? args.p_reversal_amount_cents,
        reversal_status: recovery?.reversal_status ?? "pending",
        reversal_id: recovery?.reversal_id ?? null,
        restoration_transfer_id: recovery?.restoration_transfer_id ?? null,
        restoration_status: recovery?.restoration_status ?? null,
      };
      return { data: true, error: null };
    }
    if (op.table === "record_tip_dispute_recovery_progress") {
      const args = op.payload as Record<string, unknown>;
      if (!recovery) throw new Error("Missing recovery fixture");
      if (args.p_kind === "reversal" && args.p_status === "succeeded" && failReversalSave) {
        failReversalSave = false;
        return { data: false, error: null };
      }
      if (args.p_kind === "restoration" && args.p_status === "succeeded" && failRestorationSave) {
        failRestorationSave = false;
        return { data: false, error: null };
      }
      if (args.p_kind === "reversal") {
        recovery.reversal_status = args.p_status;
        if (args.p_status === "succeeded") recovery.reversal_id = args.p_provider_id;
      } else {
        recovery.restoration_status = args.p_status;
        if (args.p_status === "succeeded") recovery.restoration_transfer_id = args.p_provider_id;
      }
      return { data: true, error: null };
    }
    return { data: null, error: null };
  });
  admin = db as unknown as SupabaseClient;
  stripe = {
    charges: { retrieve: jest.fn().mockResolvedValue({
      id: "ch_tip", transfer: "tr_original", payment_intent: "pi_tip", currency: "usd", livemode: false,
    }) },
    transfers: {
      retrieve: jest.fn().mockResolvedValue({
        id: "tr_original", destination: "acct_creator", currency: "usd", livemode: false,
        amount: 1000, amount_reversed: 0,
      }),
      createReversal,
      create: createTransfer,
      listReversals: jest.fn().mockImplementation(async () => ({ data: providerReversals, has_more: false })),
      list: jest.fn().mockImplementation(async () => ({ data: providerRestorations, has_more: false })),
    },
    disputes: { retrieve: jest.fn().mockImplementation(async () => ({ ...dispute })) },
  } as unknown as Stripe;
});

async function reconcile(eventCreated = 100) {
  return reconcileTipDisputeRecovery({
    admin, stripe, dispute: dispute as unknown as Stripe.Dispute,
    paymentIntentId: "pi_tip", chargeId: "ch_tip", eventCreated,
  });
}

test("reverses a tip transfer once and restores it once after a won dispute", async () => {
  await reconcile();
  await reconcile();
  expect(createReversal).toHaveBeenCalledTimes(1);
  expect(createReversal).toHaveBeenCalledWith("tr_original", expect.objectContaining({ amount: 500 }),
    { idempotencyKey: "creatornet-tip-dispute-reversal:dp_tip" });
  dispute.status = "won";
  await reconcile(101);
  await reconcile(101);
  expect(createTransfer).toHaveBeenCalledTimes(1);
  expect(createTransfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 500, destination: "acct_creator" }),
    { idempotencyKey: "creatornet-tip-dispute-restore:dp_tip" });
  expect(recovery).toMatchObject({ reversal_status: "succeeded", restoration_status: "succeeded" });
});

test("retains a retryable failure and uses the same reversal identity on retry", async () => {
  createReversal.mockRejectedValueOnce(Object.assign(new Error("Provider unavailable"), { code: "resource_unavailable" }));
  await expect(reconcile()).rejects.toThrow("Provider unavailable");
  expect(recovery).toMatchObject({ reversal_status: "failed", reversal_id: null });
  await reconcile(101);
  expect(createReversal).toHaveBeenCalledTimes(2);
  expect(createReversal.mock.calls[0][2]).toEqual(createReversal.mock.calls[1][2]);
  expect(recovery).toMatchObject({ reversal_status: "succeeded", reversal_id: "trr_tip" });
});

test("a lost dispute keeps the reversal and never creates a restoration transfer", async () => {
  await reconcile();
  dispute.status = "lost";
  await reconcile(101);
  expect(createReversal).toHaveBeenCalledTimes(1);
  expect(createTransfer).not.toHaveBeenCalled();
});

test("a won event during a pending reversal still restores exactly once", async () => {
  let finishReversal: (() => void) | undefined;
  createReversal.mockImplementationOnce((_transferId: string, params: Record<string, unknown>) =>
    new Promise((resolve) => {
      finishReversal = () => {
        providerReversals.push({ id: "trr_tip", amount: params.amount, transfer: "tr_original", metadata: params.metadata });
        resolve({ id: "trr_tip" });
      };
    }));
  const initial = reconcile(100);
  await new Promise((resolve) => setImmediate(resolve));
  expect(finishReversal).toBeDefined();
  dispute.status = "won";
  await reconcile(101);
  expect(createTransfer).not.toHaveBeenCalled();
  finishReversal?.();
  await initial;
  expect(recovery).toMatchObject({ reversal_id: "trr_tip", restoration_transfer_id: "tr_restore" });
  expect(createTransfer).toHaveBeenCalledTimes(1);
});

test("repairs provider writes whose database response was lost without moving funds again", async () => {
  failReversalSave = true;
  await expect(reconcile(100)).rejects.toThrow("reversal progress conflict");
  expect(createReversal).toHaveBeenCalledTimes(1);
  await reconcile(101);
  expect(createReversal).toHaveBeenCalledTimes(1);
  expect(recovery).toMatchObject({ reversal_status: "succeeded", reversal_id: "trr_tip" });

  dispute.status = "won";
  failRestorationSave = true;
  await expect(reconcile(102)).rejects.toThrow("restoration progress conflict");
  expect(createTransfer).toHaveBeenCalledTimes(1);
  await reconcile(103);
  expect(createTransfer).toHaveBeenCalledTimes(1);
  expect(recovery).toMatchObject({ restoration_status: "succeeded", restoration_transfer_id: "tr_restore" });
});

test("rejects a recovery row with a different provider linkage before moving funds", async () => {
  recovery = {
    tip_id: tipId, stripe_payment_intent_id: "pi_tip", stripe_charge_id: "ch_tip",
    stripe_transfer_id: "tr_foreign", stripe_event_created: 200,
    reversal_amount_cents: 500, reversal_status: "pending",
  };
  await expect(reconcile(100)).rejects.toThrow("recovery linkage differs");
  expect(createReversal).not.toHaveBeenCalled();
  expect(createTransfer).not.toHaveBeenCalled();
});
