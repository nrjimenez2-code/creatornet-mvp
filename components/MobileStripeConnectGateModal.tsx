"use client";

import { useCallback, useEffect, useState } from "react";

type Status =
  | { loading: true }
  | { loading: false; connected: false }
  | {
      loading: false;
      connected: true;
      onboarding_complete: boolean;
    };

type Props = {
  open: boolean;
  onClose: () => void;
  /** When status becomes sell-ready (e.g. after “refresh status”), open the composer. */
  onReady?: () => void;
};

export default function MobileStripeConnectGateModal({ open, onClose, onReady }: Props) {
  const [s, setS] = useState<Status>({ loading: true });
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setS({ loading: true });
    setErr(null);
    try {
      const res = await fetch("/api/stripe/connect/status", {
        credentials: "include",
      });
      if (!res.ok) {
        setS({ loading: false, connected: false });
        return;
      }
      const data = await res.json();
      setS({ loading: false, ...data });
      if (data.connected && data.onboarding_complete) {
        onClose();
        onReady?.();
      }
    } catch {
      setS({ loading: false, connected: false });
    }
  }, [onClose, onReady]);

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

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

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Connect Stripe"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[min(400px,95vw)] rounded-2xl border border-white/10 bg-[#0a0a0a] p-5 shadow-2xl text-white">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold">Connect Stripe first</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-white/70 hover:bg-white/10 transition shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="mt-4">
          {s.loading ? (
            <p className="text-sm text-white/50">Checking connection…</p>
          ) : s.connected && s.onboarding_complete ? (
            <p className="text-sm text-green-400">Opening composer…</p>
          ) : s.connected && !s.onboarding_complete ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-xs">
              <p className="text-amber-200 font-medium">Finish Stripe setup</p>
              <p className="text-amber-200/70 mt-1 mb-2">Required to sell.</p>
              {err && <p className="text-red-400 mb-1">{err}</p>}
              <button
                type="button"
                onClick={connect}
                disabled={starting}
                className="rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-black disabled:opacity-60"
              >
                {starting ? "…" : "Continue"}
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-[#4A35C7]/40 bg-[#4A35C7]/15 px-3 py-3 text-xs">
              <p className="text-white font-semibold">Connect Stripe to sell</p>
              <p className="text-white/60 mt-1 mb-2 leading-snug">
                CreatorNet keeps 12%; the rest goes to your bank after each sale.
              </p>
              {err && <p className="text-red-400 mb-1">{err}</p>}
              <button
                type="button"
                onClick={connect}
                disabled={starting}
                className="rounded-lg bg-[#4A35C7] px-3 py-2 text-xs font-semibold text-white disabled:opacity-60 w-full sm:w-auto"
              >
                {starting ? "Opening…" : "Connect Stripe"}
              </button>
            </div>
          )}
        </div>

        {!s.loading && !(s.connected && s.onboarding_complete) && (
          <button
            type="button"
            onClick={refresh}
            className="mt-3 text-xs text-white/40 hover:text-white/70 underline"
          >
            I finished in Stripe — refresh status
          </button>
        )}
      </div>
    </div>
  );
}
