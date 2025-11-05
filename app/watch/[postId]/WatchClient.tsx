"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabaseClient";

/** Types */
type Post = {
  id: string;
  title: string | null;
  video_url: string | null;
  poster_url: string | null;
};

type LoadProgressResponse =
  | { ok: true; seconds: number }
  | { ok: false; error?: string };

type SaveProgressBody = { postId: string; seconds: number };

/** Constants */
const MUTE_KEY = "cn_mute";
const SAVE_INTERVAL_MS = 4000; // throttle interval
const MAX_RESUME_SEC = 24 * 60 * 60; // cap a single video at 24h

export default function WatchClient({ postId }: { postId: string }) {
  const supabase = createClient();

  const [post, setPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const userIdRef = useRef<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const resumeTargetRef = useRef<number | null>(null);
  const lastSaveAtRef = useRef<number>(0);

  /** ---------------- Fetch post + auth + resume ---------------- */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [{ data: auth }, { data: p, error: postErr }] = await Promise.all([
          supabase.auth.getUser(),
          supabase
            .from("posts")
            .select("id,title,video_url,poster_url")
            .eq("id", postId)
            .single(),
        ]);

        if (cancelled) return;

        if (postErr || !p) {
          console.error("Watch fetch error:", postErr?.message ?? "not found");
          setPost(null);
          setLoading(false);
          return;
        }

        userIdRef.current = auth?.user?.id ?? null;
        setPost(p as Post);
        setLoading(false);

        // If signed in, prefetch resume progress from API
        if (auth?.user?.id) {
          try {
            const res = await fetch("/api/watch/progress", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ postId }),
            });
            const json: LoadProgressResponse = await res.json();

            if (!cancelled && json.ok && Number.isFinite(json.seconds)) {
              resumeTargetRef.current = Math.max(
                0,
                Math.min(json.seconds, MAX_RESUME_SEC)
              );
              setCurrentTime(resumeTargetRef.current);
            }
          } catch (e) {
            // non-fatal
          }
        }
      } catch (e) {
        console.error("Watch init error:", e);
        if (!cancelled) {
          setPost(null);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [postId, supabase]);

  /** ---------------- Video wiring + listeners ---------------- */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    // Restore mute preference
    const stored = localStorage.getItem(MUTE_KEY);
    if (stored === "0") {
      v.muted = false;
      setIsMuted(false);
    } else {
      v.muted = true;
      setIsMuted(true);
    }

    const onLoaded = () => {
      setDuration(Number.isFinite(v.duration) ? v.duration : 0);
      // Seek to resume point after we know duration
      if (resumeTargetRef.current && Number.isFinite(v.duration)) {
        v.currentTime = Math.min(
          resumeTargetRef.current,
          Math.max(0, v.duration - 0.25)
        );
        setCurrentTime(v.currentTime);
      }
      // Mobile: try to auto-play muted (allowed)
      v.play().catch(() => {});
    };

    const onTime = () => {
      setCurrentTime(v.currentTime || 0);
      // throttle autosave
      maybeSaveProgress(v.currentTime);
    };

    const onPlay = () => setIsPlaying(true);
    const onPause = () => {
      setIsPlaying(false);
      // flush save on pause
      maybeSaveProgress(v.currentTime, true);
    };

    const onEnded = () => {
      setIsPlaying(false);
      // mark near-end as complete
      maybeSaveProgress(v.duration || 0, true);
    };

    v.addEventListener("loadedmetadata", onLoaded);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);

    // Pause when scrolled offscreen; resume when focused in view
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            v.play().catch(() => {});
          } else {
            v.pause();
          }
        });
      },
      { threshold: 0.6 }
    );
    io.observe(v);

    // Best-effort saves on page lifecycle changes
    const flush = () => {
      if (!v) return;
      maybeSaveProgress(v.currentTime, true);
    };
    // `pagehide` is better than beforeunload on mobile Safari
    const onVisibility = () => {
      if (document.visibilityState !== "visible") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      v.removeEventListener("loadedmetadata", onLoaded);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onEnded);
      io.disconnect();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post?.video_url]);

  /** ---------------- Helpers ---------------- */
  const saveProgress = async (sec: number) => {
    if (!userIdRef.current) return; // only save for signed-in users
    // Clamp to [0, duration]
    const seconds = Math.max(0, Math.min(sec, duration || 0));

    try {
      await fetch("/api/watch/progress", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId, seconds } as SaveProgressBody),
        keepalive: true, // allows sending during pagehide
      });
    } catch {
      // ignore; next tick will retry
    }
  };

  const maybeSaveProgress = (sec: number, force = false) => {
    if (!duration || !userIdRef.current) return;

    const now = Date.now();
    if (!force && now - lastSaveAtRef.current < SAVE_INTERVAL_MS) return;

    lastSaveAtRef.current = now;
    void saveProgress(sec);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
    localStorage.setItem(MUTE_KEY, v.muted ? "1" : "0");
  };

  const requestFullscreen = async () => {
    const v = videoRef.current as any;
    if (!v) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (v.requestFullscreen) {
        await v.requestFullscreen();
      } else if (v.webkitEnterFullscreen) {
        v.webkitEnterFullscreen(); // iOS Safari
      }
    } catch (err) {
      console.error("Fullscreen error:", err);
    }
  };

  const seekTo = (clientX: number, bar: HTMLDivElement) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    const rect = bar.getBoundingClientRect();
    const pct = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    v.currentTime = pct * duration;
    setCurrentTime(v.currentTime);
    // Save immediately on manual seek
    maybeSaveProgress(v.currentTime, true);
  };

  const fmt = (t: number) => {
    if (!isFinite(t) || t < 0) return "0:00";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const title = useMemo(() => post?.title ?? "Untitled", [post?.title]);

  /** ---------------- Render ---------------- */
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-white/70 bg-black">
        Loading…
      </div>
    );
  }

  if (!post) {
    return (
      <div className="min-h-screen flex items-center justify-center text-white/70 bg-black">
        Post not found.
      </div>
    );
  }

  return (
    <main className="min-h-screen w-full bg-[#0b0b0b] text-white flex flex-col items-center justify-center">
      <div className="w-full max-w-[1100px] px-4 sm:px-6 flex flex-col items-center gap-5">
        {/* Video frame — UI unchanged */}
        <div
          className="relative aspect-[9/16] h-[78vh] max-h-[78vh] bg-black rounded-2xl overflow-hidden shadow-2xl"
          style={{ width: "min(560px, 90vw)" }}
        >
          <video
            ref={videoRef}
            src={post.video_url ?? undefined}
            poster={post.poster_url ?? undefined}
            className="h-full w-full object-contain"
            playsInline
            muted
            loop
            controls={false}
          />

          {/* Fullscreen button */}
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              requestFullscreen();
            }}
            className="absolute top-2 right-2 z-20 rounded-md bg-black/50 hover:bg-black/60 backdrop-blur px-2 py-1 text-xs"
          >
            Fullscreen
          </button>

          {/* Click-to-play overlay */}
          <button
            onClick={togglePlay}
            className="absolute inset-0 z-10"
            aria-label={isPlaying ? "Pause" : "Play"}
            style={{ cursor: "pointer" }}
          />

          {/* Controls */}
          <div className="pointer-events-auto absolute left-0 right-0 bottom-0 p-3 bg-gradient-to-t from-black/60 to-transparent z-20">
            <div
              className="w-full h-2 bg-white/20 rounded-full overflow-hidden cursor-pointer"
              onClick={(e) => seekTo(e.clientX, e.currentTarget)}
            >
              <div
                className="h-full bg-white"
                style={{
                  width: duration ? `${(currentTime / duration) * 100}%` : "0%",
                }}
              />
            </div>

            <div className="mt-2 flex items-center justify-between text-[11px] text-white/85">
              <div className="tabular-nums">
                {fmt(currentTime)} / {fmt(duration)}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlay();
                  }}
                  className="rounded bg-white/10 hover:bg-white/20 px-2 py-1"
                >
                  {isPlaying ? "Pause" : "Play"}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleMute();
                  }}
                  className="rounded bg-white/10 hover:bg-white/20 px-2 py-1"
                >
                  {isMuted ? "Unmute" : "Mute"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer — UI unchanged */}
        <div className="w-full" style={{ maxWidth: "min(560px, 90vw)" }}>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-lg sm:text-xl font-semibold truncate">
                {title}
              </h1>
              <div className="mt-1 text-xs text-white/60">
                by Creator <span className="mx-1">•</span> Purchased $75
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/library"
                className="rounded-md bg-white/10 px-3 py-2 text-sm hover:bg-white/20"
              >
                View Library
              </Link>
              <Link
                href="/dashboard"
                className="rounded-md bg-[#7c4dff] px-3 py-2 text-sm text-white hover:brightness-110"
              >
                Go to Dashboard
              </Link>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
