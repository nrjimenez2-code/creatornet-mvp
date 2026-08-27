"use client";

import posthog from "posthog-js";
import { useEffect } from "react";
import { shouldSendEvent } from "@/lib/posthogSampling";

export default function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
    if (!key || posthog.__loaded) return;
    posthog.init(key, {
      api_host: host ?? "https://us.i.posthog.com",
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: false,
      // Sample the highest-volume events (pageview/pageleave/video_impression)
      // client-side; returning null drops the event before it is sent.
      before_send: (event) => {
        if (!event) return null;
        return shouldSendEvent(event.event) ? event : null;
      },
    });
  }, []);

  return <>{children}</>;
}
