"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import posthog from "posthog-js";

const STORAGE_KEY = "cn-cookie-choice"; // "accepted" | "declined"
const SSR_SENTINEL = "ssr";

function readChoice(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode) — treat as already answered so the
    // banner doesn't reappear on every render with nowhere to persist.
    return "accepted";
  }
}

const emptySubscribe = () => () => {};

function saveChoice(choice: "accepted" | "declined") {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Nothing to do — the banner just reappears next visit.
  }
}

// US notice-and-opt-out posture: analytics runs by default, "Decline analytics"
// genuinely opts the browser out via PostHog's own persisted opt-out. Auth
// cookies are strictly necessary and not gated. If CreatorNet later targets
// EU/UK traffic this needs to become opt-in consent that gates posthog.init.
export default function CookieNotice() {
  // Server snapshot returns a sentinel so SSR + hydration render nothing and
  // the stored choice is read without a setState-in-effect mount dance.
  const stored = useSyncExternalStore(emptySubscribe, readChoice, () => SSR_SENTINEL);
  const [dismissed, setDismissed] = useState(false);

  if (stored === SSR_SENTINEL || stored !== null || dismissed) return null;

  const accept = () => {
    saveChoice("accepted");
    setDismissed(true);
  };

  const decline = () => {
    saveChoice("declined");
    try {
      // PostHog persists the opt-out itself, so this survives reloads.
      posthog.opt_out_capturing();
    } catch {
      // PostHog not initialized (no key configured) — nothing to opt out of.
    }
    setDismissed(true);
  };

  return (
    <div
      role="region"
      aria-label="Cookie notice"
      className="fixed z-50 bottom-[64px] left-2 right-2 lg:bottom-4 lg:left-auto lg:right-4 lg:max-w-sm rounded-xl border border-gray-800 bg-gray-950/95 backdrop-blur px-4 py-3 shadow-lg"
    >
      <p className="text-sm text-gray-300">
        We use cookies to keep you signed in and analytics to understand how CreatorNet is
        used.{" "}
        <Link href="/legal/cookies" className="underline text-gray-200 hover:text-white">
          Learn more
        </Link>
      </p>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={accept}
          className="btn-icon-small rounded-full bg-[#655BFF] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#5148e6] transition-colors"
        >
          OK
        </button>
        <button
          type="button"
          onClick={decline}
          className="btn-icon-small rounded-full border border-gray-700 px-4 py-1.5 text-sm font-medium text-gray-300 hover:bg-gray-900 transition-colors"
        >
          Decline analytics
        </button>
      </div>
    </div>
  );
}
