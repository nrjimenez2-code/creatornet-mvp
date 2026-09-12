import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStripe } from "@/lib/stripeClient";
import { paidCallsReady, readPaidCallAccess, verifyPaidCallCapture } from "@/lib/paidCalls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

export async function GET(_req: Request, context: { params: Promise<{ purchaseId: string }> }) {
  try {
    const { data: { user } } = await createServerClient().auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to schedule your call." }, { status: 401, headers });
    if (!paidCallsReady()) return NextResponse.json({ error: "Paid-call scheduling is not enabled." }, { status: 503, headers });
    const { purchaseId } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(purchaseId)) return NextResponse.json({ error: "Call not found." }, { status: 404, headers });
    const access = await readPaidCallAccess(supabaseAdmin, purchaseId, user.id);
    if (!access || !await verifyPaidCallCapture(getStripe(), access)) {
      return NextResponse.json({ error: "A confirmed, eligible payment is required to schedule this call." }, { status: 403, headers });
    }
    // Recheck after provider I/O: a concurrent refund or access revocation wins.
    const current = await readPaidCallAccess(supabaseAdmin, purchaseId, user.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(access)) {
      return NextResponse.json({ error: "Call access changed. Please check your purchase." }, { status: 409, headers });
    }
    return new NextResponse(null, { status: 303, headers: { ...headers, Location: current.scheduling_url } });
  } catch {
    return NextResponse.json({ error: "Unable to confirm scheduling access. Please try again or contact support." }, { status: 503, headers });
  }
}
