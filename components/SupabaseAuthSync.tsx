"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabaseClient";
import { syncBrowserSession } from "@/lib/browserSession";

export default function SupabaseAuthSync() {
  useEffect(() => {
    const supabase = createClient();

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      // Never hold Supabase's auth lock while doing asynchronous work.
      void syncBrowserSession(session, event).catch(() => {
        console.warn("Session cookie synchronization failed; protected navigation will retry.");
      });
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  return null;
}
