"use client";

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

      setPost(data);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [postId, supabase, router]);

  if (loading) {
    return (
      <main className="flex items-center justify-center min-h-screen text-gray-500">
        Loading video…
      </main>
    );
  }

  if (error) {
    return (
      <main className="flex flex-col items-center justify-center min-h-screen">
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
      <main className="flex items-center justify-center min-h-screen text-gray-500">
        Post not found.
      </main>
    );
  }

  return (
    <main className="relative mx-auto max-w-3xl p-6">
      <div className="absolute left-4 top-4 z-10">
        <BackButton
          className="bg-black/60 text-white hover:bg-black/80"
          hrefOverride={fromProfile ? "/profile" : "/library"}
          scroll={false}
        />
      </div>
      <h1 className="text-xl font-semibold mb-4 mt-12">{post.title ?? "Video"}</h1>
      <video
        className="w-full rounded-lg border"
        src={post.video_url || undefined}
        poster={post.poster_url || undefined}
        controls
        playsInline
      />
    </main>
  );
}
