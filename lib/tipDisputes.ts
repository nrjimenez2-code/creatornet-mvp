import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { getPaymentDisputeState } from "@/lib/paymentDisputes";

function objectId(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 80);
  }
  return "provider_error";
}

async function existingTipReversal(
  stripe: Stripe, transferId: string, tipId: string, disputeId: string, amount: number,
): Promise<string | null> {
  let after: string | undefined;
  let found: string | null = null;
  for (;;) {
    const page = await stripe.transfers.listReversals(transferId, { limit: 100, starting_after: after });
    for (const reversal of page.data) {
      if (reversal.metadata?.payment_kind !== "video_tip_dispute_reversal" ||
          reversal.metadata.tip_id !== tipId || reversal.metadata.dispute_id !== disputeId) continue;
      if (reversal.amount !== amount || objectId(reversal.transfer) !== transferId ||
          (found && found !== reversal.id)) {
        throw new Error(`Tip dispute ${disputeId} has conflicting provider reversals.`);
      }
      found = reversal.id;
    }
    if (!page.has_more) return found;
    after = page.data.at(-1)?.id;
    if (!after) throw new Error(`Tip dispute ${disputeId} reversal pagination is incomplete.`);
  }
}

function restorationGroup(disputeId: string): string {
  return `creatornet-tip-dispute-restore:${disputeId}`;
}

async function existingTipRestoration(
  stripe: Stripe, group: string, tipId: string, disputeId: string,
  destination: string, currency: string, amount: number, livemode: boolean,
): Promise<string | null> {
  let after: string | undefined;
  let found: string | null = null;
  for (;;) {
    const page = await stripe.transfers.list({ transfer_group: group, limit: 100, starting_after: after });
    for (const transfer of page.data) {
      if (transfer.metadata?.payment_kind !== "video_tip_dispute_restoration" ||
          transfer.metadata.tip_id !== tipId || transfer.metadata.dispute_id !== disputeId) {
        throw new Error(`Tip dispute ${disputeId} restoration group contains a foreign transfer.`);
      }
      if (transfer.amount !== amount || transfer.currency !== currency ||
          objectId(transfer.destination) !== destination || transfer.livemode !== livemode ||
          (found && found !== transfer.id)) {
        throw new Error(`Tip dispute ${disputeId} has conflicting restoration transfers.`);
      }
      found = transfer.id;
    }
    if (!page.has_more) return found;
    after = page.data.at(-1)?.id;
    if (!after) throw new Error(`Tip dispute ${disputeId} restoration pagination is incomplete.`);
  }
}

async function saveProgress(
  admin: SupabaseClient, disputeId: string, eventCreated: number,
  kind: "reversal" | "restoration", providerId: string | null,
): Promise<void> {
  const saved = await admin.rpc("record_tip_dispute_recovery_progress", {
    p_dispute_id: disputeId, p_event_created: eventCreated, p_kind: kind,
    p_status: "succeeded", p_provider_id: providerId, p_error_code: null,
  });
  if (saved.error || saved.data !== true) throw new Error(saved.error?.message || `${kind} progress conflict.`);
}

