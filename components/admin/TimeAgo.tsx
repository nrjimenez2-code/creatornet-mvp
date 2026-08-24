"use client";

import { useSyncExternalStore } from "react";
import { formatDate, timeAgo } from "@/lib/admin/format";

const emptySubscribe = () => () => {};

/**
 * Hydration-safe relative timestamp.
 *
 * `timeAgo()` depends on Date.now(), which differs between the build-time
 * prerender and the client, so rendering it directly in a prerendered page
 * causes a hydration mismatch. The static HTML shows the absolute date; once
 * mounted the client swaps in the live relative label (and `title` keeps the
 * absolute date on hover).
 */
export function TimeAgo({ iso }: { iso: string }) {
  const isMounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  return <span title={formatDate(iso)}>{isMounted ? timeAgo(iso) : formatDate(iso)}</span>;
}
