import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertMembershipId } from "@/lib/membershipAgreement";
import { membershipManualBuyerRecoveryReady } from "@/lib/membershipManualBuyer";
import { createMembershipRuntime } from "@/lib/membershipRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization", "Referrer-Policy": "no-referrer" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });

/** A bank redirect supplies only the attempt ID. Resolve it through the owned,
 * frozen selection; its query parameters never prove payment or grant access. */
export async function GET(req: NextRequest) {
  if (!membershipManualBuyerRecoveryReady()) return json({ error: "Monthly payment recovery is unavailable." }, 409);
  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: "Sign in to recover your original monthly payment." }, 401);
  try {
    const p = req.nextUrl.searchParams;
    if (p.size !== 1 || !p.has("attempt_id") || req.nextUrl.hash) return json({ error: "Invalid original payment return." }, 400);
    const attemptId = p.get("attempt_id"); assertMembershipId(attemptId);
    const api = createMembershipRuntime();
    // The saved attempt kind, not redirect parameters, selects the recovery page.
    const first = await api.resolveManualPaymentReturn(attemptId, user.id);
    return json(first);
  } catch { return json({ error: "Your original monthly payment needs review. Keep its membership reference; do not start another payment." }, 409); }
}
