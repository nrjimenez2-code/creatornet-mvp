"use client";

import {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabaseClient";
import posthog from "posthog-js";

type UserContextValue = {
  userId: string | null;
  session: Session | null;
  loading: boolean;
};

const UserContext = createContext<UserContextValue | undefined>(undefined);

function useProvideUser(): UserContextValue {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let authEvents = 0;

    // Seed once from persisted storage; the SDK may refresh an expired session.
    // A newer auth event takes precedence over this asynchronous seed.
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled || authEvents > 0) return;
        setSession(data.session);
        setLoading(false);
        const id = data.session?.user?.id;
        if (id) {
          try {
            posthog.identify(id);
          } catch {
            /* analytics must never break auth */
          }
        }
      })
      .catch((err: unknown) => {
        console.error("Error reading persisted session:", err);
        if (!cancelled && authEvents === 0) {
          setSession(null);
          setLoading(false);
        }
      });

    // Handles SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, USER_UPDATED (and
    // INITIAL_SESSION). No redirects here — pages decide via useRequireUser.
    const { data: sub } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        if (cancelled) return;
        // INITIAL_SESSION can also finish after a refresh was superseded.
        if (_event === "INITIAL_SESSION" && authEvents > 0) return;
        authEvents += 1;
        setSession(nextSession);
        setLoading(false);
        const id = nextSession?.user?.id ?? null;
        try {
          if (id) {
            posthog.identify(id);
          } else {
            posthog.reset();
          }
        } catch {
          /* analytics must never break auth */
        }
      },
    );

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return useMemo(
    () => ({
      userId: session?.user?.id ?? null,
      session,
      loading,
    }),
    [session, loading],
  );
}

export function UserProvider({ children }: { children: ReactNode }) {
  const value = useProvideUser();
  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}

/**
 * Single client-side auth source. Reads the session held by the provider —
 * client components must use this instead of calling supabase.auth directly.
 */
export function useUser(): UserContextValue {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error("useUser must be used within a UserProvider");
  }
  return context;
}

/**
 * For pages that require a signed-in user: redirects (replace) to
 * `redirectTo` once loading settles with no user.
 */
export function useRequireUser(
  redirectTo = "/auth",
): { userId: string | null; loading: boolean } {
  const { userId, loading } = useUser();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !userId) {
      router.replace(redirectTo);
    }
  }, [loading, userId, redirectTo, router]);

  return { userId, loading };
}
