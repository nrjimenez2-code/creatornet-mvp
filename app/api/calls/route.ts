import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { paidCallsReady } from "@/lib/paidCalls";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const { data: { user } } = await createServerClient().auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to see your calls." }, { status: 401, headers });
    if (!paidCallsReady()) return NextResponse.json({ items: [], hasMore: false }, { headers });
    const offset = Number(new URL(req.url).searchParams.get("offset") ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) return NextResponse.json({ error: "Invalid page." }, { status: 400, headers });
    const { data, error } = await supabaseAdmin.rpc("list_paid_calls_v1", { p_buyer_id: user.id, p_offset: offset });
    if (error) throw error;
    return NextResponse.json(data, { headers });
  } catch {
    return NextResponse.json({ error: "Your calls could not be loaded. Please try again." }, { status: 503, headers });
  }
}
