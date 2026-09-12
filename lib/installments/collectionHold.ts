import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAgreementId } from "./agreementStore";
import { assertExactInstallmentEnvironment } from "./checkoutPreparation";

type Env = Record<string, string | undefined>;
export type ExactRefundAdmission = "not_applicable" | "held" | "reconciliation_required";

/** Monthly bindings require their own agreement lock before any provider refund.
 * Keep the schema flag enabled once monthly purchases exist; a missing admission
 * RPC fails closed rather than falling through to the legacy refund path. */
export async function coordinateMonthlyMentorshipRefund(
  admin: SupabaseClient, operationId: string, token: string, env: Env,
): Promise<ExactRefundAdmission> {
  if (env.CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY !== "true") return "not_applicable";
  assertAgreementId(operationId); assertAgreementId(token);
  const { data, error } = await admin.rpc("admit_monthly_mentorship_admin_refund_v1", {
    p_operation_id: operationId, p_processing_token: token,
  });
  if (error || !["not_applicable", "held", "reconciliation_required"].includes(data)) {
    throw new Error("Monthly refund coordination requires retry or review");
  }
  return data;
}

function assertHoldSchema(env: Env) {
  assertExactInstallmentEnvironment(env, env.NEXT_PUBLIC_SITE_URL || "");
  if (env.CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY !== "true") {
    throw new Error("Exact installment collection-hold schema is not ready");
  }
}

/** No Stripe call, access change or debt cancellation. SCHEMA_READY must stay on
 * once exact bindings exist, including during a preparation/collection pause.
 * Until 045 is installed/acknowledged, an enabled candidate fails closed. */
export async function coordinateExactInstallmentRefund(
  admin: SupabaseClient, operationId: string, token: string, env: Env,
): Promise<ExactRefundAdmission> {
  const enabled = [env.CREATOR_EXACT_INSTALLMENTS_SCHEMA_READY,
    env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_PREPARE,
    env.CREATOR_EXACT_INSTALLMENTS_SANDBOX_COLLECT,
    env.CREATOR_EXACT_INSTALLMENTS_REFUND_EVENTS_READY,
    env.CREATOR_EXACT_INSTALLMENTS_BILLING_STOPS_READY,
    env.CREATOR_EXACT_INSTALLMENTS_LIFECYCLE_EVENTS_READY,
    env.CREATOR_EXACT_INSTALLMENTS_RECOVERY_READY,
    env.CREATOR_EXACT_INSTALLMENTS_STOP_COORDINATION_READY].includes("true");
  if (!enabled) return "not_applicable"; // Unchanged legacy/production path.
  assertHoldSchema(env);
  assertAgreementId(operationId); assertAgreementId(token);
  const { data, error } = await admin.rpc("admit_exact_installment_admin_refund", {
    p_operation_id: operationId, p_processing_token: token,
  });
  if (error) throw new Error("Exact installment refund coordination failed");
  if (data !== "not_applicable" && data !== "held" && data !== "reconciliation_required") {
    throw new Error("Invalid exact installment refund admission");
  }
  return data;
}

/** Internal staging adapter only; no new customer/admin endpoint. The caller
 * must authenticate an administrator and verify the cancellation request.
 * This records a durable review hold, NOT a completed Stripe cancellation. */
export async function holdExactInstallmentForCancellation(args: {
  admin: SupabaseClient; agreementId: string; requestId: string; actorId: string; env: Env;
}): Promise<{ status: "review_hold_recorded"; holdId: string }> {
  assertHoldSchema(args.env);
  for (const id of [args.agreementId, args.requestId, args.actorId]) assertAgreementId(id);
  const { data, error } = await args.admin.rpc("hold_exact_installment_for_cancellation", {
    p_agreement_id: args.agreementId, p_request_id: args.requestId, p_actor_id: args.actorId,
  });
  if (error) throw new Error("Exact installment cancellation hold failed");
  assertAgreementId(data);
  return { status: "review_hold_recorded", holdId: data };
}
