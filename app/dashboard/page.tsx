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
import { createClient } from "@/lib/supabaseClient";

type Tab = "following" | "discover";

function DashboardContent({ highlightPostId, setHighlightPostId }: { highlightPostId: string | null; setHighlightPostId: (id: string | null) => void }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createClient(), []);
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("discover");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

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
          const { data } = await supabase.auth.getUser();
          const user = data?.user;
          if (!user || cancelled) return;
          const { data: profile } = await supabase
            .from("profiles")
            .select("avatar_url")
            .eq("id", user.id)
            .maybeSingle();
          if (!cancelled) {
            setAvatarUrl(
              (profile?.avatar_url as string | null) ||
                (user.user_metadata?.avatar_url as string | null) ||
                null
            );
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
  }, [supabase]);
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

      <div className="mx-auto grid grid-cols-[52px_1fr] lg:grid-cols-[240px_1fr] gap-2 lg:gap-6 px-0 pr-2 lg:pr-10">
        {/* SIDEBAR - Always visible, icon-only on smaller screens, full on large screens (TikTok style) */}
        <aside className="sticky top-0 lg:top-6 self-start">

          {/*
          <div className="w-[240px] ml-0 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <nav className="space-y-2 text-sm">
              ... existing sidebar ...
            </nav>
          </div>
          */}
          <div className="w-[52px] lg:w-[240px] rounded-3xl border border-white/10 bg-black/70 px-1 lg:px-6 pt-4 pb-3 lg:pb-6 text-white shadow-[0_20px_50px_rgba(0,0,0,0.35)] backdrop-blur transition-all duration-300">
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
              <svg viewBox="0 0 24 24" className="h-5 w-5 lg:h-4 lg:w-4" fill="currentColor">
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
                    ? "bg-white/15 text-white"
                    : "text-white/70 hover:bg-white/10 hover:text-white"
                }`}
                title="Discover"
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6 lg:h-5 lg:w-5" fill="currentColor">
                  <path d="M12 2 15.09 8.26 22 9.27l-5 4.87 1.18 6.86L12 17.77l-6.18 3.23L7 14.14l-5-4.87 6.91-1.01L12 2Z" />
                </svg>
                <span className="hidden lg:inline">Discover</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("following")}
                className={`flex items-center justify-center lg:justify-start gap-0 lg:gap-3 rounded-xl px-2 lg:px-3 py-2 transition ${
                  activeTab === "following"
                    ? "bg-white/15 text-white"
                    : "text-white/70 hover:bg-white/10 hover:text-white"
                }`}
                title="Following"
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6 lg:h-5 lg:w-5" fill="currentColor">
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
                  {avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={avatarUrl}
                      alt="Profile avatar"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                      <path d="M12 12a5 5 0 1 0-5-5a5 5 0 0 0 5 5zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z" />
                    </svg>
                  )}
                </span>
                <span className="hidden lg:inline">Profile</span>
              </Link>

              <Link
                href="/dashboard/analytics"
                className="flex items-center justify-center lg:justify-start gap-0 lg:gap-3 rounded-xl px-2 lg:px-3 py-2 text-white/70 transition hover:bg-white/10 hover:text-white"
                title="Analytics"
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6 lg:h-5 lg:w-5" fill="currentColor">
                  <path d="M4 13h3v8H4zm6-6h3v14h-3zm6-4h3v18h-3z" />
                </svg>
                <span className="hidden lg:inline">Analytics</span>
              </Link>

              <Link
                href="/library"
                className="flex items-center justify-center lg:justify-start gap-0 lg:gap-3 rounded-xl px-2 lg:px-3 py-2 text-white/70 transition hover:bg-white/10 hover:text-white"
                title="Library"
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6 lg:h-5 lg:w-5" fill="currentColor">
                  <path d="M4 4h7a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V4Zm9 0h7a2 2 0 0 1 2 2v14h-7V4Z" />
                </svg>
                <span className="hidden lg:inline">Library</span>
              </Link>

              <Link
                href="/dashboard/closers"
                className="flex items-center justify-center lg:justify-start gap-0 lg:gap-3 rounded-xl px-2 lg:px-3 py-2 text-white/70 transition hover:bg-white/10 hover:text-white"
                title="Bookings"
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6 lg:h-5 lg:w-5" fill="currentColor">
                  <path d="M6.62 10.79a15.53 15.53 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1-.24 11.36 11.36 0 0 0 3.58.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.58 1 1 0 0 1-.24 1Z" />
                </svg>
                <span className="hidden lg:inline">Bookings</span>
              </Link>
            </nav>

            <div className="mt-6 flex justify-center lg:justify-start">
              <SidebarSignOutButton />
            </div>
          </div>
        </aside>

        {/* MAIN / FEED COLUMN */}
        <div className="min-h-[calc(100vh-40px)] flex flex-col items-center justify-start pt-0 pb-3 lg:py-3">

          

            {/* <ContinueWatching /> */}
            {/* Feed list now starts at top */}
            <FeedList activeTab={activeTab} onChangeTab={setActiveTab} highlightPostId={highlightPostId} />
          </div>
        </div>
      </div>

      {/* SEARCH DRAWER */}
      <SearchDrawer open={isSearchOpen} onClose={() => setIsSearchOpen(false)} />

      {/* CREATE POST FAB */}
      <button
        onClick={() => setIsComposerOpen(true)}
        className="
          hidden md:flex fixed left-5 bottom-5 z-40
          h-10 rounded-full bg-[#4A35C7] px-4 text-white text-sm font-semibold
          shadow-lg shadow-[#4A35C7]/30 hover:brightness-95 items-center gap-2
        "
      >
        <span className="text-lg leading-none">+</span>
        Create post
      </button>

      {isComposerOpen && (
        <PostComposerModal onClose={() => setIsComposerOpen(false)} />
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
