import "server-only";

import { NextResponse } from "next/server";
import { RefundWorkflowError } from "@/lib/admin/refunds";

/** Keep controlled workflow messages out of route-level raw-error tripwires. */
export function refundWorkflowErrorResponse(error: RefundWorkflowError) {
  return NextResponse.json({ error: error.message }, { status: error.status });
}
