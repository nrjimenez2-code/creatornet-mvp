"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import VideoCard from "./VideoCard";
import { createClient } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";
import { trackEvent, normalizeCategory } from "@/lib/posthog";

export type Tab = "following" | "discover";

type FeedListProps = {
  activeTab: Tab;
  onChangeTab: (t: Tab) => void; // kept for API stability
  highlightPostId?: string | null;
};

export type PostRow = {
  id: string;
  creator_id: string | null;
  product_id: string | null;
  price_cents: number | null;
  creator_name?: string | null;
  /** Handle for /profile/[username] (from API / profiles join) */
  creator_username?: string | null;
  creator_avatar_url?: string | null;
  title: string | null;
  video_url: string | null;
  poster_url: string | null;
  content: string | null;
  interests: string[] | null;
  hashtags?: string[] | null;
  created_at: string | null;
  product_type?: string | null;
  is_following?: boolean | null;
  likes_count?: number | null;
  comments_count?: number | null;
  shares_count?: number | null;
  is_liked?: boolean | null;
  allow_booking?: boolean | null;
  booking_url?: string | null;
  /** When false, hide buy CTA (optional; omitted = allow). */
  creator_can_sell?: boolean | null;
};

/** Hosts that often time out or fail; don't request video from them (show poster only to avoid console errors). */
const UNRELIABLE_VIDEO_HOSTS = ["sample-videos.com"];

function isUnreliableVideoUrl(url: string | null): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return UNRELIABLE_VIDEO_HOSTS.some((bad) => host === bad || host.endsWith("." + bad));
  } catch {
    return false;
  }
}

const PAGE_SIZE = 20;

