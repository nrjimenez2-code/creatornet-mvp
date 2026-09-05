"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import FeedList from "@/components/FeedList";
import PostComposerModal from "@/components/PostComposerModal";
// import ContinueWatching from "@/components/ContinueWatching";
import SearchDrawer from "@/components/SearchDrawer";
// import BackButton from "@/components/BackButton";
import SidebarSignOutButton from "@/components/SidebarSignOutButton";
import StripeConnectBanner from "@/components/StripeConnectBanner";
import { createClient } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";

type Tab = "following" | "discover";

function DashboardContent({ highlightPostId, setHighlightPostId }: { highlightPostId: string | null; setHighlightPostId: (id: string | null) => void }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createClient(), []);
  const { userId, loading: authLoading } = useUser();
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("discover");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  // Bumped after a successful post: remounts FeedList so the new post shows up.
  const [feedRefreshKey, setFeedRefreshKey] = useState(0);


  // Check for postId in URL to highlight specific video
  useEffect(() => {
    const postId = searchParams?.get("postId");
    if (postId) {
      setHighlightPostId(postId);
      // Remove postId from URL after setting it
      const url = new URL(window.location.href);
      url.searchParams.delete("postId");
      router.replace(url.pathname + url.search, { scroll: false });
    }
  }, [searchParams, router, setHighlightPostId]);

  // Fetch avatar in background - non-blocking, doesn't delay feed render
  useEffect(() => {
    let cancelled = false;
    // Use setTimeout to defer this so feed can start loading first
    const timeoutId = setTimeout(() => {
      (async () => {
        try {
          if (!userId || cancelled) return;
          const { data: profile } = await supabase
            .from("profiles")
            .select("avatar_url")
            .eq("id", userId)
            .maybeSingle();
          if (!cancelled) {
            // Only use app profile picture; no OAuth/metadata avatar — when none set, UI uses Default_DP.png
            setAvatarUrl((profile?.avatar_url as string | null) ?? null);
          }
        } catch (err) {
          console.error("Error fetching avatar:", err);
        }
      })();
    }, 0); // Defer to next tick so feed loads first
    
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [supabase, userId]);

  /**
   * Open the composer on every viewport.
   *
   * This used to gate below `lg` on Stripe Connect being fully onboarded, which
   * blocked posting ANYTHING from a phone — including a free video — for any
   * creator without Connect. That is stricter than the server, which only
   * requires Connect when a post actually sells something
   * (app/api/posts/route.ts: `selling && !isCreatorSellReady` → 403), and it is
   * unnecessary: PostComposer already fetches the Connect status itself and,
   * when it is not ready, disables the price and product controls and clears
   * attachBuy/productId/price, so a non-connected creator can only produce a
   * free post.
   */
  function handleRequestCreatePost() {
    setIsComposerOpen(true);
  }

  // useEffect(() => {
  //   router.prefetch("/dashboard/analytics");
  //   router.prefetch("/library");               // top-level
  //   router.prefetch("/dashboard/closers");     // new Bookings page
  //   router.prefetch("/profile");
  //   router.prefetch("/search");                // search results page
  // }, [router]);

  return (
    <section className="min-h-screen px-0">
      {/* Back button intentionally removed on dashboard */}
      <Link
        href="/search"
        className="lg:hidden fixed top-3 right-3 z-40 inline-flex h-10 w-10 items-center justify-center text-white bg-transparent border-0 rounded-none shadow-none backdrop-blur-0 hover:bg-transparent"
        aria-label="Open search"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="7" fill="none" stroke="white" strokeWidth="1.9" />
          <path d="M15.4 15.9L20.2 20.7" fill="none" stroke="white" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      </Link>

      <div className="mx-auto grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-2 lg:gap-6 px-0 pr-0 lg:pr-10">
        {/* SIDEBAR - Always visible, icon-only on smaller screens, full on large screens (TikTok style) */}
        <aside className="hidden lg:block sticky top-6 self-start max-h-[calc(100dvh-3rem)] overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-width:thin] [scrollbar-color:#3f3f46_transparent]">

          {/*
          <div className="w-[240px] ml-0 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <nav className="space-y-2 text-sm">
              ... existing sidebar ...
            </nav>
          </div>
          */}
          <div className="w-full min-w-0 rounded-3xl border border-white/10 bg-black/70 px-6 pt-4 pb-6 text-white shadow-[0_20px_50px_rgba(0,0,0,0.35)] backdrop-blur transition-all duration-300">
            <div className="flex items-center justify-center pb-3 lg:pb-4 border-b border-white/10">
              {/* Icon-only mode: show small logo */}
              <img
                src="/logo.png"
                alt="CreatorNet"
                className="h-10 w-10 object-contain lg:hidden -translate-y-1"
              />
              {/* Full sidebar mode: show full mark */}
              <img
                src="/creatornet-mark.png"
                alt="CreatorNet"
                className="hidden lg:block h-16 w-auto object-contain"
              />
            </div>

            <button
              type="button"
              onClick={() => setIsSearchOpen(true)}
              className="relative -mt-2 lg:-mt-4 flex w-full items-center justify-center lg:justify-start gap-0 lg:gap-3 rounded-full border border-white/25 bg-black px-2 lg:px-4 py-2 text-sm text-white/80 shadow-[0_10px_30px_rgba(0,0,0,0.45)] transition hover:bg-black/80"
              title="Search"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5 lg:hidden" fill="white" aria-hidden="true">
                <path d="M21 20.3 16.8 16a7.5 7.5 0 1 0-.8.8L20.3 21l.7-.7zM4 10.5a6.5 6.5 0 1 1 13 0a6.5 6.5 0 0 1-13 0z" />
              </svg>
              <svg viewBox="0 0 24 24" className="hidden lg:block h-4 w-4" fill="currentColor" aria-hidden="true">
                <path d="M21 20.3 16.8 16a7.5 7.5 0 1 0-.8.8L20.3 21l.7-.7zM4 10.5a6.5 6.5 0 1 1 13 0a6.5 6.5 0 0 1-13 0z" />
              </svg>
              <span className="hidden lg:inline text-white/80">Search</span>
            </button>

            <nav className="mt-3 lg:mt-6 flex flex-col gap-1.5 lg:gap-2 text-[15px] font-medium">
              <button
                type="button"
                onClick={() => setActiveTab("discover")}
                className={`flex items-center justify-center lg:justify-start gap-0 lg:gap-3 rounded-xl px-2 lg:px-3 py-2 transition ${
                  activeTab === "discover"
                    ? "text-[#4A35C7]"
                    : "text-white/70 hover:bg-white/10 hover:text-white"
                }`}
                title="Discover"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                  <path d="M12 2 15.09 8.26 22 9.27l-5 4.87 1.18 6.86L12 17.77l-6.18 3.23L7 14.14l-5-4.87 6.91-1.01L12 2Z" />
                </svg>
                <span className="hidden lg:inline">Discover</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("following")}
                className={`flex items-center justify-center lg:justify-start gap-0 lg:gap-3 rounded-xl px-2 lg:px-3 py-2 transition ${
                  activeTab === "following"
                    ? "text-[#4A35C7]"
                    : "text-white/70 hover:bg-white/10 hover:text-white"
                }`}
                title="Following"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                  <path d="M12 12a5 5 0 1 0-5-5a5 5 0 0 0 5 5zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z" />
                </svg>
                <span className="hidden lg:inline">Following</span>
              </button>

              <Link
                href="/profile"
                className="flex items-center justify-center lg:justify-start gap-0 lg:gap-3 rounded-xl px-2 lg:px-3 py-2 text-white/70 transition hover:bg-white/10 hover:text-white"
                title="Profile"
              >
                <span className="relative h-9 w-9 lg:h-9 lg:w-9 rounded-full border border-white/25 bg-white/10 overflow-hidden flex items-center justify-center flex-shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={avatarUrl || DEFAULT_AVATAR_URL}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </span>
                <span className="hidden lg:inline">Profile</span>
              </Link>

              <Link
                href="/dashboard/analytics"
                className="flex items-center justify-center lg:justify-start gap-0 lg:gap-3 rounded-xl px-2 lg:px-3 py-2 text-white/70 transition hover:bg-white/10 hover:text-white"
                title="Analytics"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                  <path d="M4 13h3v8H4zm6-6h3v14h-3zm6-4h3v18h-3z" />
                </svg>
                <span className="hidden lg:inline">Analytics</span>
              </Link>

              <Link
                href="/dashboard/earnings"
                className="flex items-center justify-center lg:justify-start gap-0 lg:gap-3 rounded-xl px-2 lg:px-3 py-2 text-white/70 transition hover:bg-white/10 hover:text-white"
                title="Earnings"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
                  <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm1 15.87V19h-2v-1.08a4.4 4.4 0 0 1-2.64-1.22l1.23-1.52A3.7 3.7 0 0 0 12 16.1c1.04 0 1.7-.4 1.7-1.05 0-.62-.51-.93-1.87-1.29-2.02-.52-3.07-1.24-3.07-2.8 0-1.44.91-2.46 2.24-2.84V7h2v1.07a4.3 4.3 0 0 1 2.24.94l-1.08 1.57a3.45 3.45 0 0 0-2.08-.7c-.94 0-1.48.4-1.48.97 0 .66.59.9 2.02 1.28 2.04.54 2.92 1.34 2.92 2.81 0 1.48-.94 2.54-2.54 2.93Z" />
                </svg>
                <span className="hidden lg:inline">Earnings</span>
              </Link>

              <Link
                href="/library"
                className="flex items-center justify-center lg:justify-start gap-0 lg:gap-3 rounded-xl px-2 lg:px-3 py-2 text-white/70 transition hover:bg-white/10 hover:text-white"
                title="Library"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                  <path d="M4 4h7a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V4Zm9 0h7a2 2 0 0 1 2 2v14h-7V4Z" />
                </svg>
                <span className="hidden lg:inline">Library</span>
              </Link>

              <Link
                href="/dashboard/closers"
                className="flex items-center justify-center lg:justify-start gap-0 lg:gap-3 rounded-xl px-2 lg:px-3 py-2 text-white/70 transition hover:bg-white/10 hover:text-white"
                title="Bookings"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                  <path d="M6.62 10.79a15.53 15.53 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1-.24 11.36 11.36 0 0 0 3.58.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.58 1 1 0 0 1-.24 1Z" />
                </svg>
                <span className="hidden lg:inline">Bookings</span>
              </Link>
            </nav>

            <div className="mt-6 space-y-3">
              <StripeConnectBanner />
            </div>

            {/* Keep desktop actions in flow so a taller Connect banner or a
                shorter viewport cannot put Create post on top of Sign out. */}
            <button
              type="button"
              onClick={handleRequestCreatePost}
              className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-[#4A35C7] px-4 text-sm font-semibold text-white shadow-lg shadow-[#4A35C7]/30 hover:brightness-95"
            >
              <span className="text-lg leading-none">+</span>
              Create post
            </button>

            <div className="mt-4 flex justify-center lg:justify-start">
              <SidebarSignOutButton />
            </div>
          </div>
        </aside>

        {/* MAIN / FEED COLUMN - fixed height so feed scroll container can fill and scroll.
            100dvh (not h-screen=100vh) so the container matches the 100dvh snap
            sections when the mobile URL bar is visible. */}
        <div className="h-[100dvh] min-h-0 flex flex-col items-stretch pt-0 pb-14 lg:py-0 overflow-hidden">
          <div className="flex-1 min-h-0 w-full overflow-hidden">

            <FeedList key={feedRefreshKey} activeTab={activeTab} onChangeTab={setActiveTab} highlightPostId={highlightPostId} />
          </div>
        </div>
      </div>

      {/* MOBILE BOTTOM: signed-out visitors get a sticky join CTA in the slot
          the nav occupies; signed-in users get the TikTok-style nav. Nothing
          renders until the auth context settles — the session is seeded async,
          so branching on !userId alone would flash the signed-out CTA at
          every signed-in user on first paint. */}
      {authLoading ? null : !userId ? (
        <div className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-black/85 backdrop-blur supports-[padding:max(0px)]:pb-[max(env(safe-area-inset-bottom),0.5rem)]">
          <div className="flex h-[52px] items-center justify-between gap-3 px-4">
            <p className="min-w-0 truncate text-xs text-white/70">
              Follow creators and unlock their offers
            </p>
            <Link
              href="/auth"
              className="btn-icon-small flex-shrink-0 rounded-full bg-[#4A35C7] px-4 py-1.5 text-sm font-semibold text-white hover:brightness-95 transition"
            >
              Join CreatorNet
            </Link>
          </div>
        </div>
      ) : (
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-black/85 backdrop-blur supports-[padding:max(0px)]:pb-[max(env(safe-area-inset-bottom),0.5rem)]">
        <div className="grid grid-cols-5 h-[52px]">
          <button
            type="button"
            onClick={() => setActiveTab("discover")}
            className={`flex flex-col items-center justify-center gap-1 text-xs ${
              activeTab === "discover" ? "text-white" : "text-white/60"
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M12 2 15.09 8.26 22 9.27l-5 4.87 1.18 6.86L12 17.77l-6.18 3.23L7 14.14l-5-4.87 6.91-1.01L12 2Z" />
            </svg>
            <span>Discover</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("following")}
            className={`flex flex-col items-center justify-center gap-1 text-xs ${
              activeTab === "following" ? "text-white" : "text-white/60"
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M12 12a5 5 0 1 0-5-5a5 5 0 0 0 5 5zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z" />
            </svg>
            <span>Following</span>
          </button>

          <button
            type="button"
            onClick={handleRequestCreatePost}
            className="flex flex-col items-center justify-center gap-1 text-xs text-white disabled:opacity-60"
          >
            {/* Per Noah's reference: an outlined rounded square with a thin plus,
                not a filled purple pill. Same footprint as before so the tab bar
                does not shift. */}
            <span
              aria-hidden="true"
              className="inline-flex h-7 w-8 items-center justify-center rounded-[7px] border-[1.5px] border-white/90 bg-transparent text-white"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M12 6v12M6 12h12" />
              </svg>
            </span>
            <span>Create</span>
          </button>

          <Link
            href="/library"
            className="flex flex-col items-center justify-center gap-1 text-xs text-white/60"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M4 4h7a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V4Zm9 0h7a2 2 0 0 1 2 2v14h-7V4Z" />
            </svg>
            <span>Library</span>
          </Link>

          <Link
            href="/profile"
            className="flex flex-col items-center justify-center gap-1 text-xs text-white/60"
          >
            <span className="h-6 w-6 rounded-full border border-white/25 bg-white/10 overflow-hidden flex items-center justify-center">
              <img
                src={avatarUrl || DEFAULT_AVATAR_URL}
                alt=""
                className="h-full w-full object-cover"
              />
            </span>
            <span>Profile</span>
          </Link>
        </div>
      </nav>
      )}

      {/* SEARCH DRAWER */}
      <SearchDrawer open={isSearchOpen} onClose={() => setIsSearchOpen(false)} />

      {/* TABLET CREATE POST FAB — desktop uses the in-flow sidebar action. */}
      <button
        type="button"
        onClick={handleRequestCreatePost}
        className="
          hidden md:flex lg:hidden fixed left-5 bottom-5 z-40
          h-10 rounded-full bg-[#4A35C7] px-4 text-white text-sm font-semibold
          shadow-lg shadow-[#4A35C7]/30 hover:brightness-95 items-center gap-2
          disabled:opacity-60
        "
      >
        <span className="text-lg leading-none">+</span>
        Create post
      </button>

      {isComposerOpen && (
        <PostComposerModal
          onClose={() => setIsComposerOpen(false)}
          onPosted={() => setFeedRefreshKey((k) => k + 1)}
        />
      )}
    </section>
  );
}

export default function DashboardPage() {
  const [highlightPostId, setHighlightPostId] = useState<string | null>(null);

  return (
    <Suspense fallback={
      <section className="min-h-screen px-0 flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </section>
    }>
      <DashboardContent highlightPostId={highlightPostId} setHighlightPostId={setHighlightPostId} />
    </Suspense>
  );
}
