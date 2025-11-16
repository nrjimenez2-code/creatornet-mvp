"use client";

import { useEffect, useState } from "react";
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
        console.error("Feed RPC error:", error);
      }

      let mapped: PostRow[] = [];
      if (Array.isArray(data)) {
        mapped = await Promise.all(
          data
            .map((r: any) => ({
              id: r.post_id as string,
              creator_id: (r.creator_id as string) ?? null,
              product_id: (r.product_id as string) ?? null,
              price_cents: (r.price_cents as number) ?? 0,
              title: (r.title as string) ?? null,
              video_url: (r.video_url as string) ?? null,
              poster_url: (r.poster_url as string) ?? null,
              content: (r.title as string) ?? "",
              interests: Array.isArray(r.tags) ? (r.tags as string[]) : [],
              created_at: null, // rpc doesn't return it; fine for now

              likes_count: (r.likes_count as number) ?? 0,
              comments_count: (r.comments_count as number) ?? 0,
              shares_count: (r.shares_count as number) ?? 0,

              allow_booking: (r.allow_booking as boolean) ?? false,
              booking_url: (r.booking_url as string) ?? null,
              is_following: (r.is_following as boolean) ?? false,
            }))
            // keep only items with media
            .filter((p: PostRow) => p.video_url || p.poster_url)
            .map(async (p) => {
              if (!p.product_id) return p;
              const { data: prod } = await supabase
                .from("products")
                .select("type")
                .eq("product_id", p.product_id)
                .maybeSingle();
              return { ...p, product_type: prod?.type ?? null };
            })
        );
      }

      if (!cancelled) {
        setItems(mapped);
        setLoading(false);
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
      className="h-screen overflow-y-auto snap-y snap-mandatory px-3 [&::-webkit-scrollbar]:hidden"
      style={{ scrollbarWidth: "none" }}
    >
      {items.map((p) => {
        const price = typeof p.price_cents === "number" ? p.price_cents : 0;
        const sellable = !!p.product_id;
        const allowBooking =
          !!p.allow_booking &&
          typeof p.booking_url === "string" &&
          p.booking_url.length > 0;

        const showCTA = sellable || allowBooking || price > 0;

        return (
          <section
            key={p.id}
            className="snap-start min-h-screen flex items-start justify-center pt-8"
          >
            <div className="relative w-full">
              <VideoCard
                // media
                src={p.video_url || undefined}
                poster={p.poster_url || "/file.svg"}

                // meta
                creator={"Noah Jimenez"}
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
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}
