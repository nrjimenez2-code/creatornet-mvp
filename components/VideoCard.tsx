"use client";
import React from "react";

export type Tab = "following" | "discover";

type VideoCardProps = {
  src?: string;
  poster?: string | null;
  creator?: string;
  caption?: string;
  hashtags?: string;

  // legacy single CTA support
  ctaLabel?: string;
  onCta?: () => void;
  showCTA?: boolean;

  // chrome
  activeTab?: Tab;
  onChangeTab?: (t: Tab) => void;

  // social counts
  likes?: number | string;
  comments?: number | string;
  shares?: number | string;
  onLike?: () => Promise<void> | void;
  onComment?: () => Promise<void> | void;
  onShare?: () => Promise<void> | void;

  // checkout + booking
  postId?: string | null;
  creatorId?: string | null;
  priceCents?: number | null;         // e.g., 2900 => $29.00
  titleForCheckout?: string | null;
  allowBooking?: boolean;             // controls whether Book is offered
  bookingRedirectUrl?: string | null; // optional deep link after $0 booking
};

export default function VideoCard({
  src,
  poster,
  creator = "creator",
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

  // checkout/booking
  postId = null,
  creatorId = null,
  priceCents = 2900,
  titleForCheckout = null,
  allowBooking = false,
  bookingRedirectUrl = null,
}: VideoCardProps) {
  const [lk, setLk] = React.useState<number>(toNum(likes));
  const [cm, setCm] = React.useState<number>(toNum(comments));
  const [sh, setSh] = React.useState<number>(toNum(shares));

  const [loading, setLoading] = React.useState<"buy" | "book" | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false); // for Buy/Book popover

  const wrapperRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => setLk(toNum(likes)), [likes]);
  React.useEffect(() => setCm(toNum(comments)), [comments]);
  React.useEffect(() => setSh(toNum(shares)), [shares]);

  // close the little menu on outside click
  React.useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      setMenuOpen(false);
    }
    if (menuOpen) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  // ----- Client actions (calls your /api/checkout route) -----
  async function createCheckoutSession(payload: any) {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });

    // Read as text first, then try JSON so we never crash on empty/non-JSON bodies.
    let data: any = null;
    let raw = "";
    try {
      raw = await res.text();
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

    // Guard: only redirect if we received a proper absolute URL
    if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
      throw new Error("Not a valid checkout URL returned from server.");
    }

    try {
      if (data?.id) localStorage.setItem("last_checkout_session", String(data.id));
    } catch {}

    // Redirect to Stripe
    window.location.assign(url);
  }

  async function handleBuy() {
    if (!postId) return onCta?.();
    try {
      setLoading("buy");
      await createCheckoutSession({
        type: "purchase",
        postId,
        amountCents: Number.isFinite(priceCents) ? priceCents : 2900,
        title: titleForCheckout ?? caption ?? "CreatorNet Video",
        creatorId: creatorId ?? undefined,
      });
    } catch (e) {
      console.error("[buy] error:", e);
      setLoading(null);
      alert((e as Error).message || "Failed to start checkout.");
    }
  }

  async function handleBook() {
    if (!postId) return onCta?.();
    try {
      setLoading("book");

      // Prefer explicit link if provided; otherwise use round-robin router.
      const redir =
        bookingRedirectUrl ??
        `/api/book?creator_id=${encodeURIComponent(creatorId || "")}&post_id=${encodeURIComponent(
          postId
        )}`;

      await createCheckoutSession({
        type: "booking",
        postId,
        creatorId: creatorId ?? undefined,
        bookingRedirectUrl: redir,
      });
    } catch (e) {
      console.error("[book] error:", e);
      setLoading(null);
      alert((e as Error).message || "Failed to start booking.");
    }
  }

  // render one CTA pill; if booking enabled, it expands to let user choose
  const canShowCTA = Boolean(showCTA && postId);

  return (
    <div
      className="
        mx-auto
        w-full max-w-[520px] aspect-[9/16]
        lg:max-w-[1100px] lg:h-[92vh] lg:aspect-auto
        rounded-3xl bg-black shadow-[0_10px_40px_rgba(0,0,0,0.45)] overflow-hidden
        relative
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
            muted
            className="max-h-full max-w-full"
            style={{ objectFit: "contain" }}
          />
        ) : poster ? (
          <img
            src={poster}
            alt=""
            className="max-h-full max-w-full"
            style={{ objectFit: "contain" }}
          />
        ) : null}
      </div>

      {/* Tabs (mobile only) */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-6 text-white/90 text-sm font-semibold md:hidden">
        <button
          className="relative"
          onClick={() => onChangeTab?.("following")}
          aria-pressed={activeTab === "following"}
        >
          <span className={activeTab === "following" ? "opacity-100" : "opacity-70"}>
            Following
          </span>
          {activeTab === "following" && (
            <span className="absolute -bottom-1 left-0 right-0 mx-auto h-[2px] w-10 bg-white rounded-full" />
          )}
        </button>
        <button
          className={activeTab === "discover" ? "opacity-100" : "opacity-70"}
          onClick={() => onChangeTab?.("discover")}
          aria-pressed={activeTab === "discover"}
        >
          Discover
        </button>
      </div>

      {/* Action rail */}
      <div className="absolute right-5 top-1/2 -translate-y-1/2 flex flex-col items-center gap-6">
        <IconButton ariaLabel="Creator">
          <UserIcon />
        </IconButton>

        <IconButton
          ariaLabel="Like"
          label={formatNum(lk)}
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
        </IconButton>

        <IconButton
          ariaLabel="Comment"
          label={formatNum(cm)}
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
        </IconButton>

        <IconButton
          ariaLabel="Share"
          label={formatNum(sh)}
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
        </IconButton>
      </div>

      {/* CTA + meta */}
      <div className="absolute left-4 right-[84px] bottom-4 space-y-3">
        {canShowCTA ? (
          <div className="relative inline-block">
            {/* Single pill (click = buy OR open menu if booking enabled) */}
            <button
              type="button"
              disabled={loading !== null}
              onClick={() => {
                if (allowBooking) setMenuOpen((v) => !v);
                else void handleBuy();
              }}
              className="
                inline-flex items-center gap-2 px-3 py-1.5 rounded-full
                bg-white/95 text-black text-sm font-semibold hover:bg-white
                transition shadow-sm disabled:opacity-70 disabled:cursor-not-allowed
              "
              aria-haspopup={allowBooking ? "menu" : undefined}
              aria-expanded={allowBooking ? menuOpen : undefined}
            >
              <CartIcon />
              {loading === "buy"
                ? "Loading…"
                : allowBooking
                ? `Buy ${priceCentsToUSD(priceCents)} / Book`
                : `Buy ${priceCentsToUSD(priceCents)}`}
              {allowBooking && (
                <svg viewBox="0 0 24 24" className="h-4 w-4">
                  <path d="M7 10l5 5 5-5z" />
                </svg>
              )}
            </button>

            {/* Tiny popover for Buy/Book when enabled */}
            {allowBooking && menuOpen && (
              <div
                role="menu"
                className="
                  absolute z-20 mt-2 w-40 rounded-xl bg-white shadow-lg ring-1 ring-black/5
                  overflow-hidden
                "
              >
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void handleBuy();
                  }}
                  disabled={loading !== null}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 disabled:opacity-70"
                >
                  {loading === "buy" ? "Buying…" : `Buy ${priceCentsToUSD(priceCents)}`}
                </button>
                <div className="h-px bg-gray-200" />
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void handleBook();
                  }}
                  disabled={loading !== null}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 disabled:opacity-70"
                >
                  {loading === "book" ? "Booking…" : "Book Free Call"}
                </button>
              </div>
            )}
          </div>
        ) : (
          showCTA && (
            <button
              onClick={onCta}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/95 text-black text-sm font-semibold hover:bg-white transition shadow-sm"
            >
              <CartIcon />
              {ctaLabel}
            </button>
          )
        )}

        <div className="text-white/95">
          <div className="text-[15px] font-semibold">{creator}</div>
          <div className="text-sm text-white/85">{caption}</div>
          <div className="text-xs text-white/70">{hashtags}</div>
        </div>
      </div>
    </div>
  );
}

