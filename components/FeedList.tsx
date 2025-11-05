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
};

export default function FeedList({ activeTab }: FeedListProps) {
  const supabase = createClient();

  const [items, setItems] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);

  const orderBy = useMemo(
    () => ({ column: "created_at", asc: false }),
    [activeTab]
  );

  // Load feed
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);

      const { data, error } = await supabase
        .from("posts")
        .select(
          "id, creator_id, product_id, price_cents, title, video_url, poster_url, content, interests, created_at, likes_count, comments_count, shares_count"
        )
        .order(orderBy.column, { ascending: orderBy.asc });

      if (cancelled) return;

      if (error) {
        console.error("Feed load error:", error);
        setItems([]);
      } else {
        const safe = (Array.isArray(data) ? data : []).filter(
          (p: any) => p?.video_url || p?.poster_url
        ) as PostRow[];
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

            if (!row.video_url && !row.poster_url) {
              return prev.filter((p) => p.id !== row.id);
            }

            if (payload.eventType === "DELETE") {
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

  // ✅ Checkout handler — creates Stripe session, saves the session id locally, then redirects
  async function handleBuy(p: PostRow) {
    try {
      const { data: auth } = await supabase.auth.getUser();
      const user = auth?.user;

      if (!user) {
        alert("Please sign in to purchase.");
        return;
      }

      const amountCents =
        typeof p.price_cents === "number" &&
        Number.isFinite(p.price_cents) &&
        p.price_cents > 0
          ? Math.round(p.price_cents)
          : 3000;

      const payload = {
        postId: p.id,
        amountCents,
        title: p.title ?? "CreatorNet video",
      };

      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include", // send auth cookies
        body: JSON.stringify(payload),
      });

      const out: { id?: string; url?: string; error?: string } = await res
        .json()
        .catch(() => ({} as any));

      console.log("Checkout response:", out);

      if (!res.ok) {
        console.error("Checkout error:", out);
        alert(out?.error || "Could not start checkout. Please try again.");
        return;
      }

      // 🔥 Save Stripe session id so /success can confirm even if URL lacks ?session_id
      if (out?.id) {
        try {
          localStorage.setItem("last_checkout_session", String(out.id));
          console.log("Saved last_checkout_session:", out.id);
        } catch (err) {
          console.warn("Could not persist session id:", err);
        }
      }

      if (out?.url) {
        window.location.href = out.url;
      } else {
        alert("Stripe session URL missing. Please try again.");
      }
    } catch (e) {
      console.error("Checkout exception:", e);
      alert("Unexpected error starting checkout.");
    }
  }

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
        const showCTA = !!p.product_id;
        const ctaLabel =
          showCTA && price > 0 ? `Buy $${(price / 100).toFixed(0)}` : "Buy / Book";

        return (
          <section
            key={p.id}
            className="snap-start min-h-[calc(100vh-64px)] flex items-center justify-center py-4"
          >
            <div className="relative w-full">
              <VideoCard
                src={p.video_url || undefined}
                poster={p.poster_url || "/file.svg"}
                creator={"Noah Jimenez"}
                caption={p.content || ""}
                hashtags={
                  Array.isArray(p.interests) && p.interests.length
                    ? p.interests.map((t) => `#${t}`).join(" ")
                    : "#entrepreneur #focus"
                }
                likes={p.likes_count ?? 0}
                comments={p.comments_count ?? 0}
                shares={p.shares_count ?? 0}
                ctaLabel={ctaLabel}
                showCTA={showCTA}
                onCta={() => handleBuy(p)}
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}
