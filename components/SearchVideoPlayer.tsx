"use client";

import { useEffect, useRef, useState } from "react";
import BackButton from "@/components/BackButton";
import VideoCard from "@/components/VideoCard";
import { isWithinRenderWindow, type PostRow } from "@/lib/feedV3";
import { loadSearchVideos } from "@/lib/searchVideoPlayer";
import { normalizeCategory } from "@/lib/posthog";
import type { SearchPost } from "@/lib/searchTypes";

type Props = {
  posts: SearchPost[];
  initialIndex: number;
  onClose: () => void;
  onDeleted: (id: string) => void;
  hasMore: boolean;
  loading: boolean;
  error: string;
  loadMore: () => void;
  retry: () => void;
};

export default function SearchVideoPlayer({ posts, initialIndex, onClose, onDeleted, hasMore, loading, error, loadMore, retry }: Props) {
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [metadata, setMetadata] = useState<Record<string, PostRow | null>>({});
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const aligned = useRef(false);
  const requestedLength = useRef(-1);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const overflow = document.body.style.overflow;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const trigger = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === "Tab" && dialogRef.current?.contains(document.activeElement)) {
        const controls = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]',
        )).filter(element => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      // A route navigation (e.g. to the creator) owns its own scroll position.
      if (trigger?.isConnected) {
        trigger.focus({ preventScroll: true });
        window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
      }
    };
  }, []);

  useEffect(() => {
    if (aligned.current) return;
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current;
      const item = itemRefs.current[initialIndex];
      if (!container || !item) return;
      // Scroll only the overlay, never the search page behind it.
      container.scrollTo({ top: item.offsetTop - (container.clientHeight - item.offsetHeight) / 2, behavior: "instant" });
      aligned.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [initialIndex]);

  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      if (!aligned.current) return;
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) setActiveIndex(Number((visible.target as HTMLElement).dataset.index));
    }, { root: containerRef.current, threshold: 0.65 });
    itemRefs.current.forEach(item => item && observer.observe(item));
    return () => observer.disconnect();
  }, [posts.length]);

  useEffect(() => {
    if (activeIndex < posts.length - 2 || !hasMore || loading || error || requestedLength.current === posts.length) return;
    requestedLength.current = posts.length;
    loadMore();
  }, [activeIndex, posts.length, hasMore, loading, error, loadMore]);

  useEffect(() => {
    const pending = posts.filter((post, index) => isWithinRenderWindow(index, activeIndex) && !(post.id in metadata));
    if (!pending.length) return;
    let cancelled = false;
    setLoadError(false);
    loadSearchVideos(pending).then(rows => {
      if (cancelled) return;
      const loaded = new Map(rows.map(row => [row.id, row]));
      setMetadata(previous => ({ ...previous, ...Object.fromEntries(pending.map(post => [post.id, loaded.get(post.id) ?? null])) }));
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [posts, activeIndex, metadata, attempt]);

  return <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Search videos" tabIndex={-1}
    className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm outline-none">
    <div className="absolute top-5 md:top-4 left-4 z-10 [&>div]:mb-0">
      <BackButton onClick={onClose} className="inline-flex h-10 w-10 items-center justify-center text-white mix-blend-difference" />
    </div>
    <button type="button" aria-label="Close video player" onClick={onClose} className="absolute top-5 right-4 z-10 h-10 w-10 rounded-full bg-black/60 text-white">✕</button>
    <div ref={containerRef} className="relative h-full overflow-y-auto overscroll-contain px-4 py-8 space-y-10 snap-y snap-mandatory scroll-smooth">
      {posts.map((result, index) => {
        const post = metadata[result.id];
        return <div key={result.id} data-index={index} ref={element => { itemRefs.current[index] = element; }} className="max-w-4xl mx-auto text-white snap-center">
          <div className="mx-auto w-full max-w-[420px]">
            {isWithinRenderWindow(index, activeIndex) && post ? <VideoCard
              postId={post.id} src={post.video_url || undefined} poster={post.poster_url}
              isActive={index === activeIndex} creatorId={post.creator_id}
              creatorUsername={post.creator_username} creatorName={post.creator_name || result.creator.username}
              creatorAvatarUrl={post.creator_avatar_url} caption={post.content ?? post.title ?? ""} title={post.title ?? post.content ?? ""}
              hashtagsList={post.hashtags ?? post.interests ?? []}
              likes={post.likes_count ?? 0} comments={post.comments_count ?? 0} shares={post.shares_count ?? 0} isLiked={post.is_liked === true}
              postCategory={normalizeCategory(post.interests?.[0] ?? null)}
              productId={post.product_id} productType={post.product_type} monthlyTerms={post.monthlyTerms}
              purchaseOptionsReady={post.purchaseOptionsReady === true} priceCents={post.price_cents}
              allowBooking={!!post.allow_booking} bookingRedirectUrl={post.allow_booking ? post.booking_url : null}
              onDeleted={() => { onDeleted(post.id); onClose(); }}
            /> : <div className="relative w-full lg:w-[420px] max-lg:h-[calc(100dvh-56px)] lg:h-[100dvh] lg:min-h-[100dvh] bg-black flex items-center justify-center">
              {isWithinRenderWindow(index, activeIndex) && <div className="text-center text-white/70" role="status">
                {post === null ? "This video is no longer available." : loadError ? <><p>Couldn’t load this video.</p><button onClick={() => setAttempt(value => value + 1)} className="mt-3 underline">Try again</button></> : "Loading video…"}
              </div>}
            </div>}
          </div>
        </div>;
      })}
      {hasMore && <div className="snap-center text-center pb-10 text-white">
        {error && <p role="alert">{error}</p>}
        <button disabled={loading} onClick={error ? retry : loadMore} className="rounded-full border border-white/25 px-6 py-3 disabled:opacity-50">
          {loading ? "Loading videos…" : error ? "Try again" : "Load more videos"}
        </button>
      </div>}
    </div>
  </div>;
}
