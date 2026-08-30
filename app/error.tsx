"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// Segment-level error boundary: keeps failures inside the page area and offers
// a retry, instead of escalating every server throw to global-error (which
// replaces the entire shell with Next's unbranded error screen).
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="min-h-svh bg-black text-gray-100 flex flex-col items-center justify-center gap-6 px-6 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/creatornet-mark.png" alt="CreatorNet" className="h-10 w-auto" />
      <div>
        <h1 className="text-3xl font-bold text-white">Something went wrong</h1>
        <p className="mt-3 max-w-md text-gray-400">
          That didn&apos;t load. It&apos;s been reported — try again in a moment.
        </p>
      </div>
      <button
        type="button"
        onClick={reset}
        className="rounded-full bg-[#655BFF] px-6 py-2.5 font-semibold text-white hover:bg-[#5148e6] transition-colors"
      >
        Try again
      </button>
    </main>
  );
}
