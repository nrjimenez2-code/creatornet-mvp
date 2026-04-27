// app/api/post-metrics/route.ts
// Called from client components (VideoCard) to update post metrics
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { updatePostMetrics } from "@/lib/updatePostMetrics";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { post_id, field, watch_seconds } = body as {
      post_id?: string;
      field?: string;
      watch_seconds?: number;
    };

    if (!post_id || !field) return NextResponse.json({ ok: true });

    const allowed = ["impressions", "views", "completions", "profile_clicks", "buy_clicks"];
    if (!allowed.includes(field)) return NextResponse.json({ ok: true });

    // Best-effort: attribute the event to the logged-in viewer when available
    // so creator_kpis can compute distinct-user metrics.
    let userId: string | null = null;
    try {
      const supabase = createServerClient();
      const { data } = await supabase.auth.getUser();
      userId = data.user?.id ?? null;
    } catch {
      userId = null;
    }

    await updatePostMetrics(
      post_id,
      { [field]: 1 } as any,
      watch_seconds,
      userId
    );
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}
