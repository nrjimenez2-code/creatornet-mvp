// app/success/page.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type ConfirmResp =
  | { ok: true; purchase_id?: string; status?: "paid" | "pending"; session_id?: string }
  | { error: string };

export default function SuccessPage() {
  const router = useRouter();
  const params = useSearchParams();
  const sessionId = params.get("session_id") || "";
  const [status, setStatus] = useState<"checking" | "ok" | "pending" | "error">("checking");
  const [message, setMessage] = useState("Almost there…");
  const triesRef = useRef(0);
  const maxTries = 6; // ~10–12s total with backoff

  async function confirmOnce(): Promise<ConfirmResp> {
    const res = await fetch("/api/confirm-purchase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ session_id: sessionId }),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) return { error: data?.error || `HTTP ${res.status}` };
    return data as ConfirmResp;
  }

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!sessionId) {
        setStatus("error");
        setMessage("Missing session id.");
        return;
      }

      // Small polling loop to cover webhook delay
      while (!cancelled && triesRef.current < maxTries) {
        try {
          const resp = await confirmOnce();

          if ("error" in resp) {
            // If webhook hasn’t landed yet, keep trying a bit
            triesRef.current += 1;
            setStatus("pending");
            setMessage(
              `Finalizing your payment… (${triesRef.current}/${maxTries})`
            );
          } else {
            // Success path
            if (resp.purchase_id) {
              setStatus("ok");
              setMessage("Payment confirmed! Redirecting…");
              setTimeout(() => router.replace(`/access/${resp.purchase_id}`), 700);
              return;
            }

            // If no purchase_id but status is paid, send to Library as fallback
            if (resp.status === "paid") {
              setStatus("ok");
              setMessage("Payment confirmed! Redirecting…");
              setTimeout(() => router.replace("/library"), 700);
              return;
            }

            // Pending -> keep polling
            triesRef.current += 1;
            setStatus("pending");
            setMessage(
              `Waiting for confirmation… (${triesRef.current}/${maxTries})`
            );
          }
        } catch {
          triesRef.current += 1;
          setStatus("pending");
          setMessage(
            `Retrying… (${triesRef.current}/${maxTries})`
          );
        }

        // Exponential-ish backoff: 400ms, 800ms, 1200ms, …
        const delay = Math.min(400 * (triesRef.current + 1), 1500);
        await new Promise((r) => setTimeout(r, delay));
      }

      // If we exhausted retries
      if (!cancelled) {
        setStatus("error");
        setMessage(
          "We couldn’t verify your payment yet. It may still post in a minute—check your Library."
        );
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [router, sessionId]);

  return (
    <main className="min-h-[70vh] flex items-center justify-center">
      <div className="text-center max-w-md">
        <div className="mb-4 animate-pulse text-4xl">🌀</div>
        <h1 className="text-xl font-semibold mb-2">
          {status === "checking"
            ? "Almost there…"
            : status === "ok"
            ? "Success"
            : status === "pending"
            ? "Finalizing…"
            : "Heads up"}
        </h1>
        <p className="text-sm text-gray-600">{message}</p>

        {status === "error" && (
          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              onClick={() => router.replace("/library")}
              className="px-4 py-2 text-sm rounded-lg bg-black text-white"
            >
              Go to Library
            </button>
            <button
              onClick={() => router.replace("/dashboard")}
              className="px-4 py-2 text-sm rounded-lg border"
            >
              Go to Dashboard
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