export default function FeedList({ activeTab, highlightPostId }: FeedListProps) {
  const supabase = useMemo(() => createClient(), []);
  const { userId: viewerId } = useUser(); // only for likes + follow state; feed fetch gets its own auth inside effect

  const [items, setItems] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const viewerIdRef = useRef<string | null>(null);

  // Sync viewerId to ref so loadMore can read it without stale closure
  useEffect(() => {
    viewerIdRef.current = viewerId ?? null;
  }, [viewerId]);

  // Track feed_viewed once on mount
  useEffect(() => {
    trackEvent("feed_viewed");
  }, []);
  const [globalSoundOn, setGlobalSoundOn] = useState(false);
  const [activePostId, setActivePostId] = useState<string | null>(null);
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

    // Reset pagination on every tab change / reload
    offsetRef.current = 0;
    hasMoreRef.current = false;
    setHasMore(false);

    // Always set loading when fetching (including tab switches)
    setLoading(true);
    setFeedError(null);

    (async () => {
      try {
        console.log("[Feed] effect ran, activeTab:", activeTab);
        const { data: authData } = await supabase.auth.getSession();
        const feedViewerId = authData?.session?.user?.id ?? null;

        const discoverParams = { p_user_id: null, p_limit: 20 };
        const followingParams = { p_user_id: feedViewerId, p_limit: 20 };
        let data: unknown = null;
        let error: { message: string; code?: string } | null = null;

        if (activeTab === "discover") {
          const ranked = await supabase.rpc("get_feed_v2", {
            p_user_id: feedViewerId,
            p_limit: 20,
            p_offset: 0,
          });
          error = ranked.error;
          if (!ranked.error && Array.isArray(ranked.data) && ranked.data.length > 0) {
            const postIds = (ranked.data as { post_id: string }[]).map((r) => r.post_id);
            const postsResult = await supabase
              .from("posts")
              .select("id, creator_id, product_id, title, video_url, poster_url, interests, hashtags, price_cents, allow_booking, booking_url, created_at, likes_count, comments_count, shares_count")
              .in("id", postIds);
            if (postsResult.error) {
              error = postsResult.error;
            } else {
              const postMap = new Map((postsResult.data ?? []).map((p: any) => [p.id, p]));
              data = postIds.map((id) => postMap.get(id)).filter(Boolean);
            }
          } else if (!ranked.error) {
            data = [];
          }
          console.log("[Feed] get_feed_v2(discover) — length:", Array.isArray(data) ? (data as unknown[]).length : 0, "error:", error?.message ?? null);
        } else {
          if (!feedViewerId) {
            // Following feed needs a logged-in user; keep UI stable if session is temporarily unavailable.
            data = [];
            error = null;
            const safeRows: unknown[] = Array.isArray(data) ? data : [];
            if (!cancelled) {
              setItems([]);
              setFeedError(null);
              setLoading(false);
              if (safeRows.length) {
                setActivePostId((prev) => prev ?? null);
              }
            }
            return;
          }
          let result = await supabase.rpc("get_feed_following", followingParams);
          data = result.data;
          error = result.error;
          if (error?.code === "42883" || (error?.message && error.message.includes("does not exist"))) {
            result = await supabase.rpc("get_feed_v1", followingParams);
            data = result.data;
            error = result.error;
          }
        }

        if (error) {
          console.error("Feed RPC error:", error);
          if (!cancelled) {
            setFeedError(error.message || "Failed to load feed");
            setLoading(false);
          }
          return;
        }

        let mapped: PostRow[] = [];

        const rawRows: unknown[] = Array.isArray(data) ? data : [];
        console.log("[Feed] rawRows.length:", rawRows.length, "data type:", typeof data, data === null ? "(null)" : "");

        if (rawRows.length > 0) {
          const baseRows: PostRow[] = rawRows
            .map((r: any) => {
              const postId = (r.post_id as string) ?? (r.id as string) ?? "";
              const rawVideo = (r.video_url as string) ?? null;
              const rawPoster = (r.poster_url as string) ?? null;
              const trimmedVideo = typeof rawVideo === "string" ? rawVideo.trim() : null;
              const videoUrl =
                trimmedVideo && !isUnreliableVideoUrl(trimmedVideo) ? trimmedVideo : null;

              const derivedName =
                (r.creator_name as string) ??
                (r.full_name as string) ??
                (r.username as string) ??
                null;
              const derivedAvatar = (r.avatar_url as string) ?? null;

              const rawUsername =
                (r.creator_username as string) ?? (r.username as string) ?? null;

              return {
                id: postId,
                creator_id: (r.creator_id as string) ?? null,
                product_id: (r.product_id as string) ?? null,
                price_cents: (r.price_cents as number) ?? 0,
                title: (r.title as string) ?? null,
                video_url: videoUrl,
                poster_url: typeof rawPoster === "string" ? rawPoster.trim() : null,
                content: (r.title as string) ?? "",
                interests: Array.isArray(r.interests) ? (r.interests as string[]) : Array.isArray(r.tags) ? (r.tags as string[]) : [],
                hashtags: Array.isArray(r.hashtags) ? (r.hashtags as string[]) : null,
                created_at: null,
                likes_count: (r.likes_count as number) ?? 0,
                comments_count: (r.comments_count as number) ?? 0,
                shares_count: (r.shares_count as number) ?? 0,
                allow_booking: (r.allow_booking as boolean) ?? false,
                booking_url: (r.booking_url as string) ?? null,
                is_following: (r.is_following as boolean) ?? false,
                creator_name: derivedName,
                creator_username: rawUsername,
                creator_avatar_url: derivedAvatar,
              };
            })
            .filter((p) => p.video_url || p.poster_url);

          console.log("[Feed] baseRows after filter (video_url or poster_url):", baseRows.length);

          // Always get product_id from server (RPC/realtime often omit it) so "Pay in full" works
          const postIds = baseRows.map((p) => p.id);
          if (postIds.length > 0) {
            try {
              const origin = typeof window !== "undefined" ? window.location.origin : "";
              const res = await fetch(
                `${origin}/api/posts/product-ids?ids=${encodeURIComponent(postIds.join(","))}`,
                { credentials: "include" }
              );
              const productIdByPostId = (await res.json().catch(() => ({}))) as Record<string, string | null>;
              baseRows.forEach((p) => {
                if (p.id in productIdByPostId) {
                  (p as { product_id: string | null }).product_id = productIdByPostId[p.id] ?? null;
                }
              });
            } catch (_) {
              // keep existing product_id if fetch fails
            }
          }

          const productIds = Array.from(
            new Set(
              baseRows
                .map((p) => p.product_id)
                .filter((id): id is string => Boolean(id))
            )
          );
          const creatorIds = Array.from(
            new Set(
              baseRows
                .map((p) => p.creator_id)
                .filter((id): id is string => Boolean(id))
            )
          );

          // Fetch all additional data in parallel for maximum speed
          const productPromise = productIds.length
            ? supabase
                .from("products")
                .select("product_id, type, amount_cents, price_cents")
                .in("product_id", productIds)
            : Promise.resolve(null);
          // Fetch creator profiles via API (service role) so avatars show on video cards despite RLS
          const profilePromise =
            creatorIds.length > 0
              ? fetch(
                  `${typeof window !== "undefined" ? window.location.origin : ""}/api/profiles?ids=${encodeURIComponent(creatorIds.join(","))}`,
                  { credentials: "include" }
                )
                  .then(async (r) => {
                    const body = (await r
                      .json()
                      .catch(() => ({}))) as {
                      profiles?: Array<{
                        id: string;
                        full_name: string | null;
                        username: string | null;
                        avatar_url: string | null;
                      }>;
                      error?: string;
                    };

                    // Session can expire briefly; don't fail whole feed over avatar lookup.
                    if (!r.ok) {
                      if (r.status === 401) return { data: [], error: null };
                      return { data: [], error: new Error(body.error || `Profiles API failed (${r.status})`) };
                    }
                    if (body.error) {
                      if (body.error === "Unauthorized") return { data: [], error: null };
                      return { data: [], error: new Error(body.error) };
                    }
                    return { data: body.profiles ?? [], error: null };
                  })
                  .catch((err: unknown) => {
                    console.error("Profile lookup error:", err);
                    return { data: null, error: err };
                  })
              : Promise.resolve({ data: [], error: null });
          const likesPromise = feedViewerId && postIds.length > 0
            ? supabase
                .from("likes")
                .select("post_id")
                .eq("user_id", feedViewerId)
                .in("post_id", postIds)
            : Promise.resolve(null);

          // Execute all lookups in parallel - this is the key optimization
          const followsPromise = feedViewerId && creatorIds.length > 0
            ? supabase
                .from("follows")
                .select("following_id")
                .eq("follower_id", feedViewerId)
                .in("following_id", creatorIds)
            : Promise.resolve(null);

          const [productRes, profileRes, likesRes, followsRes] = await Promise.all([
            productPromise,
            profilePromise,
            likesPromise,
            followsPromise,
          ]);

          const productMetaMap = new Map<string, { type: string | null; price: number | null }>();
          if (productRes?.error) {
            console.error("Product lookup error:", productRes.error);
          } else if (productRes?.data) {
            for (const row of productRes.data) {
              const typed = row as { product_id: string; type?: string | null; amount_cents?: number | null; price_cents?: number | null };
              const derivedPrice =
                (typeof typed.amount_cents === "number" && typed.amount_cents > 0 && typed.amount_cents) ||
                (typeof typed.price_cents === "number" && typed.price_cents > 0 && typed.price_cents) ||
                null;
              productMetaMap.set(typed.product_id, {
                type: typed.type ?? null,
                price: derivedPrice,
              });
            }
          }

          const profileMap = new Map<
            string,
            { full_name: string | null; username: string | null; avatar_url: string | null }
          >();
          if (profileRes?.error) {
            console.error("Profile lookup error:", profileRes.error);
          } else if (profileRes?.data) {
            for (const row of profileRes.data) {
              const typed = row as {
                id: string;
                full_name?: string | null;
                username?: string | null;
                avatar_url?: string | null;
              };
              profileMap.set(typed.id, {
                full_name: typed.full_name ?? null,
                username: typed.username ?? null,
                avatar_url: typed.avatar_url ?? null,
              });
            }
          }

          // Process likes data (already fetched in parallel above)
          let likedPostIds = new Set<string>();
          if (likesRes?.error) {
            console.error("Error fetching likes:", likesRes.error);
          } else if (likesRes?.data) {
            likedPostIds = new Set(likesRes.data.map((l) => l.post_id as string));
          }

          // Which creators the viewer follows (so we hide + when already following)
          let followedCreatorIds = new Set<string>();
          if (followsRes?.error) {
            console.error("Error fetching follows:", followsRes.error);
          } else if (followsRes?.data) {
            followedCreatorIds = new Set(followsRes.data.map((r) => r.following_id as string));
          }

          mapped = baseRows.map((p) => {
            const profile = p.creator_id ? profileMap.get(p.creator_id) : null;
            const meta = p.product_id ? productMetaMap.get(p.product_id) : null;
            const resolvedPrice =
              typeof p.price_cents === "number" && p.price_cents > 0
                ? p.price_cents
                : meta?.price ?? p.price_cents ?? 0;
            const isFollowing = p.creator_id ? followedCreatorIds.has(p.creator_id) : (p.is_following ?? false);
            return {
              ...p,
              price_cents: resolvedPrice,
              product_type: p.product_id
                ? meta?.type ?? null
                : null,
              creator_name:
                profile?.full_name ??
                profile?.username ??
                p.creator_name ??
                null,
              creator_username: profile?.username ?? p.creator_username ?? null,
              creator_avatar_url:
                profile?.avatar_url ?? p.creator_avatar_url ?? null,
              is_liked: likedPostIds.has(p.id),
              is_following: isFollowing,
            };
          });

        }

        console.log("[Feed] final mapped.length:", mapped.length);
        if (!cancelled) {
          setItems(mapped);
          setFeedError(null);
          setLoading(false);
          // Set up pagination for discover tab
          offsetRef.current = mapped.length;
          const canLoadMore = activeTab === "discover" && mapped.length >= PAGE_SIZE;
          hasMoreRef.current = canLoadMore;
          setHasMore(canLoadMore);
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
          setItems((prev) => {
            const row = (payload.new || payload.old) as any;
            const postId = (row?.id ?? row?.post_id) as string | undefined;
            if (!postId) return prev;

            // delete -> drop
            if (payload.eventType === "DELETE") {
              return prev.filter((p) => p.id !== postId);
            }

            // hide if media missing
            if (!row.video_url && !row.poster_url) {
              return prev.filter((p) => p.id !== postId);
            }

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
                interests: Array.isArray(row.interests)
                  ? row.interests
                  : next[i].interests,
                hashtags: Array.isArray(row.hashtags)
                  ? row.hashtags
                  : next[i].hashtags,
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
              interests: Array.isArray(row.interests) ? row.interests : [],
              hashtags: Array.isArray(row.hashtags) ? row.hashtags : null,
              created_at: row.created_at ?? null,
              likes_count: 0,
              comments_count: 0,
              shares_count: 0,
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
  }, [activeTab, supabase]);

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

  // Scroll to highlighted post when it loads
  useEffect(() => {
    if (highlightPostId && items.length > 0) {
      const element = sectionRefs.current.get(highlightPostId);
      if (element) {
        // Wait a bit for layout to settle
        setTimeout(() => {
          element.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 300);
      }
    }
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

  // Load next page of posts from the posts table directly (discover only)
  const loadMore = useCallback(async () => {
    if (!hasMoreRef.current || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);

    const currentOffset = offsetRef.current;
    const feedViewerId = viewerIdRef.current;

    try {
      const ranked = await supabase.rpc("get_feed_v2", {
        p_user_id: feedViewerId,
        p_limit: PAGE_SIZE,
        p_offset: currentOffset,
      });

      if (ranked.error) {
        console.error("[Feed] loadMore error:", ranked.error);
        return;
      }

      const rankedRows = Array.isArray(ranked.data) ? ranked.data as { post_id: string }[] : [];
      if (!rankedRows.length) {
        hasMoreRef.current = false;
        setHasMore(false);
        return;
      }

      const postIds = rankedRows.map((r) => r.post_id);
      const { data: rawData, error: postsError } = await supabase
        .from("posts")
        .select("id, creator_id, product_id, title, video_url, poster_url, interests, hashtags, price_cents, allow_booking, booking_url, created_at, likes_count, comments_count, shares_count")
        .in("id", postIds);

      if (postsError) {
        console.error("[Feed] loadMore posts error:", postsError);
        return;
      }

      // Reorder to match ranked order
      const postMap = new Map((rawData ?? []).map((p: any) => [p.id, p]));
      const rows = postIds.map((id) => postMap.get(id)).filter(Boolean) as any[];

      if (!rows.length) {
        hasMoreRef.current = false;
        setHasMore(false);
        return;
      }

      // Map to PostRow
      const baseRows: PostRow[] = rows
        .map((r: any) => {
          const trimmedVideo = typeof r.video_url === "string" ? r.video_url.trim() : null;
          const videoUrl = trimmedVideo && !isUnreliableVideoUrl(trimmedVideo) ? trimmedVideo : null;
          return {
            id: r.id,
            creator_id: r.creator_id ?? null,
            product_id: r.product_id ?? null,
            price_cents: r.price_cents ?? 0,
            title: r.title ?? null,
            video_url: videoUrl,
            poster_url: typeof r.poster_url === "string" ? r.poster_url.trim() : null,
            content: r.title ?? "",
            interests: Array.isArray(r.interests) ? r.interests : [],
            hashtags: Array.isArray(r.hashtags) ? r.hashtags : null,
            created_at: r.created_at ?? null,
            likes_count: r.likes_count ?? 0,
            comments_count: r.comments_count ?? 0,
            shares_count: r.shares_count ?? 0,
            allow_booking: r.allow_booking ?? false,
            booking_url: r.booking_url ?? null,
            is_following: false,
            creator_name: null,
            creator_username: null,
            creator_avatar_url: null,
          };
        })
        .filter((p) => p.video_url || p.poster_url);

      if (!baseRows.length) {
        offsetRef.current = currentOffset + rankedRows.length;
        const newHasMore = rankedRows.length >= PAGE_SIZE;
        hasMoreRef.current = newHasMore;
        setHasMore(newHasMore);
        return;
      }

      const creatorIds = Array.from(
        new Set(baseRows.map((p) => p.creator_id).filter((id): id is string => Boolean(id)))
      );
      const origin = typeof window !== "undefined" ? window.location.origin : "";

      // Fetch product IDs override
      try {
        const res = await fetch(
          `${origin}/api/posts/product-ids?ids=${encodeURIComponent(postIds.join(","))}`,
          { credentials: "include" }
        );
        const productIdByPostId = (await res.json().catch(() => ({}))) as Record<string, string | null>;
        baseRows.forEach((p) => {
          if (p.id in productIdByPostId) {
            (p as { product_id: string | null }).product_id = productIdByPostId[p.id] ?? null;
          }
        });
      } catch {}

      const productIds = Array.from(
        new Set(baseRows.map((p) => p.product_id).filter((id): id is string => Boolean(id)))
      );

      const [productRes, profileRes, likesRes, followsRes] = await Promise.all([
        productIds.length
          ? supabase
              .from("products")
              .select("product_id, type, amount_cents, price_cents")
              .in("product_id", productIds)
          : Promise.resolve(null),
        creatorIds.length
          ? fetch(
              `${origin}/api/profiles?ids=${encodeURIComponent(creatorIds.join(","))}`,
              { credentials: "include" }
            )
              .then(async (r) => {
                const body = (await r.json().catch(() => ({}))) as {
                  profiles?: Array<{ id: string; full_name: string | null; username: string | null; avatar_url: string | null }>;
                };
                if (!r.ok) return { data: [], error: null };
                return { data: body.profiles ?? [], error: null };
              })
              .catch(() => ({ data: [], error: null }))
          : Promise.resolve({ data: [], error: null }),
        feedViewerId && postIds.length
          ? supabase.from("likes").select("post_id").eq("user_id", feedViewerId).in("post_id", postIds)
          : Promise.resolve(null),
        feedViewerId && creatorIds.length
          ? supabase.from("follows").select("following_id").eq("follower_id", feedViewerId).in("following_id", creatorIds)
          : Promise.resolve(null),
      ]);

      const productMetaMap = new Map<string, { type: string | null; price: number | null }>();
      if (productRes?.data) {
        for (const row of productRes.data) {
          const typed = row as { product_id: string; type?: string | null; amount_cents?: number | null; price_cents?: number | null };
          const derivedPrice =
            (typeof typed.amount_cents === "number" && typed.amount_cents > 0 && typed.amount_cents) ||
            (typeof typed.price_cents === "number" && typed.price_cents > 0 && typed.price_cents) ||
            null;
          productMetaMap.set(typed.product_id, { type: typed.type ?? null, price: derivedPrice });
        }
      }

      const profileMap = new Map<string, { full_name: string | null; username: string | null; avatar_url: string | null }>();
      if (profileRes?.data) {
        for (const row of profileRes.data) {
          const typed = row as { id: string; full_name?: string | null; username?: string | null; avatar_url?: string | null };
          profileMap.set(typed.id, { full_name: typed.full_name ?? null, username: typed.username ?? null, avatar_url: typed.avatar_url ?? null });
        }
      }

      const likedPostIds = new Set<string>(likesRes?.data?.map((l) => l.post_id as string) ?? []);
      const followedCreatorIds = new Set<string>(followsRes?.data?.map((r) => r.following_id as string) ?? []);

      const mapped: PostRow[] = baseRows.map((p) => {
        const profile = p.creator_id ? profileMap.get(p.creator_id) : null;
        const meta = p.product_id ? productMetaMap.get(p.product_id) : null;
        const resolvedPrice =
          typeof p.price_cents === "number" && p.price_cents > 0
            ? p.price_cents
            : meta?.price ?? p.price_cents ?? 0;
        return {
          ...p,
          price_cents: resolvedPrice,
          product_type: p.product_id ? meta?.type ?? null : null,
          creator_name: profile?.full_name ?? profile?.username ?? null,
          creator_username: profile?.username ?? null,
          creator_avatar_url: profile?.avatar_url ?? null,
          is_liked: likedPostIds.has(p.id),
          is_following: p.creator_id ? followedCreatorIds.has(p.creator_id) : false,
        };
      });

      // Update offset and hasMore
      offsetRef.current = currentOffset + rankedRows.length;
      const newHasMore = rankedRows.length >= PAGE_SIZE;
      hasMoreRef.current = newHasMore;
      setHasMore(newHasMore);

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

  // Trigger loadMore when user is within 3 posts of the end (discover only)
  useEffect(() => {
    if (activeTab !== "discover" || !activePostId || !items.length) return;
    const currentIndex = items.findIndex((p) => p.id === activePostId);
    if (currentIndex >= items.length - 3) {
      loadMore();
    }
  }, [activePostId, items.length, activeTab, loadMore]);

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
            <p className="text-sm text-red-400 font-medium mb-1">Error loading feed</p>
            <p className="text-xs text-gray-500 max-w-md mb-3">{feedError}</p>
            <p className="text-xs text-gray-600">
              Check: (1) Browser console for details. (2) Supabase project has RPC{" "}
              <code className="bg-black/30 px-1 rounded">get_feed_discover</code> or{" "}
              <code className="bg-black/30 px-1 rounded">get_feed_v1</code>. (3) <code className="bg-black/30 px-1 rounded">posts</code> table has rows with <code className="bg-black/30 px-1 rounded">video_url</code> or <code className="bg-black/30 px-1 rounded">poster_url</code>.
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-500">No posts yet.</p>
        )}
      </div>
    );
  }

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

          return (
            <section
              key={`${p.id}-${idx}`}
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

                <VideoCard
                  // media
                  src={p.video_url || undefined}
                  poster={p.poster_url || "/file.svg"}
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