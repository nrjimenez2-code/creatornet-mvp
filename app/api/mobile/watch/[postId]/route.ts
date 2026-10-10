import type { NextRequest } from 'next/server';
import { mobileApi } from '@/lib/mobileApi';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isOwnPremiumPath } from '@/lib/premiumPath';
import { mobilePostId, mobileWatchAccess } from '@/lib/mobileWatchAccess';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ postId: string }> };
export async function GET(req: NextRequest, context: Context) {
  const { postId } = await context.params;
  return mobileApi(async (_request, user) => {
    if (!mobilePostId(postId)) return Response.json({ error: 'Invalid post.' }, { status: 400 });
    const access = await mobileWatchAccess(postId, user!.id);
    if (!access.post) return Response.json({ error: access.status === 402 ? 'Payment required.' : 'Post unavailable.' }, { status: access.status });
    const post = access.post;
    let downloadUrl: string | null = null;
    let downloadError = false;
    if (post.premium_path) {
      if (!post.creator_id || !isOwnPremiumPath(post.premium_path, post.creator_id)) downloadError = true;
      else {
        const signed = await supabaseAdmin.storage.from('premium').createSignedUrl(post.premium_path, access.accessSeconds);
        downloadUrl = signed.error ? null : signed.data?.signedUrl ?? null;
        downloadError = !downloadUrl;
      }
    }
    return Response.json({ post: { id: post.id, creatorId: post.creator_id, title: post.title,
      videoUrl: post.video_url, posterUrl: post.poster_url, durationSeconds: post.duration_seconds,
      hasDownload: !!post.premium_path }, downloadUrl, downloadError });
  }, ['GET'])(req);
}
export const OPTIONS = mobileApi(async () => new Response(null, { status: 204 }), ['GET']);
