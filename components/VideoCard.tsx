"use client";

import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Heart, Volume2, VolumeX, ShoppingCart, Plus } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import BuyButton from "./BuyButton";
import CommentPanel from "./CommentPanel";
import { useUser } from "@/lib/useUser";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";
import { trackEvent, normalizeCategory } from "@/lib/posthog";

type VideoCardProps = {
  src?: string;
  poster?: string | null;
  creator?: string;
  creatorAvatarUrl?: string | null;
  caption?: string;
  hashtags?: string;
  hashtagsList?: string[] | null;
  title?: string;
  creatorName?: string;
  avatarUrl?: string | null;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  likes?: number | string;
  comments?: number | string;
  shares?: number | string;
  isLiked?: boolean;
  isActive?: boolean;
  defaultMuted?: boolean;
  onBuy?: () => void;
  onBook?: () => void;
  followable?: boolean;
  onFollow?: () => void;
  postId?: string | null;
  postCategory?: string | null;
  productId?: string | null;
  creatorId?: string | null;
  /** Stable handle for /profile/[username] links; optional when only creatorId is known */
  creatorUsername?: string | null;
  priceCents?: number | null;
  titleForCheckout?: string | null;
  planMonths?: number | null;
  planPriceCents?: number | null;
  allowBooking?: boolean;
  bookingRedirectUrl?: string | null;
  productType?: string | null;
  showFollowButton?: boolean;
  isFollowingCreator?: boolean;
  onFollowChange?: (creatorId: string, isFollowing: boolean) => void;
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
  mobileMuteButtonSide?: "left" | "right";
};

