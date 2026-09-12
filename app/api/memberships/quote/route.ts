import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertMembershipId } from "@/lib/membershipAgreement";
import { membershipCheckoutReady } from "@/lib/membershipServer";
import { createMembershipRuntime } from "@/lib/membershipRuntime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function GET(req: NextRequest) {
  if (!membershipCheckoutReady()) return Response.json({ error: "Monthly checkout is not enabled." }, { status: 409, headers });
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Sign in to review this membership." }, { status: 401, headers });
  try {
    const params = new URL(req.url).searchParams, productId = params.get("product_id"), postId = params.get("post_id");
    assertMembershipId(productId); assertMembershipId(postId);
    return Response.json(await createMembershipRuntime().quote(user.id, productId, postId), { headers });
  } catch { return Response.json({ error: "This membership needs review before payment." }, { status: 409, headers }); }
}
