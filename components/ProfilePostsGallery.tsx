"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Post = {
  id: string;
  poster_url?: string | null;
  video_url?: string | null;
};

export default function ProfilePostsGallery({ posts }: { posts: Post[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [soundOn, setSoundOn] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
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

  useEffect(() => {
    if (!isOpen) return;
    videoRefs.current.forEach((video, index) => {
      if (!video) return;
      if (index === activeIndex && posts[index]?.video_url) {
        video.muted = !soundOn;
        video.loop = true;
        video
          .play()
          .catch(() => {
            /* autoplay blocked */
          });
      } else {
        video.pause();
      }
    });
  }, [isOpen, activeIndex, soundOn, posts]);

  const openModal = (index: number) => {
    setActiveIndex(index);
    setSoundOn(false);
    alignedRef.current = false;
    setIsOpen(true);
  };

  const activePost = posts[activeIndex];

  const handleVideoTap = (index: number) => {
    const video = videoRefs.current[index];
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
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
              />
            ) : (
              <div className="text-xs text-white/60">No media</div>
            )}
          </button>
        ))}
      </div>

      {isOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm">
          <button
            type="button"
            onClick={closeModal}
            className="absolute top-4 left-4 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/30 bg-black/40 text-white hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            aria-label="Back to profile"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>

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
                <div className="relative aspect-[9/16] w-full max-w-[420px] mx-auto overflow-hidden rounded-3xl border border-white/10 bg-black">
                  {post.video_url ? (
                    <video
                      ref={(el) => {
                        videoRefs.current[index] = el;
                      }}
                      src={post.video_url}
                      className="h-full w-full object-cover"
                      playsInline
                      muted
                      onClick={() => handleVideoTap(index)}
                    />
                  ) : post.poster_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={post.poster_url}
                      alt="Post media"
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-white/60">
                      No media
                    </div>
                  )}

                  {post.video_url ? (
                    <button
                      type="button"
                      onClick={() => setSoundOn((prev) => !prev)}
                      className="absolute left-3 bottom-3 flex h-9 w-9 items-center justify-center rounded-full border border-white/30 bg-black/50 text-white hover:bg-black/70"
                      aria-label={soundOn ? "Mute video" : "Unmute video"}
                    >
                      {soundOn ? <SoundOnIcon /> : <SoundOffIcon />}
                    </button>
                  ) : null}
                </div>

              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function SoundOnIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
      <path d="m3 9v6h4l5 5V4L7 9H3zm13.5 3a3.5 3.5 0 0 0-2.5-3.347v6.694A3.5 3.5 0 0 0 16.5 12zm-2.5-7.857v2.126A6.5 6.5 0 0 1 19 12a6.5 6.5 0 0 1-5 6.357v2.126A8.5 8.5 0 0 0 21 12a8.5 8.5 0 0 0-7-7.857z" />
    </svg>
  );
}

function SoundOffIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
      <path d="M5.707 4.293 4.293 5.707 8.586 10H3v4h5l5 5v-6.586l4.293 4.293 1.414-1.414-13-13zm7.293.707-4 4V10l4-4V5zm4.5-.857v2.126A6.5 6.5 0 0 1 21 12a6.5 6.5 0 0 1-2 4.652l1.46 1.46A8.5 8.5 0 0 0 23 12a8.5 8.5 0 0 0-5.5-8.857z" />
    </svg>
  );
}

