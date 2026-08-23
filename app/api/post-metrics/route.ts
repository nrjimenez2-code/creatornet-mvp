// app/api/post-metrics/route.ts
// Called from client components (VideoCard) to update post metrics
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import {
  updatePostMetrics,
  clampWatchSeconds,
  type MetricField,
} from "@/lib/updatePostMetrics";
import { allowRequest, clientKey } from "@/lib/rateLimit";

export const runtime = "nodejs";

// Fields a browser may bump. checkout_starts and purchases are server-only
// (set by checkout and the Stripe webhook).
const CLIENT_FIELDS: ReadonlySet<string> = new Set<MetricField>([
  "impressions",
  "views",
  "completions",
  "profile_clicks",
  "buy_clicks",
]);

// A person scrolling a feed fires a handful of these per minute; a script
// inflating one post fires hundreds. Anonymous viewers stay counted, they
// just cannot be counted 1000 times a minute from one connection.
const RATE = { limit: 120, windowMs: 60_000 };

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { post_id, field, watch_seconds } = body as {
      post_id?: unknown;
      field?: unknown;
      watch_seconds?: unknown;
    };

    if (typeof post_id !== "string" || !post_id) return NextResponse.json({ ok: true });
    if (typeof field !== "string" || !CLIENT_FIELDS.has(field)) {
      return NextResponse.json({ ok: true });
    }

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

    const key = userId ? `metrics:u:${userId}` : `metrics:ip:${clientKey(req)}`;
    if (!allowRequest(key, RATE)) {
      return NextResponse.json({ ok: true, limited: true });
    }

    await updatePostMetrics(
      post_id,
      { [field as MetricField]: 1 },
      clampWatchSeconds(watch_seconds),
      userId
    );
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}
