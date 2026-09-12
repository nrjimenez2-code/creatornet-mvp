import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertAgreementId } from "@/lib/installments/agreementStore";
import { buyerRecoveryEnabled, parseBuyerRecoveryInput } from "@/lib/installments/buyerRecovery";
import { buyerRecoveryController } from "@/lib/installments/buyerRecoveryServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status,
  headers: { "Cache-Control": "private, no-store", "Vary": "Cookie, Authorization", "Referrer-Policy": "no-referrer" } });
export async function GET(req: NextRequest) {
  if (!buyerRecoveryEnabled(process.env)) return json({ error: "Payment recovery is unavailable." }, 404);
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: "Sign in to review your payment." }, 401);
    const agreementId = req.nextUrl.searchParams.get("agreementId") || "";
    try { assertAgreementId(agreementId); } catch { return json({ error: "Invalid payment review." }, 400); }
    return json({ view: await buyerRecoveryController().read(agreementId, user.id) });
  } catch { return json({ error: "Payment recovery could not be loaded." }, 404); }
}
export async function POST(req: NextRequest) {
  if (!buyerRecoveryEnabled(process.env)) return json({ error: "Payment recovery is unavailable." }, 404);
  if (req.headers.get("origin") !== process.env.NEXT_PUBLIC_SITE_URL || req.nextUrl.origin !== process.env.NEXT_PUBLIC_SITE_URL)
    return json({ error: "Invalid request origin." }, 403);
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: "Sign in to review your payment." }, 401);
    if (!/^application\/json(?:;|$)/i.test(req.headers.get("content-type") || "")) return json({ error: "Invalid request." }, 400);
    let input;
    try {
      const raw = await req.text();
      input = raw.length <= 4096 ? parseBuyerRecoveryInput(JSON.parse(raw)) : null;
    } catch { input = null; }
    if (!input) return json({ error: "Review and confirm the requested action." }, 400);
    const result = await buyerRecoveryController().act(input, user.id);
    return json(result, result.status === "payment_confirmation_recorded" ? 202 : 200);
  } catch {
    // A lost response may follow saved consent or card setup. Never promise no
    // change, expose provider errors, or instruct the buyer to create a new ID.
    return json({ error: "This request needs review. Refresh payment recovery before continuing. A payment is not confirmed by this message." }, 409);
  }
}
