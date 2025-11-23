"use client";

import { useState, useEffect } from "react";
import { createBrowserClient } from "@/lib/supabaseBrowser";

type FollowButtonProps = {
  creatorId: string;
  initialFollowing: boolean;
};

export default function FollowButton({ creatorId, initialFollowing }: FollowButtonProps) {
  const [following, setFollowing] = useState(initialFollowing);
  const [loading, setLoading] = useState(false);
  const supabase = createBrowserClient();

  // Sync with initialFollowing prop changes - this ensures the button reflects the actual database state
  useEffect(() => {
    setFollowing(initialFollowing);
  }, [initialFollowing]);
  
  // Also verify the follow status on mount to ensure accuracy
  useEffect(() => {
    async function verifyFollowStatus() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data } = await supabase
        .from("follows")
        .select("follower_id, following_id")
        .eq("follower_id", user.id)
        .eq("following_id", creatorId)
        .maybeSingle();

      // Update state based on actual database state
      setFollowing(!!data);
    }
    verifyFollowStatus();
  }, [creatorId, supabase]);

  async function handleFollow() {
    if (loading) return;
    
    // Store previous state for potential revert
    const previousFollowingState = following;
    const newFollowingState = !following;
    
    // Optimistic update - update UI immediately
    setFollowing(newFollowingState);
    setLoading(true);

    try {
      // Use current origin to ensure we hit localhost or correct domain
      const apiUrl = typeof window !== "undefined" 
        ? `${window.location.origin}/api/follow`
        : "/api/follow";
      
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          creator_id: creatorId,
          action: previousFollowingState ? "unfollow" : "follow",
        }),
      });

      const data = await res.json();
      if (res.ok && data.success !== undefined) {
        // Update with server response
        setFollowing(data.following);
    } else {
        // Revert on error
        setFollowing(previousFollowingState);
        console.error("Follow error:", data.error || "Unknown error");
        alert(data.error || "Failed to update follow status. Please try again.");
      }
    } catch (err) {
      // Revert on error
      setFollowing(previousFollowingState);
      console.error("Failed to update follow status:", err);
      alert("Failed to update follow status. Please try again.");
    } finally {
    setLoading(false);
    }
  }

  return (
    <button
      onClick={handleFollow}
      disabled={loading}
      className="rounded-md bg-[#4A35C7] px-3 py-1.5 text-sm font-semibold text-white hover:brightness-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {loading ? "..." : following ? "Following" : "Follow"}
    </button>
  );
}
