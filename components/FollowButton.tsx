"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabaseClient";

interface FollowButtonProps {
  creatorId: string;
  initiallyFollowing: boolean;
}

export default function FollowButton({ creatorId, initiallyFollowing }: FollowButtonProps) {
  const supabase = createClient();
  const [isFollowing, setIsFollowing] = useState(initiallyFollowing);
  const [loading, setLoading] = useState(false);

  async function toggleFollow() {
    if (!creatorId || loading) return;
    setLoading(true);

    const { data: auth } = await supabase.auth.getUser();
    const viewerId = auth?.user?.id;
    if (!viewerId) {
      alert("Please sign in to follow creators.");
      setLoading(false);
      return;
    }

    if (isFollowing) {
      const { error } = await supabase
        .from("follows")
        .delete()
        .eq("follower_id", viewerId)
        .eq("following_id", creatorId);
      if (!error) setIsFollowing(false);
    } else {
      const { error } = await supabase
        .from("follows")
        .insert({ follower_id: viewerId, following_id: creatorId });
      if (!error) setIsFollowing(true);
    }

    setLoading(false);
  }

  return (
    <button
      type="button"
      onClick={toggleFollow}
      disabled={loading}
      className={`rounded-full px-4 py-2 text-sm font-semibold transition border disabled:opacity-60 ${
        isFollowing
          ? "bg-white text-black border-white/60 hover:bg-white/80"
          : "bg-white text-black border-white/40 hover:bg-white/85"
      }`}
    >
      {loading ? "..." : isFollowing ? "Following" : "Follow"}
    </button>
  );
}
