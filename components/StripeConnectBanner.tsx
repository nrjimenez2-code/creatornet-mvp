"use client";

import { useEffect, useState } from "react";

type Status =
  | { loading: true }
  | { loading: false; connected: false }
  | {
      loading: false;
      connected: true;
      onboarding_complete: boolean;
    };

export default function StripeConnectBanner() {
  const [s, setS] = useState<Status>({ loading: true });
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let c = false;
    (async () => {
      try {
        const res = await fetch("/api/stripe/connect/status", {
          credentials: "include",
        });
        if (!res.ok) {
          if (!c) setS({ loading: false, connected: false });
          return;
        }
        const data = await res.json();
        if (!c) setS({ loading: false, ...data });
      } catch {
        if (!c) setS({ loading: false, connected: false });
      }
    })();
    return () => {
      c = true;
    };
  }, []);

  async function connect() {
    setStarting(true);
    setErr(null);
    try {
      const res = await fetch("/api/stripe/connect/onboard", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setErr(data.error || "Could not start Stripe.");
        setStarting(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setErr("Network error.");
      setStarting(false);
    }
  }

  if (s.loading) return null;

  if (s.connected && s.onboarding_complete) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-green-500/30 bg-green-500/10 px-3 py-2.5 text-xs text-green-400">
        <span className="h-1.5 w-1.5 rounded-full bg-green-400 shrink-0" />
        Payouts active (Stripe connected)
      </div>
    );
  }

  if (s.connected && !s.onboarding_complete) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs">
        <p className="text-amber-200 font-medium">Finish Stripe setup</p>
        <p className="text-amber-200/70 mt-1 mb-2">Required to sell.</p>
        {err && <p className="text-red-400 mb-1">{err}</p>}
        <button
          type="button"
          onClick={connect}
          disabled={starting}
          className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-60"
        >
          {starting ? "…" : "Continue"}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#4A35C7]/40 bg-[#4A35C7]/15 px-3 py-3 text-xs">
      <p className="text-white font-semibold">Connect Stripe to sell</p>
      <p className="text-white/60 mt-1 mb-2 leading-snug">
        CreatorNet charges a 12% platform fee. Standard payment-processing fees are deducted
        separately. Your net earnings are routed to your connected Stripe account.
      </p>
      {err && <p className="text-red-400 mb-1">{err}</p>}
      <button
        type="button"
        onClick={connect}
        disabled={starting}
        className="rounded-lg bg-[#4A35C7] px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
      >
        {starting ? "Opening…" : "Connect Stripe"}
      </button>
    </div>
  );
}
