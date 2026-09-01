"use client";

import { useState, useSyncExternalStore } from "react";
import posthog from "posthog-js";

const STORAGE_KEY = "cn-cookie-choice";
const SSR_SENTINEL = "ssr";

function readStatus(): "in" | "out" {
  try {
    return posthog.has_opted_out_capturing() ? "out" : "in";
  } catch {
    return "in";
  }
}

const emptySubscribe = () => () => {};

function saveChoice(choice: "accepted" | "declined") {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Storage unavailable — nothing to persist.
  }
}

// Permanent opt-out control for /legal/cookies: the dismissible cookie notice
// must not be the only path to the opt-out the policies describe.
export default function AnalyticsOptOut() {
  const initial = useSyncExternalStore(
    emptySubscribe,
    readStatus,
    () => SSR_SENTINEL as "in" | "out" | typeof SSR_SENTINEL
  );
  const [override, setOverride] = useState<"in" | "out" | null>(null);

  if (initial === SSR_SENTINEL && override === null) return null;
  const status = override ?? initial;

  const optOut = () => {
    try {
      posthog.opt_out_capturing();
    } catch {
      // PostHog not initialized — nothing collecting anyway.
    }
    saveChoice("declined");
    setOverride("out");
  };

  const optIn = () => {
    try {
      posthog.opt_in_capturing();
    } catch {
      // PostHog not initialized.
    }
    saveChoice("accepted");
    setOverride("in");
  };

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
      <p className="text-sm text-gray-700">
        Analytics on this device:{" "}
        <strong>{status === "out" ? "opted out" : "active"}</strong>
      </p>
      <button
        type="button"
        onClick={status === "out" ? optIn : optOut}
        className="mt-2 rounded-full border border-gray-300 bg-white px-4 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-100 transition-colors"
      >
        {status === "out" ? "Turn analytics back on" : "Opt out of analytics"}
      </button>
    </div>
  );
}
