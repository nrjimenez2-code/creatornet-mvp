"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import { useRequireUser } from "@/lib/useUser";
import BackButton from "@/components/BackButton";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";

type Post = {
  id: string;
  creator_id: string | null;
  title: string | null;
  video_url: string | null;
  poster_url: string | null;
  creator?: {
    full_name: string | null;
    username: string | null;
    avatar_url: string | null;
  } | null;
};

export default function WatchPage() {
  const params = useParams<{ postId: string }>();
  const postId = params?.postId || "";
  const searchParams = useSearchParams();
  const fromProfile = searchParams?.get("fromProfile") === "1";
  const supabase = createClient();
  const router = useRouter();

  // Signed-out users go to the dashboard where they can see the post in the feed
  const { userId, loading: authLoading } = useRequireUser(
    `/dashboard?postId=${postId}`
  );

  const [post, setPost] = useState<Post | null>(null);
  // The downloadable file a buyer actually paid for. GET /api/watch/[postId]
  // re-checks entitlement server-side and returns a short-lived signed URL;
  // 404 simply means this post has no premium file attached.
  const [premiumUrl, setPremiumUrl] = useState<string | null>(null);
  const [premiumState, setPremiumState] = useState<"idle" | "none" | "error">(
    "idle"
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastSaveRef = useRef<number>(0);
  const userIdForProgress = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Wait for the auth context to settle; useRequireUser handles the
      // signed-out redirect.
      if (authLoading || !userId) return;

      if (!postId) {
        setError("Invalid post.");
        setLoading(false);
        return;
      }

      userIdForProgress.current = userId;

      let entitledByPurchase = false;
      if (!fromProfile) {
        // Check purchase entitlement first
        const { data: purchase, error: purErr } = await supabase
          .from("purchases")
          .select("id")
          .eq("buyer_id", userId)
          .eq("post_id", postId)
          .eq("status", "paid")
          .maybeSingle();

        if (purErr) {
          console.error("Purchase check error:", purErr);
          setError("Unable to verify access.");
          setLoading(false);
          return;
        }

        if (!purchase) {
          // Not entitled → redirect to dashboard where they can see the post and purchase it
          router.push(`/dashboard?postId=${postId}`);
          return;
        }
        entitledByPurchase = true;
      }

      // Fetch the post itself, moderation columns included. Discovery surfaces
      // filter hidden/removed posts out of the query (lib/visiblePosts.ts);
      // this page must not, because a buyer never loses what they paid for: a
      // paid purchase row, or being the post's own creator, still opens a
      // hidden or removed post. Anyone else gets the same "Post not found." a
      // nonexistent id gets — no new UI state.
      const { data, error: postErr } = await supabase
        .from("posts")
        .select("id, creator_id, title, video_url, poster_url, hidden_at, removed_at")
        .eq("id", postId)
        .maybeSingle();

      if (cancelled) return;

      const isModerated = Boolean(data?.hidden_at || data?.removed_at);
      const isOwnPost = Boolean(data?.creator_id && data.creator_id === userId);
      if (postErr || !data || (isModerated && !entitledByPurchase && !isOwnPost)) {
        if (postErr) console.error("Post fetch error:", postErr);
        setError("Post not found.");
        setLoading(false);
        return;
      }

      let creatorProfile: Post["creator"] = null;
      if (data.creator_id) {
        // Via /api/profiles, not a direct table read: public.profiles has no
        // cross-user SELECT policy, so this returned null for every creator
        // except yourself and the page showed a purchased video with no
        // attribution at all.
        try {
          const res = await fetch(
            `/api/profiles?ids=${encodeURIComponent(data.creator_id)}`,
            { credentials: "include" }
          );
          if (res.ok) {
            const { profiles } = (await res.json()) as {
              profiles?: {
                full_name: string | null;
                username: string | null;
                avatar_url: string | null;
              }[];
            };
            const creatorData = profiles?.[0];
            if (creatorData) {
              creatorProfile = {
                full_name: creatorData.full_name ?? null,
                username: creatorData.username ?? null,
                avatar_url: creatorData.avatar_url ?? null,
              };
            }
          }
        } catch {
          // Attribution is not worth failing the whole page for.
        }
      }

      setPost({
        id: data.id,
        creator_id: data.creator_id,
        title: data.title,
        video_url: data.video_url,
        poster_url: data.poster_url,
        creator: creatorProfile,
      });
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [postId, supabase, router, userId, authLoading]);

  // Load resume point + save progress on watch
  useEffect(() => {
    if (!post || !userIdForProgress.current) return;
    const video = videoRef.current;
    if (!video) return;

    // Load saved progress
    fetch(`/api/watch/progress?post_id=${post.id}`, { credentials: "include" })
      .then((r) => r.json())
      .then((json) => {
        const seconds = json?.progress?.seconds;
        if (Number.isFinite(seconds) && seconds > 5) {
          video.currentTime = seconds;
        }
      })
      .catch(() => {});

    // Save progress every 5s while watching
    const saveProgress = () => {
      if (!userIdForProgress.current || !video.duration) return;
      const now = Date.now();
      if (now - lastSaveRef.current < 5000) return;
      lastSaveRef.current = now;
      fetch("/api/watch/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        keepalive: true,
        body: JSON.stringify({
          post_id: post.id,
          seconds: Math.floor(video.currentTime),
          duration: Math.floor(video.duration),
        }),
      }).catch(() => {});
    };

    video.addEventListener("timeupdate", saveProgress);
    return () => video.removeEventListener("timeupdate", saveProgress);
  }, [post]);


  // Fetch the premium file's signed URL. Until this existed, a buyer could pay
  // for a post with an attached file and had no way to get it: nothing in the
  // app called either route that can sign it.
  useEffect(() => {
    if (!post?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/watch/${post.id}`, {
          credentials: "include",
        });
        if (cancelled) return;
        if (res.ok) {
          const { url } = (await res.json()) as { url?: string };
          setPremiumUrl(url ?? null);
          setPremiumState(url ? "idle" : "none");
        } else if (res.status === 404) {
          setPremiumState("none"); // no premium file on this post
        } else {
          setPremiumState("error");
        }
      } catch {
        if (!cancelled) setPremiumState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [post?.id]);
  if (loading) {
    return (
      <main className="relative flex items-center justify-center min-h-screen text-gray-500">
        <div className="fixed top-4 left-4 z-10">
          <BackButton hrefOverride="/dashboard" />
        </div>
        Loading video…
      </main>
    );
  }

  if (error) {
    return (
      <main className="relative flex flex-col items-center justify-center min-h-screen">
        <div className="fixed top-4 left-4 z-10">
          <BackButton hrefOverride="/dashboard" />
        </div>
        <p className="text-red-500 mb-4">{error}</p>
        <button
          onClick={() => router.push("/library")}
          className="underline text-sm text-gray-600"
        >
          Back to Library
        </button>
      </main>
    );
  }

  if (!post) {
    return (
      <main className="relative flex items-center justify-center min-h-screen text-gray-500">
        <div className="fixed top-4 left-4 z-10">
          <BackButton hrefOverride="/dashboard" />
        </div>
        Post not found.
      </main>
    );
  }

  const displayCreator =
    post.creator?.full_name || post.creator?.username || "Creator";
  const creatorProfileHref = post.creator_id
    ? userId && post.creator_id === userId
      ? "/profile"
      : post.creator?.username
        ? `/profile/${encodeURIComponent(post.creator.username)}`
        : `/creators/${post.creator_id}`
    : null;

  return (
    <main className="relative mx-auto max-w-3xl px-4 py-6 sm:p-6">
      {/* Desktop: Fixed position back button (original) */}
      <div className="hidden lg:block fixed top-4 left-4 z-10">
        <BackButton hrefOverride="/library" />
      </div>
      
      {/* Mobile: Back button + heading in flex row */}
      <div className="mb-4 flex lg:block items-center gap-4">
        <div className="lg:hidden">
          <BackButton hrefOverride="/library" />
        </div>
        <h1 className="text-lg sm:text-xl font-semibold text-white">
          {post.title ?? "Video"}
        </h1>
      </div>

      {premiumUrl && (
        <div className="mb-4 rounded-xl border border-white/15 bg-white/5 px-4 py-3">
          <p className="text-sm font-medium text-white">Your download is ready</p>
          <p className="mt-0.5 text-xs text-white/60">
            This is the file included with your purchase. The link expires in an
            hour — reload this page for a fresh one.
          </p>
          <a
            href={premiumUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-2 rounded-lg bg-[#4A35C7] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
          >
            Download file
          </a>
        </div>
      )}
      {premiumState === "error" && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-amber-200">
            Your download could not be prepared. Reload the page to try again —
            your purchase is safe.
          </p>
        </div>
      )}
      
      <div className="mx-auto flex max-w-[3500px] justify-center">
        <div className="relative w-full rounded-2xl sm:rounded-[32px] border-4 sm:border-[14px] border-gray-200 bg-black/90 p-1 sm:px-2 sm:py-2 shadow-inner">
          <div className="h-[50vh] sm:h-[60vh] md:h-[36rem] w-full overflow-hidden rounded-xl sm:rounded-[22px] border border-white/20 bg-black">
            {post.video_url ? (
              <video
                ref={videoRef}
                className="h-full w-full object-contain bg-black"
                src={post.video_url}
                poster={post.poster_url || undefined}
                aria-label={post.title ?? "Video"}
                controls
                playsInline
                id="watch-video-player"
              />
            ) : post.poster_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={post.poster_url}
                alt={post.title ?? "Video"}
                className="h-full w-full object-contain bg-black"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-white/60">
                No video available
              </div>
            )}
            
            {/* Screen enlarger button at bottom right corner */}
            {post.video_url && (
              <button
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const video = document.getElementById("watch-video-player") as HTMLVideoElement;
                  if (!video) return;
                  try {
                    if (document.fullscreenElement) {
                      await document.exitFullscreen();
                    } else if (video.requestFullscreen) {
                      await video.requestFullscreen();
                    } else if ((video as any).webkitEnterFullscreen) {
                      (video as any).webkitEnterFullscreen(); // iOS Safari
                    }
                  } catch (err) {
                    console.error("Fullscreen error:", err);
                  }
                }}
                className="absolute bottom-4 right-4 z-50 rounded-md bg-black/85 hover:bg-black border border-white/40 px-2 py-1.5 text-white transition-all flex items-center justify-center shadow-2xl"
                aria-label="Enlarge video"
                style={{ minWidth: "36px", minHeight: "36px" }}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Creator info section - responsive below video */}
      <div className="mt-6 space-y-4">
        <div className="flex items-center gap-3 justify-between">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="h-12 w-12 sm:h-14 sm:w-14 overflow-hidden rounded-full border border-white/30 bg-white/10 flex-shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {/* Decorative: the creator's name is the adjacent link text. */}
              <img
                src={post.creator?.avatar_url || DEFAULT_AVATAR_URL}
                alt=""
                className="h-full w-full object-cover"
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm sm:text-base text-white/60">Created by</div>
              {creatorProfileHref ? (
                <Link
                  href={creatorProfileHref}
                  className="text-lg sm:text-xl font-semibold text-white hover:text-[#4A35C7] underline-offset-4 transition"
                >
                  {displayCreator}
                </Link>
              ) : (
                <span className="text-lg sm:text-xl font-semibold text-white">{displayCreator}</span>
              )}
            </div>
          </div>
          {/* Library button */}
          <Link
            href="/library"
            className="px-4 sm:px-6 py-2 sm:py-2.5 rounded-lg bg-[#4A35C7] text-white text-sm sm:text-base font-semibold hover:bg-[#3D2BA3] transition-colors focus:outline-none focus:ring-2 focus:ring-[#4A35C7]/60 flex-shrink-0"
          >
            Library
          </Link>
        </div>
      </div>
    </main>
  );
}