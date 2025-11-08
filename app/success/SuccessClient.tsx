"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

type Props = { sessionId: string | null };

type ApiOK = { fulfillment_url: string | null; status: string | null };
type ApiErr = { error: string };
type ApiResp = ApiOK | ApiErr;

type ViewState =
  | { phase: "checking" }
  | { phase: "error"; message: string }
  | {
      phase: "success";
      sessionId: string;
      postId: string | null;
      amount: string | null; // we don't return amount from the by-session API yet; left here for UI parity
      fulfillmentUrl: string | null;
      status: string | null;
    };

export default function SuccessClient({ sessionId }: Props) {
  const params = useSearchParams();
  const router = useRouter();

  const postId = params.get("post_id") || null;

  const [state, setState] = useState<ViewState>({ phase: "checking" });

  // gentle backoff: 2s → 3s → 5s → 10s → 10s…
  const timeouts = useMemo(() => [2000, 3000, 5000, 10000, 10000, 10000], []);
  const pollIndex = useRef(0);
  const stop = useRef(false);

  const fetchOnce = useCallback(async () => {
    if (!sessionId) {
      setState({
        phase: "error",
        message:
          "Missing Stripe session id. If you were charged, your access will appear in your Library shortly.",
      });
      return;
    }

    try {
      const res = await fetch(
        `/api/purchases/by-session?session_id=${encodeURIComponent(sessionId)}`,
        { cache: "no-store" }
      );
      const data: ApiResp = await res.json();

      if (!res.ok || "error" in data) {
        setState({
          phase: "error",
          message:
            ("error" in data && data.error) ||
            "We couldn’t verify your purchase yet. Please check your Library later.",
        });
        return;
      }

      const fulfillmentUrl = data.fulfillment_url ?? null;
      const status = data.status ?? null;

      // We don’t have amount from this endpoint (kept for parity with your prior UI)
      setState({
        phase: "success",
        sessionId,
        postId,
        amount: null,
        fulfillmentUrl,
        status,
      });

      if (fulfillmentUrl) {
        stop.current = true;
      }
    } catch (e: any) {
      setState({
        phase: "error",
        message:
          e?.message ||
          "Something went wrong confirming your payment. Please try again in a moment.",
      });
    }
  }, [sessionId, postId]);

  useEffect(() => {
    let mounted = true;

    (async () => {
      await fetchOnce();
      while (mounted && !stop.current && pollIndex.current < timeouts.length) {
        await new Promise((r) => setTimeout(r, timeouts[pollIndex.current++]!));
        if (mounted && !stop.current) await fetchOnce();
      }
    })();

    return () => {
      mounted = false;
      stop.current = true;
    };
  }, [fetchOnce, timeouts]);

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
          {state.status
            ? `Status: ${state.status}`
            : "Your premium access is unlocking…"}
        </p>

        {state.fulfillmentUrl ? (
          <div className="flex justify-center gap-3">
            <a
              href={state.fulfillmentUrl}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90"
            >
              Open Access
            </a>
            <Link
              href="/library"
              className="px-4 py-2 border rounded-md text-sm hover:bg-muted"
            >
              View Library
            </Link>
          </div>
        ) : (
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
        )}

        <div className="mt-6 text-xs text-muted-foreground break-all">
          <p>Session: {state.sessionId}</p>
          {state.amount && <p>Amount: {state.amount}</p>}
          {state.fulfillmentUrl && <p>Access: {state.fulfillmentUrl}</p>}
        </div>
      </div>
    </main>
  );
}
