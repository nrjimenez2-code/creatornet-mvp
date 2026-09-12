import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertMembershipId } from "@/lib/membershipAgreement";
import { membershipServerContext } from "@/lib/membershipServer";
import { createMembershipRuntime } from "@/lib/membershipRuntime";
import { membershipRenewalRecoveryReady } from "@/lib/membershipRenewalRecovery";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store", Pragma: "no-cache" };
export async function POST(req: NextRequest, { params }: { params: Promise<{ membershipId: string }> }) {
  if (!membershipRenewalRecoveryReady(process.env)) return Response.json({ error: "Monthly payment recovery is unavailable. Contact support@creatornet.net." }, { status: 503, headers });
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Sign in to authenticate your own monthly payment." }, { status: 401, headers });
  try {
    if (req.headers.get("origin") !== membershipServerContext().siteOrigin) return Response.json({ error: "Invalid request origin." }, { status: 403, headers });
    const { membershipId } = await params; assertMembershipId(membershipId);
    const text = await req.text();
    if (text.length > 1024 || new URL(req.url).search || req.headers.get("content-type")?.split(";")[0] !== "application/json")
      return Response.json({ error: "Invalid monthly bank request." }, { status: 400, headers });
    const body = JSON.parse(text), keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort().join(",") : "";
    if (keys !== "action,invoiceId" || !["challenge", "status"].includes(body?.action) ||
      typeof body.invoiceId !== "string" || !/^in_[A-Za-z0-9]+$/.test(body.invoiceId))
      return Response.json({ error: "Select an original owned monthly payment." }, { status: 400, headers });
    const api = createMembershipRuntime();
    return Response.json(body.action === "challenge" ? await api.readRenewalBankChallenge(membershipId, user.id, body.invoiceId) :
      await api.readRenewalRecovery(membershipId, user.id, body.invoiceId), { headers });
  } catch { return Response.json({ error: "Bank verification is unavailable or the original payment changed. Check its payment status before continuing, or contact support@creatornet.net." }, { status: 503, headers }); }
}
