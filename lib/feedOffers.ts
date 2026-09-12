import { readMonthlyMentorshipTerms, type MonthlyMentorshipTerms } from "@/lib/membershipTerms";
import type { PostRow } from "@/lib/feedV3";

export type FeedOffer = {
  productId: string;
  linkedProductId: string;
  creatorId: string;
  productType: string | null;
  priceCents: number | null;
  monthlyTerms: MonthlyMentorshipTerms | null;
};

/** The deployed feed RPC predates monthly columns. Enrich without changing its schema. */
export async function loadFeedOffers(posts: PostRow[]): Promise<PostRow[]> {
  if (!posts.length) return posts;
  let offers: Record<string, FeedOffer | null> = {};
  try {
    const res = await fetch(`/api/posts/feed-offers?${new URLSearchParams({ ids: posts.map(p => p.id).join(",") })}`,
      { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw Error("Purchase options unavailable");
    offers = (await res.json()).offers ?? {};
  } catch { /* Keep media/Book usable; an unknown paid offer stays disabled. */ }
  return posts.map(post => {
    const blocked = { ...post, monthlyTerms: null, purchaseOptionsReady: false };
    const offer = offers[post.id];
    if (!offer || offer.creatorId !== post.creator_id ||
        (post.product_id && post.product_id !== offer.linkedProductId && post.product_id !== offer.productId)) return blocked;
    try {
      const monthlyTerms = readMonthlyMentorshipTerms(offer.monthlyTerms, offer.productType);
      return { ...post, product_id: offer.productId, product_type: offer.productType,
        // Monthly agreement pricing is product-derived, never a stale post override.
        price_cents: monthlyTerms ? offer.priceCents : post.price_cents,
        monthlyTerms, purchaseOptionsReady: true };
    } catch { return blocked; }
  });
}
