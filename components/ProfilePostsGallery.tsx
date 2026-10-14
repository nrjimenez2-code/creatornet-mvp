"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import BackButton from "@/components/BackButton";
import VideoCard from "@/components/VideoCard";
import { isWithinRenderWindow } from "@/lib/feedV3";
import { feedMediaUrl, feedPosterUrl } from "@/lib/feedMedia";
import { normalizeCategory } from "@/lib/posthog";
import { useOpenedVideoFrames } from "@/lib/useOpenedVideoFrames";
import type { MonthlyMentorshipTerms } from "@/lib/membershipTerms";
import CreatorTipToggle from "@/components/CreatorTipToggle";
import VideoViewCount from "@/components/VideoViewCount";
import type { VideoPreviewCounts } from "@/lib/postViewCounts";

type Post = VideoPreviewCounts & {
  id: string;
  creator_id?: string | null;
  title?: string | null;
  content?: string | null;
  poster_url?: string | null;
  video_url?: string | null;
  interests?: string[] | null;
  hashtags?: string[] | null;
  likes_count?: number | null;
  comments_count?: number | null;
  shares_count?: number | null;
  product_id?: string | null;
  product_type?: string | null;
  monthlyTerms?: MonthlyMentorshipTerms | null;
  purchaseOptionsReady?: boolean;
  price_cents?: number | null;
  allow_booking?: boolean | null;
  booking_url?: string | null;
  tips_enabled?: boolean;
};

type Props = {
  tippingAvailable?: boolean;
  viewerIsOwner?: boolean;
  posts: Post[];
  creatorId: string | null;
  creatorName: string;
  creatorUsername?: string | null;
  creatorAvatarUrl?: string | null;
  creatorVerified?: boolean;
  /** Ids of these posts the signed-in viewer has already liked. Without it every
   *  heart renders empty, so a viewer who already liked a post taps a hollow
   *  heart and the toggle DELETES their like instead of adding one. */
  likedPostIds?: string[];
};