export default function VideoCard(props: VideoCardProps) {
  const {
    src,
    poster,
    creator = "creator",
    creatorAvatarUrl = null,
    caption = "Quick tip goes here",
    hashtags = "#tag1 #tag2",
    hashtagsList = null,
    title,
    creatorName,
    avatarUrl,
    likeCount,
    commentCount,
    shareCount,
    likes,
    comments,
    shares,
    isLiked = false,
    isActive,
    defaultMuted = true,
    onBuy,
    onBook,
    followable,
    onFollow,
    postId = null,
    postCategory = null,
    productId = null,
    creatorId = null,
    creatorUsername = null,
    priceCents = null,
    titleForCheckout = null,
    planMonths = null,
    planPriceCents = null,
    allowBooking = false,
    bookingRedirectUrl = null,
    productType = null,
    showFollowButton = false,
    isFollowingCreator = false,
    onFollowChange,
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
    mobileMuteButtonSide = "right",
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
  const [liked, setLiked] = useState(isLiked);
  const [isFollowing, setIsFollowing] = useState(Boolean(isFollowingCreator));
  const [followLoading, setFollowLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [commentPanelOpen, setCommentPanelOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  // Money path: one in-flight checkout at a time, errors shown inline (not alert()).
  const [checkoutState, setCheckoutState] = useState<"idle" | "starting">("idle");
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buyButtonRef = useRef<HTMLButtonElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number } | null>(null);
  const [fetchedPriceCents, setFetchedPriceCents] = useState<number | null>(null);
  // Use cached user hook to avoid rate limits
  const { userId: cachedUserId } = useUser();

  // Refs for analytics (allow stable event-listener closures to access latest prop values)
  const postIdRef = useRef(postId);
  const creatorIdRef = useRef(creatorId);
  const categoryRef = useRef<string | null>(postCategory ? normalizeCategory(postCategory) : null);
  const hasTrackedViewRef = useRef(false);
  const hasTrackedCompleteRef = useRef(false);
  const hasTracked50Ref = useRef(false);
  useEffect(() => { postIdRef.current = postId; }, [postId]);
  useEffect(() => { creatorIdRef.current = creatorId; }, [creatorId]);
  useEffect(() => { categoryRef.current = postCategory ? normalizeCategory(postCategory) : null; }, [postCategory]);
  // Reset per-video tracking flags when the post changes
  useEffect(() => {
    hasTrackedViewRef.current = false;
    hasTrackedCompleteRef.current = false;
    hasTracked50Ref.current = false;
  }, [postId]);

  const displayTitle = title ?? caption ?? "";
  const displayCreator = creatorName ?? creator ?? "Creator";
  const displayAvatar = avatarUrl ?? creatorAvatarUrl ?? DEFAULT_AVATAR_URL;
  const canFollow = followable ?? showFollowButton ?? false;
  const clickableHashtags = useMemo(() => {
    if (!Array.isArray(hashtagsList) || hashtagsList.length === 0) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of hashtagsList) {
      const clean = String(raw || "").replace(/^#/, "").trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
    return out;
  }, [hashtagsList]);

  const clickableFromDisplay = useMemo(() => {
    if (clickableHashtags.length > 0) return clickableHashtags;
    if (!hashtags) return [];

    // Fallback parser: keep full label between "#" markers (supports labels with spaces, e.g. "Money & Investing")
    const chunks = hashtags.match(/#([^#]+)/g) ?? [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of chunks) {
      const clean = raw.replace(/^#/, "").trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
    return out;
  }, [clickableHashtags, hashtags]);

  const creatorProfileHref = useMemo(() => {
    if (!creatorId && !creatorUsername) return null;
    if (cachedUserId && creatorId && cachedUserId === creatorId) {
      return "/profile";
    }
    if (creatorUsername) {
      return `/profile/${encodeURIComponent(creatorUsername)}`;
    }
    if (creatorId) {
      return `/creators/${creatorId}`;
    }
    return null;
  }, [cachedUserId, creatorId, creatorUsername]);

  const formatCount = (n: number): string => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  };

  useEffect(() => {
    setLk(toNum(likeCount ?? likes ?? 0));
  }, [likeCount, likes]);

  useEffect(() => {
    setLiked(isLiked);
  }, [isLiked]);

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
      if ((e.target as HTMLElement).closest("[data-buy-dropdown]")) return;
      setMenuOpen(false);
    }
    function onScroll() {
      setMenuOpen(false);
    }
    if (menuOpen) {
      document.addEventListener("mousedown", onDoc);
      window.addEventListener("scroll", onScroll, true);
    }
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen || !buyButtonRef.current) {
      setDropdownPosition(null);
      return;
    }
    const rect = buyButtonRef.current.getBoundingClientRect();
    const dropdownMaxWidth = 200;
    const winW = typeof window !== "undefined" ? window.innerWidth : 400;
    const left = Math.max(8, Math.min(rect.left, winW - dropdownMaxWidth - 8));
    setDropdownPosition({
      top: rect.bottom + 8,
      left,
    });
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
      if (!video.duration) return;
      const pct = (video.currentTime / video.duration) * 100;
      setProgress(pct);
      if (pct >= 50 && !hasTracked50Ref.current) {
        hasTracked50Ref.current = true;
        scoreInterest(2);
      }
      if (pct >= 90 && !hasTrackedCompleteRef.current) {
        hasTrackedCompleteRef.current = true;
        trackEvent("video_completed", {
          post_id: postIdRef.current,
          creator_id: creatorIdRef.current,
          category: categoryRef.current,
          percent_watched: Math.round(pct),
          watch_time_seconds: Math.round(video.currentTime),
        });
        scoreInterest(3);
        trackMetric("completions", Math.round(video.currentTime));
      }
    };

    const handlePlay = () => {
      setIsPaused(false);
      if (!hasTrackedViewRef.current) {
        hasTrackedViewRef.current = true;
        trackEvent("video_viewed", {
          post_id: postIdRef.current,
          creator_id: creatorIdRef.current,
          category: categoryRef.current,
          watch_time_seconds: Math.round(video.currentTime ?? 0),
          percent_watched: video.duration > 0 ? Math.round((video.currentTime / video.duration) * 100) : 0,
        });
        scoreInterest(1);
        trackMetric("views");
      }
    };
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

    // play() can reject when metadata isn't ready yet (slow networks, iOS
    // Safari). Wrap the call so a rejection schedules one retry on `canplay`
    // instead of leaving the video silently paused until the user taps.
    const tryPlay = () => {
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          const onCanPlay = () => {
            video.play().catch(() => {});
          };
          video.addEventListener("canplay", onCanPlay, { once: true });
        });
      }
    };

    if (isActive === undefined) {
      const container = containerRef.current;
      if (!container) return;

      let hasTrackedImpression = false;
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting && entry.intersectionRatio >= 0.75) {
              tryPlay();
              if (!hasTrackedImpression) {
                hasTrackedImpression = true;
                trackMetric("impressions");
              }
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
      tryPlay();
    } else {
      video.pause();
    }
  }, [isActive]);

  useEffect(() => {
    if (src && !hasLoaded) {
      if (isActive === true) {
        setVideoSrc(src);
      } else if (isActive === undefined && containerRef.current) {
        const observer = new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              if (entry.isIntersecting && !hasLoaded) {
                setVideoSrc(src);
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
    if (!postId) {
      // Fallback to old behavior if no postId
      setLk((v) => v + 1);
      try {
        await onLike?.();
      } catch {
        setLk((v) => Math.max(0, v - 1));
      }
      return;
    }

    // Optimistic update
    const wasLiked = liked;
    const previousCount = lk;
    setLiked(!wasLiked);
    setLk((v) => wasLiked ? Math.max(0, v - 1) : v + 1);

    try {
      const apiUrl = typeof window !== "undefined" 
        ? `${window.location.origin}/api/posts/${postId}/like`
        : `/api/posts/${postId}/like`;
      
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });

      const data = await res.json();
      if (res.ok && data.success) {
        // Update with server response
        setLiked(data.liked);
        setLk(data.likes_count ?? previousCount);
        if (data.liked) {
          trackEvent("video_liked", {
            post_id: postId,
            creator_id: creatorId,
            category: postCategory ? normalizeCategory(postCategory) : null,
          });
        }
      } else {
        // Revert on error
        setLiked(wasLiked);
        setLk(previousCount);
        console.error("Like error:", data.error || "Unknown error");
      }
    } catch (err) {
      // Revert on error
      setLiked(wasLiked);
      setLk(previousCount);
      console.error("Failed to toggle like:", err);
    }
  }, [onLike, postId, liked, lk]);

  const handleComment = useCallback(async () => {
    if (postId) {
      // Open comment panel if we have a postId
      setCommentPanelOpen(true);
    } else {
      // Fallback to old behavior if no postId
      setCm((v) => v + 1);
      try {
        await onComment?.();
      } catch {
        setCm((v) => Math.max(0, v - 1));
      }
    }
  }, [onComment, postId]);

  const handleCommentAdded = useCallback((newCount?: number) => {
    // Update comment count with server value
    if (postId && typeof newCount === "number") {
      setCm(newCount);
    }
  }, [postId]);

  const handleShare = useCallback(async () => {
    // Copy post link to clipboard - redirects to dashboard with postId
    if (postId) {
      const postUrl = `${window.location.origin}/dashboard?postId=${postId}`;
      try {
        await navigator.clipboard.writeText(postUrl);
        setShareCopied(true);
        setTimeout(() => setShareCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy link:", err);
        // Fallback for older browsers
        const textArea = document.createElement("textarea");
        textArea.value = postUrl;
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.select();
        try {
          document.execCommand("copy");
          setShareCopied(true);
          setTimeout(() => setShareCopied(false), 2000);
        } catch (fallbackErr) {
          console.error("Fallback copy failed:", fallbackErr);
          alert(`Copy this link: ${postUrl}`);
        }
        document.body.removeChild(textArea);
      }
    }
    
    // Increment share count
    setSh((v) => v + 1);
    try {
      if (postId) {
        const apiUrl =
          typeof window !== "undefined"
            ? `${window.location.origin}/api/posts/${postId}/share`
            : `/api/posts/${postId}/share`;

        const res = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        const data = await res.json().catch(() => null);

        if (!res.ok || !data?.success) {
          throw new Error(data?.error || "Failed to record share");
        }

        if (typeof data.shares_count === "number") {
          setSh(data.shares_count);
        }
      }

      await onShare?.();
    } catch (err) {
      console.error("Share error:", err);
      setSh((v) => Math.max(0, v - 1));
    }
  }, [onShare, postId]);

  const handleFollow = useCallback(async () => {
    if (onFollow) {
      onFollow();
      return;
    }

    if (!canFollow || !creatorId || followLoading) return;

    // Optimistic UI update - update immediately for instant feedback
    const previousState = isFollowing;
    setIsFollowing(!isFollowing);
    setFollowLoading(true);

    try {
      // Use cached user ID from hook to avoid rate limits
      const viewerId = cachedUserId;

      if (!viewerId) {
        alert("Please sign in to follow creators.");
        setIsFollowing(previousState); // Revert optimistic update
        setFollowLoading(false);
        return;
      }
      if (viewerId === creatorId) {
        setIsFollowing(previousState); // Revert optimistic update
        setFollowLoading(false);
        return;
      }

      if (previousState) {
        // Unfollow
        const { error } = await supabase
          .from("follows")
          .delete()
          .eq("follower_id", viewerId)
          .eq("following_id", creatorId);
        if (error) throw error;
        // State already updated optimistically
      } else {
        // Follow
        const { error } = await supabase
          .from("follows")
          .insert({ follower_id: viewerId, following_id: creatorId });
        if (error) {
          // Check if it's a duplicate (already following)
          if (error.message?.includes("duplicate") || error.message?.includes("unique constraint")) {
            // Already following, state already updated optimistically
          } else {
            throw error;
          }
        }
        // State already updated optimistically
      }
      
      // Track follow (not unfollow)
      if (!previousState && creatorId) {
        trackEvent("followed_creator", { creator_id: creatorId });
      }
      // Notify parent component to update cached feed data
      if (onFollowChange && creatorId) {
        onFollowChange(creatorId, !previousState);
      }
    } catch (err) {
      console.error("[follow-toggle] error:", err);
      alert("Could not update follow status. Please try again.");
      // Revert optimistic update on error
      setIsFollowing(previousState);
    } finally {
      setFollowLoading(false);
    }
  }, [canFollow, creatorId, followLoading, isFollowing, onFollow, onFollowChange, supabase, cachedUserId]);

  const handleBuy = useCallback(async () => {
    // A second tap while the checkout POST is in flight would create a
    // duplicate Stripe session — ignore it.
    if (checkoutState !== "idle") return;

    trackEvent("buy_clicked", {
      post_id: postId,
      creator_id: creatorId,
      product_id: productId,
      price: priceCents ? priceCents / 100 : null,
      product_type: productType,
      category: postCategory ? normalizeCategory(postCategory) : null,
    });
    scoreInterest(10);
    trackMetric("buy_clicks");

    if (onBuy) {
      onBuy();
      return;
    }

    setCheckoutState("starting");
    setCheckoutError(null);

    let resolvedProductId = productId;
    if (!resolvedProductId && postId) {
      try {
        const r = await fetch(
          `/api/posts/product-ids?ids=${encodeURIComponent(postId)}`,
          { credentials: "include" }
        );
        const map = (await r.json().catch(() => ({}))) as Record<string, string | null>;
        resolvedProductId = map[postId] ?? null;
      } catch {
        // keep null
      }
    }

    if (!resolvedProductId) {
      setCheckoutError("No product attached to this post yet.");
      setCheckoutState("idle");
      return;
    }

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          type: "product",
          product_id: String(resolvedProductId),
          post_id: postId ?? undefined,
          creator_id: creatorId ?? null,
          titleForCheckout: titleForCheckout ?? undefined,
          buyer_id: cachedUserId ?? undefined,
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

      // Keep "starting" while the browser navigates to Stripe so the
      // button stays disabled.
      window.location.assign(url);
    } catch (e) {
      console.error("[buy] error:", e);
      setCheckoutError((e as Error).message || "Failed to start checkout.");
      setCheckoutState("idle");
    }
  }, [onBuy, productId, postId, creatorId, titleForCheckout, cachedUserId, checkoutState]);
  // Fire-and-forget interest score update (never blocks UI)
  const scoreInterest = useCallback((delta: number) => {
    const pid = postIdRef.current;
    if (!pid) return;
    fetch("/api/interest-score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: pid, delta }),
    }).catch(() => {});
  }, []);

  // Fire-and-forget post metrics update
  const trackMetric = useCallback((field: string, watchSeconds?: number) => {
    const pid = postIdRef.current;
    if (!pid) return;
    fetch("/api/post-metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: pid, field, watch_seconds: watchSeconds }),
    }).catch(() => {});
  }, []);

  const handleBook = useCallback(async () => {
    if (checkoutState !== "idle") return;

    trackEvent("call_booking_started", {
      post_id: postIdRef.current,
      creator_id: creatorIdRef.current,
      category: categoryRef.current,
    });

    if (onBook) {
      onBook();
      return;
    }

    if (!bookingRedirectUrl) {
      setCheckoutError("No booking link is configured for this post.");
      return;
    }

    setCheckoutState("starting");
    setCheckoutError(null);

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
      if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
        // Previously a silent no-op: the button just appeared dead.
        throw new Error("Not a valid booking URL returned from server.");
      }
      window.location.assign(url);
    } catch (e) {
      console.error("[book] error:", e);
      setCheckoutError((e as Error).message || "Failed to start booking.");
      setCheckoutState("idle");
    }
  }, [onBook, bookingRedirectUrl, postId, creatorId, checkoutState]);

  const handleAvatarClick = useCallback(
    async (e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();

      if (creatorProfileHref) {
        trackMetric("profile_clicks");
        router.push(creatorProfileHref);
        return;
      }

      if (!postId) {
        console.warn(
          "[VideoCard] Missing creator, creatorUsername, and postId for profile redirect"
        );
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
          trackMetric("profile_clicks");
          router.push(`/creators/${payload.creatorId}`);
        } else {
          console.warn(
            "[VideoCard] creatorId missing in API response for postId:",
            postId
          );
        }
      } catch (err) {
        console.error("[VideoCard] Avatar redirect error:", err);
      }
    },
    [creatorProfileHref, postId, router]
  );

  return (
    <div className="relative w-full mx-auto max-w-full lg:w-[420px] lg:max-w-[420px] max-lg:h-[calc(100dvh-56px)] max-lg:flex max-lg:flex-col lg:h-[100dvh] lg:min-h-[100dvh]">



      <div
        ref={containerRef}
        role="group"
        aria-label={`${displayCreator}: ${displayTitle}`}

        className="relative w-full max-lg:h-[calc(100dvh-56px)] max-lg:min-h-[calc(100dvh-56px)] overflow-hidden border border-white/12 bg-black lg:h-[100dvh] lg:min-h-[100dvh]"

        style={{ borderRadius: "16px 16px 20px 20px" }}
        onKeyDown={handleKeyDown}
        tabIndex={0}
      >

      {/* On mobile: absolute inset-0 so video area always fills the card; on desktop: fixed height */}
      <div className="relative w-full h-full max-lg:absolute max-lg:inset-0 max-lg:h-[calc(100dvh-56px)] max-lg:min-h-[calc(100dvh-56px)] bg-black overflow-hidden lg:h-[100dvh] lg:min-h-[100dvh]" style={{ borderRadius: "16px 16px 0 0" }}>



        {videoSrc || src ? (
          <video
            ref={videoRef}
            src={videoSrc || src}
            poster={poster || undefined}
            playsInline
            muted={isMuted}
            preload="metadata"
            loop
            className="absolute inset-0 h-full w-full max-lg:h-[calc(100dvh-56px)] max-lg:min-h-[calc(100dvh-56px)] lg:h-[100dvh] lg:min-h-[100dvh] object-cover"
            onClick={handleVideoClick}
          />
        ) : poster ? (
          <img
            src={poster}
            alt={displayTitle || "Post media"}
            className="absolute inset-0 h-full w-full max-lg:h-[calc(100dvh-56px)] max-lg:min-h-[calc(100dvh-56px)] lg:h-[100dvh] lg:min-h-[100dvh] object-cover"

            style={{ borderRadius: "16px 16px 0 0" }}
          />
        ) : null}

        <div
          className={`absolute top-2 sm:top-3 ${
            mobileMuteButtonSide === "left"
              ? "left-2 sm:left-3"
              : "right-2 sm:right-3"
          } lg:left-3 lg:right-auto h-10 w-10 rounded-full bg-black/35 backdrop-blur-md border border-white/10 text-white flex items-center justify-center hover:bg-black/50 transition focus:outline-none focus:ring-2 focus:ring-white/60 z-30 max-lg:bg-transparent max-lg:hover:bg-transparent max-lg:backdrop-blur-0`}
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

      <div
        className="absolute inset-x-0 bottom-0 z-20"
        style={{ borderRadius: "0 0 20px 20px", overflow: "hidden" }}
      >
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 sm:h-36 bg-gradient-to-t from-black/45 via-black/15 to-transparent" />
          <div className="relative p-3 sm:p-4 max-lg:translate-y-[7px] lg:translate-y-0">
          <div className="flex items-start gap-3 mb-3 translate-y-[44px] lg:translate-y-[45px]">

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 min-w-0">
                {creatorProfileHref ? (
                  <Link
                    href={creatorProfileHref}
                    onClick={(e) => {
                      e.stopPropagation();
                      trackMetric("profile_clicks");
                    }}
                    className="text-white font-semibold text-base truncate hover:underline"
                  >
                    {displayCreator}
                  </Link>
                ) : (
                  <span className="text-white font-semibold text-base truncate">
                    {displayCreator}
                  </span>
                )}
              </div>
              <p className="text-white/95 text-base line-clamp-2 leading-snug mt-[6px] lg:mt-0">
                {displayTitle}
              </p>
              {hashtags && (
                <div className="text-white/70 text-xs mt-1 min-w-0">
                  {clickableFromDisplay.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {clickableFromDisplay.map((tag) => (
                        <Link
                          key={tag.toLowerCase()}
                          href={`/tag/${encodeURIComponent(tag.toLowerCase())}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            // Tapping a hashtag is a strong signal that the
                            // viewer wants more of that category — bump the
                            // user's interest score for the tapped tag.
                            fetch("/api/interest-score", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                category: tag.toLowerCase(),
                                delta: 5,
                              }),
                            }).catch(() => {});
                          }}
                          className="hover:underline"
                        >
                          #{tag}
                        </Link>
                      ))}
                    </div>
                  ) : (
                    <span>{hashtags}</span>
                  )}
                </div>
              )}
            </div>
          </div>
          {(showCTA || onBuy || onBook || (productId && priceCents)) && (
            <div className="mt-2 relative -translate-y-[0.67in] lg:-translate-y-[0.67in]" ref={wrapperRef}>
              <BuyButton
                ref={buyButtonRef}
                onClick={() => setMenuOpen((prev) => !prev)}
                expanded={menuOpen}
                priceCents={
                  priceCents && priceCents > 0
                    ? priceCents
                    : fetchedPriceCents && fetchedPriceCents > 0
                      ? fetchedPriceCents
                      : null
                }
              />

              {menuOpen && dropdownPosition && typeof document !== "undefined" && createPortal(
                <div
                  data-buy-dropdown
                  role="menu"
                  className="fixed z-[9999] min-w-[140px] max-w-[min(200px,85vw)] rounded-lg bg-gradient-to-b from-[#B5BAC2]/45 to-[#B5BAC2]/30 backdrop-blur-sm border border-white/25 shadow-[inset_0_1px_1px_rgba(255,255,255,0.45),0_8px_24px_rgba(0,0,0,0.25)] overflow-hidden"
                  style={{
                    left: dropdownPosition.left,
                    top: dropdownPosition.top,
                  }}
                >
                  <button
                    role="menuitem"
                    disabled={checkoutState === "starting"}
                    onClick={() => {
                      setMenuOpen(false);
                      handleBuy();
                    }}
                    className="w-full text-left px-3 py-2 text-xs sm:text-sm font-semibold text-black hover:bg-white/20 transition disabled:opacity-60"
                  >
                    Pay in full {((priceCents && priceCents > 0) || (fetchedPriceCents && fetchedPriceCents > 0)) ? `$${(((priceCents && priceCents > 0 ? priceCents : fetchedPriceCents) || 0) / 100).toFixed(2)}` : ""}
                  </button>
                  {(productType === "course" || productType === "mentorship" || allowBooking) && (
                    <>
                      <div className="h-px bg-white/30" />
                      <button
                        role="menuitem"
                        disabled={checkoutState === "starting"}
                        onClick={() => {
                          setMenuOpen(false);
                          handleBook();
                        }}
                        className="w-full text-left px-3 py-2 text-xs sm:text-sm font-semibold text-black hover:bg-white/20 transition disabled:opacity-60"
                      >
                        Book
                      </button>
                    </>
                  )}
                </div>,
                document.body
              )}
              {checkoutState === "starting" ? (
                <p className="mt-1.5 text-xs text-white/80" role="status">
                  Opening secure checkout…
                </p>
              ) : checkoutError ? (
                <p className="mt-1.5 text-xs text-red-400" role="alert">
                  {checkoutError}
                </p>
              ) : null}
            </div>
          )}
          </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/20 z-30" style={{ height: "2px" }}>
        <div
          className="h-full bg-white/60 transition-all duration-150"
          style={{ width: `${progress}%`, height: "2px" }}
        />
      </div>
    </div>

      <div
        className="absolute grid gap-3 right-2 lg:right-[-70px] bottom-[72px] lg:bottom-6"
        style={{ 
          pointerEvents: "auto",
          zIndex: 50
        }}
      >
        <div className="relative h-12 w-12 sm:h-[52px] sm:w-[52px] md:h-14 md:w-14 lg:h-[56px] lg:w-[56px]">
          <button
            type="button"
            onClick={handleAvatarClick}
            className="h-full w-full rounded-full overflow-hidden border-2 border-white/20 flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-white/60 cursor-pointer"
            aria-label={`${displayCreator} profile`}
            style={{ pointerEvents: "auto", zIndex: 51 }}
          >
            {/* Decorative: the button's aria-label already names the creator. */}
            <img
              src={displayAvatar}
              alt=""
              className="h-full w-full object-cover pointer-events-none"
            />
          </button>
          {canFollow && !isFollowing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
                handleFollow();
              }}
              disabled={followLoading}
              className="btn-icon-small absolute -bottom-1 left-[15px] lg:left-[18px] h-6 w-6 max-lg:!h-[18px] max-lg:!w-[18px] rounded-full bg-[#4A35C7] text-white flex items-center justify-center border border-black/70 shadow-lg hover:bg-[#3D2BA3] disabled:opacity-60 transition-all focus:outline-none focus:ring-2 focus:ring-[#4A35C7]/60 z-10"

              aria-label={`Follow ${displayCreator}`}
            >
              <Plus className="h-3 w-3 max-lg:!h-[9px] max-lg:!w-[9px]" />
            </button>
          )}
        </div>
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={handleLike}
            aria-label="Like"
            className="h-[48px] w-[48px] rounded-full border border-white/10 bg-[#1A1F22] text-white flex items-center justify-center hover:opacity-90 transition focus:outline-none focus:ring-2 focus:ring-white/60 max-lg:h-auto max-lg:w-auto max-lg:rounded-none max-lg:border-0 max-lg:bg-transparent max-lg:focus:ring-0 max-lg:focus-visible:ring-0 max-lg:active:bg-transparent max-lg:[-webkit-tap-highlight-color:transparent]"
          >
            <Heart className={`h-6 w-6 ${liked ? "fill-red-500 text-red-500" : "fill-current"}`} />
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
            className="h-[48px] w-[48px] rounded-full border border-white/10 bg-[#1A1F22] flex items-center justify-center hover:opacity-90 transition focus:outline-none focus:ring-2 focus:ring-white/60 max-lg:h-auto max-lg:w-auto max-lg:rounded-none max-lg:border-0 max-lg:bg-transparent"
          >
            <svg viewBox="0 0 24 24" className="h-[29px] w-[29px] object-contain" aria-hidden="true">
              <path
                d="M12 4.5c-4.9 0-8.5 3.1-8.5 7.3c0 2.5 1.4 4.7 3.8 6l-1.1 3.2l3.4-1.9c0.8 0.2 1.6 0.3 2.4 0.3c4.9 0 8.5-3.1 8.5-7.3S16.9 4.5 12 4.5Z"
                fill="white"
                stroke="white"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <circle cx="9" cy="12" r="1.1" fill="black" />
              <circle cx="12" cy="12" r="1.1" fill="black" />
              <circle cx="15" cy="12" r="1.1" fill="black" />
            </svg>
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
            className="h-[48px] w-[48px] rounded-full border border-white/10 bg-[#1A1F22] flex items-center justify-center hover:opacity-90 transition focus:outline-none focus:ring-2 focus:ring-white/60 max-lg:h-auto max-lg:w-auto max-lg:rounded-none max-lg:border-0 max-lg:bg-transparent"
        >
            <svg viewBox="0 0 24 24" className="h-[29px] w-[29px] object-contain transform -scale-x-100" aria-hidden="true">
              <path
                d="M10 6V3L2 11L10 19V16C16.4 16 20.4 18.8 22 22C21.3 12.8 16.2 8 10 8V6Z"
                fill="white"
                stroke="white"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
        </button>
          {shareCopied ? (
            <span className="text-[12px] font-semibold leading-none tracking-tight text-[#4A35C7] translate-y-[1px]">
              Link copied
            </span>
          ) : (
            <span className="text-[12px] font-semibold leading-none tracking-tight text-white translate-y-[1px]">
              {formatCount(sh)}
            </span>
          )}
        </div>
      </div>

      {/* Comment Panel */}
      {postId && (
        <CommentPanel
          postId={postId}
          isOpen={commentPanelOpen}
          onClose={() => setCommentPanelOpen(false)}
          onCommentAdded={handleCommentAdded}
        />
      )}
    </div>
  );
}

function toNum(n: number | string | undefined | null): number {
  if (n === undefined || n === null) return 0;
  return typeof n === "string" ? Number(n) || 0 : n || 0;
}
