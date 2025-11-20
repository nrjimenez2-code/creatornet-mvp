"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import FeedList from "@/components/FeedList";
import PostComposerModal from "@/components/PostComposerModal";
import type { Tab } from "@/components/VideoCard";
// import ContinueWatching from "@/components/ContinueWatching";
import SearchDrawer from "@/components/SearchDrawer";
// import BackButton from "@/components/BackButton";
import SidebarSignOutButton from "@/components/SidebarSignOutButton";
import { createClient } from "@/lib/supabaseClient";

export default function DashboardPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("discover");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  // Prefetch heavy routes so clicks feel instant
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const user = data?.user;
      if (!user) return;
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
    })();
    return () => {
      cancelled = true;
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
      <div className="mx-auto grid grid-cols-[240px_1fr] gap-6 px-0 pr-6 md:pr-8 lg:pr-10">
        {/* SIDEBAR */}
        <aside className="hidden md:block sticky top-6 self-start">
          {/*
          <div className="w-[240px] ml-0 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <nav className="space-y-2 text-sm">
              ... existing sidebar ...
            </nav>
          </div>
          */}
          <div className="w-[260px] rounded-3xl border border-white/10 bg-black/70 px-6 pt-4 pb-6 text-white shadow-[0_20px_50px_rgba(0,0,0,0.35)] backdrop-blur">
            <div className="flex items-center pb-4 border-b border-white/10">
              <img
                src="/creatornet-mark.png"
                alt="CreatorNet mark"
                className="h-20 w-auto"
              />
            </div>

            <button
              type="button"
              onClick={() => setIsSearchOpen(true)}
              className="relative -mt-4 flex w-full items-center gap-3 rounded-full border border-white/25 bg-black px-4 py-2 text-sm text-white/80 shadow-[0_10px_30px_rgba(0,0,0,0.45)] transition hover:bg-black/80"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                <path d="M21 20.3 16.8 16a7.5 7.5 0 1 0-.8.8L20.3 21l.7-.7zM4 10.5a6.5 6.5 0 1 1 13 0a6.5 6.5 0 0 1-13 0z" />
              </svg>
              <span className="text-white/80">Search</span>
            </button>

            <nav className="mt-6 flex flex-col gap-2 text-[15px] font-medium">
              <button
                type="button"
                onClick={() => setActiveTab("discover")}
                className={`flex items-center gap-3 rounded-xl px-3 py-2 transition ${
                  activeTab === "discover"
                    ? "bg-white/15 text-white"
                    : "text-white/70 hover:bg-white/10 hover:text-white"
                }`}
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                  <path d="M12 2 15.09 8.26 22 9.27l-5 4.87 1.18 6.86L12 17.77l-6.18 3.23L7 14.14l-5-4.87 6.91-1.01L12 2Z" />
                </svg>
                Discover
              </button>

              <button
                type="button"
                onClick={() => setActiveTab("following")}
                className={`flex items-center gap-3 rounded-xl px-3 py-2 transition ${
                  activeTab === "following"
                    ? "bg-white/15 text-white"
                    : "text-white/70 hover:bg-white/10 hover:text-white"
                }`}
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                  <path d="M12 12a5 5 0 1 0-5-5a5 5 0 0 0 5 5zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z" />
                </svg>
                Following
              </button>

              <Link
                href="/profile"
                className="flex items-center gap-3 rounded-xl px-3 py-2 text-white/70 transition hover:bg-white/10 hover:text-white"
              >
                <span className="relative h-9 w-9 rounded-full border border-white/25 bg-white/10 overflow-hidden flex items-center justify-center">
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
                Profile
              </Link>

              <Link
                href="/dashboard/analytics"
                className="flex items-center gap-3 rounded-xl px-3 py-2 text-white/70 transition hover:bg-white/10 hover:text-white"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                  <path d="M4 13h3v8H4zm6-6h3v14h-3zm6-4h3v18h-3z" />
                </svg>
                Analytics
              </Link>

              <Link
                href="/library"
                className="flex items-center gap-3 rounded-xl px-3 py-2 text-white/70 transition hover:bg-white/10 hover:text-white"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                  <path d="M4 4h7a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V4Zm9 0h7a2 2 0 0 1 2 2v14h-7V4Z" />
                </svg>
                Library
              </Link>

              <Link
                href="/dashboard/closers"
                className="flex items-center gap-3 rounded-xl px-3 py-2 text-white/70 transition hover:bg-white/10 hover:text-white"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                  <path d="M6.62 10.79a15.53 15.53 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1-.24 11.36 11.36 0 0 0 3.58.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.58 1 1 0 0 1-.24 1Z" />
                </svg>
                Bookings
              </Link>
            </nav>

            <div className="mt-6">
              <SidebarSignOutButton />
            </div>
          </div>
        </aside>

        {/* MAIN / FEED COLUMN */}
        <div className="min-h-[calc(100vh-40px)] flex flex-col items-stretch justify-start py-2">
          <div className="w-full max-w-[1280px]">
            {/* <ContinueWatching /> */}
            {/* Feed list now starts at top */}
            <FeedList activeTab={activeTab} onChangeTab={setActiveTab} />
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
          h-10 rounded-full bg-[#7F5CE6] px-4 text-white text-sm font-semibold
          shadow-lg shadow-[#7F5CE6]/30 hover:brightness-95 items-center gap-2
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
