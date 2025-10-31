"use client";

import { useState } from "react";
import FeedList from "@/components/FeedList";
import PostComposer from "@/components/PostComposer";

export default function DashboardPage() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <main className="min-h-screen bg-black">
      <div className="max-w-md mx-auto w-full px-4 pt-4">
        <PostComposer onPosted={() => setRefreshKey((k) => k + 1)} />
      </div>
      <FeedList refreshKey={refreshKey} />
    </main>
  );
}
