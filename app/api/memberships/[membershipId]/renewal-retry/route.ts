import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertMembershipId } from "@/lib/membershipAgreement";
import { membershipServerContext } from "@/lib/membershipServer";
import { createMembershipRuntime } from "@/lib/membershipRuntime";
import { membershipRetryReady } from "@/lib/membershipRetry";
import { MONTHLY_RETRY_CONSENT_VERSION, MONTHLY_FUTURE_CARD_CONSENT_VERSION } from "@/lib/membershipRetryConsent";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function POST(req: NextRequest, { params }: { params: Promise<{ membershipId: string }> }) {
  if (!membershipRetryReady()) return Response.json({ error: "Monthly retry recovery is unavailable. Contact support@creatornet.net." }, { status: 503, headers });
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Sign in to recover your own monthly payment." }, { status: 401, headers });
  try {
    if (req.headers.get("origin") !== membershipServerContext().siteOrigin) return Response.json({ error: "Invalid request origin." }, { status: 403, headers });
    const { membershipId } = await params; assertMembershipId(membershipId);
    const text = await req.text();
    if (text.length > 1024 || new URL(req.url).search || req.headers.get("content-type")?.split(";")[0] !== "application/json")
      return Response.json({ error: "Invalid monthly retry request." }, { status: 400, headers });
    const body = JSON.parse(text), keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort().join(",") : "";
    const valid = body?.action === "review" && keys === "action,setupId" && typeof body.setupId === "string" ||
      body?.action === "status" && keys === "action,quoteId" && typeof body.quoteId === "string" ||
      body?.action === "pay" && keys === "accepted,action,consentVersion,futureConsentVersion,quoteId,useFutureCard" &&
        typeof body.quoteId === "string" && body.accepted === true && body.consentVersion === MONTHLY_RETRY_CONSENT_VERSION &&
        typeof body.useFutureCard === "boolean" && (body.useFutureCard ? body.futureConsentVersion === MONTHLY_FUTURE_CARD_CONSENT_VERSION : body.futureConsentVersion === null);
    if (!valid) return Response.json({ error: "Explicit separate monthly retry and future-card choices are required." }, { status: 400, headers });
    const api = createMembershipRuntime();
    if (body.action === "review") { assertMembershipId(body.setupId); return Response.json(await api.reviewRenewalRetry(membershipId, user.id, body.setupId), { headers }); }
    assertMembershipId(body.quoteId);
    if (body.action === "status") return Response.json(await api.checkRenewalRetry(membershipId, user.id, body.quoteId), { headers });
    return Response.json(await api.payRenewalRetry(membershipId, user.id, body.quoteId, body.consentVersion, true, body.useFutureCard, body.futureConsentVersion), { headers });
  } catch { return Response.json({ error: "The original retry could not be verified. Check its payment status before taking further action, or contact support@creatornet.net." }, { status: 503, headers }); }
}
