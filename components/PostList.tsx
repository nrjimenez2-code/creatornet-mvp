"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import VideoCard from "./VideoCard";

type Post = {
  id: string;
  user_id: string;
  caption: string;
  video_url: string;
  poster_url: string | null;
  created_at: string;
};

export default function PostList() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [likes, setLikes] = useState<Record<string, number>>({});
  const [likedByMe, setLikedByMe] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(0);
  const pageSize = 6;
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const [me, setMe] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null));
  }, []);

  async function loadPage(reset = false) {
    const start = reset ? 0 : from;
    const end = start + pageSize - 1;

    const { data, error } = await supabase
      .from("posts")
      .select("*")
      .order("created_at", { ascending: false })
      .range(start, end);

    if (!error && data) {
      setPosts((prev) => (reset ? (data as Post[]) : [...prev, ...(data as Post[])]));
      setFrom(end + 1);
      // fetch likes counts in one go
      const ids = data.map((d) => d.id);
      if (ids.length) {
        const { data: counts } = await supabase
          .from("post_likes")
          .select("post_id, count:post_id", { count: "exact", head: false })
          .in("post_id", ids);

        const countsMap: Record<string, number> = {};
        counts?.forEach((row: any) => {
          countsMap[row.post_id] = (countsMap[row.post_id] ?? 0) + 1;
        });
        setLikes((prev) => ({ ...prev, ...countsMap }));

        if (me) {
          const { data: mine } = await supabase
            .from("post_likes")
            .select("post_id")
            .eq("user_id", me)
            .in("post_id", ids);

          const likedMap: Record<string, boolean> = {};
          mine?.forEach((r: any) => (likedMap[r.post_id] = true));
          setLikedByMe((prev) => ({ ...prev, ...likedMap }));
        }
      }
    }
    setLoading(false);
  }

  useEffect(() => {
    loadPage(true);
    // realtime: new posts
    const ch = supabase
      .channel("posts-feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "posts" },
        (payload) => {
          setPosts((p) => [payload.new as Post, ...p]);
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  // Infinite loader
  useEffect(() => {
    if (!loadMoreRef.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadPage(false);
      },
      { rootMargin: "200px" }
    );
    io.observe(loadMoreRef.current);
    return () => io.disconnect();
  }, [loadMoreRef.current]);

  const list = useMemo(() => posts, [posts]);

  return (
    <div className="w-full">
      <div className="flex flex-col gap-8">
        {list.map((p) => (
          <VideoCard
            key={p.id}
            post={p}
            initialLikes={likes[p.id] ?? 0}
            initiallyLiked={!!likedByMe[p.id]}
            onLikeToggled={(liked) =>
            setLikes((prev) => ({
              ...prev,
              [p.id]: Math.max(0, (prev[p.id] ?? 0) + (liked ? 1 : -1)),
            }))
            }
          />
        ))}
      </div>

      {/* load more sentinel */}
      <div ref={loadMoreRef} className="h-12" />
      {loading && (
        <p className="text-center text-sm text-gray-500 mt-4">Loading…</p>
      )}
      {!loading && list.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-gray-600">
          No posts yet. Be the first to share something!
        </div>
      )}
    </div>
  );
}
