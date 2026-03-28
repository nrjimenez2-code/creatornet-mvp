// app/api/post-metrics/route.ts
// Called from client components (VideoCard) to update post metrics
import { NextRequest, NextResponse } from "next/server";
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

    await updatePostMetrics(post_id, { [field]: 1 } as any, watch_seconds);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}
