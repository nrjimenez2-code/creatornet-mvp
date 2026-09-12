import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertMembershipId } from "@/lib/membershipAgreement";
import { membershipServerContext } from "@/lib/membershipServer";
import { createMembershipRuntime } from "@/lib/membershipRuntime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function POST(req: NextRequest, { params }: { params: Promise<{ membershipId: string }> }) {
  if (process.env.CREATOR_MONTHLY_MENTORSHIPS_LEDGER_SCHEMA_READY !== "true" || process.env.CREATOR_MONTHLY_MENTORSHIPS_EVENTS_READY !== "true")
    return Response.json({ error: "Monthly reconciliation is not enabled." }, { status: 409, headers });
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Sign in to view this membership." }, { status: 401, headers });
  try {
    if (req.headers.get("origin") !== membershipServerContext().siteOrigin) return Response.json({ error: "Invalid request origin." }, { status: 403, headers });
    const { membershipId } = await params; assertMembershipId(membershipId);
    return Response.json(await createMembershipRuntime().confirmFirst(membershipId, user.id), { headers });
  } catch { return Response.json({ error: "Payment confirmation needs retry or review. Access has not been assumed." }, { status: 503, headers }); }
}
