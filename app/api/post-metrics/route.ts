import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { recordClientPostMetric } from "@/lib/postMetricRequest";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body: unknown = await req.json();
    // An anonymous event is allowed; authenticated events attribute the
    // distinct viewer through the website cookie session.
    let userId: string | null = null;
    try {
      const { data } = await createServerClient().auth.getUser();
      userId = data.user?.id ?? null;
    } catch { userId = null; }
    return NextResponse.json(await recordClientPostMetric(req, userId, body));
  } catch {
    return NextResponse.json({ ok: true });
  }
}
