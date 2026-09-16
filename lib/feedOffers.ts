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
export async function loadFeedOffers(posts: PostRow[], signal?: AbortSignal): Promise<PostRow[]> {
  if (!posts.length) return posts;
  let offers: Record<string, FeedOffer | null> = {};
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(abort, 10000);
  try {
    controller.signal.throwIfAborted();
    const res = await fetch(`/api/posts/feed-offers?${new URLSearchParams({ ids: posts.map(p => p.id).join(",") })}`,
      { credentials: "include", cache: "no-store", signal: controller.signal });
    if (!res.ok) {
      // A fetch resolves at headers. Keep this read's slot/deadline until its
      // rejected body's cancellation actually settles, not just until headers.
      await res.body?.cancel();
      throw Error("Purchase options unavailable");
    }
    const body = await res.json();
    controller.signal.throwIfAborted();
    offers = body.offers ?? {};
  } catch { controller.abort(); /* Unknown paid offers stay disabled; stop any remaining body work. */ }
  finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); }
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
