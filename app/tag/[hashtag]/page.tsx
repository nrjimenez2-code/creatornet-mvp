"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import BackButton from "@/components/BackButton";
import VideoCard from "@/components/VideoCard";
import { normalizeCategory } from "@/lib/posthog";

type ApiTagPost = {
  id: string;
  title: string | null;
  content: string | null;
  video_url: string | null;
  poster_url: string | null;
  interests: string[] | null;
  hashtags: string[] | null;
  creator_id: string;
  product_id?: string | null;
  price_cents?: number | null;
  allow_booking?: boolean | null;
  booking_url?: string | null;
  product_type?: string | null;
  likes_count?: number | null;
  comments_count?: number | null;
  shares_count?: number | null;
  purchase_count?: number | null;
  creator?: {
    username: string | null;
    full_name: string | null;
    avatar_url: string | null;
  } | null;
};

const PAGE_SIZE = 12;

export default function TagFeedPage() {
  const params = useParams<{ hashtag: string }>();
  const hashtag = decodeURIComponent(params?.hashtag ?? "").trim().toLowerCase();

  const [items, setItems] = useState<ApiTagPost[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const modalScrollRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const alignedRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const modalWheelLockRef = useRef(false);
  const modalTouchStartYRef = useRef<number | null>(null);

  // On mobile browsers (especially iOS Safari), <video> tiles without a
  // poster stay black until user interaction. Seek to a tiny offset once
  // metadata is available so the first frame paints as a thumbnail.
  const primeVideoThumbnail = useCallback((videoEl: HTMLVideoElement | null) => {
    if (!videoEl) return;
    const onLoadedMetadata = () => {
      try {
        if (videoEl.readyState >= 1 && videoEl.currentTime === 0) {
          videoEl.currentTime = 0.01;
        }
      } catch {
        // Ignore seek errors for unsupported streams/codecs.
      }
    };
    videoEl.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
  }, []);

  const loadPage = useCallback(
    async (nextOffset: number, append: boolean) => {
      if (!hashtag) return;
      if (append) setLoadingMore(true);
      else setLoading(true);

      try {
        const res = await fetch(
          `/api/tag/${encodeURIComponent(hashtag)}?offset=${nextOffset}&limit=${PAGE_SIZE}`,
          { credentials: "include" }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }

        const fetched: ApiTagPost[] = Array.isArray(data?.items) ? data.items : [];
        setItems((prev) => (append ? [...prev, ...fetched] : fetched));
        setOffset(typeof data?.nextOffset === "number" ? data.nextOffset : nextOffset + fetched.length);
        setHasMore(Boolean(data?.hasMore));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load tag feed.");
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [hashtag]
  );

  useEffect(() => {
    setItems([]);
    setOffset(0);
    setHasMore(true);
    setError(null);
    setIsOpen(false);
    setActiveIndex(0);
    loadPage(0, false);
  }, [hashtag, loadPage]);

  useEffect(() => {
    if (!hasMore || loading || loadingMore) return;
    const node = sentinelRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first?.isIntersecting) {
          loadPage(offset, true);
        }
      },
      { rootMargin: "320px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, offset, loadPage]);

  useEffect(() => {
    if (!isOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", onEsc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onEsc);
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || alignedRef.current) return;
    const child = itemRefs.current[activeIndex];
    if (child) {
      requestAnimationFrame(() => {
        child.scrollIntoView({ block: "center" });
        alignedRef.current = true;
      });
    }
  }, [isOpen, activeIndex]);

  const openModal = (index: number) => {
    setActiveIndex(index);
    alignedRef.current = false;
    setIsOpen(true);
  };

  const closeModal = () => {
    setIsOpen(false);
    alignedRef.current = false;
    const tile = gridRef.current?.children?.[activeIndex] as HTMLElement | undefined;
    if (tile) {
      requestAnimationFrame(() => {
        tile.scrollIntoView({ block: "center" });
        tile.focus?.();
      });
    }
  };

  const scrollModalToIndex = useCallback((index: number) => {
    const safeIndex = Math.max(0, Math.min(items.length - 1, index));
    const node = itemRefs.current[safeIndex];
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    setActiveIndex(safeIndex);
  }, [items.length]);

  const modalStepScrollWithLock = useCallback((direction: "up" | "down") => {
    if (modalWheelLockRef.current) return;
    modalWheelLockRef.current = true;
    const nextIndex = direction === "down" ? activeIndex + 1 : activeIndex - 1;
    scrollModalToIndex(nextIndex);
    window.setTimeout(() => {
      modalWheelLockRef.current = false;
    }, 520);
  }, [activeIndex, scrollModalToIndex]);

  const handleModalWheelStep = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!isOpen || !items.length) return;
      if (Math.abs(e.deltaY) < 8) return;
      e.preventDefault();
      modalStepScrollWithLock(e.deltaY > 0 ? "down" : "up");
    },
    [isOpen, items.length, modalStepScrollWithLock]
  );

  const handleModalKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isOpen || !items.length) return;
      if (e.key === "ArrowDown" || e.key === "PageDown") {
        e.preventDefault();
        modalStepScrollWithLock("down");
      } else if (e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        modalStepScrollWithLock("up");
      }
    },
    [isOpen, items.length, modalStepScrollWithLock]
  );

  const handleModalTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    modalTouchStartYRef.current = e.touches[0]?.clientY ?? null;
  }, []);

  const handleModalTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const startY = modalTouchStartYRef.current;
      const endY = e.changedTouches[0]?.clientY ?? null;
      modalTouchStartYRef.current = null;
      if (startY == null || endY == null) return;
      const deltaY = startY - endY;
      if (Math.abs(deltaY) < 42) return;
      modalStepScrollWithLock(deltaY > 0 ? "down" : "up");
    },
    [modalStepScrollWithLock]
  );

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="max-w-6xl mx-auto px-4 py-4 md:py-6 space-y-4 relative">
        <div className="fixed top-4 md:top-6 left-2 sm:left-3 md:left-4 z-20">
          <BackButton hrefOverride="/dashboard" />
        </div>

        <header className="space-y-1 pl-12 sm:pl-14 md:pl-16 lg:pl-0">
          <h1 className="text-2xl md:text-3xl font-semibold">#{hashtag || "tag"}</h1>
          <p className="text-sm text-white/60">Videos tagged with this hashtag</p>
        </header>

        {loading ? (
          <div className="py-12 text-center text-white/60">Loading tag feed...</div>
        ) : error ? (
          <div className="py-10 text-center">
            <p className="text-red-300 text-sm">{error}</p>
            <Link
              href={`/tag/${encodeURIComponent(hashtag)}`}
              className="inline-block mt-3 text-sm underline text-white/80"
            >
              Retry
            </Link>
          </div>
        ) : items.length === 0 ? (
          <div className="py-10 text-center text-white/60">No posts found for #{hashtag}.</div>
        ) : (
          <div
            ref={gridRef}
            className="grid grid-cols-2 gap-0 sm:grid-cols-3 lg:grid-cols-4"
          >
            {items.map((p, index) => (
              <button
                key={p.id}
                type="button"
                onClick={() => openModal(index)}
                aria-label={`Open post: ${p.title || p.content || "untitled"}`}
                className="group relative flex aspect-square items-center justify-center overflow-hidden bg-white/5 border border-white/10 transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
              >
                {p.poster_url ? (
                  <img
                    src={p.poster_url}
                    alt=""
                    className="h-full w-full object-cover transition group-hover:scale-105"
                    loading="lazy"
                  />
                ) : p.video_url ? (
                  <video
                    ref={primeVideoThumbnail}
                    src={p.video_url}
                    className="h-full w-full object-cover transition group-hover:scale-105"
                    muted
                    loop
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  <div className="text-xs text-white/60">No media</div>
                )}
              </button>
            ))}
            <div ref={sentinelRef} className="h-8 col-span-full" />
            {loadingMore && (
              <div className="pb-8 text-center text-sm text-white/60 col-span-full">Loading more...</div>
            )}
            {!hasMore && (
              <div className="pb-8 text-center text-sm text-white/40 col-span-full">You reached the end.</div>
            )}
          </div>
        )}
      </div>

      {isOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm">
          <div className="absolute top-5 md:top-4 left-4 z-20 [&>div]:mb-0">
            <BackButton
              hrefOverride={undefined}
              className="inline-flex h-10 w-10 items-center justify-center text-white mix-blend-difference transition-transform hover:-translate-x-1 focus:outline-none"
              onClick={closeModal}
            />
          </div>

          <div
            ref={modalScrollRef}
            className="h-full overflow-y-auto px-4 py-8 space-y-10 snap-y snap-mandatory scroll-smooth"
            style={{
              overscrollBehaviorY: "contain",
              touchAction: "pan-x",
            }}
            onWheel={handleModalWheelStep}
            onKeyDown={handleModalKeyDown}
            onTouchStart={handleModalTouchStart}
            onTouchEnd={handleModalTouchEnd}
            tabIndex={0}
          >
            {items.map((p, idx) => {
              const displayCreator = p.creator?.full_name ?? p.creator?.username ?? "Creator";
              const hashtagText =
                Array.isArray(p.hashtags) && p.hashtags.length
                  ? p.hashtags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ")
                  : Array.isArray(p.interests) && p.interests.length
                    ? p.interests.map((t) => `#${t}`).join(" ")
                    : "";
              const allowBooking =
                !!p.allow_booking &&
                typeof p.booking_url === "string" &&
                p.booking_url.length > 0;
              const showCTA =
                allowBooking ||
                !!p.product_id ||
                (typeof p.price_cents === "number" && p.price_cents > 0);

              return (
                <div
                  key={`modal-${p.id}`}
                  className="max-w-4xl mx-auto text-white snap-center"
                  data-index={idx}
                  ref={(el) => {
                    itemRefs.current[idx] = el;
                  }}
                >
                  <div className="mx-auto w-full max-w-[420px]">
                    <VideoCard
                      src={p.video_url || undefined}
                      poster={p.poster_url || undefined}
                      creator={displayCreator}
                      creatorName={displayCreator}
                      creatorAvatarUrl={p.creator?.avatar_url ?? null}
                      caption={p.content ?? ""}
                      title={p.title ?? p.content ?? "Tagged post"}
                      hashtags={hashtagText}
                      hashtagsList={Array.isArray(p.hashtags) ? p.hashtags : null}
                      likes={p.likes_count ?? 0}
                      comments={p.comments_count ?? 0}
                      shares={p.shares_count ?? 0}
                      showCTA={showCTA}
                      postId={p.id}
                      postCategory={normalizeCategory(p.interests?.[0] ?? null)}
                      productId={p.product_id ?? null}
                      creatorId={p.creator_id ?? null}
                      creatorUsername={p.creator?.username ?? null}
                      priceCents={p.price_cents ?? null}
                      titleForCheckout={p.title ?? p.content ?? "CreatorNet Video"}
                      productType={p.product_type ?? null}
                      purchaseCount={p.purchase_count ?? null}
                      allowBooking={allowBooking}
                      bookingRedirectUrl={allowBooking ? p.booking_url! : null}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </main>
  );
}

