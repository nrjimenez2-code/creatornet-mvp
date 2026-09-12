import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertMembershipId } from "@/lib/membershipAgreement";
import { membershipServerContext } from "@/lib/membershipServer";
import { createMembershipRuntime } from "@/lib/membershipRuntime";
import { membershipCheckoutRecoveryReady } from "@/lib/membershipCheckoutRecovery";
import { membershipInitialAbandonmentReady } from "@/lib/membershipInitialAbandonment";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function POST(req: NextRequest, { params }: { params: Promise<{ membershipId: string }> }) {
  if (!membershipCheckoutRecoveryReady()) return Response.json({ error: "Checkout recovery is unavailable. Contact support@creatornet.net." }, { status: 503, headers });
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Sign in to recover your own checkout." }, { status: 401, headers });
  try {
    if (req.headers.get("origin") !== membershipServerContext().siteOrigin) return Response.json({ error: "Invalid request origin." }, { status: 403, headers });
    const { membershipId } = await params; assertMembershipId(membershipId);
    const text = await req.text();
    if (text.length > 1024 || new URL(req.url).search) return Response.json({ error: "Invalid recovery request." }, { status: 400, headers });
    const body = JSON.parse(text);
    if (!body || Array.isArray(body) || !["reconcile", "resume", "abandon"].includes(body.action) ||
      Object.keys(body).sort().join(",") !== (body.action !== "reconcile" ? "action,confirmed" : "action") ||
      body.action !== "reconcile" && body.confirmed !== true) return Response.json({ error: "Explicit valid recovery action required." }, { status: 400, headers });
    if (body.action === "abandon" && !membershipInitialAbandonmentReady()) return Response.json({ error: "Unpaid checkout close-out is not enabled." }, { status: 503, headers });
    const api = createMembershipRuntime();
    if (body.action === "abandon") return Response.json(await api.abandonFirstCheckout(membershipId, user.id, true), { headers });
    return Response.json(body.action === "resume" ? await api.resumeFirstCheckout(membershipId, user.id, true) :
      await api.reconcileFirstCheckout(membershipId, user.id), { headers });
  } catch { return Response.json({ error: "Checkout recovery needs retry or support review. Do not start a second purchase for an uncertain payment." }, { status: 503, headers }); }
}
