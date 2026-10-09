import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useUser } from '@/lib/useUser';
import { appApi } from '../platform/api';

type Item = { id: string; postId: string; title: string; posterUrl: string | null; hasVideo: boolean;
  creatorId: string | null; creatorName: string | null; positionSeconds: number | null; durationSeconds: number | null };
type Page = { items: Item[]; nextPage: number | null };
const progress = (item: Item) => item.positionSeconds && item.durationSeconds && item.durationSeconds > 0
  ? Math.max(0, Math.min(100, Math.round(item.positionSeconds / item.durationSeconds * 100))) : 0;

function Card({ item }: { item: Item }) {
  const pct = progress(item);
  return <article className="overflow-hidden rounded-xl border border-white/20 bg-[#111]">
    <Link to={`/watch/${encodeURIComponent(item.postId)}`} className="block aspect-[4/3] bg-[#17121e]">
      {item.posterUrl ? <img src={item.posterUrl} alt="" loading="lazy" className="h-full w-full object-cover" /> :
        <div className="flex h-full items-center justify-center text-sm text-white/50">No thumbnail</div>}
    </Link>
    <div className="p-3">
      <h2 className="line-clamp-2 text-sm font-medium">{item.title}</h2>
      {item.creatorId && <Link to={`/creators/${encodeURIComponent(item.creatorId)}`} className="mt-1 block text-xs text-white/60">{item.creatorName ?? 'Creator'}</Link>}
      {pct > 0 && pct < 100 && <div className="mt-3"><div className="h-1.5 rounded bg-white/20"><div className="h-full rounded bg-[#9370DB]" style={{ width: `${pct}%` }} /></div>
        <p className="mt-1 text-xs text-white/50">{Math.floor(item.positionSeconds ?? 0)} of {Math.floor(item.durationSeconds ?? 0)} seconds</p></div>}
      <Link to={`/watch/${encodeURIComponent(item.postId)}`} className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-[#4A35C7] px-4 text-sm font-semibold">{pct > 0 && pct < 95 ? 'Resume' : 'Watch'}</Link>
    </div>
  </article>;
}

export default function Library() {
  const { userId, loading: authLoading } = useUser();
  const [revision, setRevision] = useState(0);
  useEffect(() => { const refresh = () => setRevision(value => value + 1); window.addEventListener('creatornet:refresh', refresh); return () => window.removeEventListener('creatornet:refresh', refresh); }, []);
  if (authLoading) return <main className="app-page" aria-busy="true">Loading your library…</main>;
  if (!userId) return <main className="app-page text-center"><h1>Your Library</h1><p>Sign in to see everything you buy.</p><Link to="/auth" className="app-action app-action-primary">Sign in</Link></main>;
  return <LibraryContent key={`${userId}:${revision}`} retry={() => setRevision(value => value + 1)} />;
}

function LibraryContent({ retry }: { retry: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void appApi.json<Page>('/api/mobile/library?page=0', { signal: controller.signal })
      .then(page => { if (!controller.signal.aborted) { setItems(page.items); setNextPage(page.nextPage); setLoading(false); } })
      .catch(() => { if (!controller.signal.aborted) { setError(true); setLoading(false); } });
    return () => controller.abort();
  }, []);
  const continuing = useMemo(() => items.filter(item => { const pct = progress(item); return pct > 0 && pct < 95; }), [items]);
  const loadMore = async () => {
    if (nextPage === null || moreLoading) return;
    setMoreLoading(true); setError(false);
    try {
      const page = await appApi.json<Page>(`/api/mobile/library?page=${nextPage}`);
      setItems(previous => [...previous, ...page.items]); setNextPage(page.nextPage);
    } catch { setError(true); } finally { setMoreLoading(false); }
  };
  if (loading) return <main className="app-page" aria-busy="true">Loading your library…</main>;
  if (error && !items.length) return <main className="app-page text-center"><h1>Your Library</h1><p role="alert">Couldn’t load your library. Please try again.</p><button type="button" className="app-action" onClick={retry}>Try again</button></main>;
  return <main className="app-page max-w-6xl"><h1>Your Library</h1>
    {items.length === 0 ? <div className="text-center"><p>Videos and offers you buy will show up here.</p><Link to="/dashboard" className="app-action app-action-primary">Explore the feed</Link></div> : <>
      {continuing.length > 0 && <section className="mb-8"><h2 className="mb-3 text-base font-semibold">Continue watching</h2><div className="grid grid-cols-2 gap-3">{continuing.map(item => <Card key={`resume-${item.id}`} item={item} />)}</div></section>}
      <section aria-label="Purchased videos" className="grid grid-cols-2 gap-3">{items.map(item => <Card key={item.id} item={item} />)}</section>
    </>}
    {error && <p role="alert" className="mt-4 text-red-300">Couldn’t load more purchases. Please try again.</p>}
    {nextPage !== null && <button type="button" disabled={moreLoading} className="app-action w-full" onClick={() => void loadMore()}>{moreLoading ? 'Loading…' : 'Load more'}</button>}
  </main>;
}
