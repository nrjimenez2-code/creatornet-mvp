// app/dashboard/page.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import FeedList from "@/components/FeedList";
import PostComposerModal from "@/components/PostComposerModal";
import type { Tab } from "@/components/VideoCard";
import ContinueWatching from "@/components/ContinueWatching";

export default function DashboardPage() {
  const router = useRouter();
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("following");

  return (
    <section className="min-h-screen px-0">
      <div className="mx-auto grid grid-cols-[240px_1fr] gap-6 px-0 pr-6 md:pr-8 lg:pr-10">
        {/* SIDEBAR */}
        <aside className="hidden md:block sticky top-6 self-start">
          <div className="w-[240px] ml-0 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <nav className="space-y-2 text-sm">
              {/* Search */}
              <button
                type="button"
                className="flex items-center gap-2 w-full rounded-lg bg-gray-100 px-3 py-2 font-medium text-gray-900 text-left"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
                  <path d="M21 20.3 16.8 16a7.5 7.5 0 1 0-.8.8L20.3 21l.7-.7zM4 10.5a6.5 6.5 0 1 1 13 0a6.5 6.5 0 0 1-13 0z" />
                </svg>
                Search
              </button>

              {/* Discover */}
              <button
                type="button"
                onClick={() => setActiveTab("discover")}
                className={`w-full rounded-lg px-3 py-2 text-left transition ${
                  activeTab === "discover"
                    ? "bg-gray-100 font-medium text-gray-900"
                    : "text-gray-700 hover:bg-gray-50"
                }`}
              >
                Discover
              </button>

              {/* Following */}
              <button
                type="button"
                onClick={() => setActiveTab("following")}
                className={`w-full rounded-lg px-3 py-2 text-left transition ${
                  activeTab === "following"
                    ? "bg-gray-100 font-medium text-gray-900"
                    : "text-gray-700 hover:bg-gray-50"
                }`}
              >
                Following
              </button>

              {/* Profile */}
              <button
                type="button"
                onClick={() => router.push("/profile")}
                className="w-full rounded-lg px-3 py-2 text-left text-gray-700 hover:bg-gray-50 transition"
              >
                Profile
              </button>

              {/* Analytics */}
              <button
                type="button"
                onClick={() => router.push("/analytics")}
                className="w-full rounded-lg px-3 py-2 text-left text-gray-700 hover:bg-gray-50 transition"
              >
                Analytics
              </button>

              {/* Library */}
              <button
                type="button"
                onClick={() => router.push("/library")}
                className="w-full rounded-lg px-3 py-2 text-left text-gray-700 hover:bg-gray-50 transition"
              >
                Library
              </button>

              {/* Closers */}
              <button
                type="button"
                onClick={() => router.push("/closers")}
                className="w-full rounded-lg px-3 py-2 text-left text-gray-700 hover:bg-gray-50 transition"
              >
                Closers
              </button>
            </nav>
          </div>
        </aside>

        {/* MAIN / FEED COLUMN */}
        <div className="min-h-[calc(100vh-40px)] flex flex-col items-stretch justify-start py-2">
          <div className="w-full max-w-[1280px]">
            {/* Continue Watching rail */}
            <ContinueWatching />

            {/* Feed */}
            <div className="mt-6">
              <FeedList activeTab={activeTab} onChangeTab={setActiveTab} />
            </div>
          </div>
        </div>
      </div>

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
