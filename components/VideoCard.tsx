"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Heart, Volume2, VolumeX, ShoppingCart, Plus } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";

type VideoCardProps = {
  src?: string;
  poster?: string | null;
  creator?: string;
  creatorAvatarUrl?: string | null;
  caption?: string;
  hashtags?: string;
  title?: string;
  creatorName?: string;
  avatarUrl?: string | null;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  likes?: number | string;
  comments?: number | string;
  shares?: number | string;
  isActive?: boolean;
  defaultMuted?: boolean;
  onBuy?: () => void;
  onBook?: () => void;
  followable?: boolean;
  onFollow?: () => void;
  postId?: string | null;
  productId?: string | null;
  creatorId?: string | null;
  priceCents?: number | null;
  titleForCheckout?: string | null;
  planMonths?: number | null;
  planPriceCents?: number | null;
  allowBooking?: boolean;
  bookingRedirectUrl?: string | null;
  productType?: string | null;
  showFollowButton?: boolean;
  isFollowingCreator?: boolean;
  soundEnabled?: boolean;
  onToggleSound?: () => void;
  tapToTogglePlayback?: boolean;
  onLike?: () => Promise<void> | void;
  onComment?: () => Promise<void> | void;
  onShare?: () => Promise<void> | void;
  showCTA?: boolean;
  ctaLabel?: string;
  onCta?: () => void;
  activeTab?: "following" | "discover";
  onChangeTab?: (t: "following" | "discover") => void;
};

