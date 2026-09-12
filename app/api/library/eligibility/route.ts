import type { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { membershipAccessSeconds, membershipLedgerReady } from "@/lib/membershipAccess";

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
    if (!purchaseIds.length) return Response.json({ purchaseIds: [] }, { headers });
    const result = await supabaseAdmin.from("purchases").select("id,buyer_id,status,access_granted")
      .eq("buyer_id", user.id).in("id", purchaseIds);
    if (result.error) throw result.error;
    const allowed: string[] = [];
    for (const row of result.data ?? []) {
      if (row.buyer_id !== user.id) continue;
      // Preserve the legacy listing's status restriction. Timed purchases are
      // instead governed by their current paid entitlement, including paid exit.
      if (row.access_granted === true && !["paid", "active", "complete"].includes(row.status ?? "")) continue;
      const eligible = membershipLedgerReady()
        ? await membershipAccessSeconds(supabaseAdmin, row.id, user.id) > 0
        : row.access_granted === true;
      if (eligible) allowed.push(row.id);
    }
    return Response.json({ purchaseIds: allowed }, { headers });
  } catch {
    return Response.json({ error: "Could not check library access." }, { status: 503, headers });
  }
}
