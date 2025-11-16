"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import BackButton from "@/components/BackButton";

/* ----------------------------- types & utils ----------------------------- */

type LibraryItem = {
  id: string;
  post_id: string;
  title: string;
  poster_url: string | null;
  created_at?: string | null;
  position_seconds?: number | null;
  duration_seconds?: number | null;
};

const clampPct = (pos?: number | null, dur?: number | null) => {
  if (!pos || !dur || dur <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((pos / dur) * 100)));
};

const fmt = (s?: number | null) => {
  if (!s || s <= 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, "0");
  return `${m}:${sec}`;
};

/* --------------------------------- UI bits -------------------------------- */

function CardSkeleton() {
  return (
    <div className="animate-pulse border rounded-lg overflow-hidden">
      <div className="h-48 bg-gray-100" />
      <div className="p-4 space-y-2">
        <div className="h-4 bg-gray-100 rounded w-2/3" />
        <div className="h-8 bg-gray-100 rounded w-20" />
      </div>
    </div>
  );
}

function ContinueSkeleton() {
  return (
    <div className="mb-6">
      <div className="h-6 w-44 bg-gray-100 rounded mb-3 animate-pulse" />
      <div className="flex gap-3 overflow-x-auto">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="min-w-[220px]">
            <div className="h-36 bg-gray-100 rounded animate-pulse" />
            <div className="h-3 w-24 bg-gray-100 rounded mt-2 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

function LibraryCard({
  item,
  onPrefetch,
}: {
  item: LibraryItem;
  onPrefetch: (postId: string) => void;
}) {
  const pct = clampPct(item.position_seconds, item.duration_seconds);
  const showProgress = pct > 0 && pct < 100;

  return (
    <div
      className="border rounded-lg overflow-hidden hover:shadow-md transition"
      onMouseEnter={() => onPrefetch(item.post_id)}
      onTouchStart={() => onPrefetch(item.post_id)}
    >
      {item.poster_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.poster_url}
          alt={item.title}
          className="w-full h-48 object-cover bg-gray-50"
          loading="lazy"
        />
      ) : (
        <div className="w-full h-48 bg-gray-100 flex items-center justify-center text-gray-400 text-sm">
          No thumbnail
        </div>
      )}

      {showProgress && (
        <div className="px-4 pt-3">
          <div className="h-2 w-full bg-gray-200 rounded">
            <div className="h-2 bg-black rounded" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-[11px] text-gray-500">
            {fmt(item.position_seconds)} / {fmt(item.duration_seconds)}
          </div>
        </div>
      )}

      <div className="p-4">
        <h2 className="font-medium text-sm mb-2 line-clamp-2">{item.title}</h2>
        <Link
          href={`/watch/${item.post_id}`}
          prefetch
          className="inline-block bg-black text-white text-sm px-3 py-2 rounded-md hover:opacity-90"
        >
          {pct > 0 && pct < 95 ? "Resume" : "Watch"}
        </Link>
      </div>
    </div>
  );
}

/* --------------------------------- page ---------------------------------- */

// ✅ Create client ONCE (memo), and do not put it in effect deps.
export default function LibraryPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []); // ← prevents re-renders loop
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // cache prefetches per session (ref so it doesn’t reset on re-render)
  const prefetchedRef = useRef<Set<string>>(new Set());
  const prefetchWatch = (postId: string) => {
    const s = prefetchedRef.current;
    if (!postId || s.has(postId)) return;
    s.add(postId);
    router.prefetch(`/watch/${postId}`);
  };

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        const { data: auth } = await supabase.auth.getUser();
        const user = auth?.user;
        if (!user) {
          if (!cancelled) {
            setError("You must be signed in to view your library.");
            setLoading(false);
          }
          return;
        }

        // 1) Purchases + posts
        const { data: purchases, error: pErr } = await supabase
          .from("purchases")
          .select(
            `
              id,
              post_id,
              created_at,
              posts (
                id,
                title,
                poster_url
              )
            `
          )
          .eq("buyer_id", user.id)
          .eq("status", "paid")
          .order("created_at", { ascending: false });

        if (cancelled) return;

        if (pErr) {
          setError(pErr.message);
          setLoading(false);
          return;
        }

        const base: LibraryItem[] =
          (purchases || []).map((row: any) => ({
            id: row.id,
            post_id: row.post_id,
            created_at: row.created_at ?? null,
            title: row.posts?.title ?? "Untitled",
            poster_url: row.posts?.poster_url ?? null,
          })) ?? [];

        // 2) Optional progress
        const postIds = base.map((b) => b.post_id);
        let progressByPost = new Map<
          string,
          { position_seconds: number | null; duration_seconds: number | null }
        >();

        if (postIds.length > 0) {
          const { data: prog, error: wErr } = await supabase
            .from("watch_progress")
            .select("post_id, position_seconds, duration_seconds")
            .eq("user_id", user.id)
            .in("post_id", postIds);

          // if table/policy not present yet, silently skip
          if (!wErr && prog) {
            for (const r of prog) {
              progressByPost.set(r.post_id, {
                position_seconds: r.position_seconds ?? null,
                duration_seconds: r.duration_seconds ?? null,
              });
            }
          }
        }

        const merged = base.map((b) => {
          const pr = progressByPost.get(b.post_id);
          return {
            ...b,
            position_seconds: pr?.position_seconds ?? null,
            duration_seconds: pr?.duration_seconds ?? null,
          };
        });

        if (!cancelled) {
          setItems(merged);
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || "Failed to load your library.");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []); // ← empty deps; no flicker

  const continueItems = useMemo(
    () =>
      items.filter((i) => {
        const p = clampPct(i.position_seconds, i.duration_seconds);
        return p > 0 && p < 95;
      }),
    [items]
  );

  /* ------------------------------- render -------------------------------- */

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl p-6">
        <BackButton />
        <ContinueSkeleton />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="p-6 text-center text-red-500">
        <BackButton />
        Error: {error}
        <div className="mt-4">
          <BackButton />
          <Link href="/dashboard" className="underline text-sm">
            Back to dashboard
          </Link>
        </div>
      </main>
    );
  }

  if (items.length === 0) {
    return (
      <main className="p-6 text-center text-gray-500">
        <BackButton />
        You haven’t purchased any videos yet.
        <div className="mt-4">
          <BackButton />
          <Link
            href="/dashboard"
            className="inline-block px-4 py-2 bg-black text-white rounded-md hover:opacity-90"
          >
            Explore the feed
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl p-6">
      <BackButton />
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Your Library</h1>
        <BackButton />
      </div>

      {continueItems.length > 0 && (
        <section className="mb-8">
          <h2 className="text-base font-medium mb-3">Continue watching</h2>
          <div className="flex gap-4 overflow-x-auto pb-1">
            {continueItems.map((it) => (
              <div key={`cw-${it.id}`} className="min-w-[240px] max-w-[280px]">
                <LibraryCard item={it} onPrefetch={prefetchWatch} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {items.map((item) => (
            <LibraryCard
              key={item.id}
              item={item}
              onPrefetch={prefetchWatch}
            />
          ))}
        </div>
      </section>
    </main>
  );
}
