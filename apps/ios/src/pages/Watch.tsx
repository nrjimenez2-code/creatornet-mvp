import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useUser } from '@/lib/useUser';
import { bindWatchProgress } from '@/lib/watchProgress';
import { useSoundPreference } from '@/lib/audioPreference';
import { appApi } from '../platform/api';
import { openSystemBrowser } from '../platform/systemBrowser';

type WatchData = { post: { id: string; creatorId: string | null; title: string | null; videoUrl: string | null;
  posterUrl: string | null; durationSeconds: number | null; hasDownload: boolean };
  downloadUrl: string | null; downloadError: boolean };

export default function Watch() {
  const { postId } = useParams();
  const { userId, loading: authLoading } = useUser();
  const [revision, setRevision] = useState(0);
  useEffect(() => { const refresh = () => setRevision(value => value + 1);
    window.addEventListener('creatornet:refresh', refresh); return () => window.removeEventListener('creatornet:refresh', refresh); }, []);
  if (authLoading) return <main className="app-page" aria-busy="true">Loading…</main>;
  if (!userId) return <main className="app-page"><h1>Watch</h1><p>Sign in to see your purchases.</p><Link to="/auth" className="app-action app-action-primary">Sign in</Link></main>;
  if (!postId) return <main className="app-page"><p role="alert">Invalid video.</p><Link to="/library" className="app-action">Back to Library</Link></main>;
  return <WatchContent key={`${userId}:${postId}:${revision}`} postId={postId} retry={() => setRevision(value => value + 1)} />;
}

function WatchContent({ postId, retry }: { postId: string; retry: () => void }) {
  const [data, setData] = useState<WatchData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [soundOn] = useSoundPreference();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void appApi.json<WatchData>(`/api/mobile/watch/${encodeURIComponent(postId)}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(() => { if (!controller.signal.aborted) setError('Could not open this video. Please check access and try again.'); });
    return () => controller.abort();
  }, [postId]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !data?.post.videoUrl) return;
    const stop = () => { if (document.hidden) video.pause(); };
    document.addEventListener('visibilitychange', stop);
    const unbind = bindWatchProgress(video, data.post.id);
    return () => { video.pause(); unbind(); document.removeEventListener('visibilitychange', stop); };
  }, [data]);
  useEffect(() => { if (videoRef.current) videoRef.current.muted = !soundOn; }, [data, soundOn]);
  if (error) return <main className="app-page"><p role="alert">{error}</p><button type="button" className="app-action" onClick={retry}>Try again</button><Link to="/library" className="app-action">Back to Library</Link></main>;
  if (!data) return <main className="app-page" aria-busy="true">Checking your access…</main>;
  const { post } = data;
  return <main className="app-page max-w-3xl">
    <Link to="/library" className="mb-4 inline-flex min-h-11 items-center text-sm text-white/70">← Back to Library</Link>
    <h1>{post.title || 'Video'}</h1>
    <div className="overflow-hidden rounded-xl border border-white/20 bg-black">
      {post.videoUrl ? <video key={post.id} ref={videoRef} src={post.videoUrl} poster={post.posterUrl ?? undefined}
        aria-label={post.title || 'Video'} controls playsInline preload="metadata" className="aspect-video w-full object-contain" /> :
        post.posterUrl ? <img src={post.posterUrl} alt={post.title || 'Video'} className="aspect-video w-full object-contain" /> :
          <div className="flex aspect-video items-center justify-center text-white/60">No video available</div>}
    </div>
    {post.creatorId && <Link to={`/creators/${encodeURIComponent(post.creatorId)}`} className="mt-4 inline-flex min-h-11 items-center text-sm underline">View creator</Link>}
    {data.downloadUrl && <section className="mt-4 rounded-xl border border-white/20 bg-white/5 p-4"><h2 className="font-semibold">Your download is ready</h2><p className="mt-1 text-xs text-white/60">This private link expires after your current access period. Open again for a fresh one.</p>
      <button type="button" className="app-action app-action-primary" onClick={() => { void openSystemBrowser(data.downloadUrl!); }}>Open download</button></section>}
    {data.downloadError && <p role="alert" className="mt-4 text-amber-200">Your download could not be prepared. Try opening this video again.</p>}
    {!post.hasDownload && <p className="mt-4 text-sm text-white/60">No separate download for this one. The video above is included with your purchase.</p>}
  </main>;
}
