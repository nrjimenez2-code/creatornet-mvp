import { discoverEnabled } from "@/lib/discoverServer";
// app/api/interest-score/route.ts
// Called from client components (VideoCard) to update user interest scores
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { scoreInterestRequest } from "@/lib/interestScoreRequest";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (discoverEnabled()) return NextResponse.json({ ok: true, ignored: true });
  try {
    const body: unknown = await req.json();
    // Preserve the website cookie/session admission; the mobile route supplies
    // its separately verified bearer identity to the same scoring rules.
    const { data: { user } } = await createServerClient().auth.getUser();
    return NextResponse.json(await scoreInterestRequest(user?.id ?? null, body));
  } catch {
    // Never fail a request for analytics
    return NextResponse.json({ ok: true });
  }
}
