"use client";

import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { getImageProps } from "next/image";
import { useRouter } from "next/navigation";
import { Heart, Volume2, VolumeX, Plus } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { placeBuyDropdown, type DropdownPlacement } from "@/lib/buyDropdownPlacement";
import BuyButton from "./BuyButton";
import DeleteVideoButton from "./DeleteVideoButton";
import { formatSocialProof } from "@/lib/socialProof";
import type { MonthlyMentorshipTerms } from "@/lib/membershipTerms";
import dynamic from "next/dynamic";
const CommentPanel = dynamic(() => import("./CommentPanel"), { loading: () => null });
import VerifiedCreatorBadge from "./VerifiedCreatorBadge";
import { useUser } from "@/lib/useUser";
import { useSoundPreference } from "@/lib/audioPreference";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";
import { trackEvent, normalizeCategory } from "@/lib/posthog";
import { feedMediaUrl, feedPosterUrl } from "@/lib/feedMedia";

type VideoCardProps = {
  onFeedDeleted?: (postId: string) => void;
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
  preload?: "auto" | "metadata" | "none";
  defaultMuted?: boolean;
  onBuy?: () => void;
  onBook?: () => void;
  followable?: boolean;
  onFollow?: () => void;
  postId?: string | null;
  onDeleted?: () => void;
  postCategory?: string | null;
  productId?: string | null;
  creatorId?: string | null;
  /** Stable handle for /profile/[username] links; optional when only creatorId is known */
  creatorUsername?: string | null;
  /** Creator finished Stripe Connect onboarding → purple "Verified creator" badge after the name. */
  creatorVerified?: boolean;
  priceCents?: number | null;
  monthlyTerms?: MonthlyMentorshipTerms | null;
  purchaseOptionsReady?: boolean;
  titleForCheckout?: string | null;
  planMonths?: number | null;
  planPriceCents?: number | null;
  allowBooking?: boolean;
  bookingRedirectUrl?: string | null;
  productType?: string | null;
  /** posts.purchase_count; renders social proof only above SOCIAL_PROOF_MIN_COUNT. */
  purchaseCount?: number | null;
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

/** play() rejects with NotAllowedError when autoplay policy blocks it (unmuted, no gesture yet). */
function isAutoplayBlockedError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "NotAllowedError"
  );
}

