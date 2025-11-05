"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

type ViewState =
  | { phase: "checking" }
  | { phase: "error"; message: string }
  | {
      phase: "success";
      sessionId: string;
      postId: string | null;
      amount: string | null;
    };

export default function SuccessClient() {
  const params = useSearchParams();
  const router = useRouter();

  const [state, setState] = useState<ViewState>({ phase: "checking" });
  const ran = useRef(false);

  const sessionIdFromUrl = params.get("session_id");
  const postIdFromUrl = params.get("post_id");

  // Prefer session id from URL; fall back to what we stashed pre-redirect
  const sessionId = useMemo(() => {
    if (sessionIdFromUrl) return sessionIdFromUrl;
    try {
      if (typeof window !== "undefined") {
        return localStorage.getItem("last_checkout_session");
      }
    } catch {}
    return null;
  }, [sessionIdFromUrl]);

  const postId = postIdFromUrl || null;

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    if (!sessionId) {
      setState({
        phase: "error",
        message:
          "Missing Stripe session id. If you were charged, your access will appear in your Library shortly.",
      });
      return;
    }

    const ctrl = new AbortController();

    (async () => {
      try {
        const res = await fetch("/api/stripe/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
          signal: ctrl.signal,
        });

        const out = await res.json().catch(() => ({} as any));

        if (!res.ok || !out?.success) {
          setState({
            phase: "error",
            message:
              out?.error ??
              "We couldn’t verify your payment yet. Please check your Library later.",
          });
          return;
        }

        // Clear cached session id on success
        try {
          localStorage.removeItem("last_checkout_session");
        } catch {}

        const amount =
          out.session?.amount_total != null
            ? `$${(out.session.amount_total / 100).toFixed(2)} USD`
            : null;

        setState({
          phase: "success",
          sessionId,
          postId,
          amount,
        });
      } catch {
        setState({
          phase: "error",
          message:
            "Something went wrong confirming your payment. Please try again in a moment.",
        });
      }
    })();

    return () => ctrl.abort();
  }, [sessionId, postId]);

  // ===== UI =====

  if (state.phase === "checking") {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="border rounded-lg p-6 text-center">
          <h1 className="text-lg font-semibold mb-2">Checking payment…</h1>
          <p className="text-muted-foreground text-sm">
            Please wait while we verify your purchase.
          </p>
        </div>
      </main>
    );
  }

  if (state.phase === "error") {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="border rounded-lg p-6 text-center max-w-md w-full">
          <h1 className="text-lg font-semibold mb-2 text-red-600">
            Payment issue
          </h1>
          <p className="text-muted-foreground text-sm mb-4">{state.message}</p>
          <div className="flex justify-center gap-3">
            <Link
              href="/library"
              className="px-4 py-2 border rounded-md text-sm hover:bg-muted"
            >
              View Library
            </Link>
            <button
              onClick={() => router.refresh()}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90"
            >
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  }

  // success
  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="border rounded-lg p-6 text-center max-w-md w-full">
        <h1 className="text-lg font-semibold mb-2">Payment successful 🎉</h1>
        <p className="text-muted-foreground text-sm mb-6">
          Your premium access is unlocked. A receipt has been emailed to you.
        </p>

        <div className="flex justify-center gap-3">
          {state.postId ? (
            <Link
              href={`/watch/${state.postId}`}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90"
            >
              Watch now
            </Link>
          ) : null}

          <Link
            href="/library"
            className="px-4 py-2 border rounded-md text-sm hover:bg-muted"
          >
            View Library
          </Link>
        </div>

        <div className="mt-6 text-xs text-muted-foreground">
          <p>Session: {state.sessionId}</p>
          {state.amount && <p>Amount: {state.amount}</p>}
        </div>
      </div>
    </main>
  );
}