export async function reconcileTipDisputeRecovery(args: {
  admin: SupabaseClient;
  stripe: Stripe;
  dispute: Stripe.Dispute;
  paymentIntentId: string;
  chargeId: string;
  eventCreated: number;
}): Promise<boolean> {
  const { admin, stripe, dispute, paymentIntentId, chargeId, eventCreated } = args;
  const ledger = await admin.from("payment_fee_ledger").select("tip_id")
    .eq("stripe_payment_intent_id", paymentIntentId).maybeSingle();
  if (ledger.error) throw new Error(`Tip dispute ledger lookup failed: ${ledger.error.message}`);
  const tipId = ledger.data?.tip_id as string | null | undefined;
  if (!tipId) return false;
  const tipResult = await admin.from("tips").select("id,creator_id,stripe_destination_account_id,currency")
    .eq("id", tipId).maybeSingle();
  if (tipResult.error || !tipResult.data) throw new Error("Tip dispute record is missing.");
  const charge = await stripe.charges.retrieve(chargeId);
  const transferId = objectId(charge.transfer);
  if (!transferId) throw new Error(`Tip charge ${chargeId} has no destination transfer.`);
  if (objectId(charge.payment_intent) !== paymentIntentId || charge.currency !== tipResult.data.currency ||
      dispute.currency !== charge.currency || charge.livemode !== dispute.livemode) {
    throw new Error(`Tip dispute ${dispute.id} charge linkage differs.`);
  }
  const originalTransfer = await stripe.transfers.retrieve(transferId);
  if (objectId(originalTransfer.destination) !== tipResult.data.stripe_destination_account_id ||
      originalTransfer.currency !== charge.currency || originalTransfer.livemode !== charge.livemode) {
    throw new Error(`Tip dispute ${dispute.id} destination transfer differs.`);
  }
  const availableToReverse = Math.max(0, originalTransfer.amount - originalTransfer.amount_reversed);
  const reversalTarget = Math.min(dispute.amount, availableToReverse);
  const upsert = await admin.rpc("record_tip_dispute_recovery", {
    p_dispute_id: dispute.id, p_tip_id: tipId, p_payment_intent_id: paymentIntentId,
    p_charge_id: chargeId, p_transfer_id: transferId,
    p_disputed_amount_cents: dispute.amount, p_event_created: eventCreated,
    p_reversal_amount_cents: reversalTarget, p_dispute_status: dispute.status,
  });
  if (upsert.error) throw new Error(`Tip dispute recovery write failed: ${upsert.error.message}`);
  const existing = await admin.from("tip_dispute_recoveries").select("*")
    .eq("stripe_dispute_id", dispute.id).maybeSingle();
  if (existing.error || !existing.data) throw new Error("Tip dispute recovery could not be reloaded.");
  const prior = existing.data as Record<string, unknown>;
  if (prior.tip_id !== tipId || prior.stripe_payment_intent_id !== paymentIntentId ||
      prior.stripe_charge_id !== chargeId || prior.stripe_transfer_id !== transferId) {
    throw new Error(`Tip dispute ${dispute.id} recovery linkage differs.`);
  }
  const frozenAmount = Number(prior.reversal_amount_cents);

  if (dispute.status === "won") {
    let reversalId = prior.reversal_id as string | null;
    if (!reversalId && frozenAmount > 0) {
      reversalId = await existingTipReversal(stripe, transferId, tipId, dispute.id, frozenAmount);
      if (reversalId) await saveProgress(admin, dispute.id, eventCreated, "reversal", reversalId);
    }
    if (!reversalId || prior.restoration_transfer_id) return true;
    const group = restorationGroup(dispute.id);
    try {
      let restorationId = await existingTipRestoration(
        stripe, group, tipId, dispute.id, String(tipResult.data.stripe_destination_account_id),
        String(tipResult.data.currency), frozenAmount, dispute.livemode,
      );
      if (!restorationId) {
        const transfer = await stripe.transfers.create({
          amount: frozenAmount,
          currency: String(tipResult.data.currency || dispute.currency),
          destination: String(tipResult.data.stripe_destination_account_id),
          transfer_group: group,
          metadata: { payment_kind: "video_tip_dispute_restoration", tip_id: tipId, dispute_id: dispute.id },
        }, { idempotencyKey: group });
        restorationId = transfer.id;
      }
      await saveProgress(admin, dispute.id, eventCreated, "restoration", restorationId);
    } catch (error) {
      await admin.rpc("record_tip_dispute_recovery_progress", {
        p_dispute_id: dispute.id, p_event_created: eventCreated, p_kind: "restoration",
        p_status: "failed", p_provider_id: null, p_error_code: errorCode(error),
      });
      throw error;
    }
    return true;
  }

  if (prior?.reversal_id) return true;
  try {
    if (frozenAmount === 0) {
      await saveProgress(admin, dispute.id, eventCreated, "reversal", null);
    } else {
      let reversalId = await existingTipReversal(stripe, transferId, tipId, dispute.id, frozenAmount);
      if (!reversalId) {
        const reversal = await stripe.transfers.createReversal(transferId, {
          amount: frozenAmount,
          metadata: { payment_kind: "video_tip_dispute_reversal", tip_id: tipId, dispute_id: dispute.id },
        }, { idempotencyKey: `creatornet-tip-dispute-reversal:${dispute.id}` });
        reversalId = reversal.id;
      }
      await saveProgress(admin, dispute.id, eventCreated, "reversal", reversalId);
    }
    const currentDispute = await stripe.disputes.retrieve(dispute.id);
    if (currentDispute.status === "won") {
      return reconcileTipDisputeRecovery({ ...args, dispute: currentDispute });
    }
  } catch (error) {
    await admin.rpc("record_tip_dispute_recovery_progress", {
      p_dispute_id: dispute.id, p_event_created: eventCreated, p_kind: "reversal",
      p_status: "failed", p_provider_id: null, p_error_code: errorCode(error),
    });
    throw error;
  }
  return true;
}

/** Repair a dispute that arrived before tip finalization created its ledger link. */
export async function reconcileKnownTipDisputeRecovery(
  admin: SupabaseClient,
  stripe: Stripe,
  paymentIntentId: string,
): Promise<boolean> {
  const state = await getPaymentDisputeState(admin, paymentIntentId);
  if (!state) return false;
  const dispute = await stripe.disputes.retrieve(state.disputeId);
  const chargeId = objectId(dispute.charge) || state.chargeId;
  const linkedPaymentIntent = objectId(dispute.payment_intent) || state.paymentIntentId;
  if (linkedPaymentIntent !== paymentIntentId || chargeId !== state.chargeId) {
    throw new Error(`Tip dispute ${state.disputeId} linkage differs from recorded state.`);
  }
  return reconcileTipDisputeRecovery({
    admin, stripe, dispute, paymentIntentId, chargeId, eventCreated: state.eventCreated,
  });
}
