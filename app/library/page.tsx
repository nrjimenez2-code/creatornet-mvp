"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";
import BackButton from "@/components/BackButton";

/* ----------------------------- types & utils ----------------------------- */

type LibraryItem = {
  id: string;
  post_id: string;
  title: string;
  poster_url: string | null;
  video_url: string | null;
  created_at?: string | null;
  position_seconds?: number | null;
  duration_seconds?: number | null;
  creator_id: string | null;
  creator_username: string | null;
  creator_full_name: string | null;
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
  const canResume = (item.position_seconds ?? 0) > 0 && pct < 95;

  return (
    <div
      className="w-full border border-gray-700 rounded-xl overflow-hidden hover:shadow-lg transition bg-black"
      onMouseEnter={() => onPrefetch(item.post_id)}
      onTouchStart={() => onPrefetch(item.post_id)}
    >
      <div className="aspect-[4/3] w-full bg-gray-100">
        {item.poster_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.poster_url}
            alt={item.title}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : item.video_url ? (
          <video
            src={item.video_url}
            className="h-full w-full object-cover"
            muted
            playsInline
            preload="none"
          />
        ) : (
          <div className="h-full w-full flex items-center justify-center text-gray-400 text-sm">
            No thumbnail
          </div>
        )}
      </div>

      {showProgress && (
        <div className="px-4 pt-3">
          <div className="h-2 w-full bg-gray-700 rounded">
            <div className="h-2 bg-[#9370DB] rounded" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-[11px] text-gray-400">
            {fmt(item.position_seconds)} / {fmt(item.duration_seconds)}
          </div>
        </div>
      )}
      {!item.duration_seconds && canResume ? (
        <p className="px-4 pt-3 text-[11px] text-gray-400">
          Resume at {fmt(item.position_seconds)}
        </p>
      ) : null}

      <div className="p-3">
        <h2 className="font-medium text-xs mb-2 line-clamp-2 text-white">{item.title}</h2>
        {item.creator_id && (
          <div className="text-[11px] text-white/50 mb-2 line-clamp-1">
            <Link
              href={
                item.creator_username
                  ? `/profile/${encodeURIComponent(item.creator_username)}`
                  : `/creators/${item.creator_id}`
              }
              className="hover:underline"
            >
              {item.creator_full_name ||
                (item.creator_username ? `@${item.creator_username}` : "Creator")}
            </Link>
          </div>
        )}
        <Link
          href={`/watch/${item.post_id}`}
          prefetch
          className="inline-block bg-gray-800 text-white text-xs px-3 py-1.5 rounded-md hover:opacity-90"
        >
          {canResume ? "Resume" : "Watch"}
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
  const { userId, loading: authLoading } = useUser();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // cache prefetches per session (ref so it doesn't reset on re-render)
  const prefetchedRef = useRef<Set<string>>(new Set());
  const prefetchWatch = (postId: string) => {
    const s = prefetchedRef.current;
    if (!postId || s.has(postId)) return;
    s.add(postId);
    router.prefetch(`/watch/${postId}`);
  };

  useEffect(() => {
    // While the auth context is still resolving, keep showing the loading
    // skeleton — never treat "loading" as "signed out".
    if (authLoading) return;

    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        if (!userId) {
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
                poster_url,
                video_url,
                creator_id,
                duration_seconds
              )
            `
          )
          .eq("buyer_id", userId)
          .order("created_at", { ascending: false });

        if (cancelled) return;

        if (pErr) {
          console.error("[library] purchases read error:", pErr);
          setError(pErr.message);
          setLoading(false);
          return;
        }

        // The legacy flag is deliberately false for timed purchases. Discover
        // owned rows first, then ask the same server entitlement readers used
        // by delivery. Listing never grants access or creates a signed URL.
        const eligibleIds = new Set<string>();
        for (let offset = 0; offset < (purchases ?? []).length; offset += 100) {
          const res = await fetch("/api/library/eligibility", {
            method: "POST", credentials: "include", cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ purchaseIds: purchases!.slice(offset, offset + 100).map(row => row.id) }),
          });
          if (!res.ok) throw Error("Could not check library access.");
          const body = await res.json();
          if (!Array.isArray(body.purchaseIds) || body.purchaseIds.some((id: unknown) => typeof id !== "string")) {
            throw Error("Could not check library access.");
          }
          for (const id of body.purchaseIds) eligibleIds.add(id);
        }
        if (cancelled) return;

        const baseRaw: Array<
          Omit<LibraryItem, "position_seconds">
        > = (purchases || []).filter(row => eligibleIds.has(row.id)).map((row: any) => ({
          id: row.id,
          post_id: row.post_id,
          created_at: row.created_at ?? null,
          title: row.posts?.title ?? "Untitled",
          poster_url: row.posts?.poster_url ?? null,
          video_url: row.posts?.video_url ?? null,
          creator_id: row.posts?.creator_id ?? null,
          duration_seconds: row.posts?.duration_seconds ?? null,
          creator_username: null,
          creator_full_name: null,
        }));

        const creatorIds = [
          ...new Set(baseRaw.map((b) => b.creator_id).filter(Boolean)),
        ] as string[];

        const profileById = new Map<
          string,
          { username: string | null; full_name: string | null }
        >();
        if (creatorIds.length > 0) {
          // Via /api/profiles, not a direct table read: public.profiles has no
          // cross-user SELECT policy (only `is_admin()` and `auth.uid() = id`),
          // so reading another creator's row with the RLS-scoped browser client
          // returns nothing and every item renders as an anonymous "Creator".
          // That route is auth-gated and returns display columns only.
          try {
            const res = await fetch(
              `/api/profiles?ids=${encodeURIComponent(creatorIds.join(","))}`,
              { credentials: "include" }
            );
            if (res.ok) {
              const { profiles } = (await res.json()) as {
                profiles?: {
                  id: string;
                  username: string | null;
                  full_name: string | null;
                }[];
              };
              for (const p of profiles ?? []) {
                profileById.set(p.id, {
                  username: p.username ?? null,
                  full_name: p.full_name ?? null,
                });
              }
            }
          } catch {
            // Names are decoration here — a failure must not blank the library.
          }
        }

        const base: LibraryItem[] = baseRaw.map((b) => {
          const pr = b.creator_id ? profileById.get(b.creator_id) : null;
          return {
            ...b,
            creator_username: pr?.username ?? null,
            creator_full_name: pr?.full_name ?? null,
            position_seconds: null,
          };
        });

        // 2) Optional progress
        const postIds = base.map((b) => b.post_id);
        // public.watch_progress stores the position in `seconds`; there is no
        // position_seconds/duration_seconds column and never was, so the old
        // select errored on every request and the swallowed failure left
        // "Continue watching" and every progress bar permanently dead.
        // Duration comes from posts.duration_seconds, selected above.
        const positionByPost = new Map<string, number | null>();

        if (postIds.length > 0) {
          const { data: prog, error: wErr } = await supabase
            .from("watch_progress")
            .select("post_id, seconds")
            .eq("user_id", userId)
            .in("post_id", postIds);

          if (wErr) {
            // Progress is decoration, like creator names: a failure must not
            // blank the library. But it must not be silent either.
            console.error("[library] watch_progress read error:", wErr);
          } else if (prog) {
            for (const r of prog) {
              positionByPost.set(r.post_id, r.seconds ?? null);
            }
          }
        }

        const merged = base.map((b) => ({
          ...b,
          position_seconds: positionByPost.get(b.post_id) ?? null,
        }));

        if (!cancelled) {
          setItems(merged);
          setLoading(false);
        }
      } catch (e: any) {
        console.error("[library] load error:", e);
        if (!cancelled) {
          setError(e?.message || "Failed to load your library.");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authLoading, userId, supabase]); // ← re-runs only when auth identity settles/changes

  const continueItems = useMemo(
    () =>
      items.filter((i) => {
        const p = clampPct(i.position_seconds, i.duration_seconds);
        return (i.position_seconds ?? 0) > 0 && p < 95;
      }),
    [items]
  );

  /* ------------------------------- render -------------------------------- */

  if (loading) {
    return (
      <main className="p-6 relative">
        <div className="max-w-6xl mx-auto">
          <div className="absolute top-4 left-4 z-10 translate-x-[0.0001in]">
            <BackButton hrefOverride="/dashboard" />
          </div>
          <ContinueSkeleton />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        </div>
      </main>
    );
  }

  if (error) {
    // The only signed-out path sets `error` while userId is null; every other
    // `error` is a failed purchases read for a real user. The first wants a
    // sign-in link, the second a retry — not the same red line for both.
    const isSignedOut = !userId;
    return (
      <main className="p-6 text-center relative">
        <div className="max-w-6xl mx-auto">
          <div className="absolute top-4 left-4 z-10 translate-x-[0.0001in]">
            <BackButton hrefOverride="/dashboard" />
          </div>
          {isSignedOut ? (
            <>
              <p className="mt-12 text-white font-medium">Sign in to see your library</p>
              <p className="mt-1 text-sm text-gray-400">Everything you buy shows up here.</p>
              <div className="mt-4">
                <Link
                  href="/auth"
                  className="inline-block rounded-md bg-[#4A35C7] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3D2BA3] transition-colors"
                >
                  Sign in
                </Link>
              </div>
            </>
          ) : (
            <>
              {/* `error` was set but never rendered, so a buyer whose purchases
                  failed to load saw a blank page with a back link — indistinguish-
                  able from "you own nothing". */}
              <p className="mt-12 text-red-400 font-medium" role="alert">
                Couldn&apos;t load your library
              </p>
              <p className="mt-1 text-sm text-gray-400">
                Something went wrong on our end. Give it another try.
              </p>
              <Link href="/payments" className="mt-4 inline-block text-sm underline">Review your payment plans</Link>
              <Link href="/calls" className="ml-4 mt-4 inline-block text-sm underline">Your paid calls</Link>
              <Link href="/memberships" className="ml-4 mt-4 inline-block text-sm underline">Monthly mentorships</Link>
              <div className="mt-4 flex items-center justify-center gap-4">
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="rounded-full border border-gray-700 px-4 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-900 transition-colors"
                >
                  Try again
                </button>
                <Link href="/dashboard" className="underline text-sm text-gray-400">
                  Back to dashboard
                </Link>
              </div>
            </>
          )}
        </div>
      </main>
    );
  }

  if (items.length === 0) {
    return (
      <main className="p-6 text-center text-gray-500 relative">
        <div className="max-w-6xl mx-auto">
          <div className="absolute top-4 left-4 z-10 translate-x-[0.0001in]">
            <BackButton hrefOverride="/dashboard" />
          </div>
          {/* The empty state used to be a lone button with no words — nothing
              said this page was the library or that it was empty on purpose. */}
          <h1 className="mt-12 text-lg font-semibold text-white">Your library is empty</h1>
          <p className="mt-1 text-sm text-gray-400">
            Videos and offers you buy will show up here.
          </p>
          <Link href="/payments" className="mt-4 inline-block text-sm text-white underline">Review your payment plans</Link>
          <Link href="/calls" className="ml-4 mt-4 inline-block text-sm text-white underline">Your paid calls</Link>
          <Link href="/memberships" className="ml-4 mt-4 inline-block text-sm text-white underline">Monthly mentorships</Link>
          <p className="mt-2 text-sm text-gray-400">Monthly mentorship access and billing are managed separately.</p>
          <div className="mt-4">
            <Link
              href="/dashboard"
              className="inline-block rounded-md bg-[#4A35C7] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3D2BA3] transition-colors"
            >
              Explore the feed
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="p-6 relative">
      <div className="max-w-6xl mx-auto">
        {/* Mobile: Back button on top, heading below and left-aligned */}
        <div className="block md:hidden mb-6">
          <div className="mb-3">
            <BackButton hrefOverride="/dashboard" />
          </div>
          <h1 className="text-xl font-semibold text-left">Your Library</h1>
        </div>

        {/* Desktop: Absolute positioned back button (original) */}
        <div className="hidden md:block absolute top-4 left-4 z-10">
          <BackButton hrefOverride="/dashboard" />
        </div>
        <div className="hidden md:flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">Your Library</h1>
        </div>

        <Link href="/payments" className="mb-6 inline-block text-sm underline">Review your payment plans</Link>
        <Link href="/calls" className="mb-6 ml-4 inline-block text-sm underline">Your paid calls</Link>
        <Link href="/memberships" className="mb-6 ml-4 inline-block text-sm underline">Monthly mentorships</Link>

        {continueItems.length > 0 && (
          <section className="mb-8">
            <h2 className="text-base font-medium mb-3">Continue watching</h2>
            <div className="flex gap-4 overflow-x-auto pb-1">
              {continueItems.map((it) => (
                <div key={`cw-${it.id}`} className="min-w-[210px] max-w-[220px]">
                  <LibraryCard item={it} onPrefetch={prefetchWatch} />
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-5 gap-2">
            {items.map((item) => (
              <LibraryCard
                key={item.id}
                item={item}
                onPrefetch={prefetchWatch}
              />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
