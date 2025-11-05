"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabaseClient";

type ProgressRow = {
  post_id: string;
  seconds: number;
  updated_at: string;
};

type Post = {
  id: string;
  title: string | null;
  poster_url: string | null;
  video_url: string | null;
};

type Item = {
  progress: ProgressRow;
  post: Post | null;
};

export default function ContinueWatching() {
  const supabase = createClient();

  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) {
        setItems([]);
        setLoading(false);
        return;
      }

      // 1) pull latest 12 progress rows for this user
      const { data: progress, error } = await supabase
        .from("watch_progress")
        .select("post_id,seconds,updated_at")
        .eq("user_id", uid)
        .order("updated_at", { ascending: false })
        .limit(12);

      if (error) {
        console.debug("progress fetch:", error.message);
        setItems([]);
        setLoading(false);
        return;
      }

      const ids = Array.from(new Set((progress ?? []).map((p) => p.post_id)));
      if (!ids.length) {
        setItems([]);
        setLoading(false);
        return;
      }

      // 2) fetch posts in one shot
      const { data: posts, error: pErr } = await supabase
        .from("posts")
        .select("id,title,poster_url,video_url")
        .in("id", ids);

      if (pErr) {
        console.debug("posts fetch:", pErr.message);
      }

      const postMap = new Map<string, Post>();
      (posts ?? []).forEach((p) => postMap.set(p.id, p as Post));

      const combined: Item[] = (progress ?? []).map((pr) => ({
        progress: pr as ProgressRow,
        post: postMap.get(pr.post_id) ?? null,
      }));

      if (!cancelled) {
        setItems(combined);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const visible = useMemo(
    () => items.filter((it) => it.post !== null).slice(0, 6),
    [items]
  );

  if (loading) {
    return (
      <section className="mt-6">
        <h2 className="text-lg font-semibold text-white/90">Continue Watching</h2>
        <p className="text-sm text-white/60 mt-2">Loading…</p>
      </section>
    );
  }

  if (!visible.length) {
    return (
      <section className="mt-6">
        <h2 className="text-lg font-semibold text-white/90">Continue Watching</h2>
        <p className="text-sm text-white/60 mt-2">
          Nothing here yet. Watch a video and we’ll save your place.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white/90">Continue Watching</h2>
        <Link
          href="/continue"
          className="text-xs text-white/70 hover:text-white/90 underline"
        >
          View all
        </Link>
      </div>

      <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {visible.map(({ post, progress }) => (
          <li key={progress.post_id}>
            <Link
              href={`/watch/${progress.post_id}`}
              className="block rounded-xl overflow-hidden bg-white/5 hover:bg-white/10 transition border border-white/10"
            >
              {/* Thumbnail */}
              <div className="aspect-[9/16] bg-black">
                {post?.poster_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={post.poster_url}
                    alt={post.title ?? "Video"}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full grid place-items-center text-white/50 text-xs">
                    No thumbnail
                  </div>
                )}
              </div>

              {/* Meta */}
              <div className="p-3">
                <div className="text-sm font-medium text-white/90 truncate">
                  {post?.title || "Untitled"}
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-white/15 overflow-hidden">
                  {/* We don’t know total duration here; the Watch page saves true progress.
                      This bar is decorative (we’ll fill a small portion so it reads as “in-progress”). */}
                  <div className="h-full w-[28%] bg-white/80" />
                </div>
                <div className="mt-2 text-[11px] text-white/60">
                  Resumes at {fmt(progress.seconds)}
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function fmt(t: number) {
  if (!isFinite(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
