"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import BackButton from "@/components/BackButton";
import { createClient } from "@/lib/supabaseClient";

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
        router.push("/library");
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
          // Not entitled → redirect to Library
          router.push("/library");
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
        <BackButton hrefOverride="/dashboard" />
        Loading video…
      </main>
    );
  }

  if (error) {
    return (
      <main className="relative flex flex-col items-center justify-center min-h-screen">
        <BackButton hrefOverride="/dashboard" />
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
        <BackButton hrefOverride="/dashboard" />
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
    <main className="relative mx-auto max-w-3xl p-6">
      <div className="-translate-x-[5.9in]">
        <BackButton hrefOverride="/dashboard" scroll={false} />
      </div>
      <h1 className="text-xl font-semibold mb-4 text-center">
        {post.title ?? "Video"}
      </h1>
        <div className="mx-auto flex max-w-[3500px] justify-center">
          <div className="relative w-full rounded-[32px] border-[14px] border-gray-200 bg-black/90 px-2 py-2 shadow-inner">
            <div className="h-[36rem] w-full overflow-hidden rounded-[22px] border border-white/20 bg-black">
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
          <Link
            href="/library"
            className="absolute -bottom-18 left-150 rounded-sm bg-[#4A35C7] px-6 py-2 text-sm font-semibold text-white hover:brightness-95 shadow-lg"
          >
            Library
          </Link>
          <div className="absolute -bottom-28 right-6 text-right translate-x-[-33rem]">
            <div className="text-2xl font-semibold text-left">
              {post.title ?? "Video title"}
            </div>
            <div className="mt-2 inline-flex items-center gap-3 text-lg text-white/80">
              <div className="h-14 w-14 overflow-hidden rounded-full border border-white/30 bg-white/10">
                {post.creator?.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={post.creator.avatar_url}
                    alt={displayCreator}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center">
                    👤
                  </span>
                )}
              </div>
              {creatorProfileHref ? (
                <Link
                  href={creatorProfileHref}
                  className="hover:text-white underline-offset-4"
                >
                  {displayCreator}
                </Link>
              ) : (
                <span>{displayCreator}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
