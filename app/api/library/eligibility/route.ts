import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isLibraryPurchaseEligible } from "@/lib/libraryAccess";
import { premiumSchemaReady } from "@/lib/premiumReadiness";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return Response.json({ error: "Sign in to view your library." }, { status: 401, headers });
  try {
    const { purchaseIds } = await req.json();
    if (!Array.isArray(purchaseIds) || purchaseIds.length > 100 ||
        purchaseIds.some(id => typeof id !== "string" || !id || id.length > 128)) {
      return Response.json({ error: "Invalid purchases." }, { status: 400, headers });
    }
    if (!purchaseIds.length) return Response.json({ purchaseIds: [], premiumDelivery: premiumSchemaReady() }, { headers });
    const result = await supabaseAdmin.from("purchases").select("id,buyer_id,status,access_granted,payment_intent_id")
      .eq("buyer_id", user.id).in("id", purchaseIds);
    if (result.error) throw result.error;
    const allowed: string[] = [];
    for (const row of result.data ?? []) {
      const eligible = await isLibraryPurchaseEligible(supabaseAdmin, row, user.id);
      if (eligible) allowed.push(row.id);
    }
    return Response.json({ purchaseIds: allowed, premiumDelivery: premiumSchemaReady() }, { headers });
  } catch {
    return Response.json({ error: "Could not check library access." }, { status: 503, headers });
  }
}