export default function VideoCard(props: VideoCardProps) {
  const {
    src,
    poster,
    creator = "creator",
    creatorAvatarUrl = null,
    caption = "Quick tip goes here",
    hashtags = "#tag1 #tag2",
    title,
    creatorName,
    avatarUrl,
    likeCount,
    commentCount,
    shareCount,
    likes,
    comments,
    shares,
    isActive,
    defaultMuted = true,
    onBuy,
    onBook,
    followable,
    onFollow,
    postId = null,
    productId = null,
    creatorId = null,
    priceCents = null,
    titleForCheckout = null,
    planMonths = null,
    planPriceCents = null,
    allowBooking = false,
    bookingRedirectUrl = null,
    productType = null,
    showFollowButton = false,
    isFollowingCreator = false,
    soundEnabled = false,
    onToggleSound,
    tapToTogglePlayback = true,
    onLike,
    onComment,
    onShare,
    showCTA = false,
    ctaLabel = "Buy / Book",
    onCta,
    activeTab,
    onChangeTab,
  } = props;

  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isMuted, setIsMuted] = useState(defaultMuted);
  const [isPaused, setIsPaused] = useState(true);
  const [progress, setProgress] = useState(0);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [videoSrc, setVideoSrc] = useState<string | undefined>(undefined);
  const [lk, setLk] = useState(() => toNum(likeCount ?? likes ?? 0));
  const [cm, setCm] = useState(() => toNum(commentCount ?? comments ?? 0));
  const [sh, setSh] = useState(() => toNum(shareCount ?? shares ?? 0));
  const [isFollowing, setIsFollowing] = useState(Boolean(isFollowingCreator));
  const [followLoading, setFollowLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [fetchedPriceCents, setFetchedPriceCents] = useState<number | null>(null);

  const displayTitle = title ?? caption ?? "";
  const displayCreator = creatorName ?? creator ?? "Creator";
  const displayAvatar = avatarUrl ?? creatorAvatarUrl ?? null;
  const canFollow = followable ?? showFollowButton ?? false;

  const formatCount = (n: number): string => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  };

  useEffect(() => {
    setLk(toNum(likeCount ?? likes ?? 0));
  }, [likeCount, likes]);

  useEffect(() => {
    setCm(toNum(commentCount ?? comments ?? 0));
  }, [commentCount, comments]);

  useEffect(() => {
    setSh(toNum(shareCount ?? shares ?? 0));
  }, [shareCount, shares]);

  useEffect(() => {
    setIsFollowing(Boolean(isFollowingCreator));
  }, [isFollowingCreator]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      setMenuOpen(false);
    }
    if (menuOpen) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  useEffect(() => {
    if (productId && (!priceCents || priceCents === 0)) {
      let cancelled = false;
      (async () => {
        try {
          const { data, error } = await supabase
            .from("products")
            .select("amount_cents, price_cents")
            .eq("product_id", productId)
            .maybeSingle();
          
          if (!cancelled && !error && data) {
            const productPrice = (data.amount_cents as number) || (data.price_cents as number) || null;
            if (productPrice && productPrice > 0) {
              setFetchedPriceCents(productPrice);
            }
          }
        } catch (err) {
          console.error("[VideoCard] Failed to fetch product price:", err);
        }
      })();
      return () => {
        cancelled = true;
      };
    }
  }, [productId, priceCents]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      if (video.duration) {
        setProgress((video.currentTime / video.duration) * 100);
      }
    };

    const handlePlay = () => setIsPaused(false);
    const handlePause = () => setIsPaused(true);
    const handleCanPlay = () => setHasLoaded(true);

    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("canplay", handleCanPlay);

    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("canplay", handleCanPlay);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = isMuted;
  }, [isMuted]);

  // Sync mute state with soundEnabled prop
  useEffect(() => {
    if (soundEnabled !== undefined) {
      setIsMuted(!soundEnabled);
    }
  }, [soundEnabled]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isActive === undefined) {
      const container = containerRef.current;
      if (!container) return;

      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting && entry.intersectionRatio >= 0.75) {
              video.play().catch(() => {});
            } else {
              video.pause();
            }
          });
        },
        { threshold: 0.75 }
      );

      observer.observe(container);

      return () => {
        observer.disconnect();
        video.pause();
      };
    } else if (isActive) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [isActive]);

  useEffect(() => {
    if (src && !hasLoaded) {
      if (isActive === true) {
        setVideoSrc(src);
        videoRef.current?.load();
      } else if (isActive === undefined && containerRef.current) {
        const observer = new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              if (entry.isIntersecting && !hasLoaded) {
                setVideoSrc(src);
                videoRef.current?.load();
              }
            });
          },
          { threshold: 0.1 }
        );

        observer.observe(containerRef.current);

        return () => observer.disconnect();
      }
    }
  }, [src, hasLoaded, isActive]);

  const handleVideoClick = useCallback(() => {
    const video = videoRef.current;
    if (!video || !tapToTogglePlayback) return;

    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [tapToTogglePlayback]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === " " && document.activeElement === containerRef.current) {
        e.preventDefault();
        handleVideoClick();
      }
    },
    [handleVideoClick]
  );

  const handleMuteToggle = useCallback(() => {
    setIsMuted((prev) => !prev);
    onToggleSound?.();
  }, [onToggleSound]);

  const handleLike = useCallback(async () => {
    setLk((v) => v + 1);
    try {
      await onLike?.();
    } catch {
      setLk((v) => Math.max(0, v - 1));
    }
  }, [onLike]);

  const handleComment = useCallback(async () => {
    setCm((v) => v + 1);
    try {
      await onComment?.();
    } catch {
      setCm((v) => Math.max(0, v - 1));
    }
  }, [onComment]);

  const handleShare = useCallback(async () => {
    setSh((v) => v + 1);
    try {
      await onShare?.();
    } catch {
      setSh((v) => Math.max(0, v - 1));
    }
  }, [onShare]);

  const handleFollow = useCallback(async () => {
    if (onFollow) {
      onFollow();
      return;
    }

    if (!canFollow || !creatorId || followLoading) return;

    setFollowLoading(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const viewerId = auth?.user?.id;
      if (!viewerId) {
        alert("Please sign in to follow creators.");
        return;
      }
      if (viewerId === creatorId) {
        return;
      }

      if (isFollowing) {
        const { error } = await supabase
          .from("follows")
          .delete()
          .eq("follower_id", viewerId)
          .eq("following_id", creatorId);
        if (error) throw error;
        setIsFollowing(false);
      } else {
        const { error } = await supabase
          .from("follows")
          .insert({ follower_id: viewerId, following_id: creatorId });
        if (error) throw error;
        setIsFollowing(true);
      }
    } catch (err) {
      console.error("[follow-toggle] error:", err);
      alert("Could not update follow status. Please try again.");
    } finally {
      setFollowLoading(false);
    }
  }, [canFollow, creatorId, followLoading, isFollowing, onFollow]);

  const handleBuy = useCallback(async () => {
    if (onBuy) {
      onBuy();
      return;
    }

    if (!productId) {
      alert("No product attached to this post yet.");
      return;
    }

    try {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
        body: JSON.stringify({
          type: "product",
          product_id: String(productId),
          post_id: postId ?? undefined,
          creator_id: creatorId ?? null,
          titleForCheckout: titleForCheckout ?? undefined,
        }),
      });

      const data = await res.json().catch(() => null);
    if (!res.ok) {
        throw new Error(data?.error || `Failed to create checkout session (HTTP ${res.status})`);
    }

    const url = typeof data?.url === "string" ? data.url : "";
    if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
      throw new Error("Not a valid checkout URL returned from server.");
    }

    window.location.assign(url);
    } catch (e) {
      console.error("[buy] error:", e);
      alert((e as Error).message || "Failed to start checkout.");
    }
  }, [onBuy, productId, postId, creatorId, titleForCheckout]);

  const handleBook = useCallback(async () => {
    if (onBook) {
      onBook();
      return;
    }

    if (!bookingRedirectUrl) {
      alert("No booking link is configured for this post.");
      return;
    }

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
        type: "booking",
        post_id: postId,
        creator_id: creatorId ?? undefined,
        bookingRedirectUrl,
        }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || `Failed to create checkout session (HTTP ${res.status})`);
      }

      const url = typeof data?.url === "string" ? data.url : "";
      if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
        window.location.assign(url);
      }
    } catch (e) {
      console.error("[book] error:", e);
      alert((e as Error).message || "Failed to start booking.");
    }
  }, [onBook, bookingRedirectUrl, postId, creatorId]);

  const handleAvatarClick = useCallback(async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    e?.preventDefault();
    
    console.log("[VideoCard] Avatar clicked - creatorId:", creatorId, "postId:", postId);
    
    // If creatorId is available, navigate immediately
    if (creatorId) {
      console.log("[VideoCard] Navigating to creator profile:", creatorId);
      router.push(`/creators/${creatorId}`);
      return;
    }

    // Fallback: try to fetch creatorId from API
    if (!postId) {
      console.warn("[VideoCard] Missing both creatorId and postId for avatar redirect");
      return;
    }

    try {
      const res = await fetch(`/api/posts/${postId}/creator`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "Unknown error");
        console.error("[VideoCard] Creator lookup failed:", res.status, errorText);
        return;
      }

      const payload = (await res.json()) as { creatorId?: string };
      if (payload?.creatorId) {
        router.push(`/creators/${payload.creatorId}`);
      } else {
        console.warn("[VideoCard] creatorId missing in API response for postId:", postId);
      }
    } catch (err) {
      console.error("[VideoCard] Avatar redirect error:", err);
    }
  }, [creatorId, postId, router]);

  return (
    <div className="relative w-full max-w-[504.8px]">
      <div
        ref={containerRef}
        role="group"
        aria-label={`${displayCreator}: ${displayTitle}`}
        className="relative w-full overflow-hidden border border-white/12 bg-black"
        style={{ borderRadius: "16px 16px 20px 20px" }}
        onKeyDown={handleKeyDown}
        tabIndex={0}
      >
      <div className="relative w-full aspect-[9/16] bg-black overflow-hidden" style={{ borderRadius: "16px 16px 0 0" }}>
        {videoSrc || src ? (
          <video
            ref={videoRef}
            src={videoSrc || src}
            poster={poster || undefined}
            playsInline
            muted={isMuted}
            preload="metadata"
            loop
            className="absolute inset-0 h-full w-full object-cover"
            style={{ borderRadius: "16px 16px 0 0", pointerEvents: tapToTogglePlayback ? "auto" : "none" }}
            onClick={handleVideoClick}
          />
        ) : poster ? (
          <img
            src={poster}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={{ borderRadius: "16px 16px 0 0" }}
          />
        ) : null}

        <div
          className="absolute top-2 left-2 sm:top-3 sm:left-3 h-10 w-10 rounded-full bg-black/35 backdrop-blur-md border border-white/10 text-white flex items-center justify-center hover:bg-black/50 transition focus:outline-none focus:ring-2 focus:ring-white/60 z-30"
          style={{ backdropFilter: "blur(12px)" }}
        >
          <button
            type="button"
            onClick={handleMuteToggle}
            aria-label={isMuted ? "Unmute video" : "Mute video"}
            className="w-full h-full flex items-center justify-center"
          >
            {isMuted ? (
              <VolumeX className="h-5 w-5" />
            ) : (
              <Volume2 className="h-5 w-5" />
            )}
        </button>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 p-3 sm:p-4 bg-gradient-to-t from-black/70 via-black/30 to-transparent z-20" style={{ borderRadius: "0 0 20px 20px", overflow: "hidden" }}>
          <div className="flex items-start gap-3 mb-3 translate-y-[45px]">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-white font-semibold text-base truncate">
                  {displayCreator}
                </span>
              </div>
              <p className="text-white/95 text-base line-clamp-2 leading-snug">
                {displayTitle}
              </p>
              {hashtags && (
                <p className="text-white/70 text-xs mt-1 line-clamp-1">{hashtags}</p>
              )}
            </div>
          </div>
          {(showCTA || onBuy || onBook || (productId && priceCents)) && (
            <div className="mt-2 relative -translate-y-[0.8in]" ref={wrapperRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((prev) => !prev)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white text-black text-sm font-semibold hover:bg-gray-100 transition focus:outline-none focus:ring-2 focus:ring-white/60"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                  <path d="M7 4h14l-1.5 9H8.6L7 4zM3 4h2l3 12h10v2H7a2 2 0 0 1-2-1.5L3 4zM9 21a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3zM17 21a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3z"/>
                </svg>
                <span className="font-semibold">Buy</span>
                {(priceCents && priceCents > 0) || (fetchedPriceCents && fetchedPriceCents > 0) ? (
                  <span className="font-semibold">${(((priceCents && priceCents > 0 ? priceCents : fetchedPriceCents) || 0) / 100).toFixed(2)}</span>
                ) : null}
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="black">
                  <path d="M7 10l5 5 5-5z" />
                </svg>
              </button>

              {menuOpen && (
                <div
                  role="menu"
                  className="absolute z-50 mt-2 w-56 rounded-xl bg-white shadow-lg ring-1 ring-black/5 overflow-hidden"
                >
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      handleBuy();
                    }}
                    className="w-full text-left px-4 py-3 text-sm text-gray-900 hover:bg-gray-100 transition"
                  >
                    Pay in full {((priceCents && priceCents > 0) || (fetchedPriceCents && fetchedPriceCents > 0)) ? `$${(((priceCents && priceCents > 0 ? priceCents : fetchedPriceCents) || 0) / 100).toFixed(2)}` : ""}
                  </button>
                  {(productType === "course" || productType === "mentorship" || allowBooking) && (
                    <>
                      <div className="h-px bg-gray-200" />
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          handleBook();
                        }}
                        className="w-full text-left px-4 py-3 text-sm text-gray-900 hover:bg-gray-100 transition"
                      >
                        Book
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
      </div>

      <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/20 z-30" style={{ height: "2px" }}>
        <div
          className="h-full bg-white/60 transition-all duration-150"
          style={{ width: `${progress}%`, height: "2px" }}
        />
      </div>
    </div>

      <div
        className="absolute bottom-32 sm:bottom-40 grid gap-3 -translate-x-[30px] translate-y-[140px]"
        style={{ 
          bottom: "clamp(120px, 18vh, 160px)",
          right: "-1in",
          pointerEvents: "auto",
          zIndex: 50
        }}
      >
        <div className="relative h-[56px] w-[56px]">
          {displayAvatar ? (
    <button
      type="button"
              onClick={handleAvatarClick}
              className="h-[56px] w-[56px] rounded-full overflow-hidden border-2 border-white/20 flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-white/60 cursor-pointer"
              aria-label={`${displayCreator} profile`}
              style={{ pointerEvents: "auto", zIndex: 51 }}
            >
              <img
                src={displayAvatar}
                alt={displayCreator}
                className="h-full w-full object-cover pointer-events-none"
              />
    </button>
          ) : (
      <button
        type="button"
              onClick={handleAvatarClick}
              className="h-[56px] w-[56px] rounded-full bg-white/10 border-2 border-white/20 flex-shrink-0 flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-white/60 cursor-pointer hover:bg-white/20 transition"
              aria-label={`${displayCreator} profile`}
              style={{ pointerEvents: "auto", zIndex: 51 }}
            >
              <span className="text-white/60 text-sm font-semibold pointer-events-none">{displayCreator[0]?.toUpperCase()}</span>
      </button>
          )}
          {canFollow && !isFollowing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
                handleFollow();
              }}
              disabled={followLoading}
              className="absolute -bottom-1 -right-1 h-6 w-6 rounded-full bg-[#4A35C7] text-white flex items-center justify-center border-2 border-black/70 shadow-lg hover:bg-[#3D2BA3] disabled:opacity-60 transition focus:outline-none focus:ring-2 focus:ring-[#4A35C7]/60 z-10 -translate-x-[1.003em]"
              aria-label={`Follow ${displayCreator}`}
            >
              <Plus className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={handleLike}
            aria-label="Like"
            className="h-[48px] w-[48px] rounded-full border border-white/10 text-white flex items-center justify-center hover:opacity-90 transition focus:outline-none focus:ring-2 focus:ring-white/60"
            style={{ backgroundColor: "#1A1F22" }}
          >
            <Heart className="h-6 w-6 fill-current" />
          </button>
          <span className="text-[12px] font-semibold leading-none tracking-tight text-white translate-y-[1px]">
            {formatCount(lk)}
          </span>
        </div>

        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={handleComment}
            aria-label="Comment"
            className="h-[48px] w-[48px] rounded-full border border-white/10 flex items-center justify-center hover:opacity-90 transition focus:outline-none focus:ring-2 focus:ring-white/60"
            style={{ backgroundColor: "#1A1F22" }}
          >
            <img src="/msg.png" alt="Comment" className="h-7 w-7 object-contain" />
          </button>
          <span className="text-[12px] font-semibold leading-none tracking-tight text-white translate-y-[1px]">
            {formatCount(cm)}
          </span>
        </div>

        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={handleShare}
            aria-label="Share"
            className="h-[48px] w-[48px] rounded-full border border-white/10 flex items-center justify-center hover:opacity-90 transition focus:outline-none focus:ring-2 focus:ring-white/60"
            style={{ backgroundColor: "#1A1F22" }}
        >
            <img src="/share.png" alt="Share" className="h-7 w-7 object-contain" />
        </button>
          <span className="text-[12px] font-semibold leading-none tracking-tight text-white translate-y-[1px]">
            {formatCount(sh)}
          </span>
        </div>
      </div>
    </div>
  );
}

function toNum(n: number | string | undefined | null): number {
  if (n === undefined || n === null) return 0;
  return typeof n === "string" ? Number(n) || 0 : n || 0;
}
