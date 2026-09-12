import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { onlyVisiblePosts } from "@/lib/visiblePosts";
import { membershipCommitment, readMonthlyMentorshipTerms } from "@/lib/membershipTerms";
import { resolvePriceCents } from "@/lib/offers";
import type { FeedOffer } from "@/lib/feedOffers";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Public display metadata only. Review/checkout still verify auth and current terms. */
export async function GET(req: Request) {
  const ids = [...new Set((new URL(req.url).searchParams.get("ids") ?? "").split(",").filter(Boolean))];
  if (!ids.length || ids.length > 100 || ids.some(id => id.length > 128)) {
    return Response.json({ error: "Invalid posts." }, { status: 400, headers });
  }
  try {
    const posts = await onlyVisiblePosts(supabaseAdmin.from("posts").select("id,product_id,creator_id").in("id", ids));
    if (posts.error) throw posts.error;
    const productIds = [...new Set((posts.data ?? []).map(p => p.product_id).filter((id): id is string => !!id))];
    const offers: Record<string, FeedOffer | null> = Object.fromEntries(ids.map(id => [id, null]));
    if (!productIds.length) return Response.json({ offers }, { headers });
    const monthly = process.env.CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY === "true";
    const fixed = process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY === "true";
    // Literal branches keep optional schema columns out of older installations.
    const products = () => monthly
      ? fixed
        ? supabaseAdmin.from("products").select("id,product_id,creator_id,type,active,amount_cents,price_cents,membership_terms,fixed_service_months")
        : supabaseAdmin.from("products").select("id,product_id,creator_id,type,active,amount_cents,price_cents,membership_terms")
      : fixed
        ? supabaseAdmin.from("products").select("id,product_id,creator_id,type,active,amount_cents,price_cents,fixed_service_months")
        : supabaseAdmin.from("products").select("id,product_id,creator_id,type,active,amount_cents,price_cents");
    const [direct, aliases] = await Promise.all([products().in("id", productIds), products().in("product_id", productIds)]);
    if (direct.error || aliases.error) throw direct.error || aliases.error;
    const rows = [...(direct.data ?? []), ...(aliases.data ?? [])];
    for (const post of posts.data ?? []) {
      const product = rows.find(p => p.id === post.product_id) ?? rows.find(p => p.product_id === post.product_id);
      if (!product || product.creator_id !== post.creator_id || product.active === false) continue;
      try {
        const terms = readMonthlyMentorshipTerms("membership_terms" in product ? product.membership_terms : null, product.type);
        if (terms && "fixed_service_months" in product && product.fixed_service_months != null) continue;
        const priceCents = resolvePriceCents(product);
        if (terms) {
          if (priceCents === null) continue;
          membershipCommitment(priceCents, terms);
        }
        offers[post.id] = { productId: product.id, linkedProductId: post.product_id!, creatorId: post.creator_id!,
          productType: product.type, priceCents, monthlyTerms: terms };
      } catch { /* Malformed monthly offers must never become ordinary Buy. */ }
    }
    return Response.json({ offers }, { headers });
  } catch {
    return Response.json({ error: "Could not load purchase options." }, { status: 503, headers });
  }
}
