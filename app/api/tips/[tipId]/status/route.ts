import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ tipId: string }> }) {
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { tipId } = await params;
  const { data, error } = await supabaseAdmin.from("tips")
    .select("id,status,gross_amount_cents,currency,refunded_amount_cents,paid_at,failed_at,canceled_at")
    .eq("id", tipId).eq("tipper_id", user.id).maybeSingle();
  if (error) return NextResponse.json({ error: "Tip status is unavailable." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Tip not found." }, { status: 404 });
  return NextResponse.json({
    id: data.id, status: data.status, amountCents: Number(data.gross_amount_cents),
    currency: data.currency, refundedAmountCents: Number(data.refunded_amount_cents || 0),
    refundState: Number(data.refunded_amount_cents || 0) <= 0
      ? "none"
      : Number(data.refunded_amount_cents) >= Number(data.gross_amount_cents)
        ? "full"
        : "partial",
    paidAt: data.paid_at, failedAt: data.failed_at, canceledAt: data.canceled_at,
  });
}
