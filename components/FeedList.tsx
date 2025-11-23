"use client";

import { useEffect, useRef, useState } from "react";
import VideoCard from "./VideoCard";
import { createClient } from "@/lib/supabaseClient";

export type Tab = "following" | "discover";

type FeedListProps = {
  activeTab: Tab;
  onChangeTab: (t: Tab) => void; // kept for API stability
};

export type PostRow = {
  id: string;
  creator_id: string | null;
  product_id: string | null;
  price_cents: number | null;
  creator_name?: string | null;
  creator_avatar_url?: string | null;
  title: string | null;
  video_url: string | null;
  poster_url: string | null;
  content: string | null;
  interests: string[] | null;
  created_at: string | null;

  product_type?: string | null;

  is_following?: boolean | null;
  likes_count?: number | null;
  comments_count?: number | null;
  shares_count?: number | null;

  allow_booking?: boolean | null;
  booking_url?: string | null;
};

export default function FeedList({ activeTab }: FeedListProps) {
  const supabase = createClient();

  const [items, setItems] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalSoundOn, setGlobalSoundOn] = useState(false);
  const [activePostId, setActivePostId] = useState<string | null>(null);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);

      const { data: authRes } = await supabase.auth.getUser();
      const viewerId = authRes?.user?.id ?? null;

      const rpcName = activeTab === "discover" ? "get_feed_discover" : "get_feed_following";
      const { data, error } = await supabase.rpc(rpcName, {
        p_user_id: viewerId,
        p_limit: 20,
      });

      if (error) {
        // eslint-disable-next-line no-console
        console.error("Feed RPC error:", error);
      }

      let mapped: PostRow[] = [];
      if (Array.isArray(data)) {
        const baseRows: PostRow[] = [];

        for (const r of data) {
          const postId =
            ((r.post_id as string | null | undefined) ??
              (r.id as string | null | undefined)) ||
            null;

          if (!postId) {
            console.warn("[FeedList] skipping row without post id", r);
            continue;
          }

            const derivedName =
              (r.creator_name as string) ??
              (r.full_name as string) ??
              (r.username as string) ??
              null;
            const derivedAvatar = (r.avatar_url as string) ?? null;

          const row: PostRow = {
              id: postId,
              creator_id: (r.creator_id as string) ?? null,
              product_id: (r.product_id as string) ?? null,
              price_cents: (r.price_cents as number) ?? 0,
              title: (r.title as string) ?? null,
              video_url: (r.video_url as string) ?? null,
              poster_url: (r.poster_url as string) ?? null,
              content: (r.title as string) ?? "",
              interests: Array.isArray(r.tags) ? (r.tags as string[]) : [],
              created_at: null,
              likes_count: (r.likes_count as number) ?? 0,
              comments_count: (r.comments_count as number) ?? 0,
              shares_count: (r.shares_count as number) ?? 0,
              allow_booking: (r.allow_booking as boolean) ?? false,
              booking_url: (r.booking_url as string) ?? null,
              is_following: (r.is_following as boolean) ?? false,
              creator_name: derivedName,
              creator_avatar_url: derivedAvatar,
            };

          if (row.video_url || row.poster_url) {
            baseRows.push(row);
          }
        }

        let resolvedCreators: Record<string, string> = {};
        const missingCreatorPosts = baseRows
          .filter((row) => !row.creator_id)
          .map((row) => row.id);

        if (missingCreatorPosts.length) {
          try {
            const res = await fetch("/api/posts/creators", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ postIds: missingCreatorPosts }),
            });
            if (res.ok) {
              const payload = (await res.json()) as {
                creators?: Record<string, string>;
              };
              resolvedCreators = payload?.creators ?? {};
            } else {
              console.warn(
                "[FeedList] failed to resolve creator IDs",
                missingCreatorPosts
              );
            }
          } catch (err) {
            console.error(
              "[FeedList] error resolving creator IDs:",
              err
            );
          }
        }

        const normalizedRows = baseRows.map((row) => ({
          ...row,
          creator_id: row.creator_id ?? resolvedCreators[row.id] ?? null,
        }));

        const productIds = Array.from(
          new Set(
            normalizedRows
              .map((p) => p.product_id)
              .filter((id): id is string => Boolean(id))
          )
        );
        const creatorIds = Array.from(
          new Set(
            normalizedRows
              .map((p) => p.creator_id)
              .filter((id): id is string => Boolean(id))
          )
        );

        const productPromise = productIds.length
          ? supabase
              .from("products")
              .select("product_id, type")
              .in("product_id", productIds)
          : Promise.resolve(null);
        const profilePromise = creatorIds.length
          ? supabase
              .from("profiles")
              .select("id, full_name, username, avatar_url")
              .in("id", creatorIds)
          : Promise.resolve(null);

        const [productRes, profileRes] = await Promise.all([
          productPromise,
          profilePromise,
        ]);

        const productTypeMap = new Map<string, string | null>();
        if (productRes?.error) {
          console.error("Product lookup error:", productRes.error);
        } else if (productRes?.data) {
          for (const row of productRes.data) {
            const typed = row as { product_id: string; type?: string | null };
            productTypeMap.set(typed.product_id, typed.type ?? null);
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

        mapped = normalizedRows.map((p) => {
          const profile = p.creator_id ? profileMap.get(p.creator_id) : null;
          return {
            ...p,
            product_type: p.product_id
              ? productTypeMap.get(p.product_id) ?? null
              : null,
            creator_name:
              profile?.full_name ??
              profile?.username ??
              p.creator_name ??
              null,
            creator_avatar_url:
              profile?.avatar_url ?? p.creator_avatar_url ?? null,
          };
        });
      }

      if (!cancelled) {
        setItems(mapped);
        setLoading(false);
        if (mapped.length) {
          setActivePostId((prev) => prev ?? mapped[0]?.id ?? null);
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
            const postId = row?.id as string | undefined;
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
                is_following: next[i].is_following,
              };
              return next;
            }
            // add to top for new posts
            return [
              {
                id: postId,
                creator_id: row.creator_id ?? null,
                product_id: row.product_id ?? null,
                price_cents: row.price_cents ?? 0,
                title: row.title ?? null,
                video_url: row.video_url ?? null,
                poster_url: row.poster_url ?? null,
                content: row.title ?? "",
                interests: Array.isArray(row.interests) ? row.interests : [],
                created_at: row.created_at ?? null,
                likes_count: 0,
                comments_count: 0,
                shares_count: 0,
                product_type: (row.product_type as string | null) ?? null,
                is_following: false,
              },
              ...prev,
            ];
          });
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [activeTab, supabase]);

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

  if (loading && items.length === 0) {
    return (
      <div className="w-full flex justify-center py-10 text-sm text-gray-500">
        Loading…
      </div>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <div className="w-full flex justify-center py-10 text-sm text-gray-500">
        No posts yet.
      </div>
    );
  }

  return (
    <div
    className="h-screen overflow-y-scroll snap-y snap-mandatory [&::-webkit-scrollbar]:hidden scroll-smooth"
      style={{ scrollbarWidth: "none" }}
    >
      {items.map((p, idx) => {
        const price = typeof p.price_cents === "number" ? p.price_cents : 0;
        const isActive = activePostId === p.id;
        const isSoundOn = globalSoundOn && isActive;
        const sellable = !!p.product_id;
        const allowBooking =
          !!p.allow_booking &&
          typeof p.booking_url === "string" &&
          p.booking_url.length > 0;

        const showCTA = sellable || allowBooking || price > 0;

        return (
          <section
            key={`${p.id}-${idx}`}
               className="snap-start snap-always h-screen w-full flex items-center justify-center py-24"
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
               <div className="relative w-full h-full flex items-center justify-center px-24">
              <VideoCard
  
                // media
                src={p.video_url || undefined}
                poster={p.poster_url || "/file.svg"}

                // meta
                creator={p.creator_name ?? "Creator"}
                creatorAvatarUrl={p.creator_avatar_url ?? null}
                caption={p.content || ""}
                hashtags={
                  Array.isArray(p.interests) && p.interests.length
                    ? p.interests.map((t) => `#${t}`).join(" ")
                    : "#entrepreneur #focus"
                }

                // social counts
                likes={p.likes_count ?? 0}
                comments={p.comments_count ?? 0}
                shares={p.shares_count ?? 0}

                // CTA & commerce
                showCTA={showCTA}
                postId={p.id}
                productId={p.product_id ?? null}
                creatorId={p.creator_id ?? null}
                priceCents={price}
                titleForCheckout={p.title ?? p.content ?? "CreatorNet Video"}

                productType={p.product_type ?? null}

                showFollowButton={activeTab === "discover"}
                isFollowingCreator={p.is_following ?? false}

                // booking
                allowBooking={allowBooking}
                bookingRedirectUrl={allowBooking ? p.booking_url! : null}
                soundEnabled={globalSoundOn}
                onToggleSound={() => setGlobalSoundOn((prev) => !prev)}
                defaultMuted={!globalSoundOn}
                tapToTogglePlayback
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}
