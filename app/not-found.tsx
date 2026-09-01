import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main className="min-h-svh bg-black text-gray-100 flex flex-col items-center justify-center gap-6 px-6 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/creatornet-mark.png" alt="CreatorNet" className="h-10 w-auto" />
      <div>
        <p className="text-sm font-semibold tracking-widest text-[#655BFF]">404</p>
        <h1 className="mt-2 text-3xl font-bold text-white">This page doesn&apos;t exist</h1>
        <p className="mt-3 max-w-md text-gray-400">
          The link may be broken, or the page may have been removed.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/dashboard"
          className="rounded-full bg-[#655BFF] px-6 py-2.5 font-semibold text-white hover:bg-[#5148e6] transition-colors"
        >
          Browse the feed
        </Link>
        <Link
          href="/search"
          className="rounded-full border border-gray-700 px-6 py-2.5 font-semibold text-gray-200 hover:bg-gray-900 transition-colors"
        >
          Search
        </Link>
      </div>
    </main>
  );
}
