import { NextResponse, type NextRequest } from "next/server";
import {
  adminAuthErrorResponse,
  requireAdmin,
} from "@/lib/admin/server";
import { executeAdminRefundAction } from "@/lib/admin/refund-app";
import {
  RefundWorkflowError,
  type RefundRequestInput,
} from "@/lib/admin/refunds";
import type {
  RefundReasonCode,
  RefundResponsibility,
} from "@/lib/refundAllocation";
import { refundWorkflowErrorResponse } from "@/lib/admin/refund-response";
import { isSameOriginRequest } from "@/lib/sameOrigin";

export const runtime = "nodejs";

function requestInput(body: unknown): RefundRequestInput {
  const value =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
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
  };
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }
  let context: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    context = await requireAdmin(req);
  } catch (error) {
    return adminAuthErrorResponse(error, "refund_preview");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const preview = await executeAdminRefundAction({ admin: context.admin, actorId: context.user.id }, { kind: "preview", input: requestInput(body) });
    return NextResponse.json({ preview });
  } catch (error) {
    if (error instanceof RefundWorkflowError) {
      return refundWorkflowErrorResponse(error);
    }
    console.error("[admin:refund_preview] failed:", error);
    return NextResponse.json(
      { error: "The refund preview could not be prepared." },
      { status: 500 },
    );
  }
}
