// components/LibraryClient.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

type Purchase = {
  id: string;
  post_id: string;
  created_at: string;
};

type Post = {
  id: string;
  title: string | null;
  poster_url: string | null;
  video_url: string | null;     // promo video
  premium_path: string | null;  // private file (signed via API)
  price_cents: number | null;
};

export default function LibraryClient() {
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [posts, setPosts] = useState<Record<string, Post>>({});

  useEffect(() => {
    (async () => {
      // who am I?
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id ?? null;
      setUserId(uid);
      if (!uid) {
        setLoading(false);
        return;
      }

      // get all purchases for user
      const { data: rows, error: pErr } = await supabase
        .from("purchases")
        .select("id,post_id,created_at")
        .eq("user_id", uid)
        .order("created_at", { ascending: false });

      if (pErr) {
        console.error("purchases error:", pErr);
        setLoading(false);
        return;
      }

      setPurchases(rows ?? []);

      const postIds = Array.from(new Set((rows ?? []).map(r => r.post_id)));
      if (postIds.length === 0) {
        setPosts({});
        setLoading(false);
        return;
      }

      // batch fetch posts
      const { data: postRows, error: postsErr } = await supabase
        .from("posts")
        .select("id,title,poster_url,video_url,premium_path,price_cents")
        .in("id", postIds);

      if (postsErr) {
        console.error("posts error:", postsErr);
        setLoading(false);
        return;
      }

      const map: Record<string, Post> = {};
      (postRows ?? []).forEach(p => { map[p.id] = p as Post; });
      setPosts(map);
      setLoading(false);
    })();
  }, []);

  const items = useMemo(() => {
    if (!purchases.length) return [];
    return purchases
      .map(p => ({ purchase: p, post: posts[p.post_id] }))
      .filter(x => Boolean(x.post));
  }, [purchases, posts]);

  if (loading) {
    return (
      <main className="min-h-screen bg-white flex items-center justify-center">
        <p className="text-sm text-gray-600">Loading your library…</p>
      </main>
    );
  }

  if (!userId) {
    return (
      <main className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-700">Please sign in to view your library.</p>
          <Link className="underline text-[#7E5CE6]" href="/auth">Go to sign in</Link>
        </div>
      </main>
    );
  }

  if (items.length === 0) {
    return (
      <main className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-semibold">Your Library</h1>
          <p className="text-gray-600 mt-1">You haven’t purchased anything yet.</p>
          <Link href="/dashboard" className="mt-3 inline-block rounded-md bg-[#7E5CE6] px-4 py-2 text-white">
            Explore the feed
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="flex items-center justify-between">
          <div>
            <Link href="/dashboard" className="rounded-md bg-[#7E5CE6] px-3 py-2 text-white text-sm">
              Back to dashboard
            </Link>
          </div>
          <h1 className="text-2xl font-bold">Your Library</h1>
          <div />
        </div>

        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {items.map(({ purchase, post }) => {
            const price = post.price_cents ? `$${(post.price_cents / 100).toFixed(0)}` : "";
            return (
              <article key={purchase.id} className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                <div className="aspect-[9/16] bg-black/5">
                  {post.poster_url ? (
                    // poster thumbnail
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={post.poster_url}
                      alt={post.title ?? "Video"}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    // fallback to promo frame
                    <video
                      src={post.video_url ?? undefined}
                      className="h-full w-full object-cover"
                      muted
                      playsInline
                    />
                  )}
                </div>

                <div className="p-3">
                  <h2 className="font-semibold truncate">{post.title ?? "Untitled"}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Purchased {new Date(purchase.created_at).toLocaleDateString()}
                    {price ? ` • ${price}` : ""}
                  </p>

                  <div className="mt-3 flex items-center gap-2">
                    <Link
                      href={`/watch/${post.id}`}
                      className="rounded-md bg-zinc-900 text-white px-3 py-2 text-sm hover:bg-zinc-800"
                    >
                      Watch now
                    </Link>

                    {/* Optional: fetch a fresh signed URL and open in new tab/player */}
                    {post.premium_path && (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const res = await fetch("/api/premium/access", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              credentials: "include",
                              body: JSON.stringify({ post_id: post.id }),
                            });
                            const data = await res.json();
                            if (data?.success && data.url) {
                              window.open(data.url, "_blank");
                            } else {
                              alert(data?.error || "Could not get access link.");
                            }
                          } catch (e: any) {
                            alert(e?.message || "Could not get access link.");
                          }
                        }}
                        className="rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
                      >
                        Get access link
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </main>
  );
}
