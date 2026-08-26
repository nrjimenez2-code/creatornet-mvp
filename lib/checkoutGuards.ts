// lib/checkoutGuards.ts — ties a checkout to a post that really sells the product.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSafeId } from "@/lib/ids";

/** Sentinel: the caller named a post, and it does not sell this product. */
export const INVALID_POST = Symbol("invalid-post");

/**
 * Decide which post a product purchase unlocks.
 *
 * - If the browser names a post, it must exist, carry this product, and be
 *   owned by the product's creator. Otherwise the checkout is refused. This
 *   is what stops "buy the cheapest product, set post_id to any premium post".
 * - If no post is named, use the creator's own post that sells the product
 *   (if any), so watch access still works for buyers who came in via a
 *   direct product link.
 */
export async function resolvePostForProduct(
  db: SupabaseClient,
  requestedPostId: unknown,
  productId: string,
  creatorId: string
): Promise<string | null | typeof INVALID_POST> {
  if (requestedPostId != null && requestedPostId !== "") {
    if (!isSafeId(requestedPostId)) return INVALID_POST;
    const { data: post } = await db
      .from("posts")
      .select("id, creator_id, product_id")
      .eq("id", requestedPostId)
      .maybeSingle();
    if (!post) return INVALID_POST;
    if (String(post.product_id ?? "") !== productId) return INVALID_POST;
    if (String(post.creator_id ?? "") !== creatorId) return INVALID_POST;
    return String(post.id);
  }

  const { data: post } = await db
    .from("posts")
    .select("id")
    .eq("product_id", productId)
    .eq("creator_id", creatorId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return post ? String(post.id) : null;
}
