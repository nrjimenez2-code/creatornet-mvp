"use client";

import { useEffect, useMemo, useState } from "react";
import VideoCard from "./VideoCard";
import { createClient } from "@/lib/supabaseClient";

export type Tab = "following" | "discover";

type FeedListProps = {
  activeTab: Tab;
  onChangeTab: (t: Tab) => void;
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
  likes_count?: number | null;
  comments_count?: number | null;
  shares_count?: number | null;

  // booking flags/links
  allow_booking?: boolean | null;
  booking_url?: string | null;
};

export default function FeedList({ activeTab }: FeedListProps) {
  const supabase = createClient();

  const [items, setItems] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);

  const orderBy = useMemo(
    () => ({ column: "created_at" as const, asc: false }),
    [activeTab]
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);

      const { data, error } = await supabase
        .from("posts")
        .select(
          [
            "id",
            "creator_id",
            "product_id",
            "price_cents",
            "title",
            "video_url",
            "poster_url",
            "content",
            "interests",
            "created_at",
            "likes_count",
            "comments_count",
            "shares_count",
            "allow_booking",
            "booking_url",
          ].join(",")
        )
        // cast to any to avoid ParseQuery<> mismatch noise
        .order(orderBy.column as any, { ascending: orderBy.asc });

      if (cancelled) return;

      if (error) {
        console.error("Feed load error:", error);
        setItems([]);
      } else {
        const rows = (data ?? []) as unknown as PostRow[];
        const safe = rows.filter((p) => p?.video_url || p?.poster_url);
        setItems(safe);
      }

      setLoading(false);
    })();

    const channel = supabase
      .channel("posts-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "posts" },
        (payload) => {
          setItems((prev) => {
            const row = (payload.new || payload.old) as PostRow;
            if (!row?.id) return prev;

            if (payload.eventType === "DELETE") {
              return prev.filter((p) => p.id !== row.id);
            }

            // hide if media missing
            if (!row.video_url && !row.poster_url) {
              return prev.filter((p) => p.id !== row.id);
            }

            const i = prev.findIndex((p) => p.id === row.id);
            if (i >= 0) {
              const next = [...prev];
              next[i] = { ...prev[i], ...(payload.new as PostRow) };
              return next;
            }
            return [row, ...prev];
          });
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [activeTab, orderBy.column, orderBy.asc, supabase]);

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
      className="h-[calc(100vh-64px)] overflow-y-auto snap-y snap-mandatory px-3 [&::-webkit-scrollbar]:hidden"
      style={{ scrollbarWidth: "none" }}
    >
      {items.map((p) => {
        const price = typeof p.price_cents === "number" ? p.price_cents : 0;
        const sellable = !!p.product_id;
        const allowBooking =
          !!p.allow_booking &&
          typeof p.booking_url === "string" &&
          p.booking_url.length > 0;

        // Only render CTA if the post is buyable OR bookable
        const showCTA = sellable || allowBooking;

        return (
          <section
            key={p.id}
            className="snap-start min-h-[calc(100vh-64px)] flex items-center justify-center py-4"
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

                // CTA visibility + data
                showCTA={showCTA}
                postId={p.id}
                creatorId={p.creator_id ?? null}
                priceCents={price}
                titleForCheckout={p.title ?? p.content ?? "CreatorNet Video"}

                // booking controls
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
