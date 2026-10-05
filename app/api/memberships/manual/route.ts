import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertMembershipId } from "@/lib/membershipAgreement";
import { membershipServerContext } from "@/lib/membershipServer";
import { membershipManualBuyerReady } from "@/lib/membershipManualBuyer";
import { createMembershipRuntime } from "@/lib/membershipRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization", "Referrer-Policy": "no-referrer" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });

/** Acceptance returns its identity before selecting a payment source. The client
 * saves that identity before a second request can bootstrap provider resources. */
export async function POST(req: NextRequest) {
  if (!membershipManualBuyerReady()) return json({ error: "Monthly card payment is not enabled." }, 409);
  const user = await getAuthenticatedUser(req);
  if (!user) return json({ error: "Sign in to continue your membership." }, 401);
  try {
    if (req.headers.get("origin") !== membershipServerContext().siteOrigin) return json({ error: "Invalid request origin." }, 403);
    if (req.nextUrl.searchParams.size || req.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
      return json({ error: "Invalid monthly payment request." }, 400);
    const text = await req.text();
    if (text.length > 2048) return json({ error: "Invalid monthly payment request." }, 400);
    let body: Record<string, unknown>;
    try { body = JSON.parse(text); }
    catch { return json({ error: "Invalid monthly payment request." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid monthly payment request." }, 400);
    const api = createMembershipRuntime();
    if (body.action === "select" && Object.keys(body).sort().join(",") === "action,membership_id") {
      assertMembershipId(body.membership_id);
      return json(await api.selectManualFirst(body.membership_id, user.id));
    }
    if (body.action === "accept" && Object.keys(body).sort().join(",") === "action,consent,post_id,product_id") {
      assertMembershipId(body.product_id); assertMembershipId(body.post_id);
      const c = body.consent as Record<string, unknown> | null;
      if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).sort().join(",") !== "accepted,fingerprint,version" ||
        c.accepted !== true || typeof c.version !== "string" || typeof c.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(c.fingerprint)) return json({ error: "Review the current monthly agreement." }, 400);
      return json(await api.accept(user.id, body.product_id, body.post_id,
        { accepted: true, version: c.version as string, fingerprint: c.fingerprint as string }));
    }
    return json({ error: "Invalid monthly payment request." }, 400);
  } catch { return json({ error: "Your original monthly acceptance needs review. Keep its membership reference before another payment." }, 409); }
}
