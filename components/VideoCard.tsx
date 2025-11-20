"use client";
// components/VideoCard.tsx  (READY TO REPLACE)
import React from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

export type Tab = "following" | "discover";

type VideoCardProps = {
  src?: string;
  poster?: string | null;
  creator?: string;
  creatorAvatarUrl?: string | null;
  caption?: string;
  hashtags?: string;

  ctaLabel?: string;
  onCta?: () => void;
  showCTA?: boolean;

  activeTab?: Tab;
  onChangeTab?: (t: Tab) => void;

  likes?: number | string;
  comments?: number | string;
  shares?: number | string;
  onLike?: () => Promise<void> | void;
  onComment?: () => Promise<void> | void;
  onShare?: () => Promise<void> | void;

  postId?: string | null;
  productId?: string | null;   // required for Buy in full
  creatorId?: string | null;

  priceCents?: number | null;          // full price
  titleForCheckout?: string | null;

  // Installment plan (optional)
  planMonths?: number | null;          // e.g., 5
  planPriceCents?: number | null;      // e.g., 100000 for $1,000/mo

  allowBooking?: boolean;
  bookingRedirectUrl?: string | null;

  productType?: string | null;
  showFollowButton?: boolean;
  isFollowingCreator?: boolean;
  soundEnabled?: boolean;
  onToggleSound?: () => void;
  tapToTogglePlayback?: boolean;
};

