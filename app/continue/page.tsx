"use client";

import ContinueWatching from "@/components/ContinueWatching";

export default function ContinuePage() {
  return (
    <main className="min-h-screen bg-[#0b0b0b] text-white">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold">Your Library</h1>
        <ContinueWatching />
      </div>
    </main>
  );
}
