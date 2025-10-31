"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import VideoCard from "./VideoCard";

type Post = {
  id: string;
  user_id: string | null;
  caption: string;          // aliased from `content`
  video_url: string;
  poster_url: string | null;
  created_at: string;
};

export default function FeedList() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);

  // Typed refs for each full-screen section
  const sectionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const setSectionRef = (i: number) => (el: HTMLDivElement | null) => {
    sectionRefs.current[i] = el;
  };

  // Load posts (alias content -> caption)
  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase
        .from("posts")
        .select("id, user_id, caption:content, video_url, poster_url, created_at")
        .order("created_at", { ascending: false })
        .limit(50);

      if (!mounted) return;

      if (error) {
        console.error("feed fetch error:", error.message);
        setPosts([]);
      } else {
        setPosts((data ?? []) as Post[]);
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Observe sections to decide which one is "active" (most visible)
  useEffect(() => {
    if (!sectionRefs.current.length) return;

    const visibility: Record<number, number> = {};
    let rafId: number | null = null;

    const updateActive = () => {
      let bestIdx = 0;
      let bestRatio = -1;
      for (const [k, v] of Object.entries(visibility)) {
        const idx = Number(k);
        if (v > bestRatio) {
          bestIdx = idx;
          bestRatio = v;
        }
      }
      setActiveIndex(bestIdx);
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
    };

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          const i = Number((e.target as HTMLElement).dataset.index);
          visibility[i] = e.intersectionRatio;
        });
        if (!rafId) rafId = requestAnimationFrame(updateActive);
      },
      {
        // Tight thresholds so the active card switches only when the next
        // card crosses ~half screen (TikTok-like feel)
        threshold: [0, 0.25, 0.5, 0.55, 0.6, 0.75, 1],
      }
    );

    sectionRefs.current.forEach((el) => el && io.observe(el));
    return () => {
      io.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [posts.length]);

  const list = useMemo(() => posts, [posts]);

  if (loading) {
    return (
      <div className="h-[100svh] w-full grid place-content-center text-gray-400">
        Loading…
      </div>
    );
  }

  if (!loading && list.length === 0) {
    return (
      <div className="h-[100svh] w-full grid place-content-center text-gray-300">
        No videos yet — post one from the dashboard!
      </div>
    );
  }

  return (
    <div className="h-[100svh] w-full overflow-y-scroll snap-y snap-mandatory [scrollSnapStop:always]">
      {list.map((p, i) => (
        <section
          key={`${p.id}-${i}`} // unique key
          ref={setSectionRef(i)}
          data-index={i}
          className="snap-start h-[100svh] w-full flex items-stretch justify-center"
        >
          <VideoCard post={p} active={activeIndex === i} /> {/* only the most visible plays */}
        </section>
      ))}
    </div>
  );
}