export default function ProfilePostsGallery({
  tippingAvailable = false,
  viewerIsOwner = false,
  posts: initialPosts,
  creatorId,
  creatorName,
  creatorUsername = null,
  creatorAvatarUrl = null,
  creatorVerified = false,
  likedPostIds,
}: Props) {
  const router = useRouter();
  const [tipStates, setTipStates] = useState<Record<string, boolean>>({});
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const posts = useMemo(() => initialPosts.filter((post) => !deletedIds.has(post.id)), [initialPosts, deletedIds]);
  const likedIds = useMemo(() => new Set(likedPostIds ?? []), [likedPostIds]);
  const { frameForMedia, rememberMediaRatio } = useOpenedVideoFrames();
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const alignedRef = useRef(false);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const openedTileRef = useRef<HTMLElement | null>(null);
  const gridPositionRef = useRef(0);

  const closeModal = useCallback(() => {
    setIsOpen(false);
    alignedRef.current = false;
    requestAnimationFrame(() => {
      window.scrollTo({ top: gridPositionRef.current, behavior: "instant" });
      openedTileRef.current?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
      if (e.key === "Tab") {
        const focusable = Array.from(modalRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]') ?? [])
          .filter(el => el.getClientRects().length > 0);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === modalRef.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === modalRef.current)) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", handler);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modalRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, closeModal]);

  useEffect(() => {
    if (!isOpen || alignedRef.current) return;
    const child = itemRefs.current[activeIndex];
    if (child) {
      requestAnimationFrame(() => {
        // "instant" overrides the container's scroll-smooth for this one
        // jump; otherwise opening post N animates through posts 0..N-1.
        child.scrollIntoView({ block: "center", behavior: "instant" });
        alignedRef.current = true;
      });
    }
  }, [isOpen, activeIndex]);

  useEffect(() => {
    if (!isOpen) return;
    const container = scrollRef.current;
    if (!container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!alignedRef.current) return;
          if (entry.isIntersecting) {
            const idx = Number(entry.target.getAttribute("data-index"));
            if (!Number.isNaN(idx)) {
              setActiveIndex(idx);
            }
          }
        });
      },
      { root: container, threshold: 0.65 }
    );
    itemRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [isOpen, posts.length]);

  const openModal = (index: number) => {
    openedTileRef.current = gridRef.current?.children[index] as HTMLElement | null;
    gridPositionRef.current = window.scrollY;
    setActiveIndex(index);
    alignedRef.current = false;
    setIsOpen(true);
  };

  const primeVideoThumbnail = (videoEl: HTMLVideoElement | null) => {
    if (!videoEl) return;

    // On mobile browsers (especially iOS Safari), video tiles without a poster
    // can remain black until user interaction. Seek to a tiny offset once
    // metadata is available so the first frame paints as a thumbnail.
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
  };

  return (
    <>
      <div
        ref={gridRef}
        className="grid grid-cols-3 gap-px lg:grid-cols-4"
      >
        {posts.map((post, index) => (
          <button
            key={post.id}
            type="button"
            onClick={() => openModal(index)}
            aria-describedby={post.video_url ? `profile-views-${post.id}` : undefined}
            aria-label={`Open post: ${post.title || post.content || "untitled"}`}
            className="group relative flex aspect-[9/16] items-center justify-center overflow-hidden rounded-none bg-white/5 transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80"
          >
            {post.poster_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={feedPosterUrl(post.poster_url)}
                alt=""
                style={{ height: "100%" }}
                className="absolute inset-0 h-full w-full object-cover transition group-hover:scale-105"
                loading="lazy"
              />
            ) : post.video_url ? (
              <video
                ref={primeVideoThumbnail}
                src={feedMediaUrl(post.video_url)}
                style={{ height: "100%" }}
                className="absolute inset-0 h-full w-full object-cover transition group-hover:scale-105"
                muted
                loop
                playsInline
                preload="metadata"
              />
            ) : (
              <div className="text-xs text-white/60">No media</div>
            )}
            {post.video_url ? <VideoViewCount id={`profile-views-${post.id}`} count={post.view_count} /> : null}
          </button>
        ))}
      </div>

      {isOpen && (
        <div ref={modalRef} role="dialog" aria-modal="true" aria-label="Profile video player" tabIndex={-1} className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm">
          <div className="absolute top-5 md:top-4 left-4 z-10 [&>div]:mb-0">
            <BackButton 
              hrefOverride={undefined}
              className="inline-flex h-10 w-10 items-center justify-center text-white mix-blend-difference transition-transform hover:-translate-x-1 focus:outline-none"
              onClick={closeModal}
            />
          </div>

          <div
            ref={scrollRef}
            className="h-full overflow-y-auto px-0 lg:px-4 snap-y snap-mandatory scroll-smooth"
          >
            {posts.map((post, index) => {
              // Virtualization (same window as the feed, lib/feedV3): only
              // mount the heavy VideoCard (and its <video preload=metadata>
              // + observers) near the active post. Distant posts keep a
              // placeholder with VideoCard's root height classes so the
              // snap points, this gallery's IntersectionObserver and the
              // close-to-tile scroll all keep the same geometry.
              const isMounted = isWithinRenderWindow(index, activeIndex);
              const frame = frameForMedia(post.video_url || post.poster_url || post.id);

              return (
              <div
                key={`modal-${post.id}`}
                className="h-[100dvh] w-full flex items-center justify-center text-white snap-start"
                data-index={index}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
              >
                <div className="w-full">
                  {isMounted ? (
                  <VideoCard
                    insightSource="profile"
                    src={post.video_url || undefined}
                    poster={post.poster_url ?? null}
                    desktopFeedMediaKey={frame.mediaKey}
                    desktopFeedRatio={frame.ratio}
                    desktopFeedUseNaturalFrame={frame.useNaturalFrame}
                    onDesktopFeedRatio={rememberMediaRatio}
                    mainFeedMobileLayout
                    fillMobileViewport
                    creator={creatorName}
                    creatorName={creatorName}
                    creatorAvatarUrl={creatorAvatarUrl}
                    creatorVerified={creatorVerified}
                    caption={post.title ?? ""}
                    titleForCheckout={post.title ?? post.content ?? "CreatorNet Video"}
                    hashtags={
                      Array.isArray(post.hashtags) && post.hashtags.length
                        ? post.hashtags
                            .map((h) => (h.startsWith("#") ? h : `#${h}`))
                            .join(" ")
                        : Array.isArray(post.interests) && post.interests.length
                          ? post.interests.map((t) => `#${t}`).join(" ")
                          : ""
                    }
                    isLiked={likedIds.has(post.id)}
                    likes={post.likes_count ?? 0}
                    comments={post.comments_count ?? 0}
                    shares={post.shares_count ?? 0}
                    postId={post.id}
                    onDeleted={() => {
                      setIsOpen(false);
                      setActiveIndex(0);
                      setDeletedIds((ids) => new Set([...ids, post.id]));
                      router.refresh();
                    }}
                    postCategory={normalizeCategory(post.interests?.[0] ?? null)}
                    productId={post.product_id ?? null}
                    productType={post.product_type ?? null}
                    monthlyTerms={post.monthlyTerms ?? null}
                    purchaseOptionsReady={post.purchaseOptionsReady === true}
                    creatorId={post.creator_id ?? creatorId ?? null}
                    creatorUsername={creatorUsername}
                    priceCents={post.price_cents ?? null}
                    allowBooking={!!post.allow_booking}
                    bookingRedirectUrl={post.allow_booking ? (post.booking_url ?? null) : null}
                    tipsEnabled={tippingAvailable && (tipStates[post.id] ?? post.tips_enabled === true)}
                  />
                  ) : (
                    <div
                      aria-hidden="true"
                      className="relative w-full mx-auto max-w-full lg:w-[420px] lg:max-w-[420px] max-lg:h-[100dvh] lg:h-[100dvh] lg:min-h-[100dvh] bg-black"
                    />
                  )}
                  {tippingAvailable && viewerIsOwner && isMounted && index === activeIndex && <div className="fixed right-4 top-4 z-[60]">
                    <CreatorTipToggle postId={post.id} initialEnabled={tipStates[post.id] ?? post.tips_enabled === true}
                      onChange={(enabled) => setTipStates((current) => ({ ...current, [post.id]: enabled }))} />
                  </div>}
                </div>

              </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
