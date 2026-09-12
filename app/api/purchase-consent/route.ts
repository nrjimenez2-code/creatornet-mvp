import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { isSafeId } from "@/lib/ids";
import { resolvePostForProduct, INVALID_POST } from "@/lib/checkoutGuards";
import { productPurchaseTerms, type ConsentProduct } from "@/lib/purchaseConsent";
import { purchasePoliciesActive } from "@/lib/purchasePolicies";
import type { NextRequest } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(req: NextRequest) {
  try {
    if (!purchasePoliciesActive(process.env)) return Response.json({ error: "This purchase agreement is not active." }, { status: 409, headers });
    const user = await getAuthenticatedUser(req);
    if (!user) return Response.json({ error: "Sign in to review your purchase." }, { status: 401, headers });
    const params = new URL(req.url).searchParams, productId = params.get("product_id");
    if (!isSafeId(productId)) return Response.json({ error: "Invalid product." }, { status: 400, headers });
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const result = await admin.from("products").select("id,creator_id,title,type,description,price_cents,amount_cents,currency" +
      (process.env.CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY === "true" ? ",membership_terms" : "") +
      (process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY === "true" ? ",fixed_service_months" : ""))
      .eq("id", productId).returns<ConsentProduct[]>().maybeSingle();
    if (result.error || !result.data) return Response.json({ error: "Offer not available." }, { status: 404, headers });
    const product = result.data;
    if (product.fixed_service_months != null && process.env.CREATOR_FIXED_SERVICE_ONE_TIME_READY !== "true") {
      return Response.json({ error: "This fixed-service purchase agreement is not active." }, { status: 409, headers });
    }
    const postId = await resolvePostForProduct(admin, params.get("post_id"), product.id, product.creator_id || "");
    if (postId === INVALID_POST) return Response.json({ error: "This post does not sell that offer." }, { status: 400, headers });
    return Response.json(productPurchaseTerms(product, user.id, postId), { headers });
  } catch {
    return Response.json({ error: "This offer needs review before payment." }, { status: 409, headers });
  }
}
