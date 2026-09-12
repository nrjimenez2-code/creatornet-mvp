import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertMembershipId } from "@/lib/membershipAgreement";
import { membershipServerContext } from "@/lib/membershipServer";
import { membershipPayoffCheckoutReady, membershipPayoffReconciliationReady } from "@/lib/membershipPayoffRuntime";
import { createMembershipRuntime } from "@/lib/membershipRuntime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
type RouteContext = { params: Promise<{ membershipId: string }> };
export async function GET(req: NextRequest, ctx: RouteContext) {
  if (!membershipPayoffReconciliationReady()) return Response.json({ error: "Payoff handling is unavailable. Contact support@creatornet.net." }, { status: 503, headers });
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Sign in to review your payoff." }, { status: 401, headers });
  try {
    const { membershipId } = await ctx.params; assertMembershipId(membershipId);
    if (new URL(req.url).search) throw Error();
    return Response.json(await createMembershipRuntime().quotePayoff(membershipId, user.id), { headers });
  } catch { return Response.json({ error: "Your payoff needs current payment or balance review. Contact support@creatornet.net." }, { status: 409, headers }); }
}
export async function POST(req: NextRequest, ctx: RouteContext) {
  if (!membershipPayoffReconciliationReady()) return Response.json({ error: "Payoff handling is unavailable. Contact support@creatornet.net." }, { status: 503, headers });
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Sign in to manage your payoff." }, { status: 401, headers });
  try {
    if (req.headers.get("origin") !== membershipServerContext().siteOrigin) return Response.json({ error: "Invalid request origin." }, { status: 403, headers });
    const { membershipId } = await ctx.params; assertMembershipId(membershipId);
    if (new URL(req.url).search) throw Error();
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Error();
    const keys = Object.keys(body).sort().join(",");
    const service = createMembershipRuntime();
    if (body.action === "checkout") {
      if (!membershipPayoffCheckoutReady()) return Response.json({ error: "New payoff checkout is paused." }, { status: 503, headers });
      if (keys !== "action,consent") throw Error();
      const c = body.consent;
      if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).sort().join(",") !== "accepted,fingerprint,version" ||
        c.accepted !== true || typeof c.version !== "string" || typeof c.fingerprint !== "string") throw Error();
      return Response.json(await service.acceptAndPreparePayoff(membershipId, user.id, c), { headers });
    }
    assertMembershipId(body.payoff_id);
    if (body.action === "confirm" && keys === "action,payoff_id") {
      return Response.json(await service.confirmPayoff(membershipId, user.id, body.payoff_id), { headers });
    }
    if (body.action === "abandon" && keys === "action,confirmed,payoff_id" && body.confirmed === true) {
      return Response.json(await service.abandonPayoff(membershipId, user.id, body.payoff_id, true), { headers });
    }
    throw Error();
  } catch { return Response.json({ error: "Payoff action was not confirmed. Retry the same action or contact support; no new payment identity will be guessed." }, { status: 409, headers }); }
}
