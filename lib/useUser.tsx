"use client";

import {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createClient } from "@/lib/supabaseClient";

type UserContextValue = {
  userId: string | null;
  loading: boolean;
};

const UserContext = createContext<UserContextValue | undefined>(undefined);

// Global cache for user ID to avoid repeated getUser() calls
let cachedUserId: string | null = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

function useProvideUser(): UserContextValue {
  const [userId, setUserId] = useState<string | null>(cachedUserId);
  const [loading, setLoading] = useState(!cachedUserId);
  const supabaseRef = useRef(createClient());
  const supabase = supabaseRef.current;

  useEffect(() => {
    let cancelled = false;

    async function loadUser() {
      const now = Date.now();
      if (cachedUserId && now - cacheTimestamp < CACHE_DURATION) {
        setUserId(cachedUserId);
        setLoading(false);
        return;
      }

      setLoading(true);

      try {
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (cancelled) return;

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

        if (!sessionError || sessionError.status !== 429) {
          const {
            data: { user },
            error: userError,
          } = await supabase.auth.getUser();

          if (cancelled) return;

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
        } else {
          cachedUserId = null;
          setUserId(null);
        }
      } catch (err: any) {
        console.error("Error getting user:", err);
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
    }

    loadUser();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUserId = session?.user?.id ?? null;
      cachedUserId = nextUserId;
      cacheTimestamp = nextUserId ? Date.now() : 0;
      setUserId(nextUserId);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  return useMemo(() => ({ userId, loading }), [userId, loading]);
}

export function UserProvider({ children }: { children: ReactNode }) {
  const value = useProvideUser();
  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}

/**
 * Hook to get the current user ID with caching to prevent rate limits
 */
export function useUser() {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error("useUser must be used within a UserProvider");
  }
  return context;
}

/**
 * Clear the user cache (useful after sign out)
 */
export function clearUserCache() {
  cachedUserId = null;
  cacheTimestamp = 0;
}