export default function VideoCard(props: VideoCardProps) {
  const {
    src,
    poster,
    creator = "creator",
    creatorAvatarUrl = null,
    caption = "Quick tip goes here",
    hashtags = "#tag1 #tag2",
    ctaLabel = "Buy / Book",
    onCta,
    showCTA = false,
    activeTab = "following",
    onChangeTab,
    likes = 0,
    comments = 0,
    shares = 0,
    onLike,
    onComment,
    onShare,

    postId = null,
    productId = null,
    creatorId = null,

    priceCents = 2900,
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
    tapToTogglePlayback = false,
  } = props;

  const router = useRouter();
  const [lk, setLk] = React.useState<number>(toNum(likes));
  const [cm, setCm] = React.useState<number>(toNum(comments));
  const [sh, setSh] = React.useState<number>(toNum(shares));
  const [loading, setLoading] = React.useState<"buy" | "book" | "plan" | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const [isFollowing, setIsFollowing] = React.useState<boolean>(Boolean(isFollowingCreator));
  const [followLoading, setFollowLoading] = React.useState(false);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [isPaused, setIsPaused] = React.useState(false);

  const hasPlan = !!(planMonths && planPriceCents && planMonths > 1 && planPriceCents > 0);
  const showBookOption = productType === "course" || productType === "mentorship";

  React.useEffect(() => setLk(toNum(likes)), [likes]);
  React.useEffect(() => setCm(toNum(comments)), [comments]);
  React.useEffect(() => setSh(toNum(shares)), [shares]);

  React.useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      setMenuOpen(false);
    }
    if (menuOpen) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  React.useEffect(() => {
    setIsFollowing(Boolean(isFollowingCreator));
  }, [isFollowingCreator]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const handlePlay = () => setIsPaused(false);
    const handlePause = () => setIsPaused(true);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
    };
  }, [src]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !soundEnabled;
    if (soundEnabled && video.paused) {
      video.play().catch(() => {
        /* autoplay might fail; ignore */
      });
    }
  }, [soundEnabled]);

  React.useEffect(() => {
    // reset pause state when video source changes
    setIsPaused(false);
  }, [src]);

  const canFollow = Boolean(showFollowButton && creatorId);
  const showFollowBadge = Boolean(canFollow && !isFollowing);

  const handleAvatarClick = React.useCallback(() => {
    if (!creatorId) return;
    router.push(`/creators/${creatorId}`);
  }, [creatorId, router]);

  const handleFollowToggle = React.useCallback(async () => {
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
  }, [canFollow, creatorId, followLoading, isFollowing]);

  const handleVideoTap = React.useCallback(() => {
    if (!tapToTogglePlayback) return;
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {
        setIsPaused(true);
      });
    } else {
      video.pause();
    }
  }, [tapToTogglePlayback]);

  async function createCheckoutSession(body: unknown) {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });

    let data: any = null;
    try {
      const raw = await res.text();
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    if (!res.ok) {
      const msg =
        (data && (data.error || data.message)) ||
        `Failed to create checkout session (HTTP ${res.status})`;
      throw new Error(msg);
    }

    const url = typeof data?.url === "string" ? data.url : "";
    if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
      throw new Error("Not a valid checkout URL returned from server.");
    }

    try { if (data?.id) localStorage.setItem("last_checkout_session", String(data.id)); } catch {}

    window.location.assign(url);
  }

  // Pay in full
  async function handleBuy() {
    try {
      setLoading("buy");
      const pid = productId ?? null;
      if (!pid) {
        setLoading(null);
        alert("No product attached to this post yet.");
        return;
      }
      await createCheckoutSession({
        type: "product",
        product_id: String(pid),
        post_id: postId ?? undefined,
        creator_id: creatorId ?? null,
        titleForCheckout: titleForCheckout ?? undefined,
      });
    } catch (e) {
      console.error("[buy] error:", e);
      setLoading(null);
      alert((e as Error).message || "Failed to start checkout.");
    }
  }

  // Pay monthly (installment plan)
  async function handlePlan() {
    try {
      setLoading("plan");
      const pid = productId ?? null;
      if (!pid || !hasPlan) {
        setLoading(null);
        alert("Monthly plan not available for this product.");
        return;
      }
      await createCheckoutSession({
        // IMPORTANT: server expects "plan" + plan_amount_cents
        type: "plan",
        product_id: String(pid),
        post_id: postId ?? undefined,
        creator_id: creatorId ?? null,
        plan_months: planMonths,
        plan_amount_cents: planPriceCents, // ← match server param name
        plan_title: titleForCheckout ?? undefined,
      });
    } catch (e) {
      console.error("[plan] error:", e);
      setLoading(null);
      alert((e as Error).message || "Failed to start plan checkout.");
    }
  }

  async function handleBook() {
    if (!postId) {
      onCta?.();
      return;
    }
    if (!bookingRedirectUrl) {
      alert("No booking link is configured for this post.");
      return;
    }
    try {
      setLoading("book");
      await createCheckoutSession({
        type: "booking",
        post_id: postId,
        creator_id: creatorId ?? undefined,
        bookingRedirectUrl,
      });
    } catch (e) {
      console.error("[book] error:", e);
      setLoading(null);
      alert((e as Error).message || "Failed to start booking.");
    }
  }

  const canShowCTA = Boolean(showCTA && (postId || productId));

  return (
    <div className="mx-auto flex w-full h-full max-w-[1200px] items-center justify-center gap-4 px-3">
      <div
        className="
          relative
          w-full max-w-[1080px]
          aspect-[9/16]
          min-h-[90vh]
          lg:min-h-[100vh] lg:w-auto
          rounded-3xl bg-black shadow-[0_10px_40px_rgba(0,0,0,0.45)] overflow-hidden
        "
        ref={wrapperRef}
      >
      {/* Media */}
      <div className="absolute inset-0 flex items-center justify-center bg-black overflow-hidden">
        {src ? (
          <video
            src={src}
            poster={poster || undefined}
            playsInline
            controls={false}
            loop
            autoPlay
            muted={!soundEnabled}
            className="max-h-full max-w-full"
            style={{ objectFit: "contain" }}
            ref={videoRef}
            onClick={handleVideoTap}
          />
        ) : poster ? (
          <img src={poster} alt="" className="max-h-full max-w-full" style={{ objectFit: "contain" }} />
        ) : null}
        {tapToTogglePlayback ? (
          <span
            className={`pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white transition ${
              isPaused ? "opacity-100" : "opacity-0"
            }`}
          >
            Tap to play
          </span>
        ) : null}
      </div>

      {/* Tabs (mobile only) */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-6 text-white/90 text-sm font-semibold md:hidden">
        <button className="relative" onClick={() => onChangeTab?.("following")} aria-pressed={activeTab === "following"}>
          <span className={activeTab === "following" ? "opacity-100" : "opacity-70"}>Following</span>
          {activeTab === "following" && <span className="absolute -bottom-1 left-0 right-0 mx-auto h-[2px] w-10 bg-white rounded-full" />}
        </button>
        <button className={activeTab === "discover" ? "opacity-100" : "opacity-70"} onClick={() => onChangeTab?.("discover")} aria-pressed={activeTab === "discover"}>
          Discover
        </button>
      </div>

      {/* Action rail (mobile overlay) */}
      <div className="absolute right-4 bottom-6 flex flex-col items-end gap-4 z-30 md:hidden" style={{ bottom: '120px' }}>
        <div className="self-end translate-x-0.5">
          <CreatorAvatarButton
            avatarUrl={creatorAvatarUrl}
            creatorName={creator}
            canNavigate={Boolean(creatorId)}
            onAvatarClick={creatorId ? handleAvatarClick : undefined}
            showFollowBadge={showFollowBadge}
            onFollowClick={showFollowBadge ? handleFollowToggle : undefined}
            followDisabled={followLoading}
          />
        </div>
        <ActionStat
          ariaLabel="Like"
          count={formatNum(lk)}
          onClick={async () => {
            setLk((v) => v + 1);
            try {
              await onLike?.();
            } catch {
              setLk((v) => Math.max(0, v - 1));
            }
          }}
        >
          <HeartIcon />
        </ActionStat>
        <ActionStat
          ariaLabel="Comment"
          count={formatNum(cm)}
          onClick={async () => {
            setCm((v) => v + 1);
            try {
              await onComment?.();
            } catch {
              setCm((v) => Math.max(0, v - 1));
            }
          }}
        >
          <ChatIcon />
        </ActionStat>
        <ActionStat
          ariaLabel="Share"
          count={formatNum(sh)}
          onClick={async () => {
            setSh((v) => v + 1);
            try {
              await onShare?.();
            } catch {
              setSh((v) => Math.max(0, v - 1));
            }
          }}
        >
          <ShareIcon />
        </ActionStat>
      </div>

      {/* CTA + meta */}
      {typeof soundEnabled === "boolean" && typeof onToggleSound === "function" ? (
        <SoundToggleButton enabled={soundEnabled} onClick={onToggleSound} />
      ) : null}
      <div className="absolute left-4 right-24 bottom-16 space-y-3 z-30 text-white">
        <div className="flex items-center gap-3">
          {canShowCTA ? (
            <div className="relative inline-block">
              <button
                type="button"
                disabled={loading !== null}
                onClick={() => setMenuOpen(v => !v)}
                className="
                  inline-flex items-center gap-2 px-3 py-1.5 rounded-full
                  bg-white/95 text-black text-sm font-semibold hover:bg-white
                  transition shadow-sm disabled:opacity-70 disabled:cursor-not-allowed
                "
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <CartIcon />
                {loading === "buy" || loading === "plan" ? "Loading…" :
                  hasPlan ? `Buy ${priceCentsToUSD(priceCents)} • or Plan` : `Buy ${priceCentsToUSD(priceCents)}`}
                <svg viewBox="0 0 24 24" className="h-4 w-4"><path d="M7 10l5 5 5-5z" /></svg>
              </button>

              {menuOpen && (
                <div role="menu" className="absolute z-20 mt-2 w-56 rounded-xl bg-white shadow-lg ring-1 ring-black/5 overflow-hidden">
                  <button role="menuitem" onClick={() => { setMenuOpen(false); void handleBuy(); }} disabled={loading !== null} className="w-full text-left px-3 py-2 text-sm text-gray-900 hover:bg-gray-100 disabled:opacity-70">
                    {loading === "buy" ? "Starting…" : `Pay in full ${priceCentsToUSD(priceCents)}`}
                  </button>
                  {hasPlan && (<>
                    <div className="h-px bg-gray-200" />
                    <button role="menuitem" onClick={() => { setMenuOpen(false); void handlePlan(); }} disabled={loading !== null} className="w-full text-left px-3 py-2 text-sm text-gray-900 hover:bg-gray-100 disabled:opacity-70">
                      {loading === "plan" ? "Starting…" : `Pay monthly ${priceCentsToUSD(planPriceCents)} × ${planMonths}`}
                    </button>
                  </>)}
                  {showBookOption && (
                    <>
                      <div className="h-px bg-gray-200" />
                      <button role="menuitem" onClick={() => { setMenuOpen(false); void handleBook(); }} disabled={loading !== null} className="w-full text-left px-3 py-2 text-sm text-gray-900 hover:bg-gray-100 disabled:opacity-70">
                        {loading === "book" ? "Starting…" : "Book"}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            showCTA && (
              <button onClick={onCta} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/95 text-black text-sm font-semibold hover:bg-white transition shadow-sm">
                <CartIcon /> {ctaLabel}
              </button>
            )
          )}

        </div>

        <div className="text-white/95">
          <div className="text-[15px] font-semibold">{creator}</div>
          <div className="text-sm text-white/85">{caption}</div>
          <div className="text-xs text-white/70">{hashtags}</div>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/80 via-black/40 to-transparent z-20" />
      </div>
      {/* Desktop action rail */}
      <div className="hidden md:flex flex-col items-center gap-3 pb-6" style={{ marginTop: '650px' }}>
        <CreatorAvatarButton
          avatarUrl={creatorAvatarUrl}
          creatorName={creator}
          canNavigate={Boolean(creatorId)}
          onAvatarClick={creatorId ? handleAvatarClick : undefined}
          showFollowBadge={showFollowBadge}
          onFollowClick={showFollowBadge ? handleFollowToggle : undefined}
          followDisabled={followLoading}
        />
        <ActionStat
          ariaLabel="Like"
          count={formatNum(lk)}
          onClick={async () => {
            setLk((v) => v + 1);
            try {
              await onLike?.();
            } catch {
              setLk((v) => Math.max(0, v - 1));
            }
          }}
        >
          <HeartIcon />
        </ActionStat>
        <ActionStat
          ariaLabel="Comment"
          count={formatNum(cm)}
          onClick={async () => {
            setCm((v) => v + 1);
            try {
              await onComment?.();
            } catch {
              setCm((v) => Math.max(0, v - 1));
            }
          }}
        >
          <ChatIcon />
        </ActionStat>
        <ActionStat
          ariaLabel="Share"
          count={formatNum(sh)}
          onClick={async () => {
            setSh((v) => v + 1);
            try {
              await onShare?.();
            } catch {
              setSh((v) => Math.max(0, v - 1));
            }
          }}
        >
          <ShareIcon />
        </ActionStat>
      </div>
    </div>
  );
}

type ActionStatProps = {
  children: React.ReactNode;
  count?: string | number;
  onClick?: () => void | Promise<void>;
  ariaLabel?: string;
};
function ActionStat({ children, count, onClick, ariaLabel }: ActionStatProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel || "action"}
      className="group flex flex-col items-center gap-1 text-white/90 hover:text-white transition"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1f1f1f] group-hover:bg-[#2b2b2b] transition overflow-hidden">
        <div className="h-5 w-5">{children}</div>
      </span>
      {typeof count !== "undefined" ? (
        <span className="text-sm font-semibold tracking-wide">
          {count}
        </span>
      ) : null}
    </button>
  );
}
type CreatorAvatarButtonProps = {
  avatarUrl?: string | null;
  creatorName?: string;
  showFollowBadge: boolean;
  onAvatarClick?: () => void;
  onFollowClick?: () => void;
  followDisabled?: boolean;
  canNavigate?: boolean;
};
function CreatorAvatarButton({
  avatarUrl,
  creatorName = "Creator",
  showFollowBadge,
  onAvatarClick,
  onFollowClick,
  followDisabled = false,
  canNavigate = false,
}: CreatorAvatarButtonProps) {
  return (
    <div className="relative flex flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={canNavigate ? onAvatarClick : undefined}
        disabled={!canNavigate}
        aria-label={`${creatorName} profile`}
        className="relative h-16 w-16 rounded-full flex items-center justify-center hover:bg-white/10 transition disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        style={{ overflow: "visible" }}
      >
        <span className="absolute inset-1 rounded-full overflow-hidden border border-white/15 bg-black/20">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt={creatorName} className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full flex items-center justify-center text-white/85">
              <UserIcon />
            </div>
          )}
        </span>
      </button>
      {showFollowBadge ? (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!followDisabled) {
              onFollowClick?.();
            }
          }}
          disabled={followDisabled}
          aria-label={`Follow ${creatorName}`}
          className="absolute -bottom-1 left-1/2 -translate-x-1/2 h-7 w-7 rounded-full bg-[#7F5CE6] text-white flex items-center justify-center border-2 border-black/70 shadow-lg hover:bg-[#6b4fd9] disabled:opacity-60"
        >
          <PlusIcon />
        </button>
      ) : null}
    </div>
  );
}

