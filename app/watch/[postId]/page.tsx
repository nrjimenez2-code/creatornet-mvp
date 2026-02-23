"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
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

  const [post, setPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!postId) {
        setError("Invalid post.");
        setLoading(false);
        return;
      }

      const { data: auth } = await supabase.auth.getUser();
      const user = auth?.user;
      if (!user) {
        // Redirect to dashboard where they can see the post in the feed
        router.push(`/dashboard?postId=${postId}`);
        return;
      }

      if (!fromProfile) {
        // Check purchase entitlement first
        const { data: purchase, error: purErr } = await supabase
          .from("purchases")
          .select("id")
          .eq("buyer_id", user.id)
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
      }

      // Fetch the post itself
      const { data, error: postErr } = await supabase
        .from("posts")
        .select("id, creator_id, title, video_url, poster_url")
        .eq("id", postId)
        .maybeSingle();

      if (cancelled) return;

      if (postErr || !data) {
        console.error("Post fetch error:", postErr);
        setError("Post not found.");
        setLoading(false);
        return;
      }

      let creatorProfile: Post["creator"] = null;
      if (data.creator_id) {
        const { data: creatorData } = await supabase
          .from("profiles")
          .select("full_name, username, avatar_url")
          .eq("id", data.creator_id)
          .maybeSingle();
        if (creatorData) {
          creatorProfile = {
            full_name: creatorData.full_name ?? null,
            username: creatorData.username ?? null,
            avatar_url: creatorData.avatar_url ?? null,
          };
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
  }, [postId, supabase, router]);

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
    ? `/creators/${post.creator_id}`
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
      
      <div className="mx-auto flex max-w-[3500px] justify-center">
        <div className="relative w-full rounded-2xl sm:rounded-[32px] border-4 sm:border-[14px] border-gray-200 bg-black/90 p-1 sm:px-2 sm:py-2 shadow-inner">
          <div className="h-[50vh] sm:h-[60vh] md:h-[36rem] w-full overflow-hidden rounded-xl sm:rounded-[22px] border border-white/20 bg-black">
            {post.video_url ? (
              <video
                className="h-full w-full object-contain bg-black"
                src={post.video_url}
                poster={post.poster_url || undefined}
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
              <img
                src={post.creator?.avatar_url || DEFAULT_AVATAR_URL}
                alt={displayCreator}
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