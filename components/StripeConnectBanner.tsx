"use client";

import { useEffect, useState } from "react";
import { useUser } from "@/lib/useUser";
import { createClient } from "@/lib/supabaseClient";

type Status =
  | { loading: true }
  | { loading: false; connected: false }
  | {
      loading: false;
      connected: true;
      onboarding_complete: boolean;
    };

export default function StripeConnectBanner() {
  const { session, loading: authLoading } = useUser();
  const token = session?.access_token;
  const [retry, setRetry] = useState(0);
  const [authRequired, setAuthRequired] = useState(false);
  const [statusFailed, setStatusFailed] = useState(false);
  const [s, setS] = useState<Status>({ loading: true });
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let c = false;
    setErr(null);
    setAuthRequired(false);
    setStatusFailed(false);
    setS({ loading: true });
    if (authLoading || !token) return;
    (async () => {
      try {
        const res = await fetch("/api/stripe/connect/status", {
          credentials: "include",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          if (!c) {
            setAuthRequired(res.status === 401);
            setStatusFailed(res.status !== 401);
            setS({ loading: false, connected: false });
          }
          return;
        }
        const data = await res.json();
        if (!c) setS({ loading: false, ...data });
      } catch {
        if (!c) { setStatusFailed(true); setS({ loading: false, connected: false }); }
      }
    })();
    return () => {
      c = true;
    };
  }, [authLoading, token, retry]);

  async function connect() {
    setStarting(true);
    setErr(null);
    try {
      const { data: { session: current }, error } = await createClient().auth.getSession();
      if (error || !current) { setAuthRequired(true); return; }
      // Return/refresh routes need cookies after the browser comes back from Stripe.
      // Confirm the handoff before creating an account or onboarding link.
      const sync = await fetch("/auth/callback", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "SIGNED_IN", access_token: current.access_token,
          refresh_token: current.refresh_token }),
      });
      if (!sync.ok) {
        setErr("Could not verify your session. Please try again or sign in again.");
        return;
      }
      const res = await fetch("/api/stripe/connect/onboard", {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${current.access_token}` },
      });
      if (res.status === 401) { setAuthRequired(true); return; }
      const data = await res.json();
      if (!res.ok || !data.url) {
        setErr(data.error || "Could not start Stripe.");
        setStarting(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setErr("Network error. Please try again.");
    } finally {
      setStarting(false);
    }
  }

  if (authLoading) return null;
  if (!token || authRequired) return (
    <div className="rounded-xl border border-white/20 p-3 text-xs text-white">
      <p>Sign in to connect Stripe and receive payouts.</p>
      <a href="/auth" className="mt-2 inline-block underline">Sign in</a>
    </div>
  );
  if (s.loading) return null;
  if (statusFailed) return (
    <div className="rounded-xl border border-white/20 p-3 text-xs text-white" role="status">
      <p>Could not check your Stripe connection.</p>
      <button type="button" className="mt-2 underline" onClick={() => setRetry(n => n + 1)}>Try again</button>
    </div>
  );

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
        {err && <p role="alert" className="text-red-400 mb-1">{err} <a href="/auth" className="underline">Sign in again</a></p>}
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
      {err && <p role="alert" className="text-red-400 mb-1">{err} <a href="/auth" className="underline">Sign in again</a></p>}
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
