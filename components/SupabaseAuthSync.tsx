"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabaseClient";

export default function SupabaseAuthSync() {
  useEffect(() => {
    const supabase = createClient();

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, session) => {
      try {
        // Always include cookies so the server can set HttpOnly cookies back.
        await fetch("/auth/callback", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event,
            access_token: session?.access_token ?? null,
            refresh_token: session?.refresh_token ?? null,
          }),
        });
      } catch {
        // swallow—this will be retried on next state change anyway
      }
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  return null;
}
