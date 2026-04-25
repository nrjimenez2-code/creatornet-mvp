"use client";

import { useEffect, useRef, useState } from "react";
import BackButton from "@/components/BackButton";
import VideoCard from "@/components/VideoCard";
import { normalizeCategory } from "@/lib/posthog";

type Post = {
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
  price_cents?: number | null;
  allow_booking?: boolean | null;
  booking_url?: string | null;
};

type Props = {
  posts: Post[];
  creatorId: string | null;
  creatorName: string;
  creatorUsername?: string | null;
  creatorAvatarUrl?: string | null;
};

export default function ProfilePostsGallery({
  posts,
  creatorId,
  creatorName,
  creatorUsername = null,
  creatorAvatarUrl = null,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const alignedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", handler);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = prevOverflow;
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
    setActiveIndex(index);
    alignedRef.current = false;
    setIsOpen(true);
  };

  const closeModal = () => {
    setIsOpen(false);
    alignedRef.current = false;
    const grid = gridRef.current;
    const tile = grid?.children?.[activeIndex] as HTMLElement | undefined;
    if (tile) {
      requestAnimationFrame(() => {
        tile.scrollIntoView({ block: "center" });
        tile.focus?.();
      });
    }
  };

  return (
    <>
      <div
        ref={gridRef}
        className="grid grid-cols-2 gap-0 sm:grid-cols-3 lg:grid-cols-4"
      >
        {posts.map((post, index) => (
          <button
            key={post.id}
            type="button"
            onClick={() => openModal(index)}
            className="group relative flex aspect-square items-center justify-center overflow-hidden bg-black/40 border border-black/60 transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
          >
            {post.poster_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={post.poster_url}
                alt="Post thumbnail"
                className="h-full w-full object-cover transition group-hover:scale-105"
                loading="lazy"
              />
            ) : post.video_url ? (
              <video
                src={post.video_url}
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
      </div>

      {isOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm">
          <div className="absolute top-4 left-4 z-10 [&>div]:mb-0">
            <BackButton 
              hrefOverride={undefined}
              className="inline-flex h-10 w-10 items-center justify-center text-white mix-blend-difference transition-transform hover:-translate-x-1 focus:outline-none"
              onClick={closeModal}
            />
          </div>

          <div
            ref={scrollRef}
            className="h-full overflow-y-auto px-4 py-8 space-y-10 snap-y snap-mandatory scroll-smooth"
          >
            {posts.map((post, index) => (
              <div
                key={`modal-${post.id}`}
                className="max-w-4xl mx-auto text-white snap-center"
                data-index={index}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
              >
                <div className="mx-auto w-full max-w-[420px]">
                  <VideoCard
                    src={post.video_url || undefined}
                    poster={post.poster_url ?? null}
                    creator={creatorName}
                    creatorName={creatorName}
                    creatorAvatarUrl={creatorAvatarUrl}
                    caption={post.content ?? post.title ?? ""}
                    title={post.title ?? post.content ?? ""}
                    hashtags={
                      Array.isArray(post.hashtags) && post.hashtags.length
                        ? post.hashtags
                            .map((h) => (h.startsWith("#") ? h : `#${h}`))
                            .join(" ")
                        : Array.isArray(post.interests) && post.interests.length
                          ? post.interests.map((t) => `#${t}`).join(" ")
                          : ""
                    }
                    likes={post.likes_count ?? 0}
                    comments={post.comments_count ?? 0}
                    shares={post.shares_count ?? 0}
                    postId={post.id}
                    postCategory={normalizeCategory(post.interests?.[0] ?? null)}
                    productId={post.product_id ?? null}
                    creatorId={post.creator_id ?? creatorId ?? null}
                    creatorUsername={creatorUsername}
                    priceCents={post.price_cents ?? null}
                    allowBooking={!!post.allow_booking}
                    bookingRedirectUrl={post.allow_booking ? (post.booking_url ?? null) : null}
                  />
                </div>

              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