/* Helpers */
function IconButton({
  children,
  label,
  onClick,
  ariaLabel,
}: {
  children: React.ReactNode;
  label?: string;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel || "action"}
        className="
          h-11 w-11 rounded-full bg-white/10 hover:bg-white/15
          backdrop-blur-sm border border-white/15
          flex items-center justify-center text-white transition
        "
      >
        <div className="h-5 w-5">{children}</div>
      </button>
      {label ? (
        <div className="text-[11px] leading-none text-white/80 select-none mt-0.5">
          {label}
        </div>
      ) : null}
    </div>
  );
}

function toNum(n: number | string) {
  return typeof n === "string" ? Number(n) || 0 : n || 0;
}
function formatNum(n: number | string) {
  const num = typeof n === "string" ? Number(n) : n;
  if (!isFinite(num)) return String(n);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(num);
}
function priceCentsToUSD(cents: number | null | undefined) {
  const n = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  return `$${(n / 100).toFixed(2)}`;
}

/* Icons */
function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current">
      <path d="M12 12a5 5 0 1 0-5-5a5 5 0 0 0 5 5zm0 2c-4.4 0 0-2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z" />
    </svg>
  );
}
function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current">
      <path d="M12 21s-7.5-4.8-9.6-8.2C.4 10.3 2 6.5 5.6 6.1A5 5 0 0 1 12 8.6a5 5 0 0 1 6.4-2.5c3.6.4 5.2 4.2 3.2 6.7C19.5 16.2 12 21 12 21z" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current">
      <path d="M2 4h20v12H7l-5 5V4z" />
    </svg>
  );
}
function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current">
      <path d="M18 8a3 3 0 1 0-2.8-4H12v4h3.2A3 3 0 0 0 18 8zM6 14a3 3 0 1 0 2.8 4H12v-4H8.8A3 3 0 0 0 6 14zm12 0a3 3 0 1 0 0 6a3 3 0 0 0 0-6zM12 7l4 5h-3v4h-2v-4H8l4-5z" />
    </svg>
  );
}
function CartIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
      <path d="M7 4h14l-1.5 9H8.6L7 4zM3 4h2l3 12h10v2H7a2 2 0 0 1-2-1.5L3 4zM9 21a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3zM17 21a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3z" />
    </svg>
  );
}
