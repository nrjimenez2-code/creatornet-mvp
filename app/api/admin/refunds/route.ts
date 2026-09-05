import { NextResponse, type NextRequest } from "next/server";
import {
  adminAuthErrorResponse,
  requireAdmin,
} from "@/lib/admin/server";
import { createSupabaseRefundStore } from "@/lib/admin/refund-store";
import {
  createAndProcessAdminRefund,
  processRefundOperation,
  publicRefundOperation,
  RefundWorkflowError,
  type RefundRequestInput,
} from "@/lib/admin/refunds";
import type {
  RefundReasonCode,
  RefundResponsibility,
} from "@/lib/refundAllocation";
import { getStripe } from "@/lib/stripeClient";
import { refundWorkflowErrorResponse } from "@/lib/admin/refund-response";
import { isSameOriginRequest } from "@/lib/sameOrigin";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createInput(body: unknown): RefundRequestInput | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  if (
    !Number.isSafeInteger(value.expectedRefundedBeforeCents) ||
    !Number.isSafeInteger(value.expectedApplicationFeeRefundedBeforeCents)
  ) {
    return null;
  }
  return {
    paymentFeeLedgerId:
      typeof value.paymentFeeLedgerId === "string"
        ? value.paymentFeeLedgerId
        : "",
    amountCents: value.amountCents as number,
    reasonCode: value.reasonCode as RefundReasonCode,
    responsibility: value.responsibility as RefundResponsibility,
    internalNotes:
      value.internalNotes === undefined || value.internalNotes === null
        ? null
        : (value.internalNotes as string),
    idempotencyKey:
      typeof value.idempotencyKey === "string" ? value.idempotencyKey : "",
    expectedRefundedBeforeCents: value.expectedRefundedBeforeCents as number,
    expectedApplicationFeeRefundedBeforeCents:
      value.expectedApplicationFeeRefundedBeforeCents as number,
  };
}

function responseForResult(
  result: Awaited<ReturnType<typeof processRefundOperation>>,
) {
  const status = result.disposition === "completed" ? 200 : 202;
  return NextResponse.json(
    {
      ok: result.disposition === "completed",
      disposition: result.disposition,
      operation: publicRefundOperation(result.operation),
    },
    { status },
  );
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }
  let context: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    context = await requireAdmin(req);
  } catch (error) {
    return adminAuthErrorResponse(error, "create_refund");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const input = createInput(body);
  if (!input) {
    return NextResponse.json(
      { error: "Review the current refund totals before confirming." },
      { status: 400 },
    );
  }

  try {
    const result = await createAndProcessAdminRefund(
      createSupabaseRefundStore(context.admin),
      getStripe(),
      context.user.id,
      input,
    );
    return responseForResult(result);
  } catch (error) {
    if (error instanceof RefundWorkflowError) {
      return refundWorkflowErrorResponse(error);
    }
    console.error("[admin:create_refund] failed:", error);
    return NextResponse.json(
      { error: "The refund could not be created safely." },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }
  let admin: Awaited<ReturnType<typeof requireAdmin>>["admin"];
  try {
    ({ admin } = await requireAdmin(req));
  } catch (error) {
    return adminAuthErrorResponse(error, "retry_refund");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const refundId =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).refundId
      : null;
  if (typeof refundId !== "string" || !UUID_PATTERN.test(refundId)) {
    return NextResponse.json({ error: "Invalid refund operation" }, { status: 400 });
  }

  try {
    const result = await processRefundOperation(
      createSupabaseRefundStore(admin),
      getStripe(),
      refundId,
    );
    return responseForResult(result);
  } catch (error) {
    if (error instanceof RefundWorkflowError) {
      return refundWorkflowErrorResponse(error);
    }
    console.error("[admin:retry_refund] failed:", error);
    return NextResponse.json(
      { error: "The refund could not be retried safely." },
      { status: 500 },
    );
  }
}
