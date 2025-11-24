"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabaseClient";

// Global cache for user ID to avoid repeated getUser() calls
let cachedUserId: string | null = null;
let cacheTimestamp: number = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Hook to get the current user ID with caching to prevent rate limits
 * Uses getSession() first (faster, less rate-limited) then falls back to getUser()
 */
export function useUser() {
  const [userId, setUserId] = useState<string | null>(cachedUserId);
  const [loading, setLoading] = useState(!cachedUserId);
  const supabaseRef = useRef(createClient());
  const supabase = supabaseRef.current;

  useEffect(() => {
    // Use cached value if still valid
    const now = Date.now();
    if (cachedUserId && (now - cacheTimestamp) < CACHE_DURATION) {
      setUserId(cachedUserId);
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        // Try getSession() first - it's faster and less rate-limited
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        
        if (cancelled) return;

        // If rate limited on getSession, use cached value if available
        if (sessionError && sessionError.status === 429) {
          console.warn("Rate limited on getSession(), using cached user ID if available");
          if (cachedUserId) {
            setUserId(cachedUserId);
            setLoading(false);
            return;
          }
        }

        if (session?.user?.id) {
          cachedUserId = session.user.id;
          cacheTimestamp = Date.now();
          setUserId(session.user.id);
          setLoading(false);
          return;
        }

        // Fallback to getUser() only if session doesn't have user
        // But skip if we just got rate limited
        if (!sessionError || sessionError.status !== 429) {
          const { data: { user }, error: userError } = await supabase.auth.getUser();
          
          if (cancelled) return;

          // If rate limited on getUser(), use cached value if available
          if (userError && userError.status === 429) {
            console.warn("Rate limited on getUser(), using cached user ID if available");
            if (cachedUserId) {
              setUserId(cachedUserId);
              setLoading(false);
              return;
            }
          }

          if (user?.id) {
            cachedUserId = user.id;
            cacheTimestamp = Date.now();
            setUserId(user.id);
          } else {
            cachedUserId = null;
            setUserId(null);
          }
        } else if (cachedUserId) {
          // Use cached value if we got rate limited
          setUserId(cachedUserId);
        } else {
          cachedUserId = null;
          setUserId(null);
        }
      } catch (err: any) {
        console.error("Error getting user:", err);
        // If rate limited, try to use cached value
        if (err?.status === 429 && cachedUserId) {
          console.warn("Rate limited, using cached user ID");
          setUserId(cachedUserId);
        } else if (!cancelled) {
          cachedUserId = null;
          setUserId(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase]);

  return { userId, loading };
}

/**
 * Clear the user cache (useful after sign out)
 */
export function clearUserCache() {
  cachedUserId = null;
  cacheTimestamp = 0;
}

