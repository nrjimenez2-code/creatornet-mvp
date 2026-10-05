import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertMembershipId } from "@/lib/membershipAgreement";
import { membershipCheckoutReady, membershipServerContext } from "@/lib/membershipServer";
import { createMembershipRuntime } from "@/lib/membershipRuntime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function POST(req: NextRequest) {
  // Existing hosted attempts still recover through their saved IDs. Once the
  // US-card manual buyer path is enabled, do not admit another hosted Session.
  if (process.env.CREATOR_MONTHLY_MANUAL_BUYER_READY === "true")
    return Response.json({ error: "Use the monthly US card payment path for a new membership." }, { status: 409, headers });
  if (!membershipCheckoutReady()) return Response.json({ error: "Monthly checkout is not enabled." }, { status: 409, headers });
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Sign in to purchase this membership." }, { status: 401, headers });
  try {
    if (req.headers.get("origin") !== membershipServerContext().siteOrigin) return Response.json({ error: "Invalid request origin." }, { status: 403, headers });
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["product_id", "post_id", "consent"].includes(key))) throw Error();
    assertMembershipId(body.product_id); assertMembershipId(body.post_id);
    const c = body.consent;
    if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).sort().join(",") !== "accepted,fingerprint,version" ||
      c.accepted !== true || typeof c.version !== "string" || typeof c.fingerprint !== "string") throw Error();
    return Response.json(await createMembershipRuntime().acceptAndPrepare(user.id, body.product_id, body.post_id, c), { headers });
  } catch { return Response.json({ error: "Membership checkout needs retry or review. No new payment identity will be guessed." }, { status: 409, headers }); }
}
