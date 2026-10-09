import { mobileApi } from '@/lib/mobileApi';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isLibraryPurchaseEligible } from '@/lib/libraryAccess';

export const dynamic = 'force-dynamic';
const pageSize = 50;
const response = (body: unknown, status = 200) => Response.json(body, { status });
type LibraryPost = { id: string; title: string | null; poster_url: string | null; video_url: string | null;
  creator_id: string | null; duration_seconds: number | null };
function linkedPost(value: unknown): LibraryPost | null {
  const post = Array.isArray(value) ? value[0] : value;
  return post && typeof post === 'object' && typeof post.id === 'string' ? post as LibraryPost : null;
}

const handler = mobileApi(async (req, user) => {
  const rawPage = new URL(req.url).searchParams.get('page') ?? '0';
  if (!/^(0|[1-9]\d{0,2})$/.test(rawPage)) return response({ error: 'Invalid page.' }, 400);
  const page = Number(rawPage);
  const purchases = await supabaseAdmin.from('purchases')
    .select('id,buyer_id,post_id,created_at,status,access_granted,posts(id,title,poster_url,video_url,creator_id,duration_seconds)')
    .eq('buyer_id', user!.id).order('created_at', { ascending: false })
    .range(page * pageSize, (page + 1) * pageSize);
  if (purchases.error) return response({ error: 'Could not load your library.' }, 503);
  const rows = (purchases.data ?? []).slice(0, pageSize);
  const eligible = await Promise.all(rows.map(async row => ({ row, post: linkedPost(row.posts),
    allowed: await isLibraryPurchaseEligible(supabaseAdmin, row, user!.id) })));
  const owned = eligible.filter(entry => entry.allowed && entry.row.post_id && entry.post);
  const postIds = [...new Set(owned.map(entry => entry.row.post_id as string))];
  const creatorIds = [...new Set(owned.map(entry => entry.post?.creator_id).filter((id): id is string => !!id))];
  const [progress, creators] = await Promise.all([
    postIds.length ? supabaseAdmin.from('watch_progress').select('post_id,seconds').eq('user_id', user!.id).in('post_id', postIds) : null,
    creatorIds.length ? supabaseAdmin.from('profiles').select('id,username,full_name').in('id', creatorIds) : null,
  ]);
  const seconds = new Map((progress?.data ?? []).map(row => [row.post_id, row.seconds]));
  const names = new Map((creators?.data ?? []).map(row => [row.id, row]));
  const items = owned.map(({ row, post: linked }) => {
    const post = linked!;
    const creator = post.creator_id ? names.get(post.creator_id) : null;
    return { id: row.id, postId: post.id, title: post.title ?? 'Untitled', posterUrl: post.poster_url,
      hasVideo: !!post.video_url, creatorId: post.creator_id, creatorName: creator?.full_name ?? creator?.username ?? null,
      positionSeconds: seconds.get(post.id) ?? null, durationSeconds: post.duration_seconds ?? null };
  });
  return response({ items, nextPage: (purchases.data?.length ?? 0) > pageSize ? page + 1 : null });
}, ['GET']);

export const GET = handler;
export const OPTIONS = handler;
