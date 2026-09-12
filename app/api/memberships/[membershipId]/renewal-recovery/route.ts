import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertMembershipId } from "@/lib/membershipAgreement";
import { membershipServerContext } from "@/lib/membershipServer";
import { createMembershipRuntime } from "@/lib/membershipRuntime";
import { membershipCardSetupReady } from "@/lib/membershipCardSetup";
import { MONTHLY_CARD_SETUP_CONSENT_VERSION } from "@/lib/membershipCardSetupConsent";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function POST(req: NextRequest, { params }: { params: Promise<{ membershipId: string }> }) {
  if (!membershipCardSetupReady()) return Response.json({ error: "Monthly renewal recovery is unavailable. Contact support@creatornet.net." }, { status: 503, headers });
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Sign in to recover your own monthly payment." }, { status: 401, headers });
  try {
    if (req.headers.get("origin") !== membershipServerContext().siteOrigin) return Response.json({ error: "Invalid request origin." }, { status: 403, headers });
    const { membershipId } = await params; assertMembershipId(membershipId);
    const text = await req.text();
    if (text.length > 1024 || new URL(req.url).search || req.headers.get("content-type")?.split(";")[0] !== "application/json")
      return Response.json({ error: "Invalid recovery request." }, { status: 400, headers });
    const body = JSON.parse(text), keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort().join(",") : "";
    const valid = body?.action === "status" && keys === "action" ||
      body?.action === "setup" && keys === "accepted,action,consentVersion" && body.accepted === true && body.consentVersion === MONTHLY_CARD_SETUP_CONSENT_VERSION ||
      body?.action === "verify" && keys === "action,setupId" && typeof body.setupId === "string";
    if (!valid) return Response.json({ error: "Explicit valid card setup action required." }, { status: 400, headers });
    const api = createMembershipRuntime();
    if (body.action === "status") return Response.json(await api.currentRenewalRecovery(membershipId, user.id), { headers });
    if (body.action === "setup") return Response.json(await api.prepareRenewalCardSetup(membershipId, user.id, body.consentVersion, true), { headers });
    assertMembershipId(body.setupId);
    return Response.json(await api.verifyRenewalCardSetup(membershipId, user.id, body.setupId), { headers });
  } catch { return Response.json({ error: "Monthly recovery needs retry or support review. No payment retry was authorized by this action." }, { status: 503, headers }); }
}

