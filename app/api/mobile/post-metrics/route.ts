import type { NextRequest } from "next/server";
import { mobileApi } from "@/lib/mobileApi";
import { recordClientPostMetric } from "@/lib/postMetricRequest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = mobileApi(async (req: NextRequest, user) => {
  try {
    const body: unknown = await req.json();
    return Response.json(await recordClientPostMetric(req, user?.id ?? null, body));
  } catch {
    // Metrics are best-effort and must not interrupt playback.
    return Response.json({ ok: true });
  }
}, ["POST"], false);
export const POST = handler;
export const OPTIONS = handler;
