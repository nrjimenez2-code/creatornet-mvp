"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import VideoCard from "./VideoCard";
import { createClient } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";
import { trackEvent, normalizeCategory } from "@/lib/posthog";
import {
  mapFeedV3Rows,
  isWithinRenderWindow,
  stringArrayOrNull,
  type FeedTab,
  type PostRow,
} from "@/lib/feedV3";

export type Tab = FeedTab;
export type { PostRow } from "@/lib/feedV3";

type FeedListProps = {
  activeTab: Tab;
  onChangeTab: (t: Tab) => void; // kept for API stability
  highlightPostId?: string | null;
};

const PAGE_SIZE = 20;

export default function FeedList({ activeTab, highlightPostId }: FeedListProps) {
  const supabase = useMemo(() => createClient(), []);
  const { userId: viewerId, loading: authLoading } = useUser();

  const [items, setItems] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const activeTabRef = useRef<Tab>(activeTab);
  const viewerIdRef = useRef<string | null>(null);
  // Bumped on every fresh feed load (tab change / auth settle). An in-flight
  // loadMore from a previous generation must throw its response away instead
  // of appending another tab's posts or clobbering the new pagination cursor.
  const fetchGenRef = useRef(0);

  // Sync activeTab to ref so loadMore can read it without a stale closure
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  // Sync viewerId to a ref so the load effect can read it without refetching
  // on every sign-in/out (see the comment inside the effect).
  useEffect(() => {
    viewerIdRef.current = viewerId ?? null;
  }, [viewerId]);

  // Track feed_viewed once on mount
  useEffect(() => {
    trackEvent("feed_viewed");
  }, []);
  const [globalSoundOn, setGlobalSoundOn] = useState(false);
  const [activePostId, setActivePostId] = useState<string | null>(null);
  // Mirror of items for event callbacks (the realtime handler) that need the
  // current list without a stale closure.
  const itemsRef = useRef<PostRow[]>([]);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const wheelLockRef = useRef(false);
  const touchStartYRef = useRef<number | null>(null);

  // Handler to update follow status in cached feed data
  const handleFollowChange = (creatorId: string, isFollowing: boolean) => {
    setItems((prevItems) =>
      prevItems.map((item) =>
        item.creator_id === creatorId
          ? { ...item, is_following: isFollowing }
          : item
      )
    );
  };

  useEffect(() => {
    let cancelled = false;

    // Reset pagination on every tab change / reload; invalidate stale loadMores.
    fetchGenRef.current += 1;
    offsetRef.current = 0;
    hasMoreRef.current = false;

    // Always set loading when fetching (including tab switches)
    setLoading(true);
    setFeedError(null);

    // Wait for the auth context to settle; the effect re-runs when it does.
    if (authLoading) return;

    (async () => {
      try {
        // Read the ref (synced above) instead of depending on viewerId directly,
        // so a mid-session sign-in/out doesn't refetch until the next tab change —
        // same as when this effect resolved auth itself.
        if (activeTab === "following" && !viewerIdRef.current) {
          // Following feed needs a logged-in user; keep UI stable if session
          // is temporarily unavailable (the RPC would return no rows anyway).
          if (!cancelled) {
            setItems([]);
            setFeedError(null);
            setLoading(false);
          }
          return;
        }

        // ONE call: ranked posts + creator profile + product meta + viewer
        // is_liked / is_following. The viewer is auth.uid() server-side.
        const { data, error } = await supabase.rpc("get_feed_v3", {
          p_tab: activeTab,
          p_limit: PAGE_SIZE,
          p_offset: 0,
        });

        if (error) {
          console.error("Feed RPC error:", error);
          if (!cancelled) {
            setFeedError(error.message || "Failed to load feed");
            setLoading(false);
          }
          return;
        }

        const rawCount = Array.isArray(data) ? data.length : 0;
        const mapped = mapFeedV3Rows(data);

        if (!cancelled) {
          setItems(mapped);
          setFeedError(null);
          setLoading(false);
          // Offset advances by RPC rows consumed, not by post-filter length,
          // so a dropped media-less row can never shift later pages.
          offsetRef.current = rawCount;
          hasMoreRef.current = rawCount >= PAGE_SIZE;
          if (mapped.length) {
            setActivePostId((prev) => prev ?? mapped[0]?.id ?? null);
          }
        }
      } catch (err) {
        console.error("[Feed] FeedList error:", err);
        if (!cancelled) {
          setFeedError(err instanceof Error ? err.message : "Failed to load feed");
          setLoading(false);
        }
      }
    })();

    // realtime: reflect inserts/updates/deletes on posts
    const channel = supabase
      .channel("posts-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "posts" },
        (payload) => {
          // DELETE payloads carry `new: {}` (truthy!) and the row in `old`,
          // so the event type — not truthiness — must pick the record.
          const eventRow = (payload.eventType === "DELETE"
            ? payload.old
            : payload.new) as {
            id?: string;
            post_id?: string;
            video_url?: string | null;
            poster_url?: string | null;
            hidden_at?: string | null;
            removed_at?: string | null;
          };
          const removedId = eventRow?.id ?? eventRow?.post_id;
          if (!removedId) return;

          // Drop the post on delete, on losing its media, or on being
          // moderated (hidden/removed — mirrors the feed's WHERE clause). If
          // it was the one on screen, hand the render window to a neighbor so
          // it doesn't collapse back to the top of the feed.
          // A truncated payload (payload.errors set, e.g. an oversized row)
          // can omit media URLs on a healthy post — never read that omission
          // as "media removed"; explicit deletes and moderation still apply.
          const payloadErrors = (payload as { errors?: string[] | null }).errors;
          const payloadTruncated = Array.isArray(payloadErrors) && payloadErrors.length > 0;
          if (
            payload.eventType === "DELETE" ||
            (!payloadTruncated && !eventRow.video_url && !eventRow.poster_url) ||
            eventRow.hidden_at != null ||
            eventRow.removed_at != null
          ) {
            const current = itemsRef.current;
            const idx = current.findIndex((p) => p.id === removedId);
            if (idx >= 0) {
              const remaining = current.filter((p) => p.id !== removedId);
              // Sync the mirror immediately: a second removal in the same
              // batch must not pick this (now dead) post as a neighbor.
              itemsRef.current = remaining;
              const neighborId = remaining.length
                ? remaining[Math.min(idx, remaining.length - 1)].id
                : null;
              setActivePostId((prevActive) =>
                prevActive === removedId ? neighborId : prevActive
              );
            }
            setItems((prev) => prev.filter((p) => p.id !== removedId));
            return;
          }

          setItems((prev) => {
            const row = payload.new as any;
            const postId = (row?.id ?? row?.post_id) as string | undefined;
            if (!postId) return prev;

            const i = prev.findIndex((p) => p.id === postId);
            if (i >= 0) {
              const next = [...prev];
              next[i] = {
                ...next[i],
                // only merge known fields
                title: row.title ?? next[i].title,
                video_url: row.video_url ?? next[i].video_url,
                poster_url: row.poster_url ?? next[i].poster_url,
                price_cents: row.price_cents ?? next[i].price_cents,
                product_id: row.product_id ?? next[i].product_id,
                allow_booking:
                  row.allow_booking ?? next[i].allow_booking ?? false,
                booking_url: row.booking_url ?? next[i].booking_url,
                interests: stringArrayOrNull(row.interests) ?? next[i].interests,
                hashtags: stringArrayOrNull(row.hashtags) ?? next[i].hashtags,
                purchase_count:
                  typeof row.purchase_count === "number"
                    ? row.purchase_count
                    : next[i].purchase_count ?? null,
                is_following: next[i].is_following,
              };
              return next;
            }
            // add to top for new posts (realtime payload may omit product_id — fetch it so "Pay in full" works)
            const newItem = {
              id: postId,
              creator_id: row.creator_id ?? null,
              product_id: row.product_id ?? null,
              price_cents: row.price_cents ?? 0,
              title: row.title ?? null,
              video_url: row.video_url ?? null,
              poster_url: row.poster_url ?? null,
              content: row.title ?? "",
              interests: stringArrayOrNull(row.interests) ?? [],
              hashtags: stringArrayOrNull(row.hashtags),
              created_at: row.created_at ?? null,
              likes_count: 0,
              comments_count: 0,
              shares_count: 0,
              purchase_count: 0,
              product_type: (row.product_type as string | null) ?? null,
              allow_booking: row.allow_booking ?? false,
              booking_url: row.booking_url ?? null,
              creator_name: null,
              creator_username: null,
              creator_avatar_url: null,
              is_following: false,
            };
            fetch(
              `${typeof window !== "undefined" ? window.location.origin : ""}/api/posts/product-ids?ids=${encodeURIComponent(postId)}`,
              { credentials: "include" }
            )
              .then((r) => r.json().catch(() => ({})))
              .then((map: Record<string, string | null>) => {
                const pid = map[postId] ?? newItem.product_id;
                if (pid != null) {
                  setItems((curr) =>
                    curr.map((p) =>
                      p.id === postId ? { ...p, product_id: pid } : p
                    )
                  );
                }
              })
              .catch(() => {});
            return [newItem, ...prev];
          });
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [activeTab, supabase, authLoading]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Track video_impression when a new post enters view
  useEffect(() => {
    if (!activePostId) return;
    const post = items.find((p) => p.id === activePostId);
    if (!post) return;
    trackEvent("video_impression", {
      post_id: activePostId,
      creator_id: post.creator_id,
      category: normalizeCategory(post.interests?.[0] ?? null),
    });
  }, [activePostId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to highlighted post when it loads — once per highlight id, so later
  // items updates (loadMore appends, realtime) can't yank the user back. The
  // active id is seeded first so the target's VideoCard is mounted (not a
  // placeholder) when the scroll lands on it, and the IntersectionObserver is
  // suppressed while the scroll travels so posts passing through the viewport
  // can't steal the active id back (with a timeout so it can never wedge).
  const highlightHandledRef = useRef<string | null>(null);
  const pendingHighlightScrollRef = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightPostId || items.length === 0) return;
    if (highlightHandledRef.current === highlightPostId) return;
    const element = sectionRefs.current.get(highlightPostId);
    if (!element) return; // not loaded yet; retry on the next items change
    highlightHandledRef.current = highlightPostId;
    pendingHighlightScrollRef.current = highlightPostId;
    setActivePostId(highlightPostId);
    // Wait a bit for layout to settle
    setTimeout(() => {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 300);
    // Safety valve: never suppress the observer for more than a few seconds.
    setTimeout(() => {
      if (pendingHighlightScrollRef.current === highlightPostId) {
        pendingHighlightScrollRef.current = null;
      }
    }, 4000);
  }, [highlightPostId, items]);

  useEffect(() => {
    if (!items.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) {
          const id = (visible.target as HTMLElement).dataset.postId;
          if (id) {
            // While a highlight scroll is traveling, only its target may
            // claim the active slot; posts passing by are ignored.
            const pending = pendingHighlightScrollRef.current;
            if (pending) {
              if (id !== pending) return;
              pendingHighlightScrollRef.current = null;
            }
            setActivePostId((prev) => (prev === id ? prev : id));
          }
        }
      },
      { threshold: 0.6 }
    );

    sectionRefs.current.forEach((node) => observer.observe(node));

    return () => observer.disconnect();
  }, [items]);

  const scrollByOneCard = useCallback(
    (direction: "up" | "down") => {
      if (!items.length) return;
      const currentIndex = Math.max(
        0,
        items.findIndex((p) => p.id === activePostId)
      );
      const targetIndex =
        direction === "up"
          ? Math.max(0, currentIndex - 1)
          : Math.min(items.length - 1, currentIndex + 1);

      const targetId = items[targetIndex]?.id;
      if (!targetId) return;
      const node = sectionRefs.current.get(targetId);
      if (!node) return;

      node.scrollIntoView({ behavior: "smooth", block: "start" });
      setActivePostId(targetId);
    },
    [items, activePostId]
  );

  const stepScrollWithLock = useCallback(
    (direction: "up" | "down") => {
      if (wheelLockRef.current) return;
      wheelLockRef.current = true;
      scrollByOneCard(direction);
      window.setTimeout(() => {
        wheelLockRef.current = false;
      }, 520);
    },
    [scrollByOneCard]
  );

  const handleWheelStep = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      // Enforce TikTok-like one-card movement per wheel gesture.
      if (!items.length) return;
      if (Math.abs(e.deltaY) < 8) return;
      e.preventDefault();
      stepScrollWithLock(e.deltaY > 0 ? "down" : "up");
    },
    [items.length, stepScrollWithLock]
  );

  const handleFeedKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!items.length) return;
      if (e.key === "ArrowDown" || e.key === "PageDown") {
        e.preventDefault();
        stepScrollWithLock("down");
      } else if (e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        stepScrollWithLock("up");
      }
    },
    [items.length, stepScrollWithLock]
  );

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const startY = touchStartYRef.current;
      const endY = e.changedTouches[0]?.clientY ?? null;
      touchStartYRef.current = null;
      if (startY == null || endY == null) return;
      const deltaY = startY - endY;
      if (Math.abs(deltaY) < 42) return;
      stepScrollWithLock(deltaY > 0 ? "down" : "up");
    },
    [stepScrollWithLock]
  );

  // Load the next page (both tabs — same single RPC, offset paginated)
  const loadMore = useCallback(async () => {
    if (!hasMoreRef.current || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);

    const gen = fetchGenRef.current;
    const currentOffset = offsetRef.current;

    try {
      const { data, error } = await supabase.rpc("get_feed_v3", {
        p_tab: activeTabRef.current,
        p_limit: PAGE_SIZE,
        p_offset: currentOffset,
      });

      // The tab changed (or the feed reloaded) while this request was in
      // flight — its rows belong to a dead generation. Touch nothing.
      if (gen !== fetchGenRef.current) return;

      if (error) {
        console.error("[Feed] loadMore error:", error);
        return;
      }

      const rawCount = Array.isArray(data) ? data.length : 0;
      if (!rawCount) {
        hasMoreRef.current = false;
        return;
      }

      const mapped = mapFeedV3Rows(data);

      offsetRef.current = currentOffset + rawCount;
      hasMoreRef.current = rawCount >= PAGE_SIZE;

      // Deduplicate and append
      setItems((prev) => {
        const existingIds = new Set(prev.map((p) => p.id));
        const newItems = mapped.filter((p) => !existingIds.has(p.id));
        return newItems.length ? [...prev, ...newItems] : prev;
      });
    } catch (err) {
      console.error("[Feed] loadMore error:", err);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [supabase]);

  // Trigger loadMore when the user is within 3 posts of the end (both tabs)
  useEffect(() => {
    if (!activePostId || !items.length) return;
    const currentIndex = items.findIndex((p) => p.id === activePostId);
    if (currentIndex >= items.length - 3) {
      loadMore();
    }
  }, [activePostId, items.length, loadMore]);

  if (loading && items.length === 0) {
    return (
      <div className="w-full flex justify-center py-10 text-sm text-gray-500">
        Loading…
      </div>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <div className="w-full flex flex-col items-center justify-center py-10 px-4 text-center">
        {feedError ? (
          <>
            <p className="text-sm text-red-400 font-medium mb-1">Couldn&apos;t load the feed</p>
            <p className="text-xs text-gray-500 max-w-md mb-3">
              Something went wrong on our end. Give it another try.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-full border border-gray-700 px-4 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-900 transition-colors"
            >
              Try again
            </button>
          </>
        ) : (
          <p className="text-sm text-gray-500">No posts yet.</p>
        )}
      </div>
    );
  }

  const activeIndex = activePostId
    ? items.findIndex((p) => p.id === activePostId)
    : 0;

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={feedScrollRef}
        className="h-full min-h-0 overflow-y-scroll snap-y snap-mandatory lg:snap-mandatory [&::-webkit-scrollbar]:hidden scroll-smooth"
        style={{
          scrollbarWidth: "none",
          overscrollBehaviorY: "contain",
          // Disable native vertical pan inertia so one-swipe-one-card stays consistent.
          touchAction: "pan-x",
        }}
        onWheel={handleWheelStep}
        onKeyDown={handleFeedKeyDown}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        tabIndex={0}
      >
        {items.map((p, idx) => {
        const price = typeof p.price_cents === "number" ? p.price_cents : 0;
        const isActive = activePostId === p.id;
        const isSoundOn = globalSoundOn && isActive;
        const sellable = !!p.product_id;
        const creatorCanSell = p.creator_can_sell !== false;
        const allowBooking =
          !!p.allow_booking &&
          typeof p.booking_url === "string" &&
          p.booking_url.length > 0;
        const showCTA =
          allowBooking ||
          (sellable && creatorCanSell) ||
          (price > 0 && creatorCanSell);
        // Virtualization: only mount the heavy VideoCard (and its <video>)
        // near the viewport; distant sections keep their full-height slot so
        // scroll-snap geometry and the IntersectionObserver keep working.
        const isMounted = isWithinRenderWindow(idx, activeIndex);

          return (
            <section
              key={p.id}
              className="snap-start snap-always lg:snap-always h-[100dvh] w-full flex items-start justify-center px-0 md:px-4 mt-0"
              data-post-id={p.id}
              ref={(el) => {
                const map = sectionRefs.current;
                if (el) {
                  map.set(p.id, el);
                } else {
                  map.delete(p.id);
                }
              }}
            >

              <div className="relative w-full h-full flex items-start justify-center max-w-full lg:-ml-[28rem]">
                {isMounted ? (
                  <VideoCard
                    // media
                    src={p.video_url || undefined}
                    poster={p.poster_url || undefined}
                    // meta
                    creator={p.creator_name ?? "Creator"}
                    creatorAvatarUrl={p.creator_avatar_url ?? null}
                    caption={p.content || ""}
                    hashtags={
                      Array.isArray(p.hashtags) && p.hashtags.length
                        ? p.hashtags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ")
                        : Array.isArray(p.interests) && p.interests.length
                          ? p.interests.map((t) => `#${t}`).join(" ")
                          : "#entrepreneur #focus"
                    }
                    hashtagsList={Array.isArray(p.hashtags) ? p.hashtags : null}
                    // social counts
                    likes={p.likes_count ?? 0}
                    comments={p.comments_count ?? 0}
                    shares={p.shares_count ?? 0}
                    // CTA & commerce
                    showCTA={showCTA}
                    postId={p.id}
                    postCategory={normalizeCategory(p.interests?.[0] ?? null)}
                    productId={p.product_id ?? null}
                    creatorId={p.creator_id ?? null}
                    creatorUsername={p.creator_username ?? null}
                    priceCents={price}
                    titleForCheckout={p.title ?? p.content ?? "CreatorNet Video"}
                    productType={p.product_type ?? null}
                    purchaseCount={p.purchase_count ?? null}
                    showFollowButton={activeTab === "discover"}
                    isFollowingCreator={p.is_following ?? false}
                    onFollowChange={handleFollowChange}
                    // booking
                    allowBooking={allowBooking}
                    bookingRedirectUrl={allowBooking ? p.booking_url! : null}
                    soundEnabled={isSoundOn}
                    onToggleSound={() => setGlobalSoundOn((prev) => !prev)}
                    mobileMuteButtonSide="left"
                    tapToTogglePlayback
                    isLiked={p.is_liked ?? false}
                  />
                ) : (
                  <div
                    aria-hidden="true"
                    className="w-full h-full bg-black"
                  />
                )}
              </div>
            </section>
          );
        })}
        {loadingMore && (
          <div className="h-16 flex items-center justify-center text-sm text-gray-500">
            Loading more…
          </div>
        )}
      </div>

      {/* Desktop-only feed navigation controls */}
      <div className="hidden lg:flex fixed right-6 top-1/2 -translate-y-1/2 z-40 flex-col gap-3">
        <button
          type="button"
          onClick={() => scrollByOneCard("up")}
          className="h-11 w-11 rounded-full border border-white/20 bg-black/70 text-white flex items-center justify-center shadow-[0_10px_25px_rgba(0,0,0,0.35)] backdrop-blur hover:bg-black/85 transition"
          aria-label="Previous post"
          title="Previous post"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
            <path d="M12 7l-6 6h12l-6-6z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => scrollByOneCard("down")}
          className="h-11 w-11 rounded-full border border-white/20 bg-black/70 text-white flex items-center justify-center shadow-[0_10px_25px_rgba(0,0,0,0.35)] backdrop-blur hover:bg-black/85 transition"
          aria-label="Next post"
          title="Next post"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
            <path d="M12 17l6-6H6l6 6z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
