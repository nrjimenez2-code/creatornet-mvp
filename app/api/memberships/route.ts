import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { membershipServerClients } from "@/lib/membershipServer";
import { decodeMembershipCursor, listManagedMemberships, membershipManagementReady, type MembershipView } from "@/lib/membershipManagement";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(req: NextRequest) {
  if (!membershipManagementReady()) return Response.json({ error: "Membership management is unavailable. Contact support@creatornet.net." }, { status: 503, headers });
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Sign in to manage your mentorships." }, { status: 401, headers });
  try {
    const search = new URL(req.url).searchParams, view = search.get("view") || "buyer";
    if (![...search.keys()].every(key => ["view", "cursor"].includes(key)) || search.getAll("view").length > 1 ||
      search.getAll("cursor").length > 1 || !["buyer", "creator"].includes(view)) return Response.json({ error: "Invalid membership view." }, { status: 400, headers });
    const cursor = decodeMembershipCursor(search.get("cursor")), { admin, context } = membershipServerClients();
    return Response.json(await listManagedMemberships(admin, context, user.id, view as MembershipView, cursor), { headers });
  } catch { return Response.json({ error: "Membership details need refresh or support review." }, { status: 409, headers }); }
}