function VideoCard(props: VideoCardProps) {
  const {
    src: originalSrc,
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
    preload = "metadata",
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
    creatorVerified = false,
    priceCents = null,
    monthlyTerms = null,
    purchaseOptionsReady = true,
    titleForCheckout = null,
    planMonths = null,
    planPriceCents = null,
    allowBooking = false,
    bookingRedirectUrl = null,
    productType = null,
    purchaseCount = null,
    showFollowButton = false,
    isFollowingCreator = false,
    onFollowChange,
    soundEnabled,
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

  const [failedMediaSource, setFailedMediaSource] = useState<string | undefined>();
  const src = failedMediaSource === originalSrc ? originalSrc : feedMediaUrl(originalSrc);
  const [mediaError, setMediaError] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const displayPoster = useMemo(() => {
    const cdn = feedPosterUrl(poster);
    if (posterFailed || !cdn?.startsWith("https://media.creatornet.net/thumbnails/")) return poster || undefined;
    return getImageProps({ src: cdn, alt: "", width: 390, height: 694, quality: 75 }).props.src;
  }, [poster, posterFailed]);
  const deleted = useCallback(() => {
    if (postId && props.onFeedDeleted) props.onFeedDeleted(postId);
    else props.onDeleted?.();
  }, [postId, props.onFeedDeleted, props.onDeleted]);
  useEffect(() => { setMediaError(false); setFrameReady(false); }, [src, retryVersion]);
  useEffect(() => { setPosterFailed(false); }, [poster]);

  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Subscribed read of the saved per-device preference. This MUST come from the
  // hook, not a bare readSoundOn(): the hook renders the muted server snapshot
  // during hydration and applies the stored choice on the next client render.
  // Seeding useState from readSoundOn() instead made the server emit
  // muted={true} while the first client render computed muted={false}, and React
  // does not reliably repair a hydration mismatch on <video muted> — the saved
  // "sound on" silently failed to apply, which is the jank Noah reported.
  const [storedSoundOn, setStoredSoundOn] = useSoundPreference();
  // True while this card plays muted only because the browser refused
  // unmuted autoplay; shows the "Tap for sound" chip.
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  // Who decides whether this card is muted: the feed via soundEnabled, else the
  // saved per-device preference. DERIVED, never mirrored into state — mirroring
  // is what let the two drift apart (the feed said "sound on" while the card
  // still held its own stale `false`), and a derived value cannot desync.
  const ownerMuted =
    soundEnabled === undefined ? defaultMuted && !storedSoundOn : !soundEnabled;
  // The user's own tap on THIS card, applied optimistically so the video reacts
  // instantly instead of waiting for the feed to echo soundEnabled back down.
  // null = no local override, follow the owner.
  const [mutedOverride, setMutedOverride] = useState<boolean | null>(null);
  // When the owner's intent changes, both the local override and any earlier
  // autoplay refusal are stale — the browser deserves a fresh attempt (a user
  // gesture may have happened since). Adjusting state during render is React's
  // documented alternative to a reset-on-prop-change effect, and it is why this
  // component no longer needs one.
  const [prevOwnerMuted, setPrevOwnerMuted] = useState(ownerMuted);
  if (prevOwnerMuted !== ownerMuted) {
    setPrevOwnerMuted(ownerMuted);
    setMutedOverride(null);
    setAutoplayBlocked(false);
  }
  const isMuted = mutedOverride ?? (autoplayBlocked || ownerMuted);
  const mutedRef = useRef(isMuted);
  mutedRef.current = isMuted;
  const activeRef = useRef(isActive);
  activeRef.current = isActive;
  const [isPaused, setIsPaused] = useState(true);
  const [playbackFeedback, setPlaybackFeedback] = useState(false);
  const resumeFeedbackRef = useRef(false);
  const manuallyPausedRef = useRef(false);
  useEffect(() => { manuallyPausedRef.current = false; }, [postId, isActive]);

  useEffect(() => {
    if (!playbackFeedback || isPaused) return;
    const timeout = window.setTimeout(() => setPlaybackFeedback(false), 650);
    return () => window.clearTimeout(timeout);
  }, [playbackFeedback, isPaused]);

  useEffect(() => {
    setPlaybackFeedback(false);
    resumeFeedbackRef.current = false;
  }, [isActive, src]);
  const progressBarRef = useRef<HTMLDivElement | null>(null);
  const [lk, setLk] = useState(() => toNum(likeCount ?? likes ?? 0));
  const [cm, setCm] = useState(() => toNum(commentCount ?? comments ?? 0));
  const [sh, setSh] = useState(() => toNum(shareCount ?? shares ?? 0));
  const [liked, setLiked] = useState(isLiked);
  const likePendingRef = useRef(false);
  const tapRef = useRef<{ timer: number; x: number; y: number } | null>(null);
  const heartSequence = useRef(0);
  const [tapHeart, setTapHeart] = useState<{ id: number; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!tapHeart) return;
    const timer = window.setTimeout(() => setTapHeart(null), 750);
    return () => window.clearTimeout(timer);
  }, [tapHeart]);

  useEffect(() => {
    setTapHeart(null);
    return () => {
      if (tapRef.current) window.clearTimeout(tapRef.current.timer);
      tapRef.current = null;
    };
  }, [postId, src, isActive]);
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
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPlacement | null>(null);
  const buyMenuRef = useRef<HTMLDivElement>(null);
  const buyMenuId = `buy-menu-${postId ?? "card"}`;

  /** Everything focusable in the menu, in DOM order. The refund/delivery link is
   *  included on purpose: Stripe requires it to be reachable from the purchase
   *  flow, so it must be reachable by keyboard too. */
  const buyMenuItems = useCallback(
    () =>
      Array.from(
        buyMenuRef.current?.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not([disabled]), a[href]'
        ) ?? []
      ),
    []
  );

  const onBuyMenuKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // The profile gallery, search and tag pages all close their enclosing
        // modal on Escape. Without stopPropagation one press would close this
        // menu AND the post behind it.
        e.stopPropagation();
        setMenuOpen(false);
        buyButtonRef.current?.focus();
        return;
      }
      const items = buyMenuItems();
      if (items.length === 0) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      // Portal events still reach React ancestors: keep menu navigation from
      // also moving the underlying feed/tag carousel.
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        items[(i + 1) % items.length]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        items[(i - 1 + items.length) % items.length]?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        e.stopPropagation();
        items[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        e.stopPropagation();
        items[items.length - 1]?.focus();
      }
      // Tab is deliberately left alone: closing on Tab would make the
      // Stripe-required refund/delivery link unreachable by keyboard.
    },
    [buyMenuItems]
  );
  const [fetchedPriceCents, setFetchedPriceCents] = useState<number | null>(null);
  // Use cached user hook to avoid rate limits
  const { userId: cachedUserId, loading: authLoading } = useUser();

  // Refs for analytics (allow stable event-listener closures to access latest prop values)
  const postIdRef = useRef(postId);
  const creatorIdRef = useRef(creatorId);
  const categoryRef = useRef<string | null>(postCategory ? normalizeCategory(postCategory) : null);
  const hasTrackedViewRef = useRef(false);
  const hasTrackedCompleteRef = useRef(false);
  const hasTracked50Ref = useRef(false);

  // Declare stable analytics callbacks before the effects/handlers that use them.
  const scoreInterest = useCallback((delta: number) => {
    const pid = postIdRef.current;
    if (!pid) return;
    fetch("/api/interest-score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: pid, delta }),
    }).catch(() => {});
  }, []);

  const trackMetric = useCallback((field: string, watchSeconds?: number) => {
    const pid = postIdRef.current;
    if (!pid) return;
    fetch("/api/post-metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_id: pid, field, watch_seconds: watchSeconds }),
    }).catch(() => {});
  }, []);
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
  const canFollow = !authLoading && Boolean(creatorId) && creatorId !== cachedUserId && (followable ?? showFollowButton ?? false);
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

  // Reconcile changed server props before children paint, while preserving
  // optimistic interactions when those props have not changed.
  const [syncedProps, setSyncedProps] = useState({
    postId, likeCount, likes, isLiked, commentCount, comments,
    shareCount, shares, creatorId, isFollowingCreator, soundEnabled,
  });
  if (
    syncedProps.postId !== postId || syncedProps.likeCount !== likeCount ||
    syncedProps.likes !== likes || syncedProps.isLiked !== isLiked ||
    syncedProps.commentCount !== commentCount || syncedProps.comments !== comments ||
    syncedProps.shareCount !== shareCount || syncedProps.shares !== shares ||
    syncedProps.creatorId !== creatorId || syncedProps.isFollowingCreator !== isFollowingCreator ||
    syncedProps.soundEnabled !== soundEnabled
  ) {
    setSyncedProps({ postId, likeCount, likes, isLiked, commentCount, comments,
      shareCount, shares, creatorId, isFollowingCreator, soundEnabled });
    if (syncedProps.postId !== postId || syncedProps.likeCount !== likeCount || syncedProps.likes !== likes) {
      setLk(toNum(likeCount ?? likes ?? 0));
    }
    if (syncedProps.postId !== postId || syncedProps.isLiked !== isLiked) setLiked(isLiked);
    if (syncedProps.postId !== postId || syncedProps.commentCount !== commentCount || syncedProps.comments !== comments) {
      setCm(toNum(commentCount ?? comments ?? 0));
    }
    if (syncedProps.postId !== postId || syncedProps.shareCount !== shareCount || syncedProps.shares !== shares) {
      setSh(toNum(shareCount ?? shares ?? 0));
    }
    if (syncedProps.creatorId !== creatorId || syncedProps.isFollowingCreator !== isFollowingCreator) {
      setIsFollowing(Boolean(isFollowingCreator));
    }
  }

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest("[data-buy-dropdown]")) return;
      setMenuOpen(false);
    }
    function onScroll() {
      // Do NOT tear the menu down while the user is inside it. Moving focus to a
      // menu item can itself scroll the page, which fires this capture-phase
      // listener and would close the menu the instant it opened — making the
      // menu unusable by keyboard. Only close on scrolling that happens outside.
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest?.("[data-buy-dropdown]")) return;
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

  useLayoutEffect(() => {
    if (!menuOpen || !buyButtonRef.current) return;
    const rect = buyButtonRef.current.getBoundingClientRect();
    const viewport = {
      width: typeof window !== "undefined" ? window.innerWidth : 400,
      height: typeof window !== "undefined" ? window.innerHeight : 800,
    };
    setDropdownPosition(placeBuyDropdown(rect, viewport));
  }, [menuOpen]);

  // Move focus into the menu once it exists. Runs after dropdownPosition is set,
  // which is the same commit that renders the portal. Safe only because the
  // scroll handler above now ignores scrolling caused from inside the menu.
  useEffect(() => {
    if (!menuOpen || !dropdownPosition) return;
    buyMenuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
      ?.focus();
  }, [menuOpen, dropdownPosition]);

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
      if (progressBarRef.current) progressBarRef.current.style.transform = `scaleX(${pct / 100})`;
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
      setPlaybackFeedback(resumeFeedbackRef.current);
      resumeFeedbackRef.current = false;
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

    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);

    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
    };
  }, [scoreInterest, trackMetric, retryVersion, src]);

  // Keep the poster until a decoded frame can actually be displayed, also in
  // profile viewers where this card owns its own visibility observer.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const ready = () => setFrameReady(true);
    if (video.requestVideoFrameCallback) {
      const frame = video.requestVideoFrameCallback(ready);
      return () => video.cancelVideoFrameCallback(frame);
    }
    video.addEventListener("playing", ready, { once: true });
    return () => video.removeEventListener("playing", ready);
  }, [src, retryVersion]);

  // Browser refused unmuted playback (no gesture yet on this page): keep the
  // video moving muted and offer a one-tap unmute. The saved preference is
  // deliberately NOT touched — the user asked for sound, the browser said no.
  const fallBackToMuted = useCallback((video: HTMLVideoElement) => {
    if (manuallyPausedRef.current || activeRef.current === false || videoRef.current !== video) return;
    video.muted = true;
    // isMuted is derived from this flag, so setting it is the whole mute.
    setAutoplayBlocked(true);
    video.play().catch(() => {});
  }, []);

  const activationRef = useRef(isActive);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const activationChanged = activationRef.current !== isActive;
    activationRef.current = isActive;

    const wasPlaying = !video.paused;
    video.muted = isMuted;
    if (activationChanged || isActive === false || isMuted || !wasPlaying) return;

    // Unmuting a playing video by script (the feed flips soundEnabled once a
    // card becomes active). Without user activation Chrome/WebKit pause it;
    // re-requesting play() surfaces that as NotAllowedError so the same muted
    // fallback + chip applies as in tryPlay below.
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((err: unknown) => {
        if (isAutoplayBlockedError(err)) fallBackToMuted(video);
      });
    }
  }, [isMuted, isActive, fallBackToMuted]);

  // No effect mirrors soundEnabled or the stored preference into state any more:
  // isMuted is computed from both above, so the feed prop and the saved choice
  // take effect on the very next render, and uncontrolled cards on the same page
  // move together because useSoundPreference subscribes them to one store.

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Retry once, including when canplay already fired. Source replacement
    // restarts this effect, but must not undo an intentional manual pause.
    let cancelled = false;
    let visible = isActive === true;
    let retry: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      cancelled = true;
      if (retry) video.removeEventListener("canplay", retry);
      clearTimeout(retryTimer);
    };
    const tryPlay = (retried = false) => {
      if (cancelled || !visible || manuallyPausedRef.current) return;
      video.muted = mutedRef.current;
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch((err: unknown) => {
          if (cancelled || !visible || manuallyPausedRef.current) return;
          if (isAutoplayBlockedError(err) && !video.muted) {
            fallBackToMuted(video);
            return;
          }
          if (retried || isAutoplayBlockedError(err)) return;
          const onCanPlay = () => {
            tryPlay(true);
          };
          if (retry) video.removeEventListener("canplay", retry);
          retry = onCanPlay;
          if (video.readyState >= 3) retryTimer = setTimeout(onCanPlay, 100);
          else video.addEventListener("canplay", onCanPlay, { once: true });
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
              visible = true;
              tryPlay();
              if (!hasTrackedImpression) {
                hasTrackedImpression = true;
                trackMetric("impressions");
              }
            } else {
              visible = false;
              manuallyPausedRef.current = false;
              video.pause();
            }
          });
        },
        { threshold: 0.75 }
      );

      observer.observe(container);

      return () => {
        cleanup();
        observer.disconnect();
        video.pause();
      };
    } else if (isActive) {
      tryPlay();
    } else {
      video.pause();
    }
    return cleanup;
  // Mute-only changes are handled above, without restarting activation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, src, retryVersion, trackMetric, fallBackToMuted]);

  // Local diagnostics only: inspect the video element to distinguish download
  // readiness from activation-to-first-frame delay without extra React renders.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isActive) return;
    const started = performance.now();
    let frame: number | undefined;
    let stalls = 0;
    let measured = false;
    delete video.dataset.startupMs;
    video.dataset.startupReadyState = String(video.readyState);
    video.dataset.stallCount = "0";
    let ahead = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) {
        ahead = video.buffered.end(i) - video.currentTime;
        break;
      }
    }
    video.dataset.bufferedAheadSeconds = ahead.toFixed(2);
    const recordFrame = () => {
      if (measured) return;
      measured = true;
      video.dataset.startupMs = String(Math.round(performance.now() - started));
      video.dataset.firstFrameSinceNavigationMs = String(Math.round(performance.now()));
    };
    const onWaiting = () => { video.dataset.stallCount = String(++stalls); };
    if (video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(recordFrame);
    else video.addEventListener("playing", recordFrame, { once: true });
    video.addEventListener("waiting", onWaiting);
    return () => {
      if (frame !== undefined) video.cancelVideoFrameCallback(frame);
      video.removeEventListener("playing", recordFrame);
      video.removeEventListener("waiting", onWaiting);
    };
  }, [isActive, src, retryVersion]);

  const handleVideoClick = useCallback(() => {
    const video = videoRef.current;
    if (!video || !tapToTogglePlayback) return;

    if (video.paused) {
      manuallyPausedRef.current = false;
      resumeFeedbackRef.current = true;
      video.play().catch(() => { resumeFeedbackRef.current = false; });
    } else {
      manuallyPausedRef.current = true;
      resumeFeedbackRef.current = false;
      setPlaybackFeedback(true);
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

  // A real click/tap: the one place unmuted playback is always allowed.
  const handleTapForSound = useCallback(() => {
    setAutoplayBlocked(false);
    // The gesture is an explicit request for sound on this card right now.
    setMutedOverride(false);
    // For an uncontrolled card the owner is the saved preference, so record it
    // there too — otherwise a card whose default is muted snaps straight back.
    if (soundEnabled === undefined) setStoredSoundOn(true);
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    video.play().catch(() => {});
  }, [soundEnabled, setStoredSoundOn]);

  // True only while this card is muted *solely* because the browser refused
  // unmuted autoplay: the parent (feed) or the saved preference still says
  // "sound on". autoplayBlocked itself is sticky, so it must be qualified —
  // once the user is actually unmuted, or the feed has turned sound off, the
  // chip and the "honour the gesture" branch below no longer apply.
  const isMutedByAutoplayPolicy =
    autoplayBlocked && isMuted && soundEnabled !== false;

  const handleMuteToggle = useCallback(() => {
    if (isMutedByAutoplayPolicy) {
      // The parent / saved preference already say "sound on"; this card only
      // fell back to muted because autoplay was blocked. Honour the gesture.
      handleTapForSound();
      return;
    }
    const nextMuted = !isMuted;
    // Apply on this card immediately, and tell the owner: uncontrolled cards own
    // the saved preference, the feed flips soundEnabled via onToggleSound. When
    // the owner echoes the change back, the override is cleared above.
    setMutedOverride(nextMuted);
    if (soundEnabled === undefined) setStoredSoundOn(!nextMuted);
    onToggleSound?.();
  }, [
    isMutedByAutoplayPolicy,
    handleTapForSound,
    isMuted,
    soundEnabled,
    onToggleSound,
    setStoredSoundOn,
  ]);

  const handleLike = useCallback(async (likeOnly = false) => {
    if (likePendingRef.current || (likeOnly && liked)) return;
    likePendingRef.current = true;
    if (!postId) {
      // Fallback to old behavior if no postId
      setLiked(!liked);
      setLk((v) => liked ? Math.max(0, v - 1) : v + 1);
      try {
        await onLike?.();
      } catch {
        setLiked(liked);
        setLk(lk);
      } finally {
        likePendingRef.current = false;
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
        method: likeOnly ? "PUT" : "POST",
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
    } finally {
      likePendingRef.current = false;
    }
  }, [onLike, postId, liked, lk, creatorId, postCategory]);

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
    if (!canFollow || !creatorId || followLoading) return;
    if (onFollow) {
      onFollow();
      return;
    }

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
    if (checkoutState !== "idle" || !purchaseOptionsReady) return;

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

    if (monthlyTerms) {
      if (authLoading) return;
      if (!cachedUserId) { router.push("/auth"); return; }
      if (!productId || !postId) return;
      router.push(`/memberships/review?${new URLSearchParams({ product_id: productId, post_id: postId })}`);
      return;
    }

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
  }, [onBuy, productId, postId, creatorId, titleForCheckout, cachedUserId, checkoutState,
    monthlyTerms, purchaseOptionsReady, authLoading, router,
    priceCents, productType, postCategory, scoreInterest, trackMetric]);

  const socialProof = formatSocialProof(purchaseCount, productType);

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
    <div className="feed-mobile-card relative w-full mx-auto max-w-full lg:w-[420px] lg:max-w-[420px] max-lg:h-[calc(100dvh-56px)] max-lg:flex max-lg:flex-col lg:h-[100dvh] lg:min-h-[100dvh] touch-manipulation"
      onClick={(event) => {
        const target = event.target;
        // Portal clicks bubble through React, even outside this card's DOM.
        if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
        if (target.closest('button, a, input, textarea, select, label, summary, [role="button"], [role="link"], [role="menu"], [role="dialog"], [role="slider"], [contenteditable="true"], [data-no-playback-toggle]')) return;
        if (!src) return;
        const previous = tapRef.current;
        if (previous) {
          window.clearTimeout(previous.timer);
          tapRef.current = null;
          if (Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 48) {
            const bounds = event.currentTarget.getBoundingClientRect();
            setTapHeart({ id: ++heartSequence.current, x: event.clientX - bounds.left, y: event.clientY - bounds.top });
            void handleLike(true);
            return;
          }
          handleVideoClick();
        }
        tapRef.current = {
          x: event.clientX, y: event.clientY,
          timer: window.setTimeout(() => { tapRef.current = null; handleVideoClick(); }, 300),
        };
      }}
    >
      {tapHeart && (
        <span key={tapHeart.id} data-tap-heart aria-hidden="true"
          className="pointer-events-none absolute z-[60] text-red-500 drop-shadow-lg"
          style={{ left: tapHeart.x, top: tapHeart.y, transform: "translate(-50%, -50%)" }}
          ref={(node) => {
            if (!node?.animate || node.dataset.animated || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
            node.dataset.animated = "true";
            node.animate([
              { opacity: 0, transform: "translate(-50%, -50%) scale(0.5) rotate(-12deg)" },
              { opacity: 1, transform: "translate(-50%, -50%) scale(1.12) rotate(-12deg)", offset: 0.2 },
              { opacity: 1, transform: "translate(-50%, -50%) scale(1) rotate(-12deg)", offset: 0.6 },
              { opacity: 0, transform: "translate(-50%, -80%) scale(1.1) rotate(-12deg)" },
            ], { duration: 750, fill: "forwards" });
          }}
        ><Heart className="h-20 w-20 fill-current" strokeWidth={1} /></span>
      )}



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



        {src ? (
          <video
            key={retryVersion}
            ref={videoRef}
            src={src}
            onError={() => {
              if (src !== originalSrc) setFailedMediaSource(originalSrc);
              else setMediaError(true);
            }}
            poster={displayPoster}
            playsInline
            muted={isMuted}
            preload={preload}
            loop
            className="absolute inset-0 h-full w-full max-lg:h-[calc(100dvh-56px)] max-lg:min-h-[calc(100dvh-56px)] lg:h-[100dvh] lg:min-h-[100dvh] object-cover"
          />
        ) : poster ? (
          <img
            src={poster}
            alt={displayTitle || "Post media"}
            className="absolute inset-0 h-full w-full max-lg:h-[calc(100dvh-56px)] max-lg:min-h-[calc(100dvh-56px)] lg:h-[100dvh] lg:min-h-[100dvh] object-cover"

            style={{ borderRadius: "16px 16px 0 0" }}
          />
        ) : null}

        {src && displayPoster && !frameReady && !mediaError && <img src={displayPoster} alt="" aria-hidden="true" onError={() => setPosterFailed(true)} className="pointer-events-none absolute inset-0 h-full w-full object-cover" />}
        {src && mediaError && <div role="status" className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/75 text-white">
          <p>This video couldn’t load.</p>
          <button type="button" className="rounded-full border border-white/40 px-4 py-2" onClick={() => { manuallyPausedRef.current = false; setMediaError(false); setRetryVersion(value => value + 1); }}>Retry video</button>
          <p className="text-sm">You can also scroll to the next post.</p>
        </div>}

        {src && tapToTogglePlayback && (
          <div
            aria-hidden="true"
            data-playback-feedback={isPaused ? "paused" : "playing"}
            className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center transition-opacity duration-200 motion-reduce:transition-none ${playbackFeedback ? "opacity-100" : "opacity-0"}`}
          >
            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" className="text-white/85 drop-shadow-[0_1px_3px_rgba(0,0,0,0.55)]">
              {isPaused ? <path d="m8 4 12 8-12 8Z" /> : <><rect x="6" y="4" width="4" height="16" rx="0.6" /><rect x="14" y="4" width="4" height="16" rx="0.6" /></>}
            </svg>
          </div>
        )}

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

        {isMutedByAutoplayPolicy ? (
          <button
            type="button"
            onClick={handleTapForSound}
            className="absolute top-14 sm:top-16 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-black/75 transition focus:outline-none focus:ring-2 focus:ring-white/60"
          >
            <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
            Tap for sound
          </button>
        ) : null}
      </div>

      <div
        className="absolute inset-x-0 bottom-0 z-20"
        style={{ borderRadius: "0 0 20px 20px", overflow: "hidden" }}
      >
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 sm:h-36 bg-gradient-to-t from-black/45 via-black/15 to-transparent" />
          {/* max-lg:pb — on mobile there is ALWAYS a fixed 52px bar at the bottom
              of the feed (the signed-out "Join CreatorNet" CTA, or the nav once
              signed in), and it sits at z-40 over this z-20 overlay. Without the
              extra bottom padding the caption and hashtag row render underneath
              it: measured on production at 375x812 the hashtags occupied
              y=738-782 while the bar started at y=751, so the lower two thirds
              of a hashtag link was unclickable — elementFromPoint returned the
              bar, not the link. */}
          <div className="relative p-3 sm:p-4 max-lg:pb-[56px] max-lg:translate-y-[7px] lg:translate-y-0">
          <div className={`flex items-start gap-3 mb-3 ${monthlyTerms ? "" : "translate-y-[44px] lg:translate-y-[45px]"}`}>

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
                {/* Sibling of the name (not inside it): the name `truncate`s, so a
                    badge inside it is clipped away for long names. The row's gap-2
                    spaces it; shrink-0 on the badge keeps it visible. */}
                <VerifiedCreatorBadge verified={creatorVerified} size="sm" />
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
            <div className={`mt-2 relative ${monthlyTerms ? "" : "-translate-y-[0.67in] lg:-translate-y-[0.67in]"}`} ref={wrapperRef}>
              <BuyButton
                ref={buyButtonRef}
                onClick={() => setMenuOpen((prev) => !prev)}
                expanded={menuOpen}
                menuId={buyMenuId}
                monthly={!!monthlyTerms}
                priceCents={
                  !purchaseOptionsReady ? null : priceCents && priceCents > 0
                    ? priceCents
                    : fetchedPriceCents && fetchedPriceCents > 0
                      ? fetchedPriceCents
                      : null
                }
              />
              {monthlyTerms && (
                <p className="mt-1 text-xs text-white/80" data-monthly-terms>
                  {monthlyTerms.minimumMonths === 1 ? "One paid month; no additional minimum. " : `${monthlyTerms.minimumMonths}-month minimum commitment. `}
                  {monthlyTerms.autoRenew ? "Renews monthly after the minimum until canceled." : `Ends after ${monthlyTerms.minimumMonths} ${monthlyTerms.minimumMonths === 1 ? "month" : "months"}; no automatic renewal.`}
                </p>
              )}
              {socialProof && (
                <p className="mt-1 text-xs text-white/70" data-social-proof>
                  {socialProof}
                </p>
              )}

              {menuOpen && dropdownPosition && typeof document !== "undefined" && createPortal(
                <div
                  data-buy-dropdown
                  role="menu"
                  id={buyMenuId}
                  aria-label="Purchase options"
                  ref={buyMenuRef}
                  onKeyDown={onBuyMenuKeyDown}
                  // Opaque, not translucent: this panel floats over arbitrary
                  // video frames, and the old 45%/30% wash left black text at
                  // roughly 3.2:1 against a bright frame (and the policy link
                  // near 1.9:1), under the 4.5:1 WCAG AA minimum. A solid
                  // surface makes contrast independent of the video behind it.
                  className="fixed z-[9999] min-w-[140px] max-w-[min(200px,85vw)] rounded-lg bg-[#EDEFF2] border border-black/10 shadow-[inset_0_1px_1px_rgba(255,255,255,0.45),0_8px_24px_rgba(0,0,0,0.25)] overflow-hidden"
                  style={{
                    left: dropdownPosition.left,
                    ...("top" in dropdownPosition
                      ? { top: dropdownPosition.top }
                      : { bottom: dropdownPosition.bottom }),
                  }}
                >
                  <button
                    role="menuitem"
                    disabled={checkoutState === "starting" || !purchaseOptionsReady || (!!monthlyTerms && authLoading)}
                    onClick={() => {
                      setMenuOpen(false);
                      handleBuy();
                    }}
                    className="w-full text-left px-3 py-2 text-xs sm:text-sm font-semibold text-black hover:bg-black/5 focus:bg-black/10 focus:outline-none transition disabled:opacity-60"
                  >
                    {!purchaseOptionsReady ? "Purchase unavailable" : monthlyTerms ? "Buy monthly mentorship" : productType === "call" ? "Pay for call" : "Pay in full"} {purchaseOptionsReady && ((priceCents && priceCents > 0) || (fetchedPriceCents && fetchedPriceCents > 0)) ? `$${(((priceCents && priceCents > 0 ? priceCents : fetchedPriceCents) || 0) / 100).toFixed(2)}${monthlyTerms ? "/month" : ""}` : ""}
                  </button>
                  {(productType === "course" || productType === "mentorship" || allowBooking) && (
                    <>
                      <div className="h-px bg-black/10" />
                      <button
                        role="menuitem"
                        disabled={checkoutState === "starting"}
                        onClick={() => {
                          setMenuOpen(false);
                          handleBook();
                        }}
                        className="w-full text-left px-3 py-2 text-xs sm:text-sm font-semibold text-black hover:bg-black/5 focus:bg-black/10 focus:outline-none transition disabled:opacity-60"
                      >
                        Book
                      </button>
                    </>
                  )}
                  <div className="h-px bg-black/10" />
                  {/* Plain anchor, not a menuitem: Stripe requires the refund/
                      delivery terms to be reachable from the purchase flow. */}
                  <a
                    href="/legal/refunds"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block px-3 py-1.5 text-[11px] text-black underline underline-offset-2 hover:bg-black/5 focus:bg-black/10 focus:outline-none transition"
                  >
                    Refund &amp; delivery policy
                  </a>
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
          ref={progressBarRef}
          className="h-full bg-white/60 origin-left transition-transform duration-150 motion-reduce:transition-none"
          style={{ width: "100%", transform: "scaleX(0)", height: "2px" }}
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
            onClick={() => void handleLike()}
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
        {postId && creatorId && (props.onDeleted || props.onFeedDeleted) && (
          <DeleteVideoButton postId={postId} creatorId={creatorId} onDeleted={deleted} />
        )}
      </div>

      {/* Comment Panel */}
      {postId && commentPanelOpen && (
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

export default VideoCard;
