"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import BackButton from "./BackButton";
import { signOutThisDevice } from "@/lib/browserSession";
import { createBrowserClient } from "@/lib/supabaseBrowser";

const supabase = createBrowserClient();

interface ProfileMobileHeaderProps {
  userId: string;
}

export default function ProfileMobileHeader({ userId }: ProfileMobileHeaderProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  const handleShare = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy profile link", err);
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    if (signingOut) return;
    if (typeof window !== "undefined") {
      const confirmed = window.confirm("Are you sure you want to sign out?");
      if (!confirmed) return;
    }
    setSigningOut(true);
    try {
      await signOutThisDevice(supabase);
      if (typeof window !== "undefined") {
        window.location.href = "/auth";
      }
    } catch (err) {
      console.error("Failed to sign out:", err);
      setSigningOut(false);
    }
  }, [signingOut]);

  return (
    <>
      <div className="flex items-center justify-between">
        <BackButton hrefOverride="/dashboard" />
        <div className="ml-4 flex items-center gap-2">
          <Link
            href={`/creators/${userId}/reviews`}
            className="inline-flex items-center justify-center rounded-md border border-white/20 px-3 py-1 text-xs font-semibold leading-none text-white hover:bg-white/10 transition"
          >
            Review
          </Link>
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-md bg-transparent text-white hover:bg-white/10 transition"
            aria-label="Open profile menu"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <button
            type="button"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close profile menu"
          />
          <div
            className="relative h-full w-1/2 max-w-xs bg-[#05060A] border-l border-white/10 shadow-xl flex flex-col px-4 py-5"
            aria-modal="true"
            role="dialog"
          >
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-semibold text-white">
                Profile menu
              </span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="h-8 w-8 flex items-center justify-center rounded-full hover:bg-white/10 text-white transition"
                aria-label="Close"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path
                    d="M6 6l12 12M18 6L6 18"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>

            <nav className="flex-1 flex flex-col gap-1">
              <Link
                href="/profile/edit"
                className="w-full px-3 py-2 rounded-lg text-sm text-white hover:bg-white/10 transition"
                onClick={() => setDrawerOpen(false)}
              >
                Edit profile
              </Link>
              <button
                type="button"
                onClick={handleShare}
                className="w-full text-left px-3 py-2 rounded-lg text-sm text-white hover:bg-white/10 transition"
              >
                {shareCopied ? "Profile link copied" : "Share"}
              </button>
              <Link
                href="/dashboard/analytics"
                className="w-full px-3 py-2 rounded-lg text-sm text-white hover:bg-white/10 transition"
                onClick={() => setDrawerOpen(false)}
              >
                Analytics
              </Link>
              <Link
                href="/dashboard/earnings"
                className="w-full px-3 py-2 rounded-lg text-sm text-white hover:bg-white/10 transition"
                onClick={() => setDrawerOpen(false)}
              >
                Earnings
              </Link>
              <Link
                href="/dashboard/closers"
                className="w-full px-3 py-2 rounded-lg text-sm text-white hover:bg-white/10 transition"
                onClick={() => setDrawerOpen(false)}
              >
                Bookings
              </Link>
              <Link
                href="/memberships"
                className="w-full px-3 py-2 rounded-lg text-sm text-white hover:bg-white/10 transition"
                onClick={() => setDrawerOpen(false)}
              >
                Mentorships
              </Link>
            </nav>

            <div className="mt-4 pt-3 border-t border-white/10">
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                className="w-full text-left px-3 py-2 rounded-lg text-sm font-semibold text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition"
              >
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