type SoundToggleButtonProps = {
  enabled: boolean;
  onClick: () => void;
};

function SoundToggleButton({ enabled, onClick }: SoundToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute left-3 bottom-3 flex items-center justify-center h-8 w-8 rounded-full border border-white/30 bg-black/35 backdrop-blur-sm text-white hover:bg-white/15 transition"
      aria-label={enabled ? "Mute video" : "Unmute video"}
    >
      {enabled ? <SoundOnIcon /> : <SoundOffIcon />}
    </button>
  );
}

function toNum(n: number | string) { return typeof n === "string" ? Number(n) || 0 : n || 0; }
function formatNum(n: number | string) {
  const num = typeof n === "string" ? Number(n) : n;
  if (!isFinite(num)) return String(n);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(num);
}
function priceCentsToUSD(cents?: number | null) {
  const n = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  return `$${(n / 100).toFixed(2)}`;
}

/* Icons */
function UserIcon(){return(<svg viewBox="0 0 24 24" className="h-full w-full fill-current"><path d="M12 12a5 5 0 1 0-5-5a5 5 0 0 0 5 5zm0 2c-4.4 0 0-2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z"/></svg>)}
function HeartIcon(){return(<svg viewBox="0 0 24 24" className="h-full w-full fill-current"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>)}
function ChatIcon(){return(<img src="/msg.png" alt="Comments" className="h-full w-full object-contain" />)}
function ShareIcon(){return(<img src="/image.png" alt="Share" className="h-full w-full object-contain" />)}
function CartIcon(){return(<svg viewBox="0 0 24 24" className="h-4 w-4 fill-current"><path d="M7 4h14l-1.5 9H8.6L7 4zM3 4h2l3 12h10v2H7a2 2 0 0 1-2-1.5L3 4zM9 21a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3zM17 21a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3z"/></svg>)}
function PlusIcon(){return(<svg viewBox="0 0 24 24" className="h-4 w-4 fill-current"><path d="M11 4h2v16h-2zM4 11h16v2H4z"/></svg>)}
function SoundOnIcon(){return(<svg viewBox="0 0 24 24" className="h-5 w-5 fill-current"><path d="m3 9v6h4l5 5V4L7 9H3zm13.5 3a3.5 3.5 0 0 0-2.5-3.347v6.694A3.5 3.5 0 0 0 16.5 12zm-2.5-7.857v2.126A6.5 6.5 0 0 1 19 12a6.5 6.5 0 0 1-5 6.357v2.126A8.5 8.5 0 0 0 21 12a8.5 8.5 0 0 0-7-7.857z"/></svg>)}
function SoundOffIcon(){return(<svg viewBox="0 0 24 24" className="h-5 w-5 fill-current"><path d="M5.707 4.293 4.293 5.707 8.586 10H3v4h5l5 5v-6.586l4.293 4.293 1.414-1.414-13-13zm7.293.707-4 4V10l4-4V5zm4.5-.857v2.126A6.5 6.5 0 0 1 21 12a6.5 6.5 0 0 1-2 4.652l1.46 1.46A8.5 8.5 0 0 0 23 12a8.5 8.5 0 0 0-5.5-8.857z"/></svg>)}
