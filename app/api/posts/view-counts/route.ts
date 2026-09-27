import type { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { isLibraryPurchaseEligible } from "@/lib/libraryAccess";
import { readPostViewCounts } from "@/lib/postViewCountsServer";
import { POST_VIEW_COUNT_BATCH_SIZE } from "@/lib/postViewCounts";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  if (!allowRequest(`post-view-counts:${clientKey(req)}`, { limit: 90, windowMs: 60_000 })) return tooManyRequests();
  const body = await req.json().catch(() => null);
  if (!Array.isArray(body?.postIds) || body.postIds.length > POST_VIEW_COUNT_BATCH_SIZE ||
      body.postIds.some((id: unknown) => typeof id !== "string" || !UUID.test(id)) ||
      (body.purchaseIds !== undefined && (!Array.isArray(body.purchaseIds) ||
        body.purchaseIds.length > POST_VIEW_COUNT_BATCH_SIZE ||
        body.purchaseIds.some((id: unknown) => typeof id !== "string" || !UUID.test(id))))) {
    return Response.json({ error: "Invalid videos." }, { status: 400, headers });
  }
  const ids = [...new Set<string>(body.postIds.map((id: string) => id.toLowerCase()))];
  const purchaseIds = body.purchaseIds === undefined ? null :
    [...new Set<string>(body.purchaseIds.map((id: string) => id.toLowerCase()))];
  if (!ids.length) return Response.json({ items: [] }, { headers });
  try {
    const user = await getAuthenticatedUser(req);
    const result = await supabaseAdmin.from("posts")
      .select("id,creator_id,video_url,active,hidden_at,removed_at").in("id", ids);
    if (result.error) throw result.error;
    const posts = (result.data ?? []).filter(post => !!post.video_url);
    const publicCandidates = posts.filter(post => post.active !== false && post.hidden_at === null && post.removed_at === null);
    const creators = [...new Set(publicCandidates.map(post => post.creator_id).filter(Boolean))];
    const profiles = creators.length ? await supabaseAdmin.from("profiles").select("id,banned_at,username").in("id", creators) : { data: [], error: null };
    if (profiles.error) throw profiles.error;
    const publicCreators = new Set((profiles.data ?? []).filter(profile => profile.banned_at === null && !!profile.username?.trim()).map(profile => profile.id));
    const allowed = new Set(publicCandidates.filter(post => publicCreators.has(post.creator_id)).map(post => post.id));
    if (user) {
      for (const post of posts) if (post.creator_id === user.id && post.removed_at === null) allowed.add(post.id);
      const privateIds = posts.filter(post => !allowed.has(post.id)).map(post => post.id);
      if (privateIds.length && (purchaseIds === null || purchaseIds.length)) {
        // Library supplies the eligible rows it already loaded. Recheck those exact
        // purchases so unrelated retries cannot crowd an older entitlement out of a batch.
        let purchaseQuery = supabaseAdmin.from("purchases").select("id,post_id,buyer_id,status,access_granted")
          .eq("buyer_id", user.id).in("post_id", privateIds);
        if (purchaseIds !== null) purchaseQuery = purchaseQuery.in("id", purchaseIds);
        const purchases = await purchaseQuery.limit(POST_VIEW_COUNT_BATCH_SIZE);
        if (purchases.error) throw purchases.error;
        for (const purchase of purchases.data ?? []) {
          if (!allowed.has(purchase.post_id) && await isLibraryPurchaseEligible(supabaseAdmin, purchase, user.id)) allowed.add(purchase.post_id);
        }
      }
    }
    const authorizedIds = ids.filter(id => allowed.has(id));
    const counts = await readPostViewCounts(supabaseAdmin, authorizedIds);
    return Response.json({ items: authorizedIds.map(post_id => ({ post_id, view_count: counts.get(post_id) ?? null })) }, { headers });
  } catch {
    return Response.json({ error: "Could not load view counts." }, { status: 503, headers });
  }
}
