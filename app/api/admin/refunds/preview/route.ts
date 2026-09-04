import { NextResponse, type NextRequest } from "next/server";
import {
  adminAuthErrorResponse,
  requireAdmin,
} from "@/lib/admin/server";
import { createSupabaseRefundStore } from "@/lib/admin/refund-store";
import {
  previewAdminRefund,
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
  let admin: Awaited<ReturnType<typeof requireAdmin>>["admin"];
  try {
    ({ admin } = await requireAdmin(req));
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
    const preview = await previewAdminRefund(
      createSupabaseRefundStore(admin),
      getStripe(),
      requestInput(body),
    );
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
