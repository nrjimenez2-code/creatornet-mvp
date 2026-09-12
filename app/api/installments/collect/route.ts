import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { collectContextMonthlyBooking } from "@/lib/installments/contextMonthlyCollection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** #3/#8: default-off scheduler target; no cron or hosted activation is installed
 * by adding this route. The release package must select its actual schedule. */
export async function GET(req: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  const secret = process.env.CRON_SECRET ?? "";
  const supplied = req.headers.get("authorization") ?? "";
  const expected = "Bearer " + secret;
  if (secret.length < 32 || supplied.length > 1024 || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  try {
    const bookingId = new URL(req.url).searchParams.get("booking_id") ?? "";
    const result = await collectContextMonthlyBooking(supabaseAdmin, bookingId, process.env);
    const completed = ["nothing_due", "waiting_for_invoice", "credited", "already_credited"].includes(result.status);
    return NextResponse.json({ status: result.status }, { status: completed ? 200 : 503, headers });
  } catch {
    return NextResponse.json({ error: "Monthly collection requires retry or review. Existing payment identities are preserved." }, { status: 503, headers });
  }
}
