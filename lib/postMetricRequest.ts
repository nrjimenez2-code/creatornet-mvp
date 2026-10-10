import "server-only";
import type { NextRequest } from "next/server";
import { updatePostMetrics, clampWatchSeconds, type MetricField } from "@/lib/updatePostMetrics";
import { allowRequest, clientKey } from "@/lib/rateLimit";

// Checkout starts and purchases are server-authoritative, never client bumps.
const CLIENT_FIELDS: ReadonlySet<string> = new Set<MetricField>([
  "impressions", "views", "completions", "profile_clicks", "buy_clicks",
]);
const RATE = { limit: 120, windowMs: 60_000 };

export async function recordClientPostMetric(req: NextRequest, userId: string | null, body: unknown) {
  const input = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown> : {};
  if (typeof input.post_id !== "string" || !input.post_id ||
      typeof input.field !== "string" || !CLIENT_FIELDS.has(input.field)) return { ok: true };

  const key = userId ? `metrics:u:${userId}` : `metrics:ip:${clientKey(req)}`;
  if (!allowRequest(key, RATE)) return { ok: true, limited: true };
  await updatePostMetrics(input.post_id, { [input.field as MetricField]: 1 },
    clampWatchSeconds(input.watch_seconds), userId);
  return { ok: true };
}
