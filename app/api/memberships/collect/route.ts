import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { membershipWorkerReady, runMembershipBillingWorker } from "@/lib/membershipWorker";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function GET(req: NextRequest) {
  if (!membershipWorkerReady()) return Response.json({ error: "Monthly worker is not enabled." }, { status: 409, headers });
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return Response.json({ error: "Monthly worker authentication is not configured." }, { status: 503, headers });
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(hash(req.headers.get("authorization") || ""), hash("Bearer " + secret)))
    return Response.json({ error: "Unauthorized." }, { status: 401, headers });
  if (new URL(req.url).searchParams.size !== 0) return Response.json({ error: "Worker selection is server-owned." }, { status: 400, headers });
  try {
    const result = await runMembershipBillingWorker(); return Response.json(result, { status: result.failed ? 503 : 200, headers });
  } catch { return Response.json({ error: "Monthly worker needs retry or review." }, { status: 503, headers }); }
}
