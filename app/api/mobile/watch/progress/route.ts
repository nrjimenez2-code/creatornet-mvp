import { mobileApi } from '@/lib/mobileApi';
import { mobilePostId, mobileWatchAccess } from '@/lib/mobileWatchAccess';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
const handler = mobileApi(async (req, user) => {
  const body = req.method === 'POST' ? await req.json().catch(() => null) : null;
  const postId = req.method === 'POST' ? body?.post_id : new URL(req.url).searchParams.get('post_id');
  if (typeof postId !== 'string' || !mobilePostId(postId)) return Response.json({ error: 'Invalid post.' }, { status: 400 });
  if (req.method === 'POST' && (typeof body?.seconds !== 'number' || !Number.isFinite(body.seconds) || body.seconds < 0 ||
      typeof body.duration !== 'number' || !Number.isFinite(body.duration) || body.duration <= 0 || body.duration > 86400)) {
    return Response.json({ error: 'Invalid progress.' }, { status: 400 });
  }
  const access = await mobileWatchAccess(postId, user!.id);
  if (!access.post) return Response.json({ error: 'Post unavailable.' }, { status: access.status });
  if (req.method === 'GET') {
    const found = await supabaseAdmin.from('watch_progress').select('seconds,updated_at')
      .eq('user_id', user!.id).eq('post_id', postId).maybeSingle();
    if (found.error) return Response.json({ error: 'Could not load progress.' }, { status: 503 });
    return Response.json({ progress: found.data ?? null });
  }
  const saved = await supabaseAdmin.from('watch_progress').upsert({ user_id: user!.id, post_id: postId,
    seconds: Math.min(body.seconds, body.duration), updated_at: new Date().toISOString() }, { onConflict: 'user_id,post_id' });
  if (saved.error) return Response.json({ error: 'Could not save progress.' }, { status: 503 });
  return Response.json({ ok: true });
}, ['GET', 'POST']);
export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
