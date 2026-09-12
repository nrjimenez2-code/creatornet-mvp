import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { membershipExitRecoveryReady, runMembershipExitRecovery } from "@/lib/membershipExitRecovery";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function GET(req: NextRequest) {
  if (!membershipExitRecoveryReady()) return Response.json({ error: "Monthly exit recovery is not enabled." }, { status: 409, headers });
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return Response.json({ error: "Exit recovery authentication is not configured." }, { status: 503, headers });
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(hash(req.headers.get("authorization") || ""), hash("Bearer " + secret)))
    return Response.json({ error: "Unauthorized." }, { status: 401, headers });
  if (new URL(req.url).search) return Response.json({ error: "Recovery selection is server-owned." }, { status: 400, headers });
  try { return Response.json(await runMembershipExitRecovery(), { headers }); }
  catch { return Response.json({ error: "Exit recovery needs retry or operations review." }, { status: 503, headers }); }
}
