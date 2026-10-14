"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import FeedList from "@/components/FeedList";
import { DashboardSkeleton } from "@/components/loading/Skeletons";
import { useUser } from "@/lib/useUser";

type Tab = "following" | "discover";

function DashboardContent({ highlightPostId, setHighlightPostId }: { highlightPostId: string | null; setHighlightPostId: (id: string | null) => void }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { userId, loading: authLoading } = useUser();
  const activeTab: Tab = searchParams?.get("tab") === "following" ? "following" : "discover";
  // Bumped after a successful post: remounts FeedList so the new post shows up.
  const [feedRefreshKey, setFeedRefreshKey] = useState(0);
  const [openTipPostId, setOpenTipPostId] = useState<string | null>(null);
  const [resumeTipId, setResumeTipId] = useState<string | null>(null);

  function setActiveTab(tab: Tab) {
    if (tab === activeTab) return;
    router.push(tab === "following" ? "/dashboard?tab=following" : "/dashboard", { scroll: false });
  }

  useEffect(() => {
    const refreshFeed = () => setFeedRefreshKey((key) => key + 1);
    window.addEventListener("creatornet:post-created", refreshFeed);
    return () => window.removeEventListener("creatornet:post-created", refreshFeed);
  }, []);


  // Check for postId in URL to highlight specific video
  useEffect(() => {
    const postId = searchParams?.get("postId");
    if (postId) {
      setHighlightPostId(postId);
      const returnedTipId = searchParams?.get("tipId");
      if (searchParams?.get("tip") === "1" || returnedTipId) {
        setOpenTipPostId(postId);
        setResumeTipId(returnedTipId);
      }
      // Remove postId from URL after setting it
      const url = new URL(window.location.href);
      url.searchParams.delete("postId");
      url.searchParams.delete("tip");
      url.searchParams.delete("tipId");
      router.replace(url.pathname + url.search, { scroll: false });
    }
  }, [searchParams, router, setHighlightPostId]);

  // useEffect(() => {
  //   router.prefetch("/dashboard/analytics");
  //   router.prefetch("/library");               // top-level
  //   router.prefetch("/dashboard/closers");     // new Bookings page
  //   router.prefetch("/profile");
  //   router.prefetch("/search");                // search results page
  // }, [router]);

  return (
    <section className="dashboard-feed-shell min-h-screen px-0">
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

      <div className="mx-auto w-full">
        {/* MAIN / FEED COLUMN - fixed height so feed scroll container can fill and scroll.
            100dvh (not h-screen=100vh) so the container matches the 100dvh snap
            sections when the mobile URL bar is visible. */}
        <div className="dashboard-feed-column h-[100dvh] min-h-0 flex flex-col items-stretch pt-0 pb-14 lg:py-0 overflow-hidden">
          <div className="flex-1 min-h-0 w-full overflow-hidden">

            <FeedList key={`${activeTab}:${feedRefreshKey}`} activeTab={activeTab} onChangeTab={setActiveTab} highlightPostId={highlightPostId} openTipPostId={openTipPostId} resumeTipId={resumeTipId} onTipReturnClosed={() => {
              setOpenTipPostId(null);
              setResumeTipId(null);
            }} />
          </div>
        </div>
      </div>

      {/* Signed-out visitors keep the join CTA. The shared signed-in bar lives
          in the root layout; wait for auth to settle before showing this CTA. */}
      {authLoading ? null : !userId ? (
        <div className="dashboard-feed-nav lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-black/85 backdrop-blur supports-[padding:max(0px)]:pb-[max(env(safe-area-inset-bottom),0.5rem)]">
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
      ) : null}

    </section>
  );
}

export default function DashboardPage() {
  const [highlightPostId, setHighlightPostId] = useState<string | null>(null);

  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent highlightPostId={highlightPostId} setHighlightPostId={setHighlightPostId} />
    </Suspense>
  );
}
