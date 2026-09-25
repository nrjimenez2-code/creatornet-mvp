import { NextRequest, NextResponse } from "next/server";
import { adminAuthErrorResponse, requireAdmin } from "@/lib/admin/server";
import { isSameOriginRequest } from "@/lib/sameOrigin";
import { getStripe } from "@/lib/stripeClient";
import { updateTipFromCheckoutEvent } from "@/lib/tipEvents";
import { reconcileKnownPaymentRefund } from "@/lib/paymentRefunds";
import { reconcileKnownPaymentDispute } from "@/lib/paymentDisputes";
import { reconcileTipDisputeRecovery } from "@/lib/tipDisputes";
import { decodeTipCursor, encodeTipCursor } from "@/lib/tipCursor";

export const runtime = "nodejs";

type ReconcileBody = { cursor?: unknown; limit?: unknown };
type ReconcileTip = {
  id: string;
  status: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  updated_at: string;
};

function objectId(value: string | { id: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id ?? null;
}

function publicFailure(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 80);
  }
  return "reconciliation_failed";
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }
  let context: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    context = await requireAdmin(req);
  } catch (error) {
    return adminAuthErrorResponse(error, "reconcile_tips");
  }
  let body: ReconcileBody = {};
  try { body = await req.json(); } catch { /* body is optional */ }
  const limit = Math.min(50, Math.max(1, Number.isSafeInteger(body.limit) ? Number(body.limit) : 25));
  const cursor = body.cursor ? decodeTipCursor(body.cursor) : null;
  if (body.cursor && !cursor) return NextResponse.json({ error: "Invalid cursor." }, { status: 400 });

  let query = context.admin.from("tips")
    .select("id,status,stripe_checkout_session_id,stripe_payment_intent_id,updated_at")
    .in("status", ["creating", "open", "processing", "paid", "failed", "canceled"])
    .order("updated_at", { ascending: true }).order("id", { ascending: true })
    .limit(limit);
  if (cursor) query = query.or(`updated_at.gt.${cursor.at},and(updated_at.eq.${cursor.at},id.gt.${cursor.id})`);
  const result = await query.returns<ReconcileTip[]>();
  if (result.error) {
    console.error("[tips:reconcile] list failed:", result.error.message);
    return NextResponse.json({ error: "Tip reconciliation could not start." }, { status: 500 });
  }

  const stripe = getStripe();
  const reconciled: string[] = [];
  const skipped: string[] = [];
  const failures: Array<{ tipId: string; code: string }> = [];
  for (const tip of result.data ?? []) {
    try {
      if (tip.stripe_checkout_session_id) {
        const session = await stripe.checkout.sessions.retrieve(tip.stripe_checkout_session_id);
        if (session.status === "expired") {
          await updateTipFromCheckoutEvent(context.admin, session, "checkout.session.expired");
        } else if (session.status === "complete") {
          await updateTipFromCheckoutEvent(context.admin, session, "checkout.session.completed");
        } else {
          skipped.push(tip.id);
          continue;
        }
      } else {
        const ageMs = Date.now() - Date.parse(tip.updated_at);
        if (tip.status === "paid" || (tip.status === "creating" && ageMs > 2 * 60_000)) {
          failures.push({ tipId: tip.id, code: "missing_checkout_session" });
        } else {
          skipped.push(tip.id);
        }
        continue;
      }
      if (tip.stripe_payment_intent_id) {
        await reconcileKnownPaymentRefund(context.admin, tip.stripe_payment_intent_id);
        await reconcileKnownPaymentDispute(context.admin, tip.stripe_payment_intent_id);
      }
      reconciled.push(tip.id);
    } catch (error) {
      const code = publicFailure(error);
      failures.push({ tipId: tip.id, code });
      console.error("[tips:reconcile] tip failed:", { tipId: tip.id, code });
    }
  }

  const failedRecoveries = await context.admin.from("tip_dispute_recoveries")
    .select("stripe_dispute_id,stripe_event_created")
    .or("reversal_status.eq.pending,reversal_status.eq.failed,restoration_status.eq.pending,restoration_status.eq.failed")
    .order("updated_at", { ascending: true })
    .limit(Math.min(10, limit));
  const recoveryFailures: Array<{ disputeId: string; code: string }> = [];
  if (failedRecoveries.error) {
    console.error("[tips:reconcile] dispute recovery lookup failed:", failedRecoveries.error.message);
    return NextResponse.json({ error: "Tip dispute recovery lookup failed." }, { status: 500 });
  }
  for (const row of failedRecoveries.data ?? []) {
    try {
      const dispute = await stripe.disputes.retrieve(row.stripe_dispute_id);
      const chargeId = objectId(dispute.charge);
      const paymentIntentId = objectId(dispute.payment_intent);
      if (!chargeId || !paymentIntentId) throw new Error("Dispute linkage is incomplete.");
      await reconcileTipDisputeRecovery({
        admin: context.admin, stripe, dispute, chargeId, paymentIntentId,
        eventCreated: Number(row.stripe_event_created || 0),
      });
    } catch (error) {
      const code = publicFailure(error);
      recoveryFailures.push({ disputeId: row.stripe_dispute_id, code });
      console.error("[tips:reconcile] dispute recovery failed:", {
        disputeId: row.stripe_dispute_id, code,
      });
    }
  }

  const rows = result.data ?? [];
  return NextResponse.json({
    reconciledCount: reconciled.length,
    skippedCount: skipped.length,
    failureCount: failures.length + recoveryFailures.length,
    failures,
    recoveryFailures,
    nextCursor: rows.length === limit && rows.length ? encodeTipCursor(rows[rows.length - 1]) : null,
  });
}
