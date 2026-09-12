"use client";

import { memo, useCallback, useEffect, useRef, useState, useMemo } from "react";
import FeedVideoCard from "./VideoCard";
const VideoCard = memo(FeedVideoCard);
import FeedEmptyState from "./FeedEmptyState";
import { loadFeedOffers } from "@/lib/feedOffers";
import { createClient } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";
import { readSoundOn, useSoundPreference } from "@/lib/audioPreference";
import { trackEvent, normalizeCategory } from "@/lib/posthog";
import { useDesktopViewport, usePageVisible } from "@/lib/browserVisibility";
import type { FeedInteraction } from "@/lib/feedInteraction";
import { scheduleFeedBackground } from "@/lib/feedBackground";
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
  onChangeTab: (t: Tab) => void; // used by the empty state's "Browse Discover"
  highlightPostId?: string | null;
};

const PAGE_SIZE = 20;

export default function FeedList({ activeTab, onChangeTab, highlightPostId }: FeedListProps) {
  const supabase = useMemo(() => createClient(), []);
  const { userId: viewerId, loading: authLoading } = useUser();
  const desktop = useDesktopViewport();
  const desktopRef = useRef(desktop);
  desktopRef.current = desktop;
  const pageVisible = usePageVisible();

  const [items, setItems] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [loadContext, setLoadContext] = useState({ activeTab, authLoading, viewerId });
  if (loadContext.activeTab !== activeTab || loadContext.authLoading !== authLoading || loadContext.viewerId !== viewerId) {
    if (loadContext.viewerId !== viewerId) setItems([]);
    setLoadContext({ activeTab, authLoading, viewerId });
    setLoading(true);
    setFeedError(null);
  }
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingPosts, setPendingPosts] = useState<string[]>([]);
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

  // Event callbacks use the current viewer to reject stale mutation responses.
  useEffect(() => {
    viewerIdRef.current = viewerId ?? null;
  }, [viewerId]);

  // Track feed_viewed once on mount
  useEffect(() => {
    trackEvent("feed_viewed");
  }, []);
  // Per-device, persisted across reloads (lib/audioPreference.ts).
  const [globalSoundOn, setGlobalSoundOn] = useSoundPreference();
  const [activePostId, setActivePostId] = useState<string | null>(null);
  const [warmingPostId, setWarmingPostId] = useState<string | null>(null);
  const [readyPostId, setReadyPostId] = useState<string | null>(null);
  const activeIdRef = useRef(activePostId);
  activeIdRef.current = activePostId;
  const draftsRef = useRef(new Map<string, string>());
  const handleFirstFrame = useCallback((id: string) => {
    if (activeIdRef.current === id) setReadyPostId(id);
  }, []);
  // Authoritative responses are lifted out of cards so virtualization cannot
  // restore old heart/count state. Late responses from another viewer are ignored.
  const handleInteractionChange = useCallback((id: string, patch: FeedInteraction) => {
    if ((viewerId ?? null) !== viewerIdRef.current) return;
    setItems(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row));
  }, [viewerId]);
  const handleDraftChange = useCallback((id: string, draft: string) => {
    if ((viewerId ?? null) !== viewerIdRef.current) return;
    if (draft) draftsRef.current.set(id, draft);
    else draftsRef.current.delete(id);
  }, [viewerId]);
  useEffect(() => { draftsRef.current.clear(); }, [viewerId]);
  // Mirror of items for event callbacks (the realtime handler) that need the
  // current list without a stale closure.
  const itemsRef = useRef<PostRow[]>([]);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const offerRefreshesRef = useRef(new Map<string, number>());
  const backgroundRef = useRef(new Set<() => void>());
  useEffect(() => () => {
    backgroundRef.current.forEach(cancel => cancel());
    backgroundRef.current.clear();
  }, [viewerId, activeTab]);
  const enrichPosts = useCallback((posts: PostRow[], generation: number) => {
    const versions = new Map(posts.map(post => {
      const version = (offerRefreshesRef.current.get(post.id) ?? 0) + 1;
      offerRefreshesRef.current.set(post.id, version);
      return [post.id, version];
    }));
    const run = () => {
    if (generation !== fetchGenRef.current) return;
    void loadFeedOffers(posts).then(offers => {
      if (generation !== fetchGenRef.current) return;
      const byId = new Map(offers.map(offer => [offer.id, offer]));
      setItems(current => current.map(post => {
        const offer = byId.get(post.id);
        if (!offer || offerRefreshesRef.current.get(post.id) !== versions.get(post.id)) return post;
        return { ...post, product_id: offer.product_id, product_type: offer.product_type,
          price_cents: offer.monthlyTerms ? offer.price_cents : post.price_cents,
          monthlyTerms: offer.monthlyTerms, purchaseOptionsReady: offer.purchaseOptionsReady };
      }));
    }).catch(() => { /* Media remains usable; unverified purchase controls stay disabled. */ });
    };
    if (desktopRef.current) run();
    else {
      const cancel = scheduleFeedBackground(() => {
        backgroundRef.current.delete(cancel);
        run();
      });
      backgroundRef.current.add(cancel);
    }
  }, []);

  // Handler to update follow status in cached feed data
  const handleFollowChange = useCallback((creatorId: string, isFollowing: boolean) => {
    setItems((prevItems) =>
      prevItems.map((item) =>
        item.creator_id === creatorId
          ? { ...item, is_following: isFollowing }
          : item
      )
    );
  }, []);

  const toggleSound = useCallback(() => setGlobalSoundOn(!readSoundOn()), [setGlobalSoundOn]);
  const handleDeleted = useCallback((id: string) => {
    draftsRef.current.delete(id);
    const current = itemsRef.current;
    const index = current.findIndex(row => row.id === id);
    const remaining = current.filter(row => row.id !== id);
    itemsRef.current = remaining;
    const neighbor = remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.id ?? null;
    setActivePostId(active => active === id ? neighbor : active);
    setItems(rows => rows.filter(row => row.id !== id));
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Reset pagination on every tab change / reload; invalidate stale loadMores.
    fetchGenRef.current += 1;
    offsetRef.current = 0;
    hasMoreRef.current = false;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setMoreError(false);
    setPendingPosts([]);
    setWarmingPostId(null);
    setReadyPostId(null);

    // Wait for the auth context to settle; the effect re-runs when it does.
    if (authLoading) return;

    (async () => {
      try {
        // Auth transitions start a fresh generation; viewer-specific reactions
        // must never survive an account change.
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

        // Ranked posts + creator profile + product meta + viewer
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
        const mapped = mapFeedV3Rows(data).map(post => ({ ...post, monthlyTerms: null, purchaseOptionsReady: false }));

        if (!cancelled) {
          setItems(mapped);
          enrichPosts(mapped, fetchGenRef.current);
          setFeedError(null);
          setLoading(false);
          // Offset advances by RPC rows consumed, not by post-filter length,
          // so a dropped media-less row can never shift later pages.
          offsetRef.current = rawCount;
          hasMoreRef.current = rawCount >= PAGE_SIZE;
          if (mapped.length) {
            setActivePostId(mapped[0]?.id ?? null);
            feedScrollRef.current?.scrollTo?.({ top: 0, behavior: "instant" });
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
    const offerRefreshes = offerRefreshesRef.current;
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
          // Do not prepend or hydrate unranked rows while someone is watching.
          // Refresh through the authoritative feed RPC only on an explicit tap.
          if (payload.eventType === "INSERT") {
            setPendingPosts(ids => ids.includes(removedId) ? ids : [...ids, removedId]);
            return;
          }
          const refresh = (offerRefreshes.get(removedId) ?? 0) + 1;
          offerRefreshes.set(removedId, refresh);

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

          const currentPost = itemsRef.current.find(p => p.id === removedId);
          // Updates to an unseen/queued post must not bypass the ranked refresh.
          if (!currentPost) return;
          const offerSource = { ...currentPost, ...payload.new, id: removedId } as PostRow;
          void loadFeedOffers([offerSource]).then(([offer]) => {
            if (cancelled || offerRefreshes.get(removedId) !== refresh) return;
            setItems(curr => curr.map(p => p.id === removedId ? { ...p,
              product_id: offer.product_id, product_type: offer.product_type,
              price_cents: offer.monthlyTerms ? offer.price_cents : p.price_cents,
              monthlyTerms: offer.monthlyTerms, purchaseOptionsReady: offer.purchaseOptionsReady,
            } : p));
          });

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
                monthlyTerms: null,
                purchaseOptionsReady: false,
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
            // New posts stay blocked for Buy until linked offer metadata arrives.
            const newItem = {
              id: postId,
              creator_id: row.creator_id ?? null,
              product_id: row.product_id ?? null,
              purchaseOptionsReady: false,
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
            return [newItem, ...prev];
          });
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      fetchGenRef.current += 1;
      supabase.removeChannel(channel);
    };
  }, [activeTab, supabase, authLoading, viewerId, enrichPosts, refreshKey]);

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

  const sectionMembership = items.map(item => item.id).join(",");
  const observerRef = useRef<IntersectionObserver | null>(null);
  const observedRootRef = useRef<HTMLDivElement | null>(null);
  const observedDesktopRef = useRef(desktop);
  const observedNodesRef = useRef(new Set<HTMLElement>());
  const ratiosRef = useRef(new Map<Element, IntersectionObserverEntry>());
  const scrollPositionRef = useRef(0);
  const scrollDirectionRef = useRef(1);
  useEffect(() => {
    const root = feedScrollRef.current;
    if (!root || !sectionRefs.current.size) {
      observerRef.current?.disconnect();
      observerRef.current = null;
      observedNodesRef.current.clear();
      ratiosRef.current.clear();
      return;
    }
    const ratios = ratiosRef.current;
    const commit = (id: string) => {
      if (!itemsRef.current.some(item => item.id === id)) return;
      const pending = pendingHighlightScrollRef.current;
      if (pending && pending !== id) return;
      if (pending) pendingHighlightScrollRef.current = null;
      setActivePostId(prev => prev === id ? prev : id);
    };
    if (!observerRef.current || observedRootRef.current !== root || observedDesktopRef.current !== desktop) {
      observedDesktopRef.current = desktop;
      observerRef.current?.disconnect();
      observedNodesRef.current.clear();
      ratios.clear();
      observedRootRef.current = root;
      observerRef.current = new IntersectionObserver(
      (entries) => {
        const delta = root.scrollTop - scrollPositionRef.current;
        if (Math.abs(delta) > 1) scrollDirectionRef.current = delta > 0 ? 1 : -1;
        scrollPositionRef.current = root.scrollTop;
        entries.forEach(entry => ratios.set(entry.target, entry));
        const visible = [...ratios.values()]
          .filter((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.51)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        // The visible incoming neighbor takes priority over forward prediction.
        // No timer-gated activation or decoder work for distant cards.
        const selectedId = (visible?.target as HTMLElement | undefined)?.dataset.postId ?? activeIdRef.current;
        const selectedIndex = itemsRef.current.findIndex(post => post.id === selectedId);
        const neighbor = itemsRef.current[selectedIndex + scrollDirectionRef.current];
        const neighborNode = neighbor && sectionRefs.current.get(neighbor.id);
        const entry = neighborNode && ratios.get(neighborNode);
        const warmId = !desktop && entry?.isIntersecting && entry.intersectionRatio >= 0.08 ? neighbor.id : null;
        setWarmingPostId(prev => prev === warmId ? prev : warmId);
        if (visible) {
          const id = (visible.target as HTMLElement).dataset.postId;
          if (id) {
            // While a highlight scroll is traveling, only its target may
            // claim the active slot; posts passing by are ignored.
            const pending = pendingHighlightScrollRef.current;
            if (pending) {
              if (id !== pending) return;
            }
            commit(id);
          }
        }
      },
      { root, threshold: [0, 0.08, 0.49, 0.51, 0.92, 1] }
    );
    }
    // Appending a page registers only its new sections. Existing videos keep
    // their visibility history instead of all receiving fresh observer events.
    const nodes = new Set(sectionRefs.current.values());
    for (const node of observedNodesRef.current) {
      if (!nodes.has(node)) { observerRef.current.unobserve(node); ratios.delete(node); }
    }
    for (const node of nodes) {
      if (!observedNodesRef.current.has(node)) observerRef.current.observe(node);
    }
    observedNodesRef.current = nodes;
  }, [sectionMembership, feedError, desktop]);
  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    observedNodesRef.current.clear();
    ratiosRef.current.clear();
  }, []);

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
    },
    [items, activePostId]
  );

  const handleFeedKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!items.length || e.repeat) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [role="dialog"], [role="menu"]')) return;
      if (e.key === "ArrowDown" || e.key === "PageDown") {
        e.preventDefault();
        scrollByOneCard("down");
      } else if (e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        scrollByOneCard("up");
      }
    },
    [items.length, scrollByOneCard]
  );

  // Load the next page (both tabs — same single RPC, offset paginated)
  const loadMore = useCallback(async () => {
    if (!hasMoreRef.current || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError(false);

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
        setMoreError(true);
        return;
      }

      const rawCount = Array.isArray(data) ? data.length : 0;
      if (!rawCount) {
        hasMoreRef.current = false;
        return;
      }

      const mapped = mapFeedV3Rows(data).map(post => ({ ...post, monthlyTerms: null, purchaseOptionsReady: false }));
      if (gen !== fetchGenRef.current) return;

      offsetRef.current = currentOffset + rawCount;
      hasMoreRef.current = rawCount >= PAGE_SIZE;

      // Deduplicate and append
      setItems((prev) => {
        const existingIds = new Set(prev.map((p) => p.id));
        const newItems = mapped.filter((p) => !existingIds.has(p.id));
        return newItems.length ? [...prev, ...newItems] : prev;
      });
      enrichPosts(mapped, gen);
    } catch (err) {
      console.error("[Feed] loadMore error:", err);
      if (gen === fetchGenRef.current) setMoreError(true);
    } finally {
      if (gen === fetchGenRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [supabase, enrichPosts]);

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

  // An error must win over stale rows. Switching tabs does not clear `items`,
  // so without `feedError` here a failed Following load renders the Discover
  // videos still in state as if they were the Following feed — a failed read
  // shown as a successful one, which is the thing #138 exists to prevent.
  if (!loading && (feedError || items.length === 0)) {
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
          <FeedEmptyState
            tab={activeTab}
            signedIn={!!viewerId}
            onBrowseDiscover={() => onChangeTab("discover")}
          />
        )}
      </div>
    );
  }

  const activeIndex = activePostId
    ? items.findIndex((p) => p.id === activePostId)
    : 0;

  return (
    <div className="relative h-full min-h-0 feed-mobile-viewport">
      {pendingPosts.length > 0 && <button type="button" onClick={() => { setLoading(true); setRefreshKey(key => key + 1); }} className="absolute top-14 left-1/2 -translate-x-1/2 z-40 rounded-full bg-black/85 border border-white/30 px-4 py-2 text-sm text-white">New posts · Refresh</button>}
      {(loadingMore || moreError) && <div role="status" className="absolute bottom-3 left-1/2 -translate-x-1/2 z-40 rounded-full bg-black/85 px-4 py-2 text-sm text-white">
        {moreError ? <button type="button" onClick={() => void loadMore()}>Couldn’t load more · Retry</button> : "Loading more…"}
      </div>}
      <div
        ref={feedScrollRef}
        className="h-full min-h-0 overflow-y-scroll snap-y snap-mandatory lg:snap-mandatory [&::-webkit-scrollbar]:hidden scroll-smooth"
        style={{
          scrollbarWidth: "none",
          overscrollBehaviorY: "contain",
          touchAction: "pan-y pinch-zoom",
        }}
        onKeyDown={handleFeedKeyDown}
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
              className="feed-mobile-slot snap-start snap-normal lg:snap-always h-[calc(100dvh-56px)] lg:h-[100dvh] w-full flex items-start justify-center px-0 md:px-4 mt-0"
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
                    onInteractionChange={handleInteractionChange}
                    onFirstFrame={!desktop ? handleFirstFrame : undefined}
                    prepareFrame={!desktop && pageVisible && !isActive && (warmingPostId ? warmingPostId === p.id : idx === activeIndex + 1 && readyPostId === activePostId)}
                    preferAdaptive={!desktop}
                    commentDraft={draftsRef.current.get(p.id) ?? ""}
                    onCommentDraftChange={handleDraftChange}
                    onFeedDeleted={handleDeleted}
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
                    // Signed-out viewers get a placeholder name ("Creator") from the
                    // discover RPC; never pin a Verified badge to a placeholder.
                    creatorVerified={p.creator_verified === true && p.creator_name != null}
                    priceCents={price}
                    titleForCheckout={p.title ?? p.content ?? "CreatorNet Video"}
                    productType={p.product_type ?? null}
                    monthlyTerms={p.monthlyTerms}
                    purchaseOptionsReady={p.purchaseOptionsReady === true && creatorCanSell}
                    purchaseCount={p.purchase_count ?? null}
                    showFollowButton={activeTab === "discover"}
                    isFollowingCreator={p.is_following ?? false}
                    onFollowChange={handleFollowChange}
                    // booking
                    allowBooking={allowBooking}
                    bookingRedirectUrl={allowBooking ? p.booking_url! : null}
                    soundEnabled={isSoundOn}
                    isActive={isActive}
                    preload={!pageVisible ? "none" : idx === activeIndex || idx === activeIndex + 1 || warmingPostId === p.id ? "auto" : "metadata"}
                    onToggleSound={toggleSound}
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
