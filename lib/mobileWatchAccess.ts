import 'server-only';
import { supabaseAdmin } from './supabaseAdmin';
import { isLibraryPurchaseEligible } from './libraryAccess';
import { membershipAccessSeconds, membershipLedgerReady } from './membershipAccess';

export const mobilePostId = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

export async function mobileWatchAccess(postId: string, userId: string) {
  const result = await supabaseAdmin.from('posts')
    .select('id,creator_id,title,video_url,poster_url,premium_path,duration_seconds,hidden_at,removed_at')
    .eq('id', postId).maybeSingle();
  if (result.error) return { status: 503 as const, post: null, accessSeconds: 0 };
  const post = result.data;
  if (!post) return { status: 404 as const, post: null, accessSeconds: 0 };
  if (post.creator_id === userId) return { status: 200 as const, post, accessSeconds: 3600 };

  // A buyer retains access to a paid post after moderation, just as on the
  // website. Each candidate is checked against the current entitlement reader.
  for (let offset = 0; offset < 500; offset += 50) {
    const purchases = await supabaseAdmin.from('purchases')
      .select('id,buyer_id,status,access_granted')
      .eq('buyer_id', userId).eq('post_id', postId)
      .order('created_at', { ascending: false }).range(offset, offset + 49);
    if (purchases.error) return { status: 503 as const, post: null, accessSeconds: 0 };
    for (const purchase of purchases.data ?? []) {
      if (await isLibraryPurchaseEligible(supabaseAdmin, purchase, userId)) {
        const accessSeconds = membershipLedgerReady() ? await membershipAccessSeconds(supabaseAdmin, purchase.id, userId) : 3600;
        if (accessSeconds > 0) return { status: 200 as const, post, accessSeconds };
      }
    }
    if ((purchases.data?.length ?? 0) < 50) break;
  }
  return { status: 402 as const, post: null, accessSeconds: 0 };
}
