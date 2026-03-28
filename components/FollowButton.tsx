"use client";

import { useState, useEffect } from "react";
import { createBrowserClient } from "@/lib/supabaseBrowser";
import { trackEvent } from "@/lib/posthog";

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
  // Retry multiple times to handle database replication lag
  useEffect(() => {
    let cancelled = false;
    let retryCount = 0;
    const maxRetries = 3;

    async function verifyFollowStatus() {
      if (cancelled) return;

      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) return;

      const { data } = await supabase
        .from("follows")
        .select("follower_id, following_id")
        .eq("follower_id", user.id)
        .eq("following_id", creatorId)
        .maybeSingle();

      if (cancelled) return;

      const dbFollowStatus = !!data;
      
      // Update state based on actual database state
      setFollowing(dbFollowStatus);

      // If there's a mismatch with initialFollowing and we haven't exceeded retries, try again
      if (dbFollowStatus !== initialFollowing && retryCount < maxRetries) {
        retryCount++;
        setTimeout(() => verifyFollowStatus(), 500 * retryCount); // Exponential backoff: 500ms, 1s, 1.5s
      }
    }

    verifyFollowStatus();

    return () => {
      cancelled = true;
    };
  }, [creatorId, supabase, initialFollowing]);

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
        if (data.following) {
          trackEvent("followed_creator", { creator_id: creatorId });
        }
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
