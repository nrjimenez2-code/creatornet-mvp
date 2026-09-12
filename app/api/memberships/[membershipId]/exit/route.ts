import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertMembershipId } from "@/lib/membershipAgreement";
import { membershipExitReady } from "@/lib/membershipExit";
import { membershipServerContext } from "@/lib/membershipServer";
import { createMembershipRuntime } from "@/lib/membershipRuntime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
type RouteContext = { params: Promise<{ membershipId: string }> };
export async function GET(req: NextRequest, ctx: RouteContext) {
  if (!membershipExitReady()) return Response.json({ error: "Monthly exit handling is unavailable. Contact support@creatornet.net." }, { status: 503, headers });
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Sign in to manage your membership." }, { status: 401, headers });
  try {
    const { membershipId } = await ctx.params; assertMembershipId(membershipId);
    if (new URL(req.url).search) throw Error();
    return Response.json(await createMembershipRuntime().quoteExit(membershipId, user.id), { headers });
  } catch { return Response.json({ error: "Your exit quote needs refresh or support review." }, { status: 409, headers }); }
}
export async function POST(req: NextRequest, ctx: RouteContext) {
  if (!membershipExitReady()) return Response.json({ error: "Monthly exit handling is unavailable. Contact support@creatornet.net." }, { status: 503, headers });
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Sign in to manage your membership." }, { status: 401, headers });
  try {
    if (req.headers.get("origin") !== membershipServerContext().siteOrigin) return Response.json({ error: "Invalid request origin." }, { status: 403, headers });
    const { membershipId } = await ctx.params; assertMembershipId(membershipId);
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || body.accepted !== true ||
      !["stop_renewal", "revoke_debits"].includes(body.kind) || new URL(req.url).search ||
      Object.keys(body).some(key => !["kind", "accepted", "quote"].includes(key)) ||
      (body.kind === "revoke_debits" && body.quote != null) || (body.kind === "stop_renewal" && !body.quote)) throw Error();
    const result = await createMembershipRuntime().requestExit(membershipId, user.id, body.kind, true, body.quote ?? null);
    return Response.json(result, { status: result.providerStopped ? 200 : 202, headers });
  } catch { return Response.json({ error: "Exit request was not confirmed. Refresh the quote or contact support; do not assume a payoff or cancellation." }, { status: 409, headers }); }
}
